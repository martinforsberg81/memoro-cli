/**
 * `mc resume <name> [--tool …|--codex|--claude] [--no-launch] [--json]
 *                  [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 *
 * Resume is not `mc new` with another label. If the broker still owns a live
 * PTY for this registry entry, resume attaches to it and sends no new prompt.
 * If the old PTY is gone, resume relaunches the same provider-native tool
 * session by id. If the entry has never had a tool session, resume is the
 * first fresh grounded start for that tracked worktree.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
  findEntry,
  formatEntryResolutionError,
  normalizeProviderSessions,
  providerSessionFor,
  readRegistry,
  resolveEntry,
  upsertEntry,
  withProviderSession,
} from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import { attachBrokerSession } from '../broker/attach-client.js';
import { requestBroker } from '../broker/client.js';
import {
  listLocalBrokerAndHostSessions,
  probeSessionHostRuntime,
} from '../broker/session-hosts.js';
import { sessionHostPaths } from '../broker/paths.js';
import { readSessionLifecycle } from '../broker/lifecycle-journal.js';
import {
  buildNewSessionLaunchIntent,
  buildResumeSessionLaunchIntent,
} from '../session-intent.js';
import {
  buildNativeResumeArgv,
  resolveToolSessionForResume,
} from '../tool-session.js';
import {
  buildSessionListView,
  fetchActiveCodingSessions,
  findActiveForLocalEntry,
  listChoices,
  parseNumberedChoice,
  renderActiveSelectionMessage,
  renderSessionListHuman,
} from '../session-list.js';
import { observeEntryWorktree } from '../session-observation.js';
import {
  countStaleDemotions,
  fetchLiveLocalSessionIds,
  normalizeEntryTruth,
  staleDemotionHint,
} from '../session-truth.js';
import {
  LOCAL_AUTH_MODES,
  requireLocalAuthMode,
  resolveLocalAuthMode,
} from '../local-auth-mode.js';
import {
  importManagedProviderRecovery,
  managedProviderAdapterForTool,
  inspectManagedProviderReadiness,
} from '../managed-provider-registry.js';
import {
  importLegacyNativeCodexSession,
} from '../managed-codex-recovery.js';
import {
  commitProviderSwitchDelivery,
  prepareProviderSwitch,
  recoverProviderSwitch,
} from '../provider-switch.js';
import {
  resolveSessionControllerCapability,
} from '../session-controller-capability.js';
import { reconcileManagedSession } from '../managed-session-reconciler.js';
import { inspectManagedSessionIdentitySync } from '../managed-generation-journal.js';
import { repairExitedSessionPresence } from '../session-presence.js';

export const TOOL_SUGAR = {
  '--claude': 'claude',
  '--codex': 'codex',
  '--gemini': 'gemini',
};

export async function run(rawArgv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const stdin = deps.stdin || process.stdin;
  const commandName = deps.commandName || 'resume';
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  const localAuthMode = deps.localAuthMode
    ?? resolveLocalAuthMode({ managedPortable: opts.managedPortable });
  const authMode = requireLocalAuthMode(localAuthMode);
  if (!authMode.ok) {
    stderr.write(`mc: ${authMode.error}\n`);
    return 1;
  }
  // Announced, never silent: the weaker container is only ever reached by an
  // explicit --native, so the user always knows which boundary they got.
  if (localAuthMode === LOCAL_AUTH_MODES.NATIVE && !opts.json && opts.managedPortable === false) {
    stderr.write('mc: --native — the tool uses its own sign-in; mc vault custody and the certified credential boundary are not in effect.\n');
  }
  const targetCustody = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? 'managed'
    : 'native';
  if (!opts.name) {
    return runResumePicker({
      opts,
      argv,
      stdin,
      stdout,
      stderr,
      emitDirectives,
      commandName,
      localAuthMode,
      deps,
    });
  }
  const resolvedEntry = deps.findEntry
    ? injectedLookup(opts.name, deps.findEntry)
    : resolveEntry(opts.name, { cwd: deps.cwd || process.cwd(), fallbackGlobal: true });
  let entry = resolvedEntry.entry;
  if (!resolvedEntry.ok) {
    stderr.write(`mc: ${formatEntryResolutionError(opts.name, resolvedEntry)}\n`);
    return 1;
  }
  entry = maybeObserveEntry(entry, deps);
  entry = await maybeBackfillToolSession(entry, {
    localAuthMode,
    upsert: deps.upsertEntry || upsertEntry,
    deps,
  });
  const providerState = normalizeProviderSessions(entry);
  if (!providerState.ok) {
    stderr.write(`mc: provider session state is invalid (${providerState.reason}); refusing to launch.\n`);
    return 1;
  }
  const toolValidation = validateToolFlag(opts.tool);
  if (toolValidation.error) {
    stderr.write(`mc: ${toolValidation.error}\n`);
    return 2;
  }
  let managedDecision = null;
  let handoff = null;
  let recoveredTargetTool = null;
  let recoveryLocalPresence = null;
  if (!opts.json && !opts.noLaunch && process.env.MC_TEST_MODE !== '1'
    && shouldRunProviderSwitchBoundary(deps)) {
    recoveryLocalPresence = await (
      deps.inspectLocalBrokerSessionForEntry || inspectLocalBrokerSessionForEntry
    )(entry, { request: deps.requestBroker || requestBroker, deps });
    const recovery = await (deps.recoverProviderSwitch || recoverProviderSwitch)({
      entry,
      targetTool: toolValidation.resolved,
      targetCustody,
      localPresence: recoveryLocalPresence,
      apiArgv: argv,
      env: process.env,
      deps: deps.providerSwitchDeps || deps,
    });
    if (!recovery?.ok) {
      stderr.write(`mc: provider handoff recovery failed (${recovery?.code || 'handoff-recovery-unavailable'}); refusing to launch.\n`);
      const remedy = handoffRecoveryRemedy(recovery);
      if (remedy) stderr.write(remedy);
      return 1;
    }
    if (recovery.active) {
      recoveredTargetTool = recovery.targetTool;
      if (recovery.recoveredDelivery) {
        const committed = await (deps.commitProviderSwitchDelivery
          || commitProviderSwitchDelivery)({
          entry,
          targetTool: recovery.targetTool,
          targetCustody,
          transaction: recovery.transaction,
          brokerSocketPath: recovery.brokerSocketPath
            || entry.broker_socket_path
            || null,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!committed?.ok) {
          stderr.write(`mc: provider handoff recovery failed (${committed?.code || 'handoff-cursor-commit-failed'}); refusing to launch.\n`);
          return 1;
        }
        entry = committed.entry || entry;
      } else {
        handoff = recovery;
        if (recovery.entry) entry = recovery.entry;
      }
    }
  }
  // An interrupted provider switch owns the logical session before ordinary
  // managed-generation reconciliation. Commit/recover that transaction first
  // so a live target generation is never attached while the registry still
  // names the source provider.
  if (!opts.json && !opts.noLaunch && process.env.MC_TEST_MODE !== '1'
    && localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
    const reconciled = await reconcileManagedOpen(entry, {
      apiArgv: argv,
      env: process.env,
      stdin,
      stdout,
      stderr,
      deps,
    });
    if (!reconciled.ok) return 1;
    if (reconciled.attached) {
      markEntryOpened(entry, {
        upsert: deps.upsertEntry || upsertEntry,
        now: deps.now,
      });
      return reconciled.code ?? 0;
    }
    entry = reconciled.entry;
    managedDecision = {
      ...reconciled.decision,
      localPresence: reconciled.localPresence || null,
    };
  }
  const targetTool = toolValidation.resolved || recoveredTargetTool;
  let firstLaunchInWorktree = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
      ? !hasManagedProviderToolSession(entry)
    : !hasStoredToolSession(entry);
  // Switching a session to a different tool starts a FRESH grounded session
  // in the same worktree: a provider's native transcript can't be handed to
  // another tool, but work continuity lives in the worktree and in server-side
  // continuity keyed by coding_session_id (which we rebind on the fresh start).
  const switchingTool = isToolSwitch(entry, targetTool);
  if (switchingTool && !opts.noLaunch && !opts.json
    && localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
    const ready = await requireManagedSwitchTarget({
      targetTool,
      stderr,
      deps,
    });
    if (!ready) return 1;
  }
  if (switchingTool) {
    firstLaunchInWorktree = !providerSessionFor(
      entry,
      targetTool?.id,
    )?.session_id;
  }

  let switchLocalPresence = null;
  if (!opts.json && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    let localPresence = recoveryLocalPresence || { verdict: 'unknown' };
    const inspectLocal = deps.inspectLocalBrokerSessionForEntry
      || inspectLocalBrokerSessionForEntry;
    // A tool switch never reattaches the OLD tool's live local PTY — that
    // would silently reopen the previous provider instead of switching.
    if (!switchingTool) {
      if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
        localPresence = managedDecision?.localPresence
          || (managedDecision?.action === 'resume'
            ? {
                verdict: 'exited',
                runtime_generation: managedDecision.runtimeGeneration,
              }
            : { verdict: 'unknown' });
      } else {
        const attachLocal = deps.attachLiveBrokerSession || attachLiveBrokerSession;
        const attached = await attachLocal(entry, {
          stdin,
          stdout,
          stderr,
          request: deps.requestBroker || requestBroker,
          attach: deps.attachBrokerSession || attachBrokerSession,
          apiArgv: argv,
          env: process.env,
          deps,
        });
        localPresence = attached?.localPresence || localPresence;
        if (attached?.attached) {
          markEntryOpened(entry, {
            upsert: deps.upsertEntry || upsertEntry,
            now: deps.now,
          });
          return attached.code ?? 0;
        }
      }
    } else {
      // A running TUI cannot switch tool in place: a live LOCAL PTY refuses
      // the switch with the exact way out.
      localPresence = await inspectLocal(
        entry, { request: deps.requestBroker || requestBroker, deps },
      );
      switchLocalPresence = localPresence;
      if (localPresence.verdict === 'live') {
        const liveTool = sourceForBrokerTool(localPresence.session?.tool);
        if (liveTool !== targetTool?.id) {
          stderr.write(`mc: "${entry.name}" is running here — exit it (Ctrl+D) or \`mc end ${entry.name}\` before switching tools.\n`);
          return 1;
        }
        handoff = await (deps.prepareProviderSwitch || prepareProviderSwitch)({
          entry,
          targetTool,
          targetCustody,
          localPresence,
          apiArgv: argv,
          env: process.env,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!handoff?.ok || !handoff.recoveredDelivery) {
          stderr.write(`mc: provider handoff recovery failed (${handoff?.code || 'handoff-recovery-unavailable'}); refusing to attach.\n`);
          const remedy = handoffRecoveryRemedy(handoff);
          if (remedy) stderr.write(remedy);
          return 1;
        }
        const committed = await (deps.commitProviderSwitchDelivery
          || commitProviderSwitchDelivery)({
          entry,
          targetTool,
          targetCustody,
          transaction: handoff.transaction,
          brokerSocketPath: localPresence.session?.broker_socket_path || null,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!committed?.ok) {
          stderr.write(`mc: provider handoff recovery failed (${committed?.code || 'handoff-cursor-commit-failed'}); refusing to attach.\n`);
          return 1;
        }
        entry = committed.entry || entry;
        const attached = await (deps.attachLiveBrokerSession || attachLiveBrokerSession)(
          entry,
          {
            stdin,
            stdout,
            stderr,
            request: deps.requestBroker || requestBroker,
            attach: deps.attachBrokerSession || attachBrokerSession,
            apiArgv: argv,
            env: process.env,
            deps,
          },
        );
        return attached?.attached ? attached.code ?? 0 : 1;
      }
    }

    // A server-active record may only be bypassed with positive local proof
    // that the exact runtime generation exited. Hostname equality is not
    // proof: a temporarily unreachable local broker may still own a live PTY.
    const activeCheck = await activeMatchForEntry(entry, { argv, deps });
    if (!activeCheck.ok && hasStoredToolSession(entry)) {
      stderr.write(`mc: cannot verify whether "${entry.name}" is active on another source; refusing to start a duplicate.\n`);
      return 1;
    }
    let active = activeCheck.session;
    if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
      && active
      && localPresence.verdict === 'exited'
      && nonEmpty(localPresence.runtime_generation)
      && (
        !nonEmpty(active.runtime_generation)
        || nonEmpty(active.runtime_generation) === nonEmpty(localPresence.runtime_generation)
      )) {
      const repair = await (deps.repairExitedSessionPresence
        || repairExitedSessionPresence)({
        active,
        runtimeGeneration: nonEmpty(localPresence.runtime_generation),
        argv,
        deps: deps.sessionPresenceDeps || deps,
      });
      if (repair?.ok) {
        const refreshed = await refreshActiveAfterPresenceRepair(entry, {
          argv,
          deps,
        });
        if (refreshed.ok) active = refreshed.session;
      }
    }
    const exitedGenerationMatches = active
      && localPresence.verdict === 'exited'
      && nonEmpty(active.runtime_generation)
      && nonEmpty(active.runtime_generation) === nonEmpty(localPresence.runtime_generation);
    if (active && !exitedGenerationMatches) {
      markEntryOpened(entry, {
        upsert: deps.upsertEntry || upsertEntry,
        now: deps.now,
      });
      stdout.write(renderActiveSelectionMessage(active));
      return 0;
    }
    if (!active && localPresence.verdict === 'unreachable') {
      stderr.write(renderUnreachableLocalRuntime(entry));
      return 1;
    }
  }

  if (switchingTool && !opts.json && !opts.noLaunch
    && process.env.MC_TEST_MODE !== '1'
    && shouldRunProviderSwitchBoundary(deps)
    && !handoff) {
    handoff = await (deps.prepareProviderSwitch || prepareProviderSwitch)({
      entry,
      targetTool,
      targetCustody,
      localPresence: switchLocalPresence,
      apiArgv: argv,
      env: process.env,
      deps: deps.providerSwitchDeps || deps,
    });
    if (!handoff?.ok || handoff.recoveredDelivery) {
      stderr.write(`mc: provider handoff failed (${handoff?.code || 'handoff-recovery-required'}); target provider was not started.\n`);
      return 1;
    }
    if (handoff.entry) entry = handoff.entry;
  }

  if (opts.tool || handoff?.transaction) {
    if (switchingTool) {
      const switched = applyToolSwitch(entry, targetTool, {
        targetCustody,
        upsert: handoff?.transaction
          ? (patch) => ({ ...entry, ...patch })
          : deps.upsertEntry || upsertEntry,
      });
      if (switched?.error) {
        stderr.write(`mc: provider session state is invalid (${switched.error}); refusing to launch.\n`);
        return 1;
      }
      entry = switched;
    } else {
      const res = applyToolOverride(entry, opts.tool, {
        upsert: deps.upsertEntry || upsertEntry,
        resolved: targetTool,
      });
      if (res.error) {
        stderr.write(`mc: ${res.error}\n`);
        return 2;
      }
      entry = res.entry;
    }
  }

  if (!opts.json) {
    entry = markEntryOpened(entry, {
      upsert: deps.upsertEntry || upsertEntry,
      now: deps.now,
    });
  }

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }

  if (opts.json) {
    stdout.write(JSON.stringify({
      name: entry.name,
      session_id: entry.session_id || null,
      repository_id: entry.repository_id || null,
      tool: entry.tool || DEFAULT_TOOL,
      worktree_path: entry.worktree_path || null,
      coding_session_id: entry.coding_session_id || null,
      tool_session_id: entry.tool_session_id || null,
      tool_session_source: entry.tool_session_source || null,
      tool_transcript_path: entry.tool_transcript_path || null,
      current_branch: entry.current_branch || null,
      original_branch: entry.original_branch || entry.branch || null,
      observed_head: entry.observed_head || null,
      last_observed_at: entry.last_observed_at || null,
    }, null, 2) + '\n');
    return 0;
  }

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // Broker-owned process model: resume starts through the broker and the
  // local terminal attaches as a client. Closing this terminal detaches
  // without killing the LLM session.
  const launch = firstLaunchInWorktree
    ? freshLaunchDependency(deps)
    : (deps.launchResumeSession || launchResumeSession);
  return launch({
    entry,
    apiArgv: argv,
    stderr,
    env: process.env,
    localAuthMode,
    handoff,
  });
}

export async function launchResumeSession({
  entry,
  apiArgv = [],
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  stderr = process.stderr,
  handoff = null,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }
  const targetCustody = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? 'managed'
    : 'native';

  const launchTool = resolveToolInput(entry?.tool || DEFAULT_TOOL);
  await materialiseVaultForLaunch({ entry, launchTool, localAuthMode, stderr, deps });

  const toolSession = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? storedManagedToolSession(entry, launchTool)
    : await (deps.resolveToolSessionForResume || resolveToolSessionForResume)({
        entry,
        launchTool,
        deps: deps.toolSessionDeps || deps,
      });
  if (!toolSession?.ok) {
    if (isProviderSessionStateFailure(toolSession?.reason)) {
      stderr.write(`mc: provider session state is invalid (${toolSession.reason}); refusing to launch.\n`);
      return 1;
    }
    // Reaching the resume path means this provider has already launched for
    // the mc session. Missing native state is continuity loss, not permission
    // to create a replacement provider conversation under the same identity.
    stderr.write(`mc: no ${launchTool?.shortName || 'provider'}-native session to resume for "${entry.name}" — refusing to create a replacement session.\n`);
    return 1;
  }
  const providerPatch = withProviderSession(entry, toolSession.source, {
    session_id: toolSession.sessionId,
    transcript_path: toolSession.transcriptPath || null,
  });
  if (!providerPatch.ok) {
    stderr.write(`mc: provider session state is invalid (${providerPatch.reason}); refusing to launch.\n`);
    return 1;
  }
  const resumeArgv = buildNativeResumeArgv({
    entry,
    launchTool,
    sessionId: toolSession.sessionId,
  });
  if (!resumeArgv.ok) {
    stderr.write(renderUnsupportedNativeResume(entry, resumeArgv));
    return 1;
  }

  const launch = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const result = await launch({
    ...buildResumeSessionLaunchIntent({
      entry,
      launchTool,
      resumeArgv: resumeArgv.argv,
      apiArgv,
      env,
      localAuthMode,
      handoffUserMessage: handoff?.message || null,
      handoffTransaction: handoff?.transaction || null,
    }),
    stderr,
    onAllocated: ({ codingSessionId }) => {
      try {
        (deps.upsertEntry || upsertEntry)({
          name: entry.name,
          ...entryRegistryIdentity(entry),
          coding_session_id: codingSessionId,
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'session-identity-commit-failed' };
      }
    },
    onLaunched: async ({
      codingSessionId,
      brokerSocketPath = null,
      hostKind = null,
      sessionControllerCapability = null,
    }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      let currentEntry = findCurrentEntry(entry, deps);
      if (handoff?.transaction) {
        const completed = await (deps.commitProviderSwitchDelivery
          || commitProviderSwitchDelivery)({
          entry: currentEntry,
          targetTool: launchTool,
          transaction: handoff.transaction,
          targetCustody,
          sessionControllerCapability,
          brokerSocketPath,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!completed?.ok) return completed;
        currentEntry = completed.entry || currentEntry;
      }
      const currentProviderPatch = withProviderSession(currentEntry, toolSession.source, {
        session_id: toolSession.sessionId,
        transcript_path: toolSession.transcriptPath || null,
      });
      if (!currentProviderPatch.ok) {
        return { ok: false, code: currentProviderPatch.reason };
      }
      const patch = {
        name: entry.name,
        ...entryRegistryIdentity(entry),
        coding_session_id: codingSessionId,
        session_state: 'live',
        tool_session_id: toolSession.sessionId,
        tool_session_source: toolSession.source,
        tool_transcript_path: toolSession.transcriptPath || null,
        ...(localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
          ? {
              tool_session_provider_adapter: entry.tool_session_provider_adapter,
              tool_session_provider_generation: entry.tool_session_provider_generation,
            }
          : {}),
      };
      // Keep the prior proven generation until SessionStart evidence for this
      // exact runtime has been committed by the broker.
      patch.provider_sessions = currentProviderPatch.providerSessions;
      if (brokerSocketPath) patch.broker_socket_path = brokerSocketPath;
      if (hostKind) patch.host_kind = hostKind;
      upsert(patch);
      return { ok: true };
    },
    onExited: ({ providerArtifact = null }) => {
      commitProviderArtifact({
        entry: findCurrentEntry(entry, deps),
        expectedTool: launchTool?.id,
        providerArtifact,
        localAuthMode,
        upsert: deps.upsertEntry || upsertEntry,
      });
    },
    deps: deps.launchDeps || {},
  });
  if (typeof result === 'number') return result;
  return result?.code ?? 0;
}

export async function launchFreshSession({
  entry,
  apiArgv = [],
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  stderr = process.stderr,
  handoff = null,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }
  const targetCustody = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? 'managed'
    : 'native';

  const launchTool = resolveToolInput(entry?.tool || DEFAULT_TOOL);
  await materialiseVaultForLaunch({ entry, launchTool, localAuthMode, stderr, deps });

  const launch = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const result = await launch({
    ...buildNewSessionLaunchIntent({
      entry,
      worktreePath: entry.worktree_path,
      focus: freshLaunchFocus(entry),
      launchTool,
      // Preserve an existing coding_session_id so a fresh launch (e.g. after
      // a tool switch) stays on the same Memoro coding session; null for a
      // genuinely first launch lets the launcher mint one.
      codingSessionId: entry.coding_session_id || null,
      apiArgv,
      env,
      localAuthMode,
      handoffUserMessage: handoff?.message || null,
      handoffTransaction: handoff?.transaction || null,
    }),
    stderr,
    onAllocated: ({ codingSessionId }) => {
      try {
        (deps.upsertEntry || upsertEntry)({
          name: entry.name,
          ...entryRegistryIdentity(entry),
          coding_session_id: codingSessionId,
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'session-identity-commit-failed' };
      }
    },
    onLaunched: async ({
      codingSessionId,
      brokerSocketPath = null,
      hostKind = null,
      sessionControllerCapability = null,
    }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      let currentEntry = findCurrentEntry(entry, deps);
      if (handoff?.transaction) {
        const completed = await (deps.commitProviderSwitchDelivery
          || commitProviderSwitchDelivery)({
          entry: currentEntry,
          targetTool: launchTool,
          transaction: handoff.transaction,
          targetCustody,
          sessionControllerCapability,
          brokerSocketPath,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!completed?.ok) return completed;
        currentEntry = completed.entry || currentEntry;
      }
      const patch = {
        name: entry.name,
        ...entryRegistryIdentity(entry),
        coding_session_id: codingSessionId,
        session_state: 'live',
      };
      if (brokerSocketPath) patch.broker_socket_path = brokerSocketPath;
      if (hostKind) patch.host_kind = hostKind;
      upsert(patch);
      return { ok: true };
    },
    onExited: ({ providerArtifact = null }) => {
      commitProviderArtifact({
        entry: findCurrentEntry(entry, deps),
        expectedTool: launchTool?.id,
        providerArtifact,
        localAuthMode,
        upsert: deps.upsertEntry || upsertEntry,
      });
    },
    deps: deps.launchDeps || {},
  });
  if (typeof result === 'number') return result;
  return result?.code ?? 0;
}

function commitProviderArtifact({
  entry,
  expectedTool,
  providerArtifact,
  localAuthMode,
  upsert,
} = {}) {
  if (!providerArtifact || !expectedTool || providerArtifact.tool !== expectedTool) return false;
  const managed = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE;
  if (!managed && localAuthMode !== LOCAL_AUTH_MODES.NATIVE) return false;
  const managedAdapter = managed
    ? managedProviderAdapterForTool(providerArtifact.tool)
    : null;
  if (managed && !managedAdapter) return false;
  const providerPatch = withProviderSession(entry, providerArtifact.tool, {
    session_id: providerArtifact.provider_session_id,
    transcript_path: managed ? null : providerArtifact.transcript_path,
    runtime_generation: providerArtifact.runtime_generation,
  });
  if (!providerPatch.ok) return false;
  upsert({
    name: entry.name,
    ...entryRegistryIdentity(entry),
    tool_session_id: providerArtifact.provider_session_id,
    tool_session_source: providerArtifact.tool,
    tool_transcript_path: managed ? null : providerArtifact.transcript_path,
    ...(managed
      ? {
          tool_session_provider_adapter: managedAdapter.provider_adapter_id,
          tool_session_provider_generation: providerArtifact.runtime_generation,
        }
      : {}),
    provider_sessions: providerPatch.providerSessions,
  });
  return true;
}

async function materialiseVaultForLaunch({
  entry,
  launchTool,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  stderr = process.stderr,
  deps = {},
} = {}) {
  if (localAuthMode !== LOCAL_AUTH_MODES.NATIVE) return;
  const materialise = deps.materialiseVaultBeforeLaunch
    || (await import('../vault/startup.js')).materialiseVaultBeforeLaunch;

  try {
    const res = await materialise({
      sessionId: entry.legacy_session_key || entry.session_id || entry.name,
      worktreePath: entry.worktree_path || undefined,
      adapters: launchTool?.adapter ? [launchTool.adapter] : undefined,
    });
    if (!res.ok && res.hint) {
      stderr.write(`mc: ${res.hint}\n`);
    }
  } catch (err) {
    stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }
}

export function parseArgs(argv) {
  const opts = {
    name: null,
    tool: null,
    noLaunch: false,
    json: false,
    // Named lifecycle launches use managed custody by default. Keep accepting
    // --managed-portable as a no-op compatibility spelling for older scripts.
    // `--native` is the explicit opt-out: the user chooses the weaker
    // container deliberately; no failed gate may ever select it for them.
    managedPortable: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--managed-portable') { opts.managedPortable = true; continue; }
    if (a === '--native') { opts.managedPortable = false; continue; }
    if (a === '--tool') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { error: '--tool requires a value' };
      opts.tool = next;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_SUGAR, a)) {
      if (opts.tool && opts.tool !== TOOL_SUGAR[a]) {
        return { error: `conflicting tool flags: --tool ${opts.tool} and ${a}` };
      }
      opts.tool = TOOL_SUGAR[a];
      continue;
    }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}

export function resumableEntries(reg = readRegistry()) {
  const entries = Array.isArray(reg?.entries) ? reg.entries : [];
  return entries
    .filter((e) => e && typeof e.name === 'string' && e.name)
    .map((e) => ({
      name: e.name,
      session_id: e.session_id || null,
      repository_id: e.repository_id || null,
      repository_identity: e.repository_identity || null,
      branch: e.branch || '',
      tool: e.tool || DEFAULT_TOOL,
      session_state: e.session_state || 'no-session-yet',
      worktree_path: e.worktree_path || null,
      kind: e.kind || 'work',
      label: e.label || null,
      focus: e.focus || null,
      coding_session_id: e.coding_session_id || null,
      repo_slug: e.repo_slug || null,
      original_branch: e.original_branch || e.branch || null,
      current_branch: e.current_branch || null,
      observed_head: e.observed_head || null,
      last_observed_at: e.last_observed_at || null,
    }))
    .sort((a, b) => (
      a.name.localeCompare(b.name)
      || String(a.repository_id || '').localeCompare(String(b.repository_id || ''))
    ));
}

export async function runResumePicker({
  opts,
  argv = [],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  emitDirectives = false,
  commandName = 'resume',
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }
  const loadRegistry = deps.readRegistry || readRegistry;
  const fetchActive = deps.fetchActiveSessions || ((args) => fetchActiveCodingSessions({ argv: args }));
  const launch = deps.launchResumeSession || launchResumeSession;
  const freshLaunch = freshLaunchDependency(deps);
  const attachLive = deps.attachLiveBrokerSession || attachLiveBrokerSession;
  const upsert = deps.upsertEntry || upsertEntry;
  const toolValidation = validateToolFlag(opts.tool);
  if (toolValidation.error) {
    stderr.write(`mc: ${toolValidation.error}\n`);
    return 2;
  }
  // Same truth check as `mc list`: never offer a dead session as live.
  const liveIds = await fetchLiveLocalSessionIds({ deps });
  const entries = resumableEntries(loadRegistry())
    .map((e) => normalizeEntryTruth(e, liveIds, { withVerdict: false }));
  const demoted = countStaleDemotions(entries);
  if (demoted > 0) stderr.write(staleDemotionHint(demoted));

  if (opts.json) {
    stdout.write(JSON.stringify({
      entries,
      hint: `Run \`mc ${commandName} <name>\` to open a session. Tool flags cannot switch provider for an existing provider session.`,
    }, null, 2) + '\n');
    return 0;
  }

  const activeRes = await fetchActive(argv);
  if (activeRes?.warning) stderr.write(`mc: ${activeRes.warning}\n`);
  const view = buildSessionListView({
    activeSessions: activeRes?.sessions || [],
    localEntries: entries,
  });
  stdout.write(renderSessionListHuman({
    view,
    title: `mc sessions available to ${commandName}:`,
    emptyLocalHint: 'Create one with `mc new <name> [focus] --codex`.',
    isTTY: stdout?.isTTY === true,
    terminalWidth: stdout?.columns,
    useColor: stdout?.isTTY === true
      && (deps.env || process.env)?.TERM !== 'dumb'
      && !Object.hasOwn(deps.env || process.env, 'NO_COLOR'),
  }));

  const choices = listChoices(view);
  if (choices.length === 0) return 0;

  const isInteractive = deps.isTTY ?? (stdin?.isTTY && stdout?.isTTY);
  if (!isInteractive) {
    const toolHint = opts.tool
      ? `mc ${commandName} <name> --${opts.tool === 'claude' ? 'claude' : opts.tool}`
      : `mc ${commandName} <name>`;
    stdout.write(`Run \`${toolHint}\` to open a local session.\n`);
    return 0;
  }

  const answer = await promptForChoice({ stdin, stdout, deps });
  const parsed = parseNumberedChoice(answer, choices);
  if (parsed.error) {
    stderr.write(`mc: ${parsed.error}\n`);
    return 2;
  }
  return resumeSelectedChoice(parsed.choice, {
    opts,
    apiArgv: argv,
    localAuthMode,
    emitDirectives,
    stdin,
    stdout,
    stderr,
    launchResumeSession: launch,
    launchFreshSession: freshLaunch,
    attachLiveBrokerSession: attachLive,
    upsertEntry: upsert,
    resolvedTool: toolValidation.resolved,
    activePresenceVerified: activeRes?.ok === true,
    deps,
  });
}

export async function resumeSelectedChoice(choice, {
  opts = {},
  apiArgv = [],
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  emitDirectives = false,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  launchResumeSession: launch = launchResumeSession,
  launchFreshSession: freshLaunchOverride,
  attachLiveBrokerSession: attachLive = attachLiveBrokerSession,
  upsertEntry: upsert = upsertEntry,
  resolvedTool = null,
  activePresenceVerified = true,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }
  const targetCustody = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? 'managed'
    : 'native';

  if (!choice) return 2;
  if (choice.type === 'active') {
    if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
      const reconciled = await reconcileManagedOpen({
        ...choice,
        name: choice.label || choice.name || null,
        coding_session_id: choice.coding_session_id || choice.id || null,
      }, {
        apiArgv,
        env,
        stdin,
        stdout,
        stderr,
        attachLive,
        upsert,
        deps,
      });
      if (!reconciled.ok) return 1;
      if (reconciled.attached) return reconciled.code ?? 0;
      stderr.write('mc: active managed session could not be bound to its exact local runtime.\n');
      return 1;
    }
    const attached = await attachLive({
      name: choice.label || choice.name || null,
      coding_session_id: choice.coding_session_id || choice.id || null,
    }, {
      stdin,
      stdout,
      stderr,
      apiArgv,
      env,
      deps,
    });
    if (attached?.attached) return attached.code ?? 0;
    stdout.write(renderActiveSelectionMessage(choice));
    return 0;
  }

  let entry = maybeObserveEntry(choice, deps);
  const backfillDeps = {
    ...deps,
    ...(hasInjectedPickerRuntime({ launch, freshLaunchOverride, attachLive, upsert }) ? { __injectedRuntime: true } : {}),
  };
  entry = await maybeBackfillToolSession(entry, {
    localAuthMode,
    upsert,
    deps: backfillDeps,
  });
  let managedDecision = null;
  let handoff = null;
  let effectiveTargetTool = resolvedTool;
  let recoveryLocalPresence = null;
  if (!opts.noLaunch && process.env.MC_TEST_MODE !== '1'
    && shouldRunProviderSwitchBoundary(backfillDeps)) {
    recoveryLocalPresence = await (
      deps.inspectLocalBrokerSessionForEntry || inspectLocalBrokerSessionForEntry
    )(entry, { request: deps.requestBroker || requestBroker, deps });
    const recovery = await (deps.recoverProviderSwitch || recoverProviderSwitch)({
      entry,
      targetTool: resolvedTool,
      targetCustody,
      localPresence: recoveryLocalPresence,
      apiArgv,
      env,
      deps: deps.providerSwitchDeps || deps,
    });
    if (!recovery?.ok) {
      stderr.write(`mc: provider handoff recovery failed (${recovery?.code || 'handoff-recovery-unavailable'}); refusing to launch.\n`);
      const remedy = handoffRecoveryRemedy(recovery);
      if (remedy) stderr.write(remedy);
      return 1;
    }
    if (recovery.active) {
      effectiveTargetTool = recovery.targetTool;
      if (recovery.recoveredDelivery) {
        const committed = await (deps.commitProviderSwitchDelivery
          || commitProviderSwitchDelivery)({
          entry,
          targetTool: recovery.targetTool,
          transaction: recovery.transaction,
          targetCustody,
          brokerSocketPath: recovery.brokerSocketPath
            || entry.broker_socket_path
            || null,
          deps: deps.providerSwitchDeps || deps,
        });
        if (!committed?.ok) {
          stderr.write(`mc: provider handoff recovery failed (${committed?.code || 'handoff-cursor-commit-failed'}); refusing to launch.\n`);
          return 1;
        }
        entry = committed.entry || entry;
      } else {
        handoff = recovery;
        if (recovery.entry) entry = recovery.entry;
      }
    }
  }
  if (!opts.noLaunch && process.env.MC_TEST_MODE !== '1'
    && localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
    const reconciled = await reconcileManagedOpen(entry, {
      apiArgv,
      env,
      stdin,
      stdout,
      stderr,
      attachLive,
      upsert,
      deps,
    });
    if (!reconciled.ok) return 1;
    if (reconciled.attached) {
      markEntryOpened(entry, { upsert, now: deps.now });
      return reconciled.code ?? 0;
    }
    entry = reconciled.entry;
    managedDecision = reconciled.decision;
  }
  const switchingTool = isToolSwitch(entry, effectiveTargetTool);
  if (switchingTool && !opts.noLaunch
    && localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
    const ready = await requireManagedSwitchTarget({
      targetTool: effectiveTargetTool,
      stderr,
      deps,
    });
    if (!ready) return 1;
  }
  const firstLaunchInWorktree = switchingTool
    ? !providerSessionFor(entry, effectiveTargetTool?.id)?.session_id
    : entry.session_state === 'no-session-yet'
      && (
        localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
          ? !hasManagedProviderToolSession(entry)
          : !hasStoredToolSession(entry)
      );
  const freshLaunch = freshLaunchDependency({
    launchFreshSession: freshLaunchOverride,
  });
  let localPresence = recoveryLocalPresence || { verdict: 'unknown' };
  if (!switchingTool && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
      localPresence = managedDecision?.localPresence
        || (managedDecision?.action === 'resume'
          ? {
              verdict: 'exited',
              runtime_generation: managedDecision.runtimeGeneration,
            }
          : { verdict: 'unknown' });
    } else {
      const attached = await attachLive(entry, { stdin, stdout, stderr, deps });
      localPresence = attached?.localPresence || localPresence;
      if (attached?.attached) {
        markEntryOpened(entry, {
          upsert,
          now: deps.now,
        });
        return attached.code ?? 0;
      }
    }
    if (localPresence.verdict === 'unreachable') {
      stderr.write(renderUnreachableLocalRuntime(entry));
      return 1;
    }
    if (!activePresenceVerified && hasStoredToolSession(entry)) {
      stderr.write(`mc: cannot verify whether "${entry.name}" is active on another source; refusing to start a duplicate.\n`);
      return 1;
    }
  }
  if (switchingTool && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    localPresence = await (
      deps.inspectLocalBrokerSessionForEntry || inspectLocalBrokerSessionForEntry
    )(entry, { request: deps.requestBroker || requestBroker, deps });
    if (localPresence.verdict === 'live') {
      stderr.write(`mc: "${entry.name}" is running here — exit it (Ctrl+D) or \`mc end ${entry.name}\` before switching tools.\n`);
      return 1;
    }
    if (localPresence.verdict === 'unreachable') {
      stderr.write(renderUnreachableLocalRuntime(entry));
      return 1;
    }
    if (!activePresenceVerified && hasStoredToolSession(entry)) {
      stderr.write(`mc: cannot verify whether "${entry.name}" is active on another source; refusing to start a duplicate.\n`);
      return 1;
    }
  }

  if (switchingTool && !opts.noLaunch && process.env.MC_TEST_MODE !== '1'
    && shouldRunProviderSwitchBoundary(backfillDeps) && !handoff) {
    handoff = await (deps.prepareProviderSwitch || prepareProviderSwitch)({
      entry,
      targetTool: effectiveTargetTool,
      targetCustody,
      localPresence,
      apiArgv,
      env,
      deps: deps.providerSwitchDeps || deps,
    });
    if (!handoff?.ok || handoff.recoveredDelivery) {
      stderr.write(`mc: provider handoff failed (${handoff?.code || 'handoff-recovery-required'}); target provider was not started.\n`);
      return 1;
    }
    if (handoff.entry) entry = handoff.entry;
  }

  if (opts.tool || handoff?.transaction) {
    if (switchingTool) {
      const switched = applyToolSwitch(entry, effectiveTargetTool, {
        targetCustody,
        upsert: handoff?.transaction
          ? (patch) => ({ ...entry, ...patch })
          : upsert,
      });
      if (switched?.error) {
        stderr.write(`mc: provider session state is invalid (${switched.error}); refusing to launch.\n`);
        return 1;
      }
      entry = switched;
    } else {
      const res = applyToolOverride(entry, opts.tool, {
        upsert,
        resolved: effectiveTargetTool,
      });
      if (res.error) {
        stderr.write(`mc: ${res.error}\n`);
        return 2;
      }
      entry = res.entry;
    }
  }

  entry = markEntryOpened(entry, {
    upsert,
    now: deps.now,
  });

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }
  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') return 0;
  const launchOptions = {
    entry,
    apiArgv,
    env,
    localAuthMode,
    stderr,
    handoff,
  };
  return firstLaunchInWorktree ? freshLaunch(launchOptions) : launch(launchOptions);
}

async function reconcileManagedOpen(entry, {
  apiArgv = [],
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  attachLive = null,
  upsert = null,
  deps = {},
} = {}) {
  const inspectIdentity = deps.inspectManagedSessionIdentity
    || inspectManagedSessionIdentitySync;
  const identity = inspectIdentity({
    sessionName: entry.name,
    registrySessionId: entry.session_id || null,
    legacySessionKey: entry.legacy_session_key || null,
  });
  if (identity?.kind === 'unknown') {
    stderr.write(`mc: managed session identity is unavailable (${identity.reason || 'unknown'}); refusing to launch.\n`);
    return { ok: false, decision: null };
  }
  if (identity?.kind === 'present') {
    const durableId = identity.identity.coding_session_id;
    if (entry.coding_session_id && entry.coding_session_id !== durableId) {
      stderr.write('mc: managed session identity conflicts with the registry; refusing to launch.\n');
      return { ok: false, decision: null };
    }
    if (!entry.coding_session_id) {
      const writeEntry = upsert || deps.upsertEntry || upsertEntry;
      try {
        const written = writeEntry({
          name: entry.name,
          ...entryRegistryIdentity(entry),
          coding_session_id: durableId,
        });
        entry = { ...entry, coding_session_id: durableId, ...(written || {}) };
      } catch {
        stderr.write('mc: managed session identity could not be projected into the registry; refusing to launch.\n');
        return { ok: false, decision: null };
      }
    }
  }
  const inspectLocal = deps.inspectLocalBrokerSessionForEntry
    || inspectLocalBrokerSessionForEntry;
  const localPresence = await inspectLocal(entry, {
    request: deps.requestBroker || requestBroker,
    deps,
  });
  if (localPresence?.verdict === 'live'
    && (
      typeof deps.importLegacyNativeProviderSession === 'function'
      || !hasInjectedRuntimeDeps(deps)
    )) {
    const liveCutover = (deps.importLegacyNativeProviderSession
      || importLegacyNativeCodexSession)({
      entry,
      deps: deps.managedNativeImportDeps || deps,
    });
    if (liveCutover?.imported && liveCutover.repaired_cutover === true) {
      const decision = {
        ok: false,
        action: 'blocked',
        reason: 'managed-cutover-fresh-runtime-still-live',
        localPresence,
      };
      stderr.write('mc: an incorrect fresh cutover runtime is still live; exit that Codex session before reopening the preserved provider session.\n');
      return { ok: false, decision };
    }
  }
  if (localPresence?.verdict !== 'live') {
    const toolId = resolveToolInput(entry?.tool || DEFAULT_TOOL)?.id || null;
    const imported = await (deps.importManagedProviderRecovery
      || importManagedProviderRecovery)({
      tool: toolId,
      entry,
      localPresence,
      registry: { entries: [entry] },
      deps: deps.managedLegacyImportDeps || deps,
    });
    if (imported?.attempted && !imported.ok) {
      const reason = imported.reason || 'managed-recovery-import-failed';
      stderr.write(`mc: managed legacy generation import failed (${reason}); refusing to launch.\n`);
      return { ok: false, decision: null };
    }
    const shouldImportNative = !imported?.attempted
      && (
        typeof deps.importLegacyNativeProviderSession === 'function'
        || !hasInjectedRuntimeDeps(deps)
      );
    if (shouldImportNative) {
      const importNative = deps.importLegacyNativeProviderSession
        || importLegacyNativeCodexSession;
      let nativeImport = importNative({
        entry,
        deps: deps.managedNativeImportDeps || deps,
      });
      if (!nativeImport?.attempted
        && nativeImport?.reason === 'managed-native-import-provider-id-missing'
        && new Set(['idle', 'live', 'dead']).has(entry?.session_state)) {
        const continuity = await discoverManagedNativeContinuityEntry({
          entry,
          tool: toolId,
          deps,
        });
        if (!continuity.ok) {
          stderr.write(`mc: managed provider continuity discovery failed (${continuity.reason}); refusing to launch.\n`);
          return { ok: false, decision: null };
        }
        if (continuity.discovered) {
          nativeImport = importNative({
            entry: continuity.entry,
            deps: deps.managedNativeImportDeps || deps,
          });
        }
      }
      if (nativeImport?.attempted && !nativeImport.ok) {
        const reason = nativeImport.reason || 'managed-native-import-failed';
        stderr.write(`mc: managed provider continuity import failed (${reason}); refusing to launch.\n`);
        return { ok: false, decision: null };
      }
      if (nativeImport?.imported) {
        const decision = {
          ok: true,
          action: 'resume',
          tool: toolId,
          providerSessionId: nativeImport.provider_session_id,
          runtimeGeneration: nativeImport.runtime_generation,
          localPresence,
          repairedCutover: nativeImport.repaired_cutover === true,
        };
        return projectManagedResumeDecision({
          entry,
          decision,
          localPresence,
          upsert,
          deps,
          stderr,
        });
      }
    }
  }
  const decision = await (deps.reconcileManagedSession || reconcileManagedSession)({
    entry,
    inspectLocalPresence: () => localPresence,
    deps: deps.managedReconcilerDeps || deps,
  });
  if (!decision?.ok || decision.action === 'blocked') {
    const reason = decision?.reason || 'managed-session-reconciliation-failed';
    stderr.write(`mc: managed session reconciliation is blocked (${reason}); refusing to start a duplicate provider session.\n`);
    return { ok: false, decision };
  }
  if (decision.action === 'attach') {
    const attach = attachLive || deps.attachLiveBrokerSession || attachLiveBrokerSession;
    const attached = await attach(entry, {
      stdin,
      stdout,
      stderr,
      request: deps.requestBroker || requestBroker,
      attach: deps.attachBrokerSession || attachBrokerSession,
      apiArgv,
      env,
      deps,
    });
    if (!attached?.attached) {
      stderr.write('mc: the exact managed runtime was live but could not be attached; refusing to relaunch it.\n');
      return { ok: false, decision };
    }
    return {
      ok: true,
      attached: true,
      code: attached.code ?? 0,
      entry,
      decision,
      localPresence,
    };
  }
  if (decision.action !== 'resume') {
    return {
      ok: true,
      attached: false,
      entry,
      decision,
      localPresence,
    };
  }

  return projectManagedResumeDecision({
    entry,
    decision,
    localPresence,
    upsert,
    deps,
    stderr,
  });
}

async function discoverManagedNativeContinuityEntry({
  entry,
  tool,
  deps = {},
} = {}) {
  if (tool !== 'codex') return { ok: true, entry, discovered: false };
  const existing = providerSessionFor(entry, tool)?.session_id
    || exactNonEmpty(entry?.tool_session_id);
  if (existing) return { ok: true, entry, discovered: false };

  const resolver = deps.resolveToolSessionForResume || resolveToolSessionForResume;
  let resolved;
  try {
    resolved = await resolver({
      entry,
      launchTool: resolveToolInput(tool),
      deps: deps.toolSessionDeps || deps,
    });
  } catch {
    return {
      ok: false,
      reason: 'managed-native-continuity-discovery-unavailable',
    };
  }
  if (!resolved?.ok) {
    return new Set([
      'no-tool-session-id',
      'unknown-tool-source',
    ]).has(resolved?.reason)
      ? { ok: true, entry, discovered: false }
      : {
          ok: false,
          reason: resolved?.reason || 'managed-native-continuity-discovery-failed',
        };
  }

  const providerPatch = withProviderSession(entry, tool, {
    session_id: resolved.sessionId,
    transcript_path: resolved.transcriptPath || null,
  });
  if (!providerPatch.ok) {
    return {
      ok: false,
      reason: providerPatch.reason || 'managed-native-continuity-projection-invalid',
    };
  }
  return {
    ok: true,
    discovered: true,
    entry: {
      ...entry,
      tool_session_id: resolved.sessionId,
      tool_session_source: tool,
      tool_transcript_path: resolved.transcriptPath || null,
      provider_sessions: providerPatch.providerSessions,
    },
  };
}

function projectManagedResumeDecision({
  entry,
  decision,
  localPresence,
  upsert = null,
  deps = {},
  stderr = process.stderr,
} = {}) {
  const tool = decision.tool;
  const adapter = managedProviderAdapterForTool(tool);
  if (!adapter) {
    stderr.write('mc: managed provider adapter is unavailable; refusing to launch.\n');
    return { ok: false, decision };
  }
  const providerPatch = withProviderSession(entry, tool, {
    session_id: decision.providerSessionId,
    transcript_path: null,
    runtime_generation: decision.runtimeGeneration,
  });
  if (!providerPatch.ok) {
    stderr.write(`mc: managed provider projection is invalid (${providerPatch.reason}); refusing to launch.\n`);
    return { ok: false, decision };
  }
  const writeEntry = upsert || deps.upsertEntry || upsertEntry;
  const patch = {
    name: entry.name,
    ...entryRegistryIdentity(entry),
    coding_session_id: entry.coding_session_id,
    session_state: 'idle',
    tool_session_id: decision.providerSessionId,
    tool_session_source: tool,
    tool_transcript_path: null,
    tool_session_provider_adapter: adapter.provider_adapter_id,
    tool_session_provider_generation: decision.runtimeGeneration,
    provider_sessions: providerPatch.providerSessions,
  };
  let written;
  try {
    written = writeEntry(patch);
  } catch {
    stderr.write('mc: managed provider projection could not be committed; refusing to launch.\n');
    return { ok: false, decision };
  }
  return {
    ok: true,
    attached: false,
    entry: { ...entry, ...patch, ...(written || {}) },
    decision,
    localPresence,
  };
}

function maybeObserveEntry(entry, deps = {}) {
  const observer = deps.observeEntryWorktree || (!deps.findEntry ? observeEntryWorktree : null);
  if (!observer) return entry;
  try {
    return observer(entry, {
      upsert: deps.upsertEntry || upsertEntry,
    })?.entry || entry;
  } catch {
    return entry;
  }
}

function markEntryOpened(entry, { upsert = upsertEntry, now = () => new Date().toISOString() } = {}) {
  if (!entry?.name) return entry;
  const openedAt = typeof now === 'function' ? now() : new Date().toISOString();
  try {
    upsert({ name: entry.name, ...entryRegistryIdentity(entry), last_opened_at: openedAt });
    return { ...entry, last_opened_at: openedAt };
  } catch {
    return { ...entry, last_opened_at: openedAt };
  }
}

async function maybeBackfillToolSession(entry, {
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  upsert = upsertEntry,
  deps = {},
} = {}) {
  if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) return entry;
  if (!entry?.name || hasProviderToolSession(entry)) return entry;
  const hasInjectedResolver = hasInjectedToolSessionResolver(deps);
  if (process.env.MC_TEST_MODE === '1' && !hasInjectedResolver) return entry;
  if (hasInjectedRuntimeDeps(deps) && !hasInjectedResolver) {
    return entry;
  }
  const launchTool = resolveToolInput(entry?.tool || DEFAULT_TOOL);
  const resolver = deps.resolveToolSessionForResume || resolveToolSessionForResume;
  let resolved = null;
  try {
    resolved = await resolver({
      entry,
      launchTool,
      deps: deps.toolSessionDeps || deps,
    });
  } catch {
    return entry;
  }
  if (!resolved?.ok || !nonEmpty(resolved.sessionId)) return entry;
  const patch = {
    name: entry.name,
    ...entryRegistryIdentity(entry),
    tool_session_id: resolved.sessionId,
    tool_session_source: resolved.source || null,
    tool_transcript_path: resolved.transcriptPath || null,
  };
  const providerPatch = withProviderSession(entry, resolved.source, {
    session_id: resolved.sessionId,
    transcript_path: resolved.transcriptPath || null,
  });
  if (!providerPatch.ok) return entry;
  patch.provider_sessions = providerPatch.providerSessions;
  try {
    const next = upsert(patch);
    return { ...entry, ...patch, ...(next || {}) };
  } catch {
    return { ...entry, ...patch };
  }
}

function storedManagedToolSession(entry, launchTool) {
  const sessionId = exactNonEmpty(entry?.tool_session_id);
  const providerAdapter = exactNonEmpty(entry?.tool_session_provider_adapter);
  const providerGeneration = exactNonEmpty(entry?.tool_session_provider_generation);
  const expectedAdapter = managedProviderAdapterForTool(launchTool?.id);
  if (!sessionId
    || !expectedAdapter
    || providerAdapter !== expectedAdapter.provider_adapter_id
    || !isManagedGeneration(providerGeneration)) {
    return {
      ok: false,
      reason: 'no-managed-provider-session-id',
      source: launchTool?.id || entry?.tool || null,
      sessionId: null,
      transcriptPath: null,
    };
  }
  return {
    ok: true,
    source: launchTool?.id || entry?.tool || null,
    sessionId,
    transcriptPath: null,
    from: 'registry',
  };
}

function hasManagedProviderToolSession(entry) {
  const tool = resolveToolInput(entry?.tool || DEFAULT_TOOL)?.id || null;
  const adapter = managedProviderAdapterForTool(tool);
  return !!(
    adapter
    && exactNonEmpty(entry?.tool_session_id)
    && exactNonEmpty(entry?.tool_session_provider_adapter) === adapter.provider_adapter_id
    && isManagedGeneration(exactNonEmpty(entry?.tool_session_provider_generation))
  );
}

function isManagedGeneration(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value || '');
}

function isProviderSessionStateFailure(reason) {
  return new Set([
    'provider-sessions-invalid',
    'legacy-provider-ambiguous',
    'legacy-provider-invalid',
    'invalid-provider-session',
    'unknown-provider',
  ]).has(reason);
}

function exactNonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function findLiveBrokerSessionForEntry(entry, {
  request = requestBroker,
  deps = {},
} = {}) {
  const presence = await inspectLocalBrokerSessionForEntry(entry, { request, deps });
  return presence.verdict === 'live' ? presence.session : null;
}

export async function inspectLocalBrokerSessionForEntry(entry, {
  request = requestBroker,
  deps = {},
} = {}) {
  const listed = await request({ type: 'sessions' }).catch(() => null);
  const sessions = await (deps.listLocalBrokerAndHostSessions || listLocalBrokerAndHostSessions)({ request })
    .catch(() => listed?.sessions || []);
  const target = selectBrokerSessionForEntry(entry, sessions || listed?.sessions || []);
  if (isLiveBrokerSession(target)) {
    return {
      verdict: 'live',
      session: target,
      runtime_generation: nonEmpty(target.runtime_generation),
    };
  }
  if (isExitedBrokerSession(target)) {
    return {
      verdict: 'exited',
      session: target,
      runtime_generation: nonEmpty(target.runtime_generation),
    };
  }

  const codingSessionId = nonEmpty(entry?.coding_session_id);
  if (!codingSessionId) return { verdict: 'unknown', session: null };
  const paths = (deps.sessionHostPaths || sessionHostPaths)(codingSessionId);
  let lifecycle = null;
  try {
    lifecycle = await (deps.readSessionLifecycle || readSessionLifecycle)({
      path: paths.lifecyclePath,
      codingSessionId,
    });
  } catch {}
  const hostRuntime = await (
    deps.probeSessionHostRuntime || probeSessionHostRuntime
  )(paths, {
    request,
    expectedSessionId: codingSessionId,
  });
  if (lifecycle?.verdict === 'exited') {
    return {
      verdict: 'exited',
      session: null,
      runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
      lifecycle,
      ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
      ...(hostRuntime?.verdict === 'exited'
        ? { reason: hostRuntime.reason || 'host-process-exited' }
        : {}),
    };
  }
  if (lifecycle?.verdict === 'live') {
    if (hostRuntime?.verdict === 'exited') {
      return {
        verdict: 'exited',
        session: null,
        runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
        lifecycle,
        host_runtime: hostRuntime,
        reason: hostRuntime.reason || 'host-process-exited',
      };
    }
    // A live journal with a REACHABLE host that provably does not host the
    // session (e.g. the host was restarted after a machine crash) is positive
    // exit evidence: the host owns this session's socket namespace, so an
    // authoritative empty listing means the recorded runtime is gone.
    if (hostRuntime?.verdict === 'live'
      && hostRuntime.hosts_expected_session === false) {
      return {
        verdict: 'exited',
        session: null,
        runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
        lifecycle,
        host_runtime: hostRuntime,
        reason: 'host-session-absent',
      };
    }
    return {
      verdict: 'unreachable',
      session: null,
      runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
      lifecycle,
      ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
    };
  }
  if (hostRuntime?.verdict === 'exited') {
    return {
      verdict: 'exited',
      session: null,
      runtime_generation: null,
      lifecycle,
      host_runtime: hostRuntime,
      reason: hostRuntime.reason || 'host-process-exited',
    };
  }
  return { verdict: 'unknown', session: null, lifecycle };
}

export async function attachLiveBrokerSession(entry, {
  request = requestBroker,
  attach = attachBrokerSession,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  apiArgv = [],
  env = process.env,
  deps = {},
} = {}) {
  const localPresence = await inspectLocalBrokerSessionForEntry(entry, { request, deps });
  const target = localPresence.verdict === 'live' ? localPresence.session : null;
  const id = brokerSessionId(target);
  if (!id) return { attached: false, localPresence };
  const expectedTool = resolveToolInput(entry?.tool || DEFAULT_TOOL)?.id || null;
  const actualTool = sourceForBrokerTool(target?.tool);
  if (expectedTool && actualTool && expectedTool !== actualTool) {
    return {
      attached: false,
      providerMismatch: true,
      localPresence,
    };
  }
  const authority = await (
    deps.resolveSessionControllerCapability
    || resolveSessionControllerCapability
  )({
    codingSessionId: id,
    apiArgv,
    env,
    deps,
  });
  if (!authority?.ok) {
    return {
      attached: false,
      controllerUnavailable: true,
      localPresence,
    };
  }
  const code = await attach({
    id,
    controllerCapability: authority.capability,
    ...(target?.broker_socket_path ? { socketPath: target.broker_socket_path } : {}),
    stdin,
    stdout,
    stderr,
  });
  return { attached: true, code, id, localPresence };
}

export function selectLiveBrokerSessionForEntry(entry, sessions = []) {
  return selectBrokerSessionForEntry(
    entry,
    Array.isArray(sessions) ? sessions.filter(isLiveBrokerSession) : [],
  );
}

export function selectBrokerSessionForEntry(entry, sessions = []) {
  if (!entry || !Array.isArray(sessions)) return null;

  const entryId = nonEmpty(entry.coding_session_id);
  if (entryId) {
    const direct = sessions.find((session) => brokerSessionId(session) === entryId);
    if (direct) return direct;
  }

  const worktreePath = nonEmpty(entry.worktree_path);
  if (worktreePath) {
    const normalizedWorktreePath = normalizePathForMatch(worktreePath);
    const byCwd = sessions.find(
      (session) => normalizePathForMatch(session.cwd) === normalizedWorktreePath,
    );
    if (byCwd) return byCwd;
  }

  const name = nonEmpty(entry.name);
  if (name) {
    return sessions.find((session) => (
      nonEmpty(session.name) === name
      || nonEmpty(session.worktree_name) === name
    )) || null;
  }

  return null;
}

function isLiveBrokerSession(session) {
  return !!brokerSessionId(session)
    && session?.attachable !== false
    && session?.session_state !== 'dead'
    && !session?.exit;
}

function isExitedBrokerSession(session) {
  return !!brokerSessionId(session)
    && (session?.session_state === 'dead' || !!session?.exit);
}

function brokerSessionId(session) {
  return nonEmpty(session?.id) || nonEmpty(session?.coding_session_id);
}

function hasStoredToolSession(entry) {
  return !!(
    nonEmpty(entry?.coding_session_id)
    || nonEmpty(entry?.tool_session_id)
    || nonEmpty(entry?.provider_session_id)
    || nonEmpty(entry?.llm_session_id)
  );
}

function hasProviderToolSession(entry) {
  return !!(
    nonEmpty(entry?.tool_session_id)
    || nonEmpty(entry?.provider_session_id)
    || nonEmpty(entry?.llm_session_id)
  );
}

function hasInjectedToolSessionResolver(deps = {}) {
  return !!(
    deps.resolveToolSessionForResume
    || deps.findLatestTranscriptForTool
    || deps.toolSessionDeps?.findLatestTranscriptForTool
  );
}

function hasInjectedRuntimeDeps(deps = {}) {
  if (deps.__injectedRuntime) return true;
  return [
    'findEntry',
    'readRegistry',
    'fetchActiveSessions',
    'launchResumeSession',
    'launchFreshSession',
    'attachLiveBrokerSession',
    'requestBroker',
    'upsertEntry',
    'listLocalBrokerAndHostSessions',
    'observeEntryWorktree',
  ].some((key) => Object.prototype.hasOwnProperty.call(deps, key));
}

function injectedLookup(identifier, lookup) {
  const entry = lookup(identifier);
  return entry
    ? { ok: true, entry, source: 'injected' }
    : { ok: false, entry: null, reason: 'missing' };
}

function findCurrentEntry(entry, deps = {}) {
  if (deps.findEntry) return deps.findEntry(entry.name) || entry;
  return findEntry(entry.session_id || entry.name, {
    cwd: entry.worktree_path || process.cwd(),
  }) || entry;
}

function entryRegistryIdentity(entry) {
  return {
    ...(entry?.session_id ? { session_id: entry.session_id } : {}),
    ...(entry?.repository_id ? { repository_id: entry.repository_id } : {}),
  };
}

function shouldRunProviderSwitchBoundary(deps = {}) {
  return typeof deps.recoverProviderSwitch === 'function'
    || typeof deps.prepareProviderSwitch === 'function'
    || !hasInjectedRuntimeDeps(deps);
}

async function requireManagedSwitchTarget({
  targetTool,
  stderr,
  deps = {},
} = {}) {
  const inspect = deps.inspectManagedProviderReadiness
    || inspectManagedProviderReadiness;
  let readiness;
  try {
    readiness = await inspect({
      tool: targetTool?.id,
      deps: deps.managedProviderReadinessDeps || {},
    });
  } catch {
    readiness = null;
  }
  if (readiness?.ok === true) return true;
  const reason = readiness?.reason || 'managed-provider-readiness-failed';
  stderr.write(`mc: managed target provider is not ready (${reason}); target provider was not launched.\n`);
  if (readiness?.hint) stderr.write(`    → ${readiness.hint}\n`);
  return false;
}

function hasInjectedPickerRuntime({
  launch,
  freshLaunchOverride,
  attachLive,
  upsert,
} = {}) {
  return launch !== launchResumeSession
    || !!freshLaunchOverride
    || attachLive !== attachBrokerSession
    || upsert !== upsertEntry;
}

function freshLaunchDependency(deps = {}) {
  return deps.launchFreshSession || launchFreshSession;
}

function freshLaunchFocus(entry = {}) {
  return nonEmpty(entry.focus) || nonEmpty(entry.label);
}

function normalizePathForMatch(value) {
  const text = nonEmpty(value);
  if (!text) return null;
  let out = text.replace(/[/\\]+$/, '');
  if (process.platform === 'darwin' && out.startsWith('/private/')) {
    out = out.slice('/private'.length);
  }
  return out;
}

/**
 * Failure codes must name the way out. A custody conflict means the
 * interrupted switch journal was begun under the OTHER custody flag —
 * the fix is always to retry with the recorded one.
 */
