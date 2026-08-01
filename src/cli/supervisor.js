import { createInterface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from 'node:process';

import {
  controlLocalBrokerSession,
  dispatchLocalBrokerSession,
} from '../bin-mc.js';
import { requestBroker as defaultRequestBroker } from '../runtime/broker/client.js';
import { readLocalSessionOutput } from '../runtime/broker/cloud.js';
import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from '../runtime/broker/session-hosts.js';
import {
  resolveSessionControllerCapability,
} from '../mc/session-controller-capability.js';
import {
  buildWatchSnapshot,
  cleanSessionOutput,
} from './sessions-watch.js';
import { readRegistry as defaultReadRegistry } from '../mc/registry.js';
import {
  appendSupervisorMessage as defaultAppendSupervisorMessage,
  ensureSupervisorAuth as defaultEnsureSupervisorAuth,
  getSupervisorConversation as defaultGetSupervisorConversation,
  logoutSupervisor as defaultLogoutSupervisor,
  runSupervisorTurn as defaultRunSupervisorTurn,
  syncSupervisorSnapshot as defaultSyncSupervisorSnapshot,
} from '../mc/supervisor-auth.js';

const DEFAULT_OUTPUT_TIMEOUT_MS = 750;
const MAX_SUPERVISOR_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 6000;
const DEFAULT_READ_TOOL_CHARS = 4000;
const DEFAULT_WATCH_INTERVAL_SECONDS = 20;
const MIN_WATCH_INTERVAL_SECONDS = 5;
const MAX_WATCH_INTERVAL_SECONDS = 300;
const DEFAULT_WATCH_TIMEOUT_MINUTES = 30;
const MAX_WATCH_TIMEOUT_MINUTES = 240;
const MAX_SUPERVISOR_WATCHES = 10;
const WATCH_TRIGGER_DISPOSITIONS = new Set(['awaiting_reply', 'review_suggested', 'idle', 'stale_idle', 'dead']);
const WATCH_CONDITIONS = new Set(['done_or_review', 'state_change', 'new_output_matching', 'idle_after_work']);
const DISPOSITIONS = ['awaiting_reply', 'review_suggested', 'working', 'idle', 'stale_idle', 'dead'];
const ONLY_ALIASES = {
  actionable: ['awaiting_reply', 'review_suggested'],
  active: ['awaiting_reply', 'review_suggested', 'working'],
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || defaultOutput;
  const stderr = deps.stderr || defaultError;
  const input = deps.stdin || defaultInput;
  const opts = parseSupervisorArgs(argv);
  if (opts.help) {
    stdout.write(renderSupervisorHelp());
    return 0;
  }
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  if (opts.logout) {
    const logoutSupervisor = deps.logoutSupervisor || defaultLogoutSupervisor;
    return logoutSupervisor({ argv, stdout, stderr });
  }

  let supervisorAuth = null;
  if (!opts.local) {
    const ensureSupervisorAuth = deps.ensureSupervisorAuth || defaultEnsureSupervisorAuth;
    supervisorAuth = await ensureSupervisorAuth({ argv, stderr });
    if (!supervisorAuth?.ok) {
      if (supervisorAuth?.error) stderr.write(`mc: ${supervisorAuth.error}\n`);
      return supervisorAuth?.code ?? 1;
    }
  }

  const context = createSupervisorContext({ opts, deps, stdout, stderr, supervisorAuth });

  if (opts.json || opts.once || !isInteractive(input, stdout, deps)) {
    const snapshot = await collectSupervisorSnapshot(context);
    await syncSupervisorSnapshot(snapshot, context);
    if (opts.json) stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    else stdout.write(renderSupervisorSnapshot(snapshot));
    return snapshot.ok === false ? 1 : 0;
  }

  const createInterfaceFn = deps.createInterface || createInterface;
  const rl = createInterfaceFn({ input, output: stdout, terminal: true });
  let watchManager = null;
  try {
    const interactiveContext = {
      ...context,
      confirm: deps.confirm || ((question) => askConfirmation(rl, question)),
      interactive: true,
    };
    watchManager = deps.watchManager || createSupervisorWatchManager(interactiveContext, {
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
      disableTimers: deps.disableWatchTimers === true,
    });
    interactiveContext.watchManager = watchManager;
    stdout.write('mc supervisor\n');
    stdout.write('session control plane\n\n');
    const conversation = await loadSupervisorConversation(interactiveContext);
    if (conversation) stdout.write(renderSupervisorConversation(conversation));
    const initialSnapshot = await collectSupervisorSnapshot(interactiveContext);
    await syncSupervisorSnapshot(initialSnapshot, interactiveContext);
    stdout.write(renderSupervisorSnapshot(initialSnapshot));
    stdout.write('\nType `help` for commands.\n');

    for (;;) {
      const prompt = await readSupervisorPromptLine(rl, stdout);
      if (prompt.exit) return prompt.code;
      let result;
      try {
        result = await handleSupervisorLine(prompt.line, interactiveContext);
      } catch (err) {
        const exit = supervisorReadlineExit(err, stdout);
        if (exit) return exit.code;
        throw err;
      }
      if (result.exit) return result.code ?? 0;
    }
  } finally {
    watchManager?.close?.();
    rl.close();
  }
}

async function readSupervisorPromptLine(rl, stdout) {
  try {
    const line = await rl.question('mc supervisor> ');
    if (line == null) {
      stdout.write('\n');
      return { exit: true, code: 0 };
    }
    return { exit: false, line };
  } catch (err) {
    const exit = supervisorReadlineExit(err, stdout);
    if (exit) return exit;
    throw err;
  }
}

function supervisorReadlineExit(err, stdout) {
  if (isReadlineAbortError(err)) {
    stdout.write('\n');
    return { exit: true, code: 130 };
  }
  if (isReadlineClosedError(err)) {
    stdout.write('\n');
    return { exit: true, code: 0 };
  }
  return null;
}

function isReadlineAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function isReadlineClosedError(err) {
  return err?.code === 'ERR_USE_AFTER_CLOSE'
    || err?.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || /\breadline\b.*\bclosed\b/i.test(String(err?.message || ''));
}

export function parseSupervisorArgs(argv = []) {
  const opts = {
    json: false,
    once: false,
    includeDead: false,
    hideSelf: false,
    excludeWorktreeNames: [],
    onlyDispositions: [],
    readOutput: true,
    outputTimeoutMs: DEFAULT_OUTPUT_TIMEOUT_MS,
    help: false,
    local: false,
    logout: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'logout') opts.logout = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--local') opts.local = true;
    else if (arg === '--api') {
      if (!argv[i + 1]) return { ...opts, error: '--api requires a URL' };
      i += 1;
    }
    else if (arg === '--include-dead') opts.includeDead = true;
    else if (arg === '--hide-self') opts.hideSelf = true;
    else if (arg === '--no-output') opts.readOutput = false;
    else if (arg === '--exclude-worktree') {
      const name = argv[++i];
      if (!name) return { ...opts, error: '--exclude-worktree requires a worktree name' };
      opts.excludeWorktreeNames.push(name);
    } else if (arg === '--only') {
      const value = argv[++i];
      if (!value) return { ...opts, error: '--only requires a value' };
      const parsed = parseOnlyDispositions(value);
      if (parsed.error) return { ...opts, error: parsed.error };
      opts.onlyDispositions.push(...parsed.values);
    } else if (arg === '--output-timeout') {
      const ms = Number(argv[++i]);
      if (!Number.isFinite(ms) || ms < 0) {
        return { ...opts, error: '--output-timeout must be a non-negative number of milliseconds' };
      }
      opts.outputTimeoutMs = ms;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      return { ...opts, error: `unknown flag: ${arg}` };
    }
  }

  return opts;
}

export async function handleSupervisorLine(line, context) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return writeSnapshot(context);

  const { command, rest } = splitCommand(trimmed);
  if (['quit', 'exit', 'q', ':q'].includes(command)) return { exit: true, code: 0 };
  if (['help', '?'].includes(command)) {
    context.stdout.write(renderSupervisorHelp());
    return { exit: false, code: 0 };
  }
  if (['list', 'ls', 'status'].includes(command)) return writeSnapshot(context);
  if (['watch', 'watches'].includes(command)) return listWatches(rest, context);
  if (['unwatch', 'cancel-watch'].includes(command)) return cancelWatch(rest, context);
  if (['read', 'tail'].includes(command)) return readSession(rest, context);
  if (command === 'send') return sendSession(rest, context);
  if (['stop', 'kill'].includes(command)) return controlSession('stop', rest, context);
  if (['remove', 'rm'].includes(command)) return controlSession('remove', rest, context);
  if (['ask', 'run'].includes(command)) return runSupervisorPrompt(rest, context);

  return runSupervisorPrompt(trimmed, context);
}

