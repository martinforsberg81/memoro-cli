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
import { hostname } from 'node:os';

import { findEntry, readRegistry, upsertEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import { attachBrokerSession } from '../broker/attach-client.js';
import { requestBroker } from '../broker/client.js';
import { listLocalBrokerAndHostSessions } from '../broker/session-hosts.js';
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
import { MANAGED_CODEX_PROVIDER_ID } from '../provider-adapters/codex-managed.js';

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
  const localAuthMode = resolveLocalAuthMode({ managedPortable: opts.managedPortable });
  const authMode = requireLocalAuthMode(localAuthMode);
  if (!authMode.ok) {
    stderr.write(`mc: ${authMode.error}\n`);
    return 1;
  }
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
  const lookupEntry = deps.findEntry || findEntry;
  let entry = lookupEntry(opts.name);
  if (!entry) {
    stderr.write(`mc: no such session "${opts.name}"\n`);
    return 1;
  }
  entry = maybeObserveEntry(entry, deps);
  entry = await maybeBackfillToolSession(entry, {
    localAuthMode,
    upsert: deps.upsertEntry || upsertEntry,
    deps,
  });
  let firstLaunchInWorktree = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
    ? !hasManagedProviderToolSession(entry)
    : !hasStoredToolSession(entry);

  const toolValidation = validateToolFlag(opts.tool);
  if (toolValidation.error) {
    stderr.write(`mc: ${toolValidation.error}\n`);
    return 2;
  }
  // Switching a session to a different tool starts a FRESH grounded session
  // in the same worktree: a provider's native transcript can't be handed to
  // another tool, but work continuity lives in the worktree and in server-side
  // continuity keyed by coding_session_id (which we rebind on the fresh start).
  const switchingTool = isToolSwitch(entry, toolValidation.resolved);
  if (switchingTool) firstLaunchInWorktree = true;

  if (!opts.json && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    // A tool switch never reattaches the OLD tool's live local PTY — that
    // would silently reopen the previous provider instead of switching.
    if (!switchingTool) {
      if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
        const live = await (deps.findLiveBrokerSessionForEntry || findLiveBrokerSessionForEntry)(
          entry, { request: deps.requestBroker || requestBroker, deps },
        );
        if (live) {
          stderr.write('mc: managed portable launch conflicts with an existing local broker session; end it before retrying.\n');
          return 1;
        }
      } else {
        const attached = await attachLiveBrokerSession(entry, {
          stdin,
          stdout,
          stderr,
          request: deps.requestBroker || requestBroker,
          attach: deps.attachBrokerSession || attachBrokerSession,
          deps,
        });
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
      const live = await (deps.findLiveBrokerSessionForEntry || findLiveBrokerSessionForEntry)(
        entry, { request: deps.requestBroker || requestBroker, deps },
      );
      if (live) {
        stderr.write(`mc: "${entry.name}" is running here — exit it (Ctrl+D) or \`mc end ${entry.name}\` before switching tools.\n`);
        return 1;
      }
    }

    // Active-server-match idempotency: never spawn a duplicate of a session
    // live somewhere else. Both branches above established that no LOCAL PTY
    // is live, and the local broker is the authority for this machine — a
    // server record naming THIS machine is a stale heartbeat (Ctrl+D moments
    // ago), so open/switch proceeds. A record for ANOTHER machine is a
    // genuine duplicate risk and still blocks.
    const active = await activeMatchForEntry(entry, { argv, deps });
    const staleSameMachine = active?.machine_id
      && active.machine_id === (deps.hostname || hostname)();
    if (active && !staleSameMachine) {
      markEntryOpened(entry, {
        upsert: deps.upsertEntry || upsertEntry,
        now: deps.now,
      });
      stdout.write(renderActiveSelectionMessage(active));
      return 0;
    }
  }

  if (opts.tool) {
    if (switchingTool) {
      entry = applyToolSwitch(entry, toolValidation.resolved, {
        upsert: deps.upsertEntry || upsertEntry,
      });
    } else {
      const res = applyToolOverride(entry, opts.tool, {
        upsert: deps.upsertEntry || upsertEntry,
        resolved: toolValidation.resolved,
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
  });
}

export async function launchResumeSession({
  entry,
  apiArgv = [],
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }

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
    // No provider-native session to resume (e.g. the tool exited before any
    // message created a transcript). Under the contract, continuity is
    // server-owned — a fresh grounded launch on the SAME coding session is
    // strictly better than a dead end, and it is announced, never silent.
    stderr.write(`mc: no ${launchTool?.shortName || 'provider'}-native session to resume for "${entry.name}" — starting a fresh grounded session on the same coding session.\n`);
    return (deps.launchFreshSession || launchFreshSession)({
      entry,
      apiArgv,
      env,
      localAuthMode,
      stderr,
      deps,
    });
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
    }),
    stderr,
    onLaunched: ({ codingSessionId, brokerSocketPath = null, hostKind = null }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      const patch = {
        name: entry.name,
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
      if (brokerSocketPath) patch.broker_socket_path = brokerSocketPath;
      if (hostKind) patch.host_kind = hostKind;
      upsert(patch);
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
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }

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
    }),
    stderr,
    onLaunched: ({ codingSessionId, brokerSocketPath = null, hostKind = null }) => {
      const upsert = deps.upsertEntry || upsertEntry;
      const patch = {
        name: entry.name,
        coding_session_id: codingSessionId,
        session_state: 'live',
      };
      if (brokerSocketPath) patch.broker_socket_path = brokerSocketPath;
      if (hostKind) patch.host_kind = hostKind;
      upsert(patch);
    },
    deps: deps.launchDeps || {},
  });
  if (typeof result === 'number') return result;
  return result?.code ?? 0;
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
      sessionId: entry.name,
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
    managedPortable: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--managed-portable') { opts.managedPortable = true; continue; }
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
    .sort((a, b) => a.name.localeCompare(b.name));
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
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    stderr.write(`mc: ${authMode?.error || 'local auth mode unavailable'}\n`);
    return 1;
  }

  if (!choice) return 2;
  if (choice.type === 'active') {
    if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
      stderr.write('mc: managed portable launch cannot attach to an existing active session.\n');
      return 1;
    }
    const attached = await attachLive({
      name: choice.label || choice.name || null,
      coding_session_id: choice.coding_session_id || choice.id || null,
    }, { stdin, stdout, stderr, deps });
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
  const switchingTool = isToolSwitch(entry, resolvedTool);
  const firstLaunchInWorktree = switchingTool || (
    localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE
      ? !hasManagedProviderToolSession(entry)
      : !hasStoredToolSession(entry)
  );
  const freshLaunch = freshLaunchDependency({
    launchFreshSession: freshLaunchOverride,
  });
  if (!switchingTool && !opts.noLaunch && process.env.MC_TEST_MODE !== '1') {
    if (localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE) {
      const live = await (deps.findLiveBrokerSessionForEntry || findLiveBrokerSessionForEntry)(
        entry,
        { request: deps.requestBroker || requestBroker, deps },
      );
      if (live) {
        stderr.write('mc: managed portable launch conflicts with an existing local broker session; end it before retrying.\n');
        return 1;
      }
    } else {
      const attached = await attachLive(entry, { stdin, stdout, stderr, deps });
      if (attached?.attached) {
        markEntryOpened(entry, {
          upsert,
          now: deps.now,
        });
        return attached.code ?? 0;
      }
    }
  }

  if (opts.tool) {
    if (switchingTool) {
      entry = applyToolSwitch(entry, resolvedTool, { upsert });
    } else {
      const res = applyToolOverride(entry, opts.tool, { upsert, resolved: resolvedTool });
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
  };
  return firstLaunchInWorktree ? freshLaunch(launchOptions) : launch(launchOptions);
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
    upsert({ name: entry.name, last_opened_at: openedAt });
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
    tool_session_id: resolved.sessionId,
    tool_session_source: resolved.source || null,
    tool_transcript_path: resolved.transcriptPath || null,
  };
  try {
    const next = upsert(patch);
    return { ...entry, ...patch, ...(next || {}) };
  } catch {
    return { ...entry, ...patch };
  }
}