function handoffRecoveryRemedy(recovery) {
  if (recovery?.code === 'handoff-switch-journal-conflict'
    && recovery.recordedTargetTool) {
    const nativeFlag = recovery.recordedCustody === 'native' ? ' --native' : '';
    return `mc: the interrupted switch targets ${recovery.recordedTargetTool} — retry with \`--${recovery.recordedTargetTool}${nativeFlag}\`.\n`;
  }
  if (recovery?.code !== 'handoff-target-custody-conflict') return null;
  if (recovery.recordedCustody === 'native') {
    return 'mc: the interrupted switch targets the tool\'s own sign-in — retry with `--native`.\n';
  }
  if (recovery.recordedCustody === 'managed') {
    return 'mc: the interrupted switch targets managed custody — retry without `--native`.\n';
  }
  return null;
}

function renderCannotResumeSameToolSession(entry = {}, resolved = {}) {
  const name = nonEmpty(entry.name) || '<unknown>';
  const worktree = nonEmpty(entry.worktree_path) || '<unknown>';
  const source = nonEmpty(resolved?.source) || nonEmpty(entry.tool) || '<unknown>';
  return [
    `mc: kan inte resume:a samma provider-session för "${name}".`,
    `mc: no provider-native session id found for ${source} in ${worktree}.`,
    'mc: refusing to start a contextless replacement session.',
    '',
  ].join('\n');
}