export async function collectSupervisorSnapshot({
  request,
  readOutput,
  opts,
  stderr,
  now = Date.now,
  readRegistry = defaultReadRegistry,
} = {}) {
  let sessions = [];
  try {
    sessions = await listLocalBrokerAndHostSessions({ request });
  } catch (err) {
    stderr?.write?.(`mc: local broker sessions unavailable (${err.message || String(err)})\n`);
    return {
      ok: false,
      error: err.message || String(err),
      generated_at: new Date(resolveNow(now)).toISOString(),
      sessions: [],
      counts: {},
    };
  }

  const outputs = new Map();
  if (opts.readOutput) {
    for (const session of sessions) {
      if (!isReadableSession(session, opts)) continue;
      const id = session.id || session.coding_session_id;
      const output = await readOutput(id, session).catch(() => '');
      outputs.set(id, output);
    }
  }

  const snapshot = buildWatchSnapshot({
    sessions,
    outputs,
    includeDead: opts.includeDead,
    excludeWorktreeNames: [
      ...(opts.hideSelf && process.env.MC_SESSION_NAME ? [process.env.MC_SESSION_NAME] : []),
      ...opts.excludeWorktreeNames,
    ],
    onlyDispositions: opts.onlyDispositions,
    now: resolveNow(now),
  });
  const registryEntries = readSupervisorRegistryEntries(readRegistry);
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => attachSupervisorRegistryMetadata(session, registryEntries)),
  };
}

export async function resolveLocalSupervisorSession(identifier, {
  request = defaultRequestBroker,
} = {}) {
  if (!identifier) return { ok: false, error: 'identifier is required' };
  const sessions = await listLocalBrokerAndHostSessions({ request });
  const direct = sessions.find((session) => directSessionMatch(session, identifier));
  if (direct) return { ok: true, session: direct, id: sessionId(direct), matchedBy: 'id' };

  const matches = sessions
    .filter((session) => namedSessionMatch(session, identifier))
    .sort(compareRecentSessions);
  if (!matches.length) return { ok: false, error: `local session not found: ${identifier}` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `${matches.length} local sessions match "${identifier}"; use a session id`,
      collisions: matches.length,
    };
  }
  return {
    ok: true,
    session: matches[0],
    id: sessionId(matches[0]),
    matchedBy: 'name',
    collisions: 0,
  };
}

export function renderSupervisorSnapshot(snapshot) {
  const out = [];
  out.push('mc supervisor sessions');
  out.push(`generated ${snapshot.generated_at}`);
  const counts = formatSupervisorCounts(snapshot.counts || {});
  if (counts) out.push(`summary ${counts}`);
  out.push('');

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (!sessions.length) {
    out.push('(no local broker sessions)');
    out.push('');
    return out.join('\n');
  }

  for (const section of supervisorSections(sessions)) {
    if (!section.sessions.length) continue;
    out.push(`${section.title} (${section.sessions.length})`);
    out.push('  session                 age       state    note');
    out.push('  ----------------------  --------  -------  ------------------------------');
    for (const session of section.sessions) {
      out.push(formatSupervisorSessionRow(session));
    }
    out.push('');
  }

  out.push('Commands');
  out.push('  read <session>                 show recent output');
  out.push('  send <session> <message>       send a message');
  out.push('  stop <session> --yes           stop a session');
  out.push('  list                           refresh this view');
  return out.join('\n') + '\n';
}

export function renderSupervisorHelp() {
  return `mc supervisor

Control prompt for running mc coding sessions.

Commands
  list | status                  Refresh the session snapshot
  watch | watches                List active supervisor watches
  unwatch <id|all>               Cancel active supervisor watches
  read <label|id>                Print recent output from one local session
  send <label|id> <message>      Send a message into one local session
  ask <instruction>              Ask the synced supervisor LLM to steer sessions
  stop <label|id> [--yes]        Stop a broker-owned session
  remove <label|id> [--yes]      Remove a broker session from inventory
  <natural language>             Same as ask; the supervisor may list/triage/inspect/read/send/watch
  help                           Show this help
  quit                           Exit supervisor

Options
  mc supervisor --once           Print one human snapshot and exit
  mc supervisor --json           Print one JSON snapshot and exit
  mc supervisor logout           Revoke and remove the local supervisor token
  mc supervisor --no-output      Snapshot without reading session output
  mc supervisor --only active    Filter to actionable/working sessions
  mc supervisor --local          Use local broker controls without online sync
`;
}

function createSupervisorContext({ opts, deps, stdout, stderr, supervisorAuth = null }) {
  const request = deps.requestBroker || defaultRequestBroker;
  const readOutput = deps.readOutput || (async (sessionIdValue, session) => {
    const authority = await (
      deps.resolveSessionControllerCapability
      || resolveSessionControllerCapability
    )({
      codingSessionId: sessionIdValue,
      deps,
    });
    if (!authority?.ok) throw new Error('session controller authority is unavailable');
    return readLocalSessionOutput({
      request: requestForSession(session, {
        request,
        controllerCapability: authority.capability,
      }),
      sessionId: sessionIdValue,
      timeoutMs: opts.outputTimeoutMs,
    });
  });
  return {
    opts,
    request,
    stdout,
    stderr,
    readOutput,
    now: deps.now || Date.now,
    dispatch: deps.dispatch || ((identifier, message) => dispatchLocalBrokerSession(identifier, message, { request })),
    control: deps.control || ((identifier, args) => controlLocalBrokerSession(identifier, { ...args, request })),
    confirm: deps.confirm || (async () => false),
    syncSnapshot: deps.syncSnapshot || defaultSyncSupervisorSnapshot,
    appendMessage: deps.appendMessage || defaultAppendSupervisorMessage,
    getConversation: deps.getConversation || defaultGetSupervisorConversation,
    runSupervisorTurn: deps.runSupervisorTurn || defaultRunSupervisorTurn,
    watchManager: deps.watchManager || null,
    supervisorAuth,
  };
}

async function writeSnapshot(context) {
  const snapshot = await collectSupervisorSnapshot(context);
  await syncSupervisorSnapshot(snapshot, context);
  context.stdout.write(renderSupervisorSnapshot(snapshot));
  return { exit: false, code: snapshot.ok === false ? 1 : 0 };
}

async function listWatches(_rest, context) {
  const watches = context.watchManager?.list?.() || [];
  if (!watches.length) {
    writeUiBlock(context, 'watches', 'no active watches');
    return { exit: false, code: 0 };
  }
  writeUiBlock(context, 'watches', watches.map((watch) => (
    `${watch.id}  ${watch.session_name || watch.session}  ${watch.condition}  every ${watch.interval_seconds}s  expires ${formatRemaining(watch.expires_at, context.now)}`
  )));
  return { exit: false, code: 0 };
}

async function cancelWatch(rest, context) {
  const target = String(rest || '').trim();
  if (!target) {
    context.stderr.write('mc: usage: unwatch <id|all>\n');
    return { exit: false, code: 2 };
  }
  if (!context.watchManager) {
    writeUiBlock(context, 'watches', 'no active watches');
    return { exit: false, code: 0 };
  }
  const cancelled = context.watchManager.cancel(target);
  writeUiBlock(context, 'watches', cancelled.length
    ? cancelled.map((watch) => `cancelled ${watch.id} ${watch.session_name || watch.session}`)
    : `no matching watch: ${target}`);
  return { exit: false, code: cancelled.length ? 0 : 1 };
}

