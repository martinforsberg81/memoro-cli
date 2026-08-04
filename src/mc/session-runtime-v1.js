import {
  beginRuntimeGenerationSync,
  bindRuntimeConversationSync,
  completeRuntimeGenerationSync,
  decideSessionRuntimeAction,
  failRuntimeGenerationSync,
  inspectSessionRuntimeSync,
} from './session-runtime-journal.js';
import { prepareCertifiedLaunchPlan } from '../runtime/certified-execution/launch-plan.js';
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
    return attached.ok
      ? success({ action: 'attach', generation_id: generationId, code: attached.code })
      : failure(attached.reason, attached.code);
  }

  if (decision.action === 'manual-repair'
    || decision.action === 'resolve-missing-conversation') {
    return failure(decision.reason || decision.action);
  }
  if (decision.action === 'switch') {
    return failure('tool-switch-requires-explicit-handoff');
  }
  if (decision.action === 'explicit-replacement-required' && !replace) {
    return failure('explicit-replacement-required');
  }

  const selectedTool = selectTool({ requested: tool, decision, snapshot });
  if (!selectedTool) return failure('tool-unavailable');
  if (noLaunch) {
    return success({
      action: decision.action === 'explicit-replacement-required' ? 'replace' : decision.action,
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

  let portal = deps.portal || null;
  if (!portal) {
    try {
      portal = await (deps.resolvePortal || resolveTrustedVaultPortal)({
        deps: deps.portalDeps || {},
      });
    } catch {}
  }
  const prepared = await (deps.prepareLaunchPlan || prepareCertifiedLaunchPlan)({
    mcHomeDir,
    mcSessionId,
    generationId: generation.intent.generation_id,
    portal,
    baseEnv: deps.env || process.env,
    deps: deps.certifiedExecution || {},
  });
  if (!prepared?.ok) return failure(prepared?.reason || 'certified-launch-unavailable');

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
    ? success({ action: generation.intent.action, generation_id: generation.intent.generation_id, code: attached.code })
    : failure(attached.reason, attached.code);
}

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

function failure(reason, code = 1) {
  return { ok: false, code: Number.isInteger(code) ? code : 1, reason };
}