function renderUnsupportedNativeResume(entry = {}, resolved = {}) {
  const tool = nonEmpty(resolved?.tool) || nonEmpty(entry.tool) || '<unknown>';
  return [
    `mc: ${tool} adapter saknar native resume-kontrakt.`,
    'mc: refusing to start a contextless replacement session.',
    '',
  ].join('\n');
}

function renderUnreachableLocalRuntime(entry = {}) {
  const name = nonEmpty(entry.name) || '<unknown>';
  return [
    `mc: "${name}" has a locally recorded live runtime, but its broker is unreachable.`,
    'mc: refusing to start a duplicate provider session; run `mc doctor` and restore the session host before retrying.',
    '',
  ].join('\n');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function activeMatchForEntry(entry, { argv = [], deps = {} } = {}) {
  const fetchActive = deps.fetchActiveSessions || ((args) => fetchActiveCodingSessions({ argv: args }));
  const activeRes = await fetchActive(argv);
  if (!activeRes?.ok) return { ok: false, session: null };
  return {
    ok: true,
    session: findActiveForLocalEntry(entry, activeRes.sessions || []),
  };
}

async function refreshActiveAfterPresenceRepair(entry, {
  argv = [],
  deps = {},
} = {}) {
  const delays = Array.isArray(deps.presenceRepairRefreshDelaysMs)
    ? deps.presenceRepairRefreshDelaysMs
    : [0, 150, 500];
  let latest = { ok: false, session: null };
  for (const delay of delays) {
    if (delay > 0) {
      try { await (deps.sleep || sleep)(delay); } catch {}
    }
    latest = await activeMatchForEntry(entry, { argv, deps });
    if (!latest.ok || !latest.session) return latest;
  }
  return latest;
}

function validateToolFlag(tool) {
  if (!tool) return { resolved: null };
  const resolved = resolveToolInput(tool);
  if (!resolved) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return { resolved };
}

function sourceForBrokerTool(tool) {
  return resolveToolInput(tool)?.id || null;
}

/**
 * True when a tool flag asks to run an EXISTING session under a different
 * provider than it's stored with. Only meaningful once the session has a
 * stored session to preserve/rebind; a never-launched entry simply takes the
 * flag as its initial provider via applyToolOverride.
 */
function isToolSwitch(entry, resolvedTool = null) {
  if (!resolvedTool || !hasStoredToolSession(entry)) return false;
  const current = resolveToolInput(entry?.tool || DEFAULT_TOOL);
  return !!current && current.id !== resolvedTool.id;
}

/**
 * Flip an existing session to a new provider. Clears the previous tool's
 * native-transcript pointers (they can't be resumed under the new tool) but
 * PRESERVES coding_session_id — the continuity binding that carries the prior
 * work's server-side context into the fresh, grounded session.
 */
function applyToolSwitch(entry, resolvedTool, {
  targetCustody = 'native',
  upsert = upsertEntry,
} = {}) {
  const targetProvider = providerSessionFor(entry, resolvedTool?.id);
  const targetSessionId = exactNonEmpty(targetProvider?.session_id);
  const targetGeneration = exactNonEmpty(targetProvider?.runtime_generation);
  const targetAdapter = targetCustody === 'managed'
    ? managedProviderAdapterForTool(resolvedTool?.id)
    : null;
  if (targetCustody === 'managed' && targetSessionId
    && (!targetAdapter || !isManagedGeneration(targetGeneration))) {
    return { error: 'managed-target-provider-session-unconfirmed' };
  }
  const patch = {
    name: entry.name,
    ...entryRegistryIdentity(entry),
    tool: resolvedTool.shortName,
    tool_session_id: targetSessionId,
    tool_session_source: targetSessionId ? resolvedTool.id : null,
    tool_transcript_path: targetCustody === 'native'
      ? targetProvider?.transcript_path || null
      : null,
    tool_session_provider_adapter: targetCustody === 'managed' && targetSessionId
      ? targetAdapter.provider_adapter_id
      : null,
    tool_session_provider_generation: targetCustody === 'managed' && targetSessionId
      ? targetGeneration
      : null,
  };
  const migrated = normalizeProviderSessions(entry);
  if (!migrated.ok) return { error: migrated.reason };
  patch.provider_sessions = migrated.providerSessions;
  const next = upsert(patch);
  return { ...entry, ...patch, ...(next || {}) };
}

function applyToolOverride(entry, tool, { upsert = upsertEntry, resolved = null } = {}) {
  const resolvedTool = resolved || validateToolFlag(tool).resolved;
  if (!resolvedTool) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return {
    entry: upsert({
      name: entry.name,
      ...entryRegistryIdentity(entry),
      tool: resolvedTool.shortName,
    }),
  };
}

async function promptForChoice({ stdin, stdout, deps = {} } = {}) {
  const prompt = 'Select a session number: ';
  if (typeof deps.readLine === 'function') {
    stdout.write(prompt);
    return deps.readLine({ stdin, stdout, prompt });
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