function storedManagedToolSession(entry, launchTool) {
  const sessionId = nonEmpty(entry?.tool_session_id);
  const providerAdapter = nonEmpty(entry?.tool_session_provider_adapter);
  const providerGeneration = nonEmpty(entry?.tool_session_provider_generation);
  if (!sessionId
    || providerAdapter !== MANAGED_CODEX_PROVIDER_ID
    || !isManagedGeneration(providerGeneration)) {
    return {
      ok: false,
      reason: 'no-managed-provider-session-id',
      source: launchTool?.shortName || entry?.tool || null,
      sessionId: null,
      transcriptPath: null,
    };
  }
  return {
    ok: true,
    source: launchTool?.shortName || entry?.tool || null,
    sessionId,
    transcriptPath: null,
    from: 'registry',
  };
}

function hasManagedProviderToolSession(entry) {
  return !!(
    nonEmpty(entry?.tool_session_id)
    && nonEmpty(entry?.tool_session_provider_adapter) === MANAGED_CODEX_PROVIDER_ID
    && isManagedGeneration(nonEmpty(entry?.tool_session_provider_generation))
  );
}

function isManagedGeneration(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value || '');
}

export async function findLiveBrokerSessionForEntry(entry, {
  request = requestBroker,
  deps = {},
} = {}) {
  const listed = await request({ type: 'sessions' }).catch(() => null);
  const sessions = await (deps.listLocalBrokerAndHostSessions || listLocalBrokerAndHostSessions)({ request })
    .catch(() => listed?.sessions || []);
  return selectLiveBrokerSessionForEntry(entry, sessions || listed?.sessions || []);
}