async function runSupervisorPrompt(prompt, context) {
  const content = String(prompt || '').trim();
  if (!content) {
    context.stderr.write('mc: usage: ask <instruction>\n');
    return { exit: false, code: 2 };
  }
  if (!context.supervisorAuth || context.opts?.local) {
    context.stderr.write('mc: supervisor LLM requires online supervisor sync. Run without --local.\n');
    return { exit: false, code: 1 };
  }

  const runContext = { ...context, opts: context.opts || parseSupervisorArgs([]) };
  const snapshot = await collectSupervisorSnapshot(runContext);
  await syncSupervisorSnapshot(snapshot, runContext);

  let nextTurn = {
    message: {
      content,
      client_message_id: newSupervisorClientMessageId(),
    },
  };

  return runSupervisorTurnLoop(nextTurn, runContext);
}

async function runSupervisorTurnLoop(nextTurn, context) {
  let hadToolCalls = false;
  const runContext = {
    ...context,
    supervisorToolCache: context.supervisorToolCache || new Map(),
  };

  for (let round = 0; round < MAX_SUPERVISOR_TOOL_ROUNDS; round += 1) {
    const result = await runContext.runSupervisorTurn(nextTurn, { auth: runContext.supervisorAuth }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!result?.ok) {
      runContext.stderr.write(formatSupervisorRunFailure(result));
      return { exit: false, code: 1 };
    }

    const run = normalizeSupervisorRun(result.run);
    renderSupervisorRun(run, runContext);
    if (!run.tool_calls.length) {
      return { exit: false, code: 0 };
    }

    hadToolCalls = true;
    const toolResults = [];
    for (const call of run.tool_calls) {
      toolResults.push(await executeSupervisorToolCall(call, runContext));
    }

    const appended = await appendSupervisorToolResults(toolResults, runContext);
    if (!appended) return { exit: false, code: 1 };
    nextTurn = { continue: true };
  }

  if (!hadToolCalls) return { exit: false, code: 0 };
  return requestSupervisorFinalAnswer(runContext);
}

function renderSupervisorRun(run, context) {
  if (run.response) {
    writeUiBlock(context, 'supervisor', run.response);
  } else if (run.tool_calls.length) {
    writeUiBlock(context, 'supervisor', `executing ${run.tool_calls.length} tool call${run.tool_calls.length === 1 ? '' : 's'}`);
  }
}

function formatSupervisorRunFailure(result = {}) {
  const code = result.code || result.error || 'MC_SUPERVISOR_RUN_FAILED';
  const message = result.message && result.message !== code
    ? `\n  ${result.message}`
    : '';
  const retry = result.retryable === true ? '\n  Try again. If it keeps failing, share this error code.' : '';
  const cause = result.cause_code ? `\n  cause: ${result.cause_code}` : '';
  return `mc: ${code}${message}${retry}${cause}\n`;
}

function writeUiBlock(context, title, body, { async = context.asyncOutput === true } = {}) {
  const lines = Array.isArray(body)
    ? body.map((line) => String(line || ''))
    : String(body || '').split('\n');
  if (async && context.interactive) context.stdout.write('\n');
  context.stdout.write(`${title}\n`);
  for (const line of lines) {
    const text = line || '';
    context.stdout.write(`  ${text}\n`);
  }
  context.stdout.write('\n');
  if (async && context.interactive) context.stdout.write('mc supervisor> ');
}

