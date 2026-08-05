import {
  beginRuntimeGenerationSync,
  bindRuntimeConversationSync,
  completeRuntimeGenerationSync,
  decideSessionRuntimeAction,
  failRuntimeGenerationSync,
  inspectSessionRuntimeSync,
} from './session-runtime-journal.js';
import { prepareCertifiedLaunchPlan } from '../runtime/certified-execution/launch-plan.js';
import { reopenLocalSession } from './session-lifecycle-v1.js';
import { SessionRuntimeSocketServer } from '../runtime/session-host/server.js';
import {
  attachLocalSessionTerminal,
} from '../runtime/session-host/terminal-client.js';
import { probeSessionRuntimeHost } from '../runtime/session-host/client.js';
import { reconcileRuntimeHostSync } from '../runtime/session-host/runtime-host.js';
import { resolveTrustedVaultPortal } from '../vault/engine/trusted-portal.js';

export async function openLocalSessionRuntime({
  mcHomeDir,
  session,
  workspace,
  tool = null,
  replace = false,
  noLaunch = false,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const mcSessionId = session.mc_session_id;
  // Opening an archived session is a request to pick it back up. `end`
  // archives, `delete` destroys; without this, `end` was a one-way door with
  // no verb to undo it.
  if (session.projection?.lifecycle === 'archived') {
    try {
      (deps.reopenSession || reopenLocalSession)({ mcHomeDir, mcSessionId, deps: deps.lifecycleDeps || {} });
    } catch (error) {
      return failure(error?.reason || 'session-reopen-failed');
    }
  }
  let snapshot = (deps.inspectRuntime || inspectSessionRuntimeSync)({ mcHomeDir, mcSessionId });
  if (snapshot.kind !== 'present') return failure(snapshot.reason || 'runtime-state-unavailable');
  let decision = (deps.decideRuntimeAction || decideSessionRuntimeAction)(snapshot, { tool });

  if (decision.action === 'finalize-exit') {
    (deps.completeGeneration || completeRuntimeGenerationSync)({
      mcHomeDir,
      mcSessionId,
      generationId: decision.generation_id,
      conversationId: decision.conversation_id,
    });
    snapshot = (deps.inspectRuntime || inspectSessionRuntimeSync)({ mcHomeDir, mcSessionId });
    decision = (deps.decideRuntimeAction || decideSessionRuntimeAction)(snapshot, { tool });
  }

  if (decision.action === 'attach' || decision.action === 'reconcile-accepted-outcome') {
    const generationId = decision.generation_id;
    const probe = await (deps.probeRuntimeHost || probeSessionRuntimeHost)({
      mcHomeDir,
      mcSessionId,
      generationId,
    });
    const reconciled = (deps.reconcileRuntimeHost || reconcileRuntimeHostSync)({
      mcHomeDir,
      mcSessionId,
      probe,
    });
    if (reconciled.action !== 'attach') {
      return failure(reconciled.reason || reconciled.action);
    }
    if (noLaunch) return success({ action: 'attach', generation_id: generationId });
    const attached = await (deps.attachTerminal || attachLocalSessionTerminal)({
      mcHomeDir,
      mcSessionId,
      generationId,
      stdin,
      stdout,
      stderr,
    });
    if (attached.ok) {
      return success({ action: 'attach', generation_id: generationId, code: attached.code });
    }
    // A runtime mc cannot attach to is not a runtime the user can use, and
    // refusing here left the session unopenable by every verb — open, restart,
    // end-and-reopen — because each of them starts by trying to attach again.
    //
    // The commonest cause is an mc that moved: the host identity includes the
    // build that started it, so after an upgrade the recorded runtime belongs
    // to a stranger. Whatever the cause, an unattachable runtime is a spent
    // one. Retire the generation and continue into a fresh launch rather than
    // reporting the attach failure as the session's verdict.
    markGenerationFailed({
      deps,
      mcHomeDir,
      mcSessionId,
      generationId,
      reason: attached.reason || 'runtime-not-attachable',
    });
    snapshot = (deps.inspectRuntime || inspectSessionRuntimeSync)({ mcHomeDir, mcSessionId });
    decision = (deps.decideRuntimeAction || decideSessionRuntimeAction)(snapshot, { tool });
  }

  if (decision.action === 'manual-repair'
    || decision.action === 'resolve-missing-conversation') {
    return failure(decision.reason || decision.action);
  }
  if (decision.action === 'switch') {
    return failure('tool-switch-requires-explicit-handoff');
  }
  // `--replace` is still the only way to abandon a conversation that could
  // otherwise be resumed. It is now a user override of a working resume,
  // rather than the price of mc's last failed launch.
  if (replace && decision.action === 'resume') {
    decision = {
      action: 'explicit-replacement-required',
      previous_generation_id: snapshot.generations.at(-1)?.intent?.generation_id || null,
      tool: decision.tool,
    };
  }
  if (decision.action === 'explicit-replacement-required' && !replace) {
    return failure('explicit-replacement-required');
  }

  const selectedTool = selectTool({ requested: tool, decision, snapshot });
  if (!selectedTool) return failure('tool-unavailable');
  if (noLaunch) {
    return success({
      action: ['explicit-replacement-required', 'replace-failed-generation'].includes(decision.action)
        ? 'replace'
        : decision.action,
      tool: selectedTool,
      workspace_id: workspace.workspace_id,
      launch_cwd: workspace.current_path,
    });
  }

  let generation;
  if (decision.action === 'launch-planned-generation') {
    generation = snapshot.active_generation;
  } else {
    const intent = generationIntentFromDecision(decision, snapshot, {
      tool: selectedTool,
      workspace,
    });
    try {
      generation = (deps.beginGeneration || beginRuntimeGenerationSync)({
        mcHomeDir,
        mcSessionId,
        ...intent,
      });
    } catch (error) {
      return failure(error?.reason || 'runtime-generation-create-failed');
    }
  }

  let replacedUnresumableConversation = false;
  let portal = deps.portal || null;
  if (!portal) {
    try {
      portal = await (deps.resolvePortal || resolveTrustedVaultPortal)({
        deps: deps.portalDeps || {},
      });
    } catch {}
  }
  const planLaunch = (forGeneration) => (deps.prepareLaunchPlan || prepareCertifiedLaunchPlan)({
    mcHomeDir,
    mcSessionId,
    sessionName: session.metadata.name,
    generationId: forGeneration.intent.generation_id,
    portal,
    baseEnv: deps.env || process.env,
    deps: deps.certifiedExecution || {},
  });
  let prepared = await planLaunch(generation);
  // A conversation mc cannot resume does not mean the session has none. mc
  // itself creates replacement conversations when a resume fails, so the
  // newest one is often an empty stand-in for a real history one step back —
  // and replacing it again on every open builds a chain of empty
  // conversations while the work sits just behind them. So walk back through
  // what the session actually recorded and resume the newest one that can be,
  // before concluding there is nothing to continue.
  if (!prepared?.ok && UNRESUMABLE_CONVERSATION.has(prepared?.reason)) {
    const tried = new Set([conversationTargetedBy(generation)].filter(Boolean));
    for (const candidate of [...snapshot.conversations].reverse()) {
      if (tried.has(candidate.conversation_id) || candidate.tool !== selectedTool) continue;
      tried.add(candidate.conversation_id);
      markGenerationFailed({
        deps,
        mcHomeDir,
        mcSessionId,
        generationId: generation.intent.generation_id,
        reason: prepared.reason,
      });
      let candidateGeneration;
      try {
        candidateGeneration = (deps.beginGeneration || beginRuntimeGenerationSync)({
          mcHomeDir,
          mcSessionId,
          action: 'resume',
          resumeConversationId: candidate.conversation_id,
          tool: selectedTool,
          workspaceId: workspace.workspace_id,
          launchCwd: workspace.current_path,
        });
      } catch { break; }
      const attempt = await planLaunch(candidateGeneration);
      if (attempt?.ok) {
        generation = candidateGeneration;
        prepared = attempt;
        break;
      }
      if (!UNRESUMABLE_CONVERSATION.has(attempt?.reason)) {
        generation = candidateGeneration;
        prepared = attempt;
        break;
      }
      generation = candidateGeneration;
      prepared = attempt;
    }
  }
  if (!prepared?.ok && UNRESUMABLE_CONVERSATION.has(prepared?.reason)) {
    // The session records which conversation it was using, but that
    // conversation's transcript was never written anywhere mc controls — it
    // belonged to a session that ran before managed execution and lived in the
    // user's own tool home. There is nothing to resume and nothing a retry can
    // recover.
    //
    // Refusing a replacement exists to stop mc from silently dropping a
    // conversation that could still be continued. Here there is provably none,
    // so the refusal protects nothing and only leaves the session unopenable.
    // mc starts a fresh conversation itself and records why, rather than
    // reporting a reason code and asking for a flag.
    markGenerationFailed({
      deps,
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      reason: prepared.reason,
    });
    try {
      generation = (deps.beginGeneration || beginRuntimeGenerationSync)({
        mcHomeDir,
        mcSessionId,
        action: 'replace',
        previousGenerationId: generation.intent.generation_id,
        replacementReason: 'legacy-transcript-unavailable',
        tool: selectedTool,
        workspaceId: workspace.workspace_id,
        launchCwd: workspace.current_path,
      });
    } catch (error) {
      return failure(error?.reason || 'runtime-generation-create-failed');
    }
    replacedUnresumableConversation = true;
    prepared = await planLaunch(generation);
  }
  if (!prepared?.ok) {
    return failure(prepared?.reason || 'certified-launch-unavailable', 1, prepared?.diagnostic_code);
  }

  let runtime = null;
  let server = null;
  let runtimeExit = null;
  try {
    const ptyFactory = deps.ptyFactory || await loadPtyFactory();
    runtime = await prepared.plan.startRuntime({
      ptyFactory,
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
    });
    const runtimeStatus = runtime.status();
    runtimeExit = runtimeStatus.state === 'exited'
      ? Promise.resolve(runtimeStatus)
      : new Promise((resolve) => runtime.once('exit', resolve));
    server = (deps.createSocketServer
      ? deps.createSocketServer({ mcHomeDir, host: runtime })
      : new SessionRuntimeSocketServer({ mcHomeDir, host: runtime }));
    await server.start();
  } catch (error) {
    if (runtime) {
      const cleaned = await cleanupFailedRuntimeLaunch({
        runtime,
        runtimeExit,
        plan: prepared.plan,
        deps,
        mcHomeDir,
        mcSessionId,
        generationId: generation.intent.generation_id,
      });
      if (!cleaned.ok) return failure(cleaned.reason);
    } else {
      try { await prepared.plan.abort(); } catch {}
    }
    return failure(error?.reason || 'runtime-launch-failed');
  }

  const attached = await (deps.attachTerminal || attachLocalSessionTerminal)({
    mcHomeDir,
    mcSessionId,
    generationId: generation.intent.generation_id,
    stdin,
    stdout,
    stderr,
  });
  await runtimeExit;
  try { await server.stop(); } catch {}

  const captured = prepared.plan.captureConversationArtifact();
  if (!captured.ok) {
    markGenerationFailed({
      deps,
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      reason: 'conversation-not-observed',
    });
    try { await runtime.close(); } catch {}
    return failure(captured.reason || 'conversation-not-observed');
  }

  let conversationId = generation.intent.resume_conversation_id;
  if (generation.intent.action !== 'resume') {
    try {
      const conversation = (deps.bindConversation || bindRuntimeConversationSync)({
        mcHomeDir,
        mcSessionId,
        generationId: generation.intent.generation_id,
        handle: captured.handle,
      });
      conversationId = conversation.conversation_id;
    } catch (error) {
      markGenerationFailed({
        deps,
        mcHomeDir,
        mcSessionId,
        generationId: generation.intent.generation_id,
        reason: 'conversation-binding-failed',
      });
      try { await runtime.close(); } catch {}
      return failure(error?.reason || 'conversation-binding-failed');
    }
  }

  const closed = await prepared.plan.closeBoundary({
    portal,
    providerArtifact: captured.artifact,
  });
  if (!closed?.ok) {
    markGenerationFailed({
      deps,
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      reason: 'credential-boundary-close-failed',
    });
    try { await runtime.close(); } catch {}
    return failure(closed?.reason || 'credential-boundary-close-failed');
  }

  try {
    (deps.completeGeneration || completeRuntimeGenerationSync)({
      mcHomeDir,
      mcSessionId,
      generationId: generation.intent.generation_id,
      conversationId,
    });
  } catch (error) {
    try { await runtime.close(); } catch {}
    return failure(error?.reason || 'runtime-completion-failed');
  }
  try { await runtime.close(); } catch {}
  return attached.ok
    ? success({
      action: generation.intent.action,
      generation_id: generation.intent.generation_id,
      code: attached.code,
      ...(replacedUnresumableConversation ? { replaced_unresumable_conversation: true } : {}),
    })
    : failure(attached.reason, attached.code);
}

/**
 * The conversation a generation names, or null when it names none.
 *
 * Guessing here is worse than not knowing: a replacement generation targets no
 * conversation, and treating the newest one as "already tried" skipped exactly
 * the conversation worth resuming.
 */
function conversationTargetedBy(generation) {
  return generation?.intent?.resume_conversation_id || null;
}

// Reasons that mean "the recorded conversation has no transcript to resume",
// as opposed to a transcript that is present but unreadable — those stay hard
// failures, because a damaged transcript is not the same as an absent one.
const UNRESUMABLE_CONVERSATION = new Set([
  'managed-portable-session-manifest-missing',
  'managed-portable-session-source-missing',
  // The store holds an archive, but not for this conversation. Same meaning
  // as no archive at all: this conversation cannot be resumed from here.
  'managed-portable-session-state-mismatch',
]);

function generationIntentFromDecision(decision, snapshot, { tool, workspace }) {
  const common = {
    tool,
    workspaceId: workspace.workspace_id,
    launchCwd: workspace.current_path,
  };
  if (decision.action === 'start') return { action: 'start', ...common };
  if (decision.action === 'resume') {
    return { action: 'resume', resumeConversationId: decision.conversation_id, ...common };
  }
  if (decision.action === 'explicit-replacement-required') {
    return {
      action: 'replace',
      previousGenerationId: decision.previous_generation_id,
      replacementReason: 'user-requested-replacement',
      ...common,
    };
  }
  if (decision.action === 'replace-failed-generation') {
    return {
      action: 'replace',
      previousGenerationId: decision.previous_generation_id,
      replacementReason: 'previous-generation-failed',
      ...common,
    };
  }
  throw new Error(`unsupported runtime action: ${decision.action}`);
}

function selectTool({ requested, decision, snapshot }) {
  if (requested) return requested;
  if (decision.tool) return decision.tool;
  return snapshot.generations.at(-1)?.intent?.tool || 'codex';
}

function markGenerationFailed({ deps, ...options }) {
  try { (deps.failGeneration || failRuntimeGenerationSync)(options); } catch {}
}

async function cleanupFailedRuntimeLaunch({
  runtime,
  runtimeExit,
  plan,
  deps,
  mcHomeDir,
  mcSessionId,
  generationId,
}) {
  let stopped = ['exited', 'failed'].includes(runtime.status()?.state);
  if (!stopped) {
    try { runtime.stop('SIGTERM'); } catch {}
    stopped = await (deps.waitForRuntimeExit || waitForRuntimeExit)(runtimeExit, 2000);
  }
  if (!stopped) {
    try { runtime.stop('SIGKILL'); } catch {}
    stopped = await (deps.waitForRuntimeExit || waitForRuntimeExit)(runtimeExit, 2000);
  }
  if (!stopped) return { ok: false, reason: 'runtime-stop-timeout' };

  markGenerationFailed({
    deps,
    mcHomeDir,
    mcSessionId,
    generationId,
    reason: 'runtime-host-start-failed',
  });
  let boundary;
  try { boundary = await plan.abortClaimedRuntime(); } catch {}
  try { await runtime.close(); } catch {}
  return boundary?.ok
    ? { ok: true }
    : { ok: false, reason: boundary?.reason || 'credential-boundary-abort-failed' };
}

function waitForRuntimeExit(runtimeExit, timeoutMs) {
  if (!runtimeExit) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    Promise.resolve(runtimeExit).then(() => finish(true), () => finish(false));
  });
}

async function loadPtyFactory() {
  const loaded = await import('node-pty');
  return loaded.default || loaded;
}

function success(fields) {
  return { ok: true, code: fields.code ?? 0, ...fields };
}

function failure(reason, code = 1, diagnosticCode = null) {
  return {
    ok: false,
    code: Number.isInteger(code) ? code : 1,
    reason,
    ...(diagnosticCode ? { diagnostic_code: diagnosticCode } : {}),
  };
}