export async function attachLiveBrokerSession(entry, {
  request = requestBroker,
  attach = attachBrokerSession,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  deps = {},
} = {}) {
  const target = await findLiveBrokerSessionForEntry(entry, { request, deps });
  const id = brokerSessionId(target);
  if (!id) return { attached: false };
  const code = await attach({
    id,
    ...(target?.broker_socket_path ? { socketPath: target.broker_socket_path } : {}),
    stdin,
    stdout,
    stderr,
  });
  return { attached: true, code, id };
}

export function selectLiveBrokerSessionForEntry(entry, sessions = []) {
  if (!entry || !Array.isArray(sessions)) return null;
  const live = sessions.filter(isLiveBrokerSession);

  const entryId = nonEmpty(entry.coding_session_id);
  if (entryId) {
    const direct = live.find((session) => brokerSessionId(session) === entryId);
    if (direct) return direct;
  }

  const worktreePath = nonEmpty(entry.worktree_path);
  if (worktreePath) {
    const normalizedWorktreePath = normalizePathForMatch(worktreePath);
    const byCwd = live.find(
      (session) => normalizePathForMatch(session.cwd) === normalizedWorktreePath,
    );
    if (byCwd) return byCwd;
  }

  const name = nonEmpty(entry.name);
  if (name) {
    return live.find((session) => (
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function activeMatchForEntry(entry, { argv = [], deps = {} } = {}) {
  const fetchActive = deps.fetchActiveSessions || ((args) => fetchActiveCodingSessions({ argv: args }));
  const activeRes = await fetchActive(argv);
  if (!activeRes?.ok) return null;
  return findActiveForLocalEntry(entry, activeRes.sessions || []);
}

function validateToolFlag(tool) {
  if (!tool) return { resolved: null };
  const resolved = resolveToolInput(tool);
  if (!resolved) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return { resolved };
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
function applyToolSwitch(entry, resolvedTool, { upsert = upsertEntry } = {}) {
  const patch = {
    name: entry.name,
    tool: resolvedTool.shortName,
    tool_session_id: null,
    tool_session_source: null,
    tool_transcript_path: null,
    tool_session_provider_adapter: null,
    tool_session_provider_generation: null,
  };
  const next = upsert(patch);
  return { ...entry, ...patch, ...(next || {}) };
}

function applyToolOverride(entry, tool, { upsert = upsertEntry, resolved = null } = {}) {
  const resolvedTool = resolved || validateToolFlag(tool).resolved;
  if (!resolvedTool) {
    return { error: `unknown tool: ${tool}. Try: claude | codex | gemini` };
  }
  return { entry: upsert({ name: entry.name, tool: resolvedTool.shortName }) };
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