async function executeSupervisorToolCall(call, context) {
  const cacheKey = supervisorToolCacheKey(call);
  if (cacheKey && context.supervisorToolCache?.has(cacheKey)) {
    const cached = {
      ...context.supervisorToolCache.get(cacheKey),
      call_id: call.id,
      cached: true,
    };
    writeUiBlock(context, 'tools', cachedToolResultLine(call, cached));
    return cached;
  }

  if (call.tool === 'sessions.list') {
    const snapshot = await collectSupervisorSnapshot(context);
    await syncSupervisorSnapshot(snapshot, context);
    const compact = compactSnapshotForSupervisorSync(snapshot);
    writeUiBlock(context, 'tools', `list sessions    ok ${compact.sessions.length} sessions`);
    const result = {
      call_id: call.id,
      tool: call.tool,
      ok: snapshot.ok !== false,
      counts: compact.counts || {},
      sessions: compact.sessions,
      error: snapshot.ok === false ? snapshot.error || 'snapshot failed' : null,
    };
    cacheSupervisorToolResult(context, cacheKey, result);
    return result;
  }

  if (call.tool === 'sessions.triage') {
    const snapshot = await collectSupervisorSnapshot(context);
    await syncSupervisorSnapshot(snapshot, context);
    const triage = buildSupervisorTriageSnapshot(snapshot);
    writeUiBlock(context, 'tools', `triage sessions    ok ${triage.sessions.length} sessions`);
    const result = {
      call_id: call.id,
      tool: call.tool,
      ok: snapshot.ok !== false,
      counts: triage.counts || {},
      sessions: triage.sessions,
      contract: {
        purpose: 'prioritize attention; not approval, merge, or deploy evidence',
        next_tool_for_decisions: 'sessions.inspect',
      },
      error: snapshot.ok === false ? snapshot.error || 'snapshot failed' : null,
    };
    cacheSupervisorToolResult(context, cacheKey, result);
    return result;
  }

  if (call.tool === 'sessions.read') {
    const resolved = await resolveLocalSupervisorSession(call.args.session, { request: context.request }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!resolved.ok) {
      writeUiBlock(context, 'tools', `read ${call.args.session}    failed ${resolved.error}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: resolved.error,
      };
    }
    const output = await context.readOutput(resolved.id, resolved.session).catch((err) => {
      return { __error: err.message || String(err) };
    });
    if (output && typeof output === 'object' && output.__error) {
      writeUiBlock(context, 'tools', `read ${call.args.session}    failed ${output.__error}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        session_id: resolved.id,
        error: output.__error,
      };
    }
    const cleanedOutput = cleanSessionOutput(output || '');
    const label = resolved.session.name || resolved.session.label || resolved.id;
    writeUiBlock(context, 'tools', `read ${label}    ok ${resolved.id}`);
    const result = {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      session: call.args.session,
      session_id: resolved.id,
      contract: {
        purpose: 'transcript/output read only; not a delivery decision',
        next_tool_for_decisions: 'sessions.inspect',
      },
      output: truncateToolText(cleanedOutput, call.args.max_output_chars || DEFAULT_READ_TOOL_CHARS),
    };
    cacheSupervisorToolResult(context, cacheKey, result);
    return result;
  }

  if (call.tool === 'sessions.inspect') {
    const resolved = await resolveLocalSupervisorSession(call.args.session, { request: context.request }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!resolved.ok) {
      writeUiBlock(context, 'tools', `inspect ${call.args.session}    failed ${resolved.error}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: resolved.error,
      };
    }
    const output = await context.readOutput(resolved.id, resolved.session).catch((err) => {
      return { __error: err.message || String(err) };
    });
    if (output && typeof output === 'object' && output.__error) {
      writeUiBlock(context, 'tools', `inspect ${call.args.session}    failed ${output.__error}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        session_id: resolved.id,
        error: output.__error,
      };
    }
    const cleanedOutput = cleanSessionOutput(output || '');
    const label = resolved.session.name || resolved.session.label || resolved.id;
    writeUiBlock(context, 'tools', `inspect ${label}    ok ${resolved.id}`);
    const packet = buildSupervisorInspectPacket(resolved, cleanedOutput, context, {
      maxOutputChars: call.args.max_output_chars || DEFAULT_READ_TOOL_CHARS,
    });
    const result = {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      session: call.args.session,
      session_id: resolved.id,
      inspect: packet,
    };
    cacheSupervisorToolResult(context, cacheKey, result);
    return result;
  }

  if (call.tool === 'sessions.send') {
    const result = await context.dispatch(call.args.session, call.args.message).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!result?.ok) {
      writeUiBlock(context, 'tools', `send ${call.args.session}    failed ${result?.error || 'local dispatch failed'}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: result?.error || 'local dispatch failed',
      };
    }
    writeUiBlock(context, 'tools', `send ${call.args.session}    sent ${result.id}`);
    return {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      session: call.args.session,
      session_id: result.id,
      message_length: call.args.message.length,
    };
  }

  if (call.tool === 'sessions.watch') {
    if (!context.watchManager) {
      writeUiBlock(context, 'tools', `watch ${call.args.session}    failed interactive supervisor required`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: 'watching requires an interactive supervisor terminal',
      };
    }
    const result = await context.watchManager.add(call.args).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!result?.ok) {
      writeUiBlock(context, 'tools', `watch ${call.args.session}    failed ${result?.error || 'watch failed'}`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: result?.error || 'watch failed',
      };
    }
    writeUiBlock(
      context,
      'tools',
      `watch ${result.watch.session_name || result.watch.session}    every ${result.watch.interval_seconds}s, timeout ${result.watch.timeout_minutes}m`,
    );
    return {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      watch_id: result.watch.id,
      session: result.watch.session,
      session_id: result.watch.session_id,
      condition: result.watch.condition,
      interval_seconds: result.watch.interval_seconds,
      timeout_minutes: result.watch.timeout_minutes,
    };
  }

  return {
    call_id: call.id,
    tool: call.tool,
    ok: false,
    error: `unsupported tool: ${call.tool}`,
  };
}

async function requestSupervisorFinalAnswer(context) {
  const appended = await context.appendMessage({
    role: 'system',
    content: [
      'mc supervisor control',
      `The local terminal reached the ${MAX_SUPERVISOR_TOOL_ROUNDS}-round tool budget for this user request.`,
      'Do not request more tools in the next response.',
      'Answer now from the available session list/triage/inspect/read/send/watch results in recent conversation.',
      'If evidence is incomplete, say so briefly and give the next concrete action.',
    ].join('\n'),
  }, { auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!appended?.ok) {
    context.stderr.write(`mc: supervisor finalization failed (${appended?.error || 'unknown error'})\n`);
    return { exit: false, code: 1 };
  }

  const result = await context.runSupervisorTurn({ continue: true }, { auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!result?.ok) {
    context.stderr.write(`mc: supervisor final answer failed (${result?.error || 'unknown error'})\n`);
    return { exit: false, code: 1 };
  }
  const run = normalizeSupervisorRun(result.run);
  if (run.response) renderSupervisorRun({ ...run, tool_calls: [] }, context);
  else writeUiBlock(context, 'supervisor', 'Jag har nått verktygsgränsen för den här frågan. Fråga igen för en fördjupning.');
  return { exit: false, code: 0 };
}

function supervisorToolCacheKey(call) {
  if (call.tool === 'sessions.list') return 'sessions.list';
  if (call.tool === 'sessions.triage') return 'sessions.triage';
  if (call.tool === 'sessions.read') {
    return `sessions.read:${call.args.session}:${call.args.max_output_chars || DEFAULT_READ_TOOL_CHARS}`;
  }
  if (call.tool === 'sessions.inspect') {
    return `sessions.inspect:${call.args.session}:${call.args.max_output_chars || DEFAULT_READ_TOOL_CHARS}`;
  }
  return null;
}

function cacheSupervisorToolResult(context, cacheKey, result) {
  if (!cacheKey || !result?.ok || !context.supervisorToolCache) return;
  context.supervisorToolCache.set(cacheKey, result);
}

function cachedToolResultLine(call, result) {
  if (call.tool === 'sessions.list') {
    return `list sessions    cached ${Array.isArray(result.sessions) ? result.sessions.length : 0} sessions`;
  }
  if (call.tool === 'sessions.triage') {
    return `triage sessions    cached ${Array.isArray(result.sessions) ? result.sessions.length : 0} sessions`;
  }
  if (call.tool === 'sessions.inspect') {
    return `inspect ${call.args.session}    cached ${result.session_id || ''}`.trimEnd();
  }
  if (call.tool === 'sessions.read') {
    return `read ${call.args.session}    cached ${result.session_id || ''}`.trimEnd();
  }
  return `${call.tool}    cached`;
}

async function appendSupervisorToolResults(results, context) {
  const content = serializeSupervisorToolResults(results);
  const result = await context.appendMessage({ role: 'system', content }, { auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!result?.ok) {
    context.stderr.write(`mc: supervisor tool result sync failed (${result?.error || 'unknown error'})\n`);
    return false;
  }
  return true;
}

export function createSupervisorWatchManager(context, {
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  disableTimers = false,
} = {}) {
  const watches = new Map();

  function list() {
    return Array.from(watches.values()).map(publicWatch);
  }

  function close() {
    for (const watch of watches.values()) {
      if (watch.timer) clearTimeoutFn(watch.timer);
    }
    watches.clear();
  }

  function cancel(target) {
    const key = String(target || '').trim();
    const cancelled = [];
    for (const watch of watches.values()) {
      if (
        key === 'all'
        || watch.id === key
        || watch.session === key
        || watch.session_id === key
        || watch.session_name === key
      ) {
        if (watch.timer) clearTimeoutFn(watch.timer);
        watches.delete(watch.id);
        cancelled.push(publicWatch(watch));
      }
    }
    return cancelled;
  }

  async function add(rawArgs = {}) {
    if (watches.size >= MAX_SUPERVISOR_WATCHES) {
      return { ok: false, error: `too many active watches; max ${MAX_SUPERVISOR_WATCHES}` };
    }
    const args = normalizeWatchArgs(rawArgs);
    if (!args.ok) return args;

    const sample = await readSupervisorWatchSample(args.value, context).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!sample.ok) return { ok: false, error: sample.error || 'session unavailable' };

    const now = resolveNow(context.now || Date.now);
    const watch = {
      id: newSupervisorWatchId(),
      session: args.value.session,
      session_id: sample.session.id || null,
      session_name: sample.session.name || args.value.session,
      condition: args.value.condition,
      description: args.value.description,
      interval_seconds: args.value.interval_seconds,
      timeout_minutes: args.value.timeout_minutes,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + args.value.timeout_minutes * 60_000).toISOString(),
      last_state: sample.session.state || null,
      last_disposition: sample.session.disposition || null,
      last_output: sample.output || '',
      seen_working: sample.session.disposition === 'working',
      timer: null,
    };
    watches.set(watch.id, watch);
    schedule(watch);
    return { ok: true, watch: publicWatch(watch) };
  }

  function schedule(watch) {
    if (disableTimers || !watches.has(watch.id)) return;
    watch.timer = setTimeoutFn(() => {
      tick(watch.id).catch((err) => {
        context.stderr?.write?.(`mc: watch ${watch.id} failed: ${err.message || String(err)}\n`);
      });
    }, watch.interval_seconds * 1000);
    if (typeof watch.timer?.unref === 'function') watch.timer.unref();
  }

  async function tick(id) {
    const watch = watches.get(id);
    if (!watch) return { ok: false, error: 'watch not found' };
    if (watch.timer) {
      clearTimeoutFn(watch.timer);
      watch.timer = null;
    }

    const now = resolveNow(context.now || Date.now);
    if (now >= Date.parse(watch.expires_at)) {
      watches.delete(watch.id);
      const event = buildWatchEvent(watch, {
        type: 'expired',
        reason: 'timeout',
        atMs: now,
      });
      await handleSupervisorWatchEvent(event, context);
      return { ok: true, event };
    }

    const sample = await readSupervisorWatchSample(watch, context).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!sample.ok) {
      watches.delete(watch.id);
      const event = buildWatchEvent(watch, {
        type: 'failed',
        reason: sample.error || 'session unavailable',
        atMs: now,
      });
      await handleSupervisorWatchEvent(event, context);
      return { ok: false, event, error: event.reason };
    }

    const event = evaluateSupervisorWatch(watch, sample, now);
    updateWatchBaseline(watch, sample);
    if (event) {
      watches.delete(watch.id);
      await handleSupervisorWatchEvent(event, context);
      return { ok: true, event };
    }

    schedule(watch);
    return { ok: true, event: null };
  }

  return { add, cancel, close, list, tick };
}

async function handleSupervisorWatchEvent(event, context) {
  const eventContext = { ...context, asyncOutput: true };
  writeUiBlock(eventContext, `watch ${event.session_name || event.session || event.watch_id}`, [
    `${event.type}: ${event.reason || event.condition}`,
    event.disposition ? `disposition: ${event.disposition}` : '',
    event.excerpt ? `excerpt: ${oneLine(event.excerpt, 220)}` : '',
  ].filter(Boolean));

  const synced = await context.appendMessage({
    role: 'system',
    content: serializeSupervisorWatchEvent(event),
  }, { auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!synced?.ok) {
    context.stderr?.write?.(`mc: supervisor watch event sync failed (${synced?.error || 'unknown error'})\n`);
    return;
  }

  const appended = await appendSupervisorToolResults([supervisorWatchEventToolResult(event)], eventContext);
  if (!appended) return;

  await runSupervisorTurnLoop({ continue: true }, eventContext);
}

function normalizeWatchArgs(rawArgs = {}) {
  const session = typeof rawArgs.session === 'string' ? rawArgs.session.trim() : '';
  if (!session) return { ok: false, error: 'watch session is required' };
  const condition = typeof rawArgs.condition === 'string' ? rawArgs.condition.trim() : '';
  if (!WATCH_CONDITIONS.has(condition)) {
    return { ok: false, error: `watch condition must be one of: ${Array.from(WATCH_CONDITIONS).join(', ')}` };
  }
  return {
    ok: true,
    value: {
      session,
      condition,
      description: oneLine(rawArgs.description || condition, 1000),
      interval_seconds: clampInteger(
        rawArgs.interval_seconds,
        MIN_WATCH_INTERVAL_SECONDS,
        MAX_WATCH_INTERVAL_SECONDS,
        DEFAULT_WATCH_INTERVAL_SECONDS,
      ),
      timeout_minutes: clampInteger(
        rawArgs.timeout_minutes,
        1,
        MAX_WATCH_TIMEOUT_MINUTES,
        DEFAULT_WATCH_TIMEOUT_MINUTES,
      ),
    },
  };
}

async function readSupervisorWatchSample(watch, context) {
  const resolved = await resolveLocalSupervisorSession(watch.session, { request: context.request });
  if (!resolved?.ok) return { ok: false, error: resolved?.error || 'session unavailable' };
  const shouldReadOutput = watch.condition !== 'state_change';
  const output = shouldReadOutput
    ? await context.readOutput(resolved.id, resolved.session).catch(() => '')
    : '';
  const cleanedOutput = cleanSessionOutput(output || '');
  const snapshot = buildWatchSnapshot({
    sessions: [resolved.session],
    outputs: new Map([[resolved.id, cleanedOutput]]),
    includeDead: true,
    excludeWorktreeNames: [],
    onlyDispositions: [],
    now: resolveNow(context.now || Date.now),
  });
  const session = snapshot.sessions?.[0] || {
    id: resolved.id,
    name: resolved.session.name || resolved.session.label || null,
    state: resolved.session.state || resolved.session.session_state || null,
    disposition: null,
  };
  return {
    ok: true,
    session,
    output: truncateToolText(cleanedOutput, DEFAULT_READ_TOOL_CHARS),
  };
}

function evaluateSupervisorWatch(watch, sample, nowMs) {
  const session = sample.session || {};
  const disposition = session.disposition || null;
  const state = session.state || null;
  const output = sample.output || '';
  const outputChanged = !!output && output !== watch.last_output;
  const stateChanged = state !== watch.last_state || disposition !== watch.last_disposition;
  const seenWorking = watch.seen_working || watch.last_disposition === 'working' || disposition === 'working';
  const triggerLikeDone = WATCH_TRIGGER_DISPOSITIONS.has(disposition);

  if (watch.condition === 'done_or_review' && triggerLikeDone) {
    return buildWatchEvent(watch, {
      type: 'triggered',
      reason: stateChanged ? 'session status changed' : 'session is done or needs review',
      atMs: nowMs,
      sample,
    });
  }

  if (watch.condition === 'state_change' && stateChanged) {
    return buildWatchEvent(watch, {
      type: 'triggered',
      reason: 'session state changed',
      atMs: nowMs,
      sample,
    });
  }

  if (watch.condition === 'new_output_matching' && outputChanged) {
    return buildWatchEvent(watch, {
      type: 'triggered',
      reason: 'new matching output observed',
      atMs: nowMs,
      sample,
    });
  }

  if (watch.condition === 'idle_after_work' && seenWorking && triggerLikeDone) {
    return buildWatchEvent(watch, {
      type: 'triggered',
      reason: 'session became idle after working',
      atMs: nowMs,
      sample,
    });
  }

  return null;
}

function updateWatchBaseline(watch, sample) {
  const session = sample.session || {};
  watch.last_state = session.state || null;
  watch.last_disposition = session.disposition || null;
  watch.last_output = sample.output || '';
  if (session.disposition === 'working') watch.seen_working = true;
}

function buildWatchEvent(watch, {
  type,
  reason,
  atMs,
  sample = null,
} = {}) {
  const session = sample?.session || {};
  const output = cleanSessionOutput(sample?.output || '');
  const signal = supervisorLatestSignal({ ...session, latest_text: output || session.latest_text }, 260);
  const triage = buildSupervisorTriageCard({ ...session, latest_text: output || session.latest_text }, signal);
  const inspect = buildSupervisorInspectPacketFromSession({ ...session, latest_text: output || session.latest_text }, output, {
    maxOutputChars: 1000,
  });
  return {
    id: newSupervisorWatchEventId(),
    watch_id: watch.id,
    type,
    reason,
    condition: watch.condition,
    description: watch.description,
    session: watch.session,
    session_id: session.id || watch.session_id || null,
    session_name: session.name || watch.session_name || watch.session,
    disposition: session.disposition || watch.last_disposition || null,
    state: session.state || watch.last_state || null,
    triggered_at: new Date(atMs || Date.now()).toISOString(),
    triage,
    inspect,
    evidence_excerpt: inspect.work.latest_signal || null,
    excerpt: output ? truncateToolText(output, 1000) : '',
  };
}

function serializeSupervisorWatchEvent(event) {
  return `mc watch event\n${JSON.stringify({
    id: event.id,
    watch_id: event.watch_id,
    type: event.type,
    reason: event.reason,
    condition: event.condition,
    description: event.description,
    session: event.session,
    session_id: event.session_id,
    session_name: event.session_name,
    disposition: event.disposition,
    state: event.state,
    triggered_at: event.triggered_at,
    triage: event.triage || null,
    evidence_excerpt: event.evidence_excerpt || null,
    excerpt: event.excerpt ? truncateToolText(event.excerpt, 1000) : '',
  })}`;
}

function supervisorWatchEventToolResult(event = {}) {
  return {
    call_id: event.id || newSupervisorWatchEventId(),
    tool: 'sessions.inspect',
    ok: true,
    session: event.session || event.session_name || null,
    session_id: event.session_id || null,
    inspect: event.inspect || null,
    evidence_excerpt: event.evidence_excerpt || null,
    source: 'watch_event',
    watch_id: event.watch_id || null,
    watch_condition: event.condition || null,
  };
}

function publicWatch(watch) {
  return {
    id: watch.id,
    session: watch.session,
    session_id: watch.session_id,
    session_name: watch.session_name,
    condition: watch.condition,
    description: watch.description,
    interval_seconds: watch.interval_seconds,
    timeout_minutes: watch.timeout_minutes,
    created_at: watch.created_at,
    expires_at: watch.expires_at,
  };
}

async function syncSupervisorSnapshot(snapshot, context) {
  if (!context.supervisorAuth || context.opts.local) return;
  const compact = compactSnapshotForSupervisorSync(snapshot);
  const result = await context.syncSnapshot(compact, { auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!result?.ok) {
    context.stderr.write(`mc: supervisor sync failed (${result?.error || 'unknown error'})\n`);
  }
}

function normalizeSupervisorRun(run = {}) {
  return {
    id: typeof run.id === 'string' ? run.id : null,
    status: typeof run.status === 'string' ? run.status : 'completed',
    response: oneLine(run.response || '', 2000),
    tool_calls: Array.isArray(run.tool_calls)
      ? run.tool_calls.map(normalizeSupervisorToolCall).filter(Boolean)
      : [],
  };
}

function normalizeSupervisorToolCall(call) {
  if (!call || typeof call !== 'object') return null;
  const tool = String(call.tool || '');
  if (!['sessions.list', 'sessions.triage', 'sessions.inspect', 'sessions.read', 'sessions.send', 'sessions.watch'].includes(tool)) return null;
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const session = typeof args.session === 'string' ? args.session.trim() : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  const condition = typeof args.condition === 'string' ? args.condition.trim() : '';
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if ((tool === 'sessions.inspect' || tool === 'sessions.read' || tool === 'sessions.send' || tool === 'sessions.watch') && !session) return null;
  if (tool === 'sessions.send' && !message) return null;
  if (tool === 'sessions.watch' && !WATCH_CONDITIONS.has(condition)) return null;
  return {
    id: typeof call.id === 'string' && call.id.trim() ? call.id.trim() : `call_${Date.now().toString(36)}`,
    tool,
    args: {
      session: (tool === 'sessions.list' || tool === 'sessions.triage') ? null : session,
      message: tool === 'sessions.send' ? message : null,
      max_output_chars: Number.isFinite(Number(args.max_output_chars))
        ? Math.max(500, Math.min(12000, Math.round(Number(args.max_output_chars))))
        : null,
      condition: tool === 'sessions.watch' ? condition : null,
      description: tool === 'sessions.watch' ? description : null,
      interval_seconds: tool === 'sessions.watch'
        ? clampInteger(args.interval_seconds, MIN_WATCH_INTERVAL_SECONDS, MAX_WATCH_INTERVAL_SECONDS, DEFAULT_WATCH_INTERVAL_SECONDS)
        : null,
      timeout_minutes: tool === 'sessions.watch'
        ? clampInteger(args.timeout_minutes, 1, MAX_WATCH_TIMEOUT_MINUTES, DEFAULT_WATCH_TIMEOUT_MINUTES)
        : null,
    },
    reason: typeof call.reason === 'string' ? oneLine(call.reason, 500) : '',
  };
}

function serializeSupervisorToolResults(results = []) {
  const compact = results.map((result) => {
    if (!result?.output) return result;
    return {
      ...result,
      output: truncateToolText(result.output, 3000),
    };
  });
  let content = `mc tool results\n${JSON.stringify({
    generated_at: new Date().toISOString(),
    results: compact,
  })}`;
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const reduced = compact.map((result) => (
    result?.output ? { ...result, output: truncateToolText(result.output, 1000) } : result
  ));
  content = `mc tool results\n${JSON.stringify({
    generated_at: new Date().toISOString(),
    results: reduced,
  })}`;
  return truncateToolText(content, MAX_TOOL_RESULT_CHARS);
}

function truncateToolText(value, max) {
  const text = String(value || '').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function newSupervisorClientMessageId() {
  return `terminal:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function newSupervisorWatchId() {
  return `watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newSupervisorWatchEventId() {
  return `watch_evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function loadSupervisorConversation(context) {
  if (!context.supervisorAuth || context.opts.local) return null;
  const result = await context.getConversation({ auth: context.supervisorAuth }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
    status: err.status,
  }));
  if (!result?.ok) {
    const recovery = result?.status === 401 || result?.status === 403
      ? ' Run `mc supervisor logout` and retry.'
      : '';
    context.stderr.write(`mc: supervisor conversation unavailable (${result?.error || 'unknown error'}).${recovery}\n`);
    return null;
  }
  return result.conversation || null;
}

export function renderSupervisorConversation(conversation = {}) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages.slice(-5) : [];
  if (!messages.length) return '';
  const out = [];
  out.push('online conversation');
  out.push(`revision ${conversation.revision || 0}`);
  for (const message of messages) {
    out.push(`  ${message.role || 'message'}: ${oneLine(message.content, 140)}`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

export function compactSnapshotForSupervisorSync(snapshot = {}) {
  return {
    ok: snapshot.ok !== false,
    generated_at: snapshot.generated_at,
    counts: snapshot.counts || {},
    sessions: Array.isArray(snapshot.sessions)
      ? snapshot.sessions.map(compactSupervisorSession).filter(Boolean)
      : [],
  };
}

function buildSupervisorTriageSnapshot(snapshot = {}) {
  return {
    ...compactSnapshotForSupervisorSync(snapshot),
    sessions: Array.isArray(snapshot.sessions)
      ? snapshot.sessions.map((session) => compactSupervisorTriageSession(session)).filter(Boolean)
      : [],
  };
}

function compactSupervisorSession(session) {
  if (!session?.id) return null;
  return {
    id: session.id,
    name: session.name || null,
    tool: session.tool || null,
    worktree_name: session.worktree_name || null,
    state: session.state || null,
    attachable: session.attachable === true,
    disposition: session.disposition || null,
    last_output_at: session.last_output_at || null,
    last_input_at: session.last_input_at || null,
    last_output_age_seconds: session.last_output_age_seconds ?? null,
    current_branch: session.current_branch || null,
    dirty_files: finiteNumber(session.dirty_files),
    ahead: finiteNumber(session.ahead),
    behind: finiteNumber(session.behind),
    open_question: session.open_question === true,
    safety_verdict: session.safety_verdict || null,
    lifecycle: buildSupervisorLifecycle(session),
  };
}

function compactSupervisorTriageSession(session) {
  const compact = compactSupervisorSession(session);
  if (!compact) return null;
  const signal = supervisorLatestSignal(session, 260);
  return {
    ...compact,
    latest_signal: signal,
    triage: buildSupervisorTriageCard(session, signal),
  };
}

function buildSupervisorInspectPacket(resolved, output, context, { maxOutputChars = DEFAULT_READ_TOOL_CHARS } = {}) {
  const snapshot = buildWatchSnapshot({
    sessions: [resolved.session],
    outputs: new Map([[resolved.id, output || '']]),
    includeDead: true,
    excludeWorktreeNames: [],
    onlyDispositions: [],
    now: resolveNow(context.now || Date.now),
  });
  const registryEntries = readSupervisorRegistryEntries(context.readRegistry || defaultReadRegistry);
  const session = attachSupervisorRegistryMetadata(snapshot.sessions?.[0] || {
    id: resolved.id,
    name: resolved.session.name || resolved.session.label || resolved.id,
    state: resolved.session.session_state || resolved.session.state || 'unknown',
    disposition: null,
    latest_text: output || '',
  }, registryEntries);
  return buildSupervisorInspectPacketFromSession(session, output, { maxOutputChars });
}

function buildSupervisorInspectPacketFromSession(session = {}, output = '', { maxOutputChars = DEFAULT_READ_TOOL_CHARS } = {}) {
  const signal = supervisorLatestSignal(session, 500);
  const status = supervisorWorkStatus(session, signal);
  return {
    contract: {
      purpose: 'decision packet for one session',
      list_is_inventory_only: true,
      triage_is_priority_only: true,
      lifecycle_is_not_approval: true,
    },
    session: compactSupervisorSession(session),
    lifecycle: buildSupervisorLifecycle(session),
    work: {
      status,
      needs_user: session.open_question === true
        || session.disposition === 'awaiting_reply'
        || session.disposition === 'review_suggested',
      open_question: session.open_question === true,
      latest_signal: signal || null,
      suggested_user_reply: session.recommended_reply ? oneLine(session.recommended_reply, 500) : null,
      blocker_or_failure: looksLikeFailureSignal(signal),
    },
    delivery: buildSupervisorDeliveryAssessment(session, signal),
    git: compactSupervisorGitState(session),
    evidence: {
      level: output ? 'session_output_excerpt' : 'status_only',
      source: 'local_session_output',
      output_excerpt: truncateToolText(output || '', maxOutputChars),
    },
    limits: supervisorDecisionLimits(session, signal),
  };
}

function buildSupervisorLifecycle(session = {}) {
  return {
    state: session.state || session.session_state || null,
    disposition: session.disposition || null,
    attachable: session.attachable === true,
    close_readiness: supervisorSessionCloseReadiness(session),
    safety_verdict: session.safety_verdict || null,
    last_output_age_seconds: session.last_output_age_seconds ?? null,
  };
}

function buildSupervisorTriageCard(session = {}, signal = '') {
  const status = supervisorWorkStatus(session, signal);
  const rank = supervisorPriorityRank(session, signal);
  return {
    status,
    priority: priorityLabel(rank),
    priority_rank: rank,
    needs_user: session.open_question === true
      || session.disposition === 'awaiting_reply'
      || session.disposition === 'review_suggested',
    focus_reason: supervisorFocusReason(session, status, signal),
    next_probe: supervisorNextProbe(session, status, signal),
    confidence: signal ? 'medium' : 'low',
    evidence_level: signal ? 'session_output_excerpt' : 'status_only',
    not_a_delivery_decision: true,
  };
}

function buildSupervisorDeliveryAssessment(session = {}, signal = '') {
  return {
    status: supervisorDeliveryStatus(session, signal),
    merge_readiness: supervisorMergeReadiness(session, signal),
    approval_evidence: supervisorApprovalEvidence(signal),
    exact_next_action: supervisorDeliveryNextAction(session, signal),
    cannot_conclude_from: [
      'SAFE_TO_END',
      'dirty_files',
      'idle_or_stale_state',
      'safety_verdict',
      'absence_of_known_blockers',
    ],
  };
}

function supervisorWorkStatus(session, signal = '') {
  if (session.open_question === true || session.disposition === 'awaiting_reply') return 'needs_user_reply';
  if (session.disposition === 'review_suggested') return 'review_suggested';
  if (session.disposition === 'working') return 'working';
  if (session.disposition === 'dead') return 'dead';
  if (session.safety_verdict === 'HAS_UNMERGED_WORK') return 'has_unmerged_work';
  if (session.safety_verdict === 'NEEDS_REVIEW') return 'needs_review';
  if (looksLikeFailureSignal(signal)) return 'blocked_or_failed';
  if (looksLikeCompletionSignal(signal)) return 'ready_to_review';
  if (session.disposition === 'stale_idle') return 'stale_idle';
  if (session.disposition === 'idle') return 'idle';
  return session.disposition || 'unknown';
}

function supervisorPriorityRank(session, signal = '') {
  const status = supervisorWorkStatus(session, signal);
  if (status === 'needs_user_reply') return 100;
  if (status === 'review_suggested' || status === 'needs_review') return 90;
  if (status === 'blocked_or_failed') return 85;
  if (status === 'has_unmerged_work') return 75;
  if (status === 'ready_to_review') return 70;
  if (status === 'idle') return 50;
  if (status === 'working') return 30;
  if (status === 'stale_idle') return 25;
  if (status === 'dead') return 5;
  return 20;
}

function supervisorFocusReason(session, status, signal = '') {
  if (status === 'needs_user_reply') return 'session is waiting for a user answer';
  if (status === 'review_suggested' || status === 'needs_review') return 'session produced review-worthy output';
  if (status === 'blocked_or_failed') return 'latest output looks blocked or failed';
  if (status === 'has_unmerged_work') return 'registry reports unmerged work';
  if (status === 'ready_to_review') return 'latest output claims completion or review readiness';
  if (status === 'working') return 'session is actively working';
  if (status === 'stale_idle') return 'session has been idle long enough to inspect or close';
  if (looksLikePrSignal(signal)) return 'latest output mentions PR or CI state';
  return 'session may be relevant but has no strong triage signal';
}

function supervisorNextProbe(session, status, signal = '') {
  if (session.recommended_reply) return 'answer_or_delegate';
  if (status === 'working') return 'watch_or_wait';
  if (status === 'stale_idle') return 'inspect_then_close_or_refresh';
  if (status === 'needs_user_reply') return 'inspect_or_answer';
  if (status === 'blocked_or_failed') return 'inspect_then_unblock';
  if (looksLikePrSignal(signal)) return 'inspect_then_check_pr_ci';
  return 'inspect';
}

function supervisorDeliveryStatus(session = {}, signal = '') {
  if (looksLikeFailureSignal(signal)) return 'blocked_or_failed';
  if (looksLikePrSignal(signal)) return 'mentions_pr_or_ci';
  if (looksLikeCompletionSignal(signal) || session.disposition === 'review_suggested') return 'needs_content_review';
  return 'not_assessed';
}

function supervisorMergeReadiness(session = {}, signal = '') {
  if (looksLikePrSignal(signal) || session.safety_verdict === 'HAS_UNMERGED_WORK') return 'needs_pr_or_ci_check';
  if (looksLikeCompletionSignal(signal) || session.disposition === 'review_suggested') return 'needs_content_review';
  return 'not_assessed';
}

function supervisorApprovalEvidence(signal = '') {
  if (!signal) return 'none';
  if (looksLikePrSignal(signal)) return 'session_output_mentions_pr_or_ci';
  if (looksLikeCompletionSignal(signal)) return 'session_output_claims_completion';
  return 'session_output_excerpt';
}

function supervisorDeliveryNextAction(session = {}, signal = '') {
  if (!signal) return 'inspect latest output before recommending approval or merge';
  if (looksLikeFailureSignal(signal)) return 'send a concrete unblock/fix instruction or take over';
  if (looksLikePrSignal(signal)) return 'check PR and CI state before recommending merge/deploy';
  if (looksLikeCompletionSignal(signal) || session.disposition === 'review_suggested') {
    return 'review output against the original goal; then approve, close, or send a correction';
  }
  return 'read enough context to decide whether this matters';
}

function supervisorSessionCloseReadiness(session = {}) {
  if (session.safety_verdict === 'SAFE_TO_END') return 'safe_to_end_after_user_decision';
  if (session.safety_verdict === 'HAS_UNMERGED_WORK') return 'has_unmerged_work';
  if (session.safety_verdict === 'NEEDS_REVIEW') return 'needs_review';
  return 'unknown';
}

function supervisorDecisionLimits(session = {}, signal = '') {
  const limits = [];
  if (!signal) limits.push('no_recent_output_evidence');
  limits.push('status_dirty_files_and_safety_verdict_are_not_merge_approval');
  if (session.safety_verdict === 'SAFE_TO_END') limits.push('safe_to_end_is_not_merge_ready');
  return limits;
}

function compactSupervisorGitState(session = {}) {
  return {
    branch: session.current_branch || null,
    dirty_files: finiteNumber(session.dirty_files),
    ahead: finiteNumber(session.ahead),
    behind: finiteNumber(session.behind),
    safety_verdict: session.safety_verdict || null,
  };
}

function supervisorLatestSignal(session = {}, max = 260) {
  return oneLine(session.recommended_reply || session.latest_text || '', max);
}

function priorityLabel(rank) {
  if (rank >= 85) return 'high';
  if (rank >= 50) return 'medium';
  return 'low';
}

function looksLikeFailureSignal(text = '') {
  return /\b(failed|failing|error|blocked|timeout|cannot|missing|crash|exception|stacktrace|test failure|tests? failed|kan inte|saknas|felar)\b/i.test(text);
}

function looksLikeCompletionSignal(text = '') {
  return /\b(done|klar|klart|ready for review|tests? passed|verifierat|validated|commit|pushad|pushed|merged|mergead|deploy(?:ed)?|PR #\d+)\b/i.test(text);
}

function looksLikePrSignal(text = '') {
  return /\b(PR #\d+|pull request|checks?|merge|merged|mergead|ready for review)\b/i.test(text);
}

function readSupervisorRegistryEntries(readRegistryFn = defaultReadRegistry) {
  try {
    const reg = readRegistryFn?.();
    return Array.isArray(reg?.entries) ? reg.entries : [];
  } catch {
    return [];
  }
}

function attachSupervisorRegistryMetadata(session, entries = []) {
  const entry = findSupervisorRegistryEntry(session, entries);
  if (!entry) return session;
  return {
    ...session,
    registry_name: entry.name || null,
    label: session.label || entry.label || null,
    current_branch: entry.current_branch || entry.branch || session.current_branch || null,
    dirty_files: finiteNumber(entry.dirty_files ?? session.dirty_files),
    ahead: finiteNumber(entry.ahead ?? session.ahead),
    behind: finiteNumber(entry.behind ?? session.behind),
    open_question: entry.open_question === true || session.open_question === true,
    safety_verdict: entry.safety_verdict || session.safety_verdict || null,
  };
}

function findSupervisorRegistryEntry(session = {}, entries = []) {
  const id = session.id || session.coding_session_id || null;
  const name = session.name || session.label || session.worktree_name || null;
  const worktree = session.worktree_name || localWorktreeName(session.cwd) || null;
  if (id) {
    const exactId = entries.filter((entry) => entry.coding_session_id === id);
    if (exactId.length === 1) return exactId[0];
    if (exactId.length > 1) return null;
  }
  const cwd = normalizeSupervisorPath(session.cwd || session.worktree_path);
  if (cwd) {
    const exactPath = entries.filter((entry) => (
      normalizeSupervisorPath(entry.worktree_path) === cwd
    ));
    if (exactPath.length === 1) return exactPath[0];
    if (exactPath.length > 1) return null;
  }
  const names = new Set([name, worktree].filter(Boolean));
  const named = entries.filter((entry) => (
    !entry.session_id && !entry.repository_id && names.has(entry.name)
  ));
  return named.length === 1 ? named[0] : null;
}

function normalizeSupervisorPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/[/\\]+$/u, '');
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function oneLine(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function supervisorSections(sessions) {
  const sections = [
    { title: 'Needs reply', dispositions: ['awaiting_reply'] },
    { title: 'Review suggested', dispositions: ['review_suggested'] },
    { title: 'Working', dispositions: ['working'] },
    { title: 'Idle', dispositions: ['idle'] },
    { title: 'Stale idle', dispositions: ['stale_idle'] },
    { title: 'Dead', dispositions: ['dead'] },
  ];
  return sections.map((section) => ({
    ...section,
    sessions: sessions.filter((session) => section.dispositions.includes(session.disposition)),
  }));
}

function formatSupervisorSessionRow(session) {
  const name = truncateCell(session.name || session.id || 'session', 22);
  const age = truncateCell(formatAge(session.last_output_age_seconds) || '-', 8);
  const state = truncateCell(session.state || '-', 7);
  const note = oneLine(session.recommended_reply || session.latest_text || '', 78) || '-';
  return `  ${padRight(name, 22)}  ${padRight(age, 8)}  ${padRight(state, 7)}  ${note}`;
}

function formatSupervisorCounts(counts) {
  const order = ['awaiting_reply', 'review_suggested', 'working', 'idle', 'stale_idle', 'dead'];
  return order
    .filter((key) => counts[key])
    .map((key) => `${key}=${counts[key]}`)
    .join(' ');
}

function formatAge(seconds) {
  if (typeof seconds !== 'number') return null;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatRemaining(isoTime, now = Date.now) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return '-';
  const remainingSeconds = Math.max(0, Math.round((timestamp - resolveNow(now)) / 1000));
  if (remainingSeconds < 60) return `${remainingSeconds}s`;
  if (remainingSeconds < 3600) return `${Math.floor(remainingSeconds / 60)}m`;
  if (remainingSeconds < 86400) return `${Math.floor(remainingSeconds / 3600)}h`;
  return `${Math.floor(remainingSeconds / 86400)}d`;
}

function truncateCell(value, width) {
  const text = oneLine(value, width);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function padRight(value, width) {
  const text = String(value || '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function readSession(rest, context) {
  const { identifier, error } = parseIdentifierRest(rest, 'read');
  if (error) {
    context.stderr.write(`mc: ${error}\n`);
    return { exit: false, code: 2 };
  }
  const resolved = await resolveLocalSupervisorSession(identifier, { request: context.request }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!resolved.ok) {
    context.stderr.write(`mc: ${resolved.error}\n`);
    return { exit: false, code: 1 };
  }
  const output = await context.readOutput(resolved.id, resolved.session).catch((err) => {
    context.stderr.write(`mc: read failed: ${err.message || String(err)}\n`);
    return null;
  });
  if (output == null) return { exit: false, code: 1 };
  const label = resolved.session.name || resolved.session.label || resolved.id;
  context.stdout.write(`--- ${label} (${resolved.id}) ---\n`);
  context.stdout.write((String(output || '').trim() || '(no recent output)') + '\n');
  return { exit: false, code: 0 };
}

async function sendSession(rest, context) {
  const { identifier, message, error } = parseSendRest(rest);
  if (error) {
    context.stderr.write(`mc: ${error}\n`);
    return { exit: false, code: 2 };
  }
  const result = await context.dispatch(identifier, message).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!result?.ok) {
    context.stderr.write(`mc: send failed: ${result?.error || 'local dispatch failed'}\n`);
    return { exit: false, code: 1 };
  }
  context.stdout.write(`sent to ${result.id}\n`);
  return { exit: false, code: 0 };
}

async function controlSession(action, rest, context) {
  const parsed = parseControlRest(rest, action);
  if (parsed.error) {
    context.stderr.write(`mc: ${parsed.error}\n`);
    return { exit: false, code: 2 };
  }
  const resolved = await resolveLocalSupervisorSession(parsed.identifier, { request: context.request }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!resolved.ok) {
    context.stderr.write(`mc: ${resolved.error}\n`);
    return { exit: false, code: 1 };
  }
  if (!parsed.yes) {
    const ok = await context.confirm(`${action} ${resolved.session.name || resolved.id}? [y/N] `);
    if (!ok) {
      context.stdout.write(`${action} cancelled\n`);
      return { exit: false, code: 0 };
    }
  }
  const result = await context.control(resolved.id, {
    action,
    signal: parsed.signal,
  }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!result?.ok) {
    context.stderr.write(`mc: ${action} failed: ${result?.error || 'local control failed'}\n`);
    return { exit: false, code: 1 };
  }
  context.stdout.write(`${action === 'stop' ? 'stopped' : 'removed'} ${result.id}\n`);
  return { exit: false, code: 0 };
}

function parseOnlyDispositions(value) {
  const values = [];
  for (const raw of String(value || '').split(',')) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (ONLY_ALIASES[key]) values.push(...ONLY_ALIASES[key]);
    else if (DISPOSITIONS.includes(key)) values.push(key);
    else return { error: `--only must be actionable, active, or one of: ${DISPOSITIONS.join(', ')}` };
  }
  if (!values.length) return { error: '--only requires at least one disposition' };
  return { values: [...new Set(values)] };
}

function splitCommand(line) {
  const match = String(line || '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    command: (match?.[1] || '').toLowerCase(),
    rest: match?.[2] || '',
  };
}

function parseIdentifierRest(rest, command) {
  const trimmed = String(rest || '').trim();
  if (!trimmed) return { error: `usage: ${command} <label|id>` };
  const [identifier, ...extra] = trimmed.split(/\s+/);
  if (extra.length) return { error: `usage: ${command} <label|id>` };
  return { identifier };
}

function parseSendRest(rest) {
  const trimmed = String(rest || '').trim();
  if (!trimmed) return { error: 'usage: send <label|id> <message>' };
  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match?.[1] || !match?.[2]?.trim()) return { error: 'usage: send <label|id> <message>' };
  return { identifier: match[1], message: match[2].trim() };
}

function parseControlRest(rest, action) {
  const opts = { identifier: null, signal: 'SIGTERM', yes: false };
  const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const arg = parts[i];
    if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
      continue;
    }
    if (arg === '--signal') {
      const next = parts[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--signal requires a value' };
      opts.signal = next;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    if (opts.identifier) return { ...opts, error: `usage: ${action} <label|id> [--yes]` };
    opts.identifier = arg;
  }
  if (!opts.identifier) return { ...opts, error: `usage: ${action} <label|id> [--yes]` };
  if (action !== 'stop') opts.signal = undefined;
  return opts;
}

function isReadableSession(session, opts) {
  if (!session?.id && !session?.coding_session_id) return false;
  if (session.session_state === 'dead' && !opts.includeDead) return false;
  return session.attachable !== false;
}

function directSessionMatch(session, identifier) {
  return session?.id === identifier || session?.coding_session_id === identifier;
}

function namedSessionMatch(session, identifier) {
  return session?.name === identifier
    || session?.label === identifier
    || localWorktreeName(session?.cwd) === identifier;
}

function sessionId(session) {
  return session?.id || session?.coding_session_id || null;
}

function localWorktreeName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || null;
}

function compareRecentSessions(a, b) {
  return timestampOf(b) - timestampOf(a);
}

function timestampOf(session) {
  const value = session?.last_output_at || session?.lastOutputAt || session?.last_input_at || session?.lastInputAt || '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveNow(now) {
  return typeof now === 'function' ? now() : now;
}

function isInteractive(input, output, deps) {
  if (typeof deps.isInteractive === 'boolean') return deps.isInteractive;
  return input?.isTTY === true && output?.isTTY === true;
}

async function askConfirmation(rl, question) {
  let answer;
  try {
    answer = await rl.question(question);
  } catch (err) {
    if (isReadlineAbortError(err) || isReadlineClosedError(err)) return false;
    throw err;
  }
  return /^(y|yes|j|ja)$/i.test(String(answer || '').trim());
}
