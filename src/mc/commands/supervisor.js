import { createInterface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from 'node:process';

import {
  controlLocalBrokerSession,
  dispatchLocalBrokerSession,
} from '../../bin-mc.js';
import { requestBroker as defaultRequestBroker } from '../broker/client.js';
import { readLocalSessionOutput } from '../broker/cloud.js';
import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from '../broker/session-hosts.js';
import {
  buildWatchSnapshot,
} from './sessions-watch.js';
import {
  appendSupervisorMessage as defaultAppendSupervisorMessage,
  ensureSupervisorAuth as defaultEnsureSupervisorAuth,
  getSupervisorConversation as defaultGetSupervisorConversation,
  logoutSupervisor as defaultLogoutSupervisor,
  runSupervisorTurn as defaultRunSupervisorTurn,
  syncSupervisorSnapshot as defaultSyncSupervisorSnapshot,
} from '../supervisor-auth.js';

const DEFAULT_OUTPUT_TIMEOUT_MS = 750;
const MAX_SUPERVISOR_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 6000;
const DEFAULT_READ_TOOL_CHARS = 4000;
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

  const rl = createInterface({ input, output: stdout, terminal: true });
  try {
    const interactiveContext = {
      ...context,
      confirm: deps.confirm || ((question) => askConfirmation(rl, question)),
    };
    stdout.write('mc supervisor\n');
    stdout.write('session control plane\n\n');
    const conversation = await loadSupervisorConversation(interactiveContext);
    if (conversation) stdout.write(renderSupervisorConversation(conversation));
    const initialSnapshot = await collectSupervisorSnapshot(interactiveContext);
    await syncSupervisorSnapshot(initialSnapshot, interactiveContext);
    stdout.write(renderSupervisorSnapshot(initialSnapshot));
    stdout.write('\nType `help` for commands.\n');

    for (;;) {
      const line = await rl.question('mc supervisor> ');
      const result = await handleSupervisorLine(line, interactiveContext);
      if (result.exit) return result.code ?? 0;
    }
  } finally {
    rl.close();
  }
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
  if (['list', 'ls', 'watch', 'status'].includes(command)) return writeSnapshot(context);
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

  return buildWatchSnapshot({
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
  return {
    ok: true,
    session: matches[0],
    id: sessionId(matches[0]),
    matchedBy: 'name',
    collisions: matches.length > 1 ? matches.length : 0,
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
  list | watch | status          Refresh the session snapshot
  read <label|id>                Print recent output from one local session
  send <label|id> <message>      Send a message into one local session
  ask <instruction>              Ask the synced supervisor LLM to steer sessions
  stop <label|id> [--yes]        Stop a broker-owned session
  remove <label|id> [--yes]      Remove a broker session from inventory
  <natural language>             Same as ask; the supervisor may list/read/send
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
  const readOutput = deps.readOutput || ((sessionIdValue, session) => readLocalSessionOutput({
    request: requestForSession(session, { request }),
    sessionId: sessionIdValue,
    timeoutMs: opts.outputTimeoutMs,
  }));
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
    supervisorAuth,
  };
}

async function writeSnapshot(context) {
  const snapshot = await collectSupervisorSnapshot(context);
  await syncSupervisorSnapshot(snapshot, context);
  context.stdout.write(renderSupervisorSnapshot(snapshot));
  return { exit: false, code: snapshot.ok === false ? 1 : 0 };
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
  let hadToolCalls = false;

  for (let round = 0; round < MAX_SUPERVISOR_TOOL_ROUNDS; round += 1) {
    const result = await runContext.runSupervisorTurn(nextTurn, { auth: runContext.supervisorAuth }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!result?.ok) {
      context.stderr.write(`mc: supervisor run failed (${result?.error || 'unknown error'})\n`);
      return { exit: false, code: 1 };
    }

    const run = normalizeSupervisorRun(result.run);
    renderSupervisorRun(run, context);
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

  if (hadToolCalls) {
    context.stderr.write(`mc: supervisor stopped after ${MAX_SUPERVISOR_TOOL_ROUNDS} tool rounds; ask again to continue.\n`);
  }
  return { exit: false, code: hadToolCalls ? 1 : 0 };
}

function renderSupervisorRun(run, context) {
  if (run.response) {
    context.stdout.write(`supervisor: ${run.response}\n`);
  } else if (run.tool_calls.length) {
    context.stdout.write(`supervisor: executing ${run.tool_calls.length} tool call${run.tool_calls.length === 1 ? '' : 's'}\n`);
  }
}

async function executeSupervisorToolCall(call, context) {
  if (call.tool === 'sessions.list') {
    const snapshot = await collectSupervisorSnapshot(context);
    await syncSupervisorSnapshot(snapshot, context);
    const compact = compactSnapshotForSupervisorSync(snapshot);
    context.stdout.write(`tool sessions.list -> ${compact.sessions.length} sessions\n`);
    return {
      call_id: call.id,
      tool: call.tool,
      ok: snapshot.ok !== false,
      counts: compact.counts || {},
      sessions: compact.sessions,
      error: snapshot.ok === false ? snapshot.error || 'snapshot failed' : null,
    };
  }

  if (call.tool === 'sessions.read') {
    const resolved = await resolveLocalSupervisorSession(call.args.session, { request: context.request }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!resolved.ok) {
      context.stderr.write(`tool sessions.read -> ${resolved.error}\n`);
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
      context.stderr.write(`tool sessions.read -> ${output.__error}\n`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        session_id: resolved.id,
        error: output.__error,
      };
    }
    const label = resolved.session.name || resolved.session.label || resolved.id;
    context.stdout.write(`tool sessions.read -> ${label} (${resolved.id})\n`);
    return {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      session: call.args.session,
      session_id: resolved.id,
      output: truncateToolText(output || '', call.args.max_output_chars || DEFAULT_READ_TOOL_CHARS),
    };
  }

  if (call.tool === 'sessions.send') {
    const result = await context.dispatch(call.args.session, call.args.message).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!result?.ok) {
      context.stderr.write(`tool sessions.send -> ${result?.error || 'local dispatch failed'}\n`);
      return {
        call_id: call.id,
        tool: call.tool,
        ok: false,
        session: call.args.session,
        error: result?.error || 'local dispatch failed',
      };
    }
    context.stdout.write(`tool sessions.send -> sent to ${result.id}\n`);
    return {
      call_id: call.id,
      tool: call.tool,
      ok: true,
      session: call.args.session,
      session_id: result.id,
      message_length: call.args.message.length,
    };
  }

  return {
    call_id: call.id,
    tool: call.tool,
    ok: false,
    error: `unsupported tool: ${call.tool}`,
  };
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
  if (!['sessions.list', 'sessions.read', 'sessions.send'].includes(tool)) return null;
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const session = typeof args.session === 'string' ? args.session.trim() : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if ((tool === 'sessions.read' || tool === 'sessions.send') && !session) return null;
  if (tool === 'sessions.send' && !message) return null;
  return {
    id: typeof call.id === 'string' && call.id.trim() ? call.id.trim() : `call_${Date.now().toString(36)}`,
    tool,
    args: {
      session: tool === 'sessions.list' ? null : session,
      message: tool === 'sessions.send' ? message : null,
      max_output_chars: Number.isFinite(Number(args.max_output_chars))
        ? Math.max(500, Math.min(12000, Math.round(Number(args.max_output_chars))))
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

function newSupervisorClientMessageId() {
  return `terminal:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
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
  };
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
  const answer = await rl.question(question);
  return /^(y|yes|j|ja)$/i.test(String(answer || '').trim());
}
