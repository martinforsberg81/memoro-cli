/** A desk's entrance is independent of the provider that keeps its sessions alive. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

import { declared, isSameTool, toolsDeclaring } from '../adapters/index.js';
import { foregroundDir, registerForeground } from './foreground.js';
import { normalizeSessionRole } from './session-role.js';
import { scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { workRoot } from './paths.js';
import { pidAlive } from './status-collect.js';
import { select } from './prompt.js';
import { log } from './logger.js';

const failure = reason => ({ ok: false, reason });
const ENTRANCES = new Set(['plan', 'manager', 'brief', 'martin']);

/** Linux SSH entrances of the four person roles keep their provider alive past the terminal. */
export function entersPersistentSession({ env = process.env, platform = process.platform, isInteractive, verb } = {}) {
  return platform === 'linux' && ENTRANCES.has(verb) && env.MC_HEADLESS !== '1'
    && Boolean(env.SSH_CONNECTION || env.SSH_TTY) && isInteractive(env);
}

/** The environment of a process mc starts for a desk: nothing a launching shell or an older holder left behind. */
export function terminalEnvironment(env) {
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TERM', 'COLORTERM',
    'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'MC_HOME', 'MC_WORK_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
  return Object.fromEntries(Object.entries(scrubRuntimeSecretsFromEnv(env))
    .filter(([key, value]) => typeof value === 'string' && (allowed.has(key) || /^LC_[A-Z_]+$/u.test(key))));
}

export function readRegister(env, io = fs) {
  const dir = foregroundDir(env);
  let names;
  try { names = io.readdirSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^\d+\.json$/u.test(name)).flatMap(name => {
    try { return [JSON.parse(io.readFileSync(join(dir, name), 'utf8'))]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

/** A register record's desk identity is shared by discovery and pending-start recovery. */
export function recordMatchesDesk(options, record) {
  return isSameTool(record.tool, options.launch?.id || options.tool)
    && normalizeSessionRole(record.role?.name || record.verb) === normalizeSessionRole(options.roleName || options.verb)
    && (record.programme || null) === (options.programme || null)
    && (record.area || null) === (options.areaName || null);
}

/** Both sources must agree: neither a stale record nor an unrelated daemon session is this desk. */
export function deskSessions(options, agents, records, alive = pidAlive) {
  return agents.flatMap(agent => {
    const record = records.find(item => item.pid === agent.pid && recordMatchesDesk(options, item));
    return record && typeof agent.id === 'string' && agent.id && agent.cwd === resolve(options.worktree.path) && alive(agent.pid)
      ? [{ ...agent, started: record.started }] : [];
  });
}

export function sessionName(options, sessions) {
  const base = `mc ${normalizeSessionRole(options.roleName || options.verb)}${options.programme ? ` ${options.programme}` : ''}`;
  const names = new Set(sessions.map(item => item.name));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * Claude's Remote Control flag, with its name as the value. A bare `--remote-control`
 * takes the next positional as its optional name, which would be the opening prompt.
 * The flag leads the argv, so the opening prompt stays the last member.
 */
export function withRemoteControl(args, name) {
  return ['--remote-control', name, ...args];
}

/** Serialise selection through registration, not attachment: two entrances must not resume one transcript. */
export async function lockDesk(options, { io = fs, spawnProcess = spawn } = {}) {
  const root = join(workRoot(options.env), 'runner', 'session-entrance');
  io.mkdirSync(root, { recursive: true, mode: 0o700 });
  const desk = [resolve(workRoot(options.env)), resolve(options.areaRoot),
    normalizeSessionRole(options.roleName || options.verb), options.programme || null];
  const lock = join(root, `${createHash('sha256').update(JSON.stringify(desk)).digest('hex')}.lock`);
  // The Linux runner uses the same pipe-owned flock pattern. An interrupted
  // selector closes its pipe, releasing the kernel lock without stale-pid reaping.
  const child = spawnProcess('/usr/bin/flock', ['--exclusive', '--nonblock', '--close', lock, '/bin/cat'], {
    env: terminalEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false;
  child.once('close', () => { closed = true; });
  return await new Promise((resolveLock, reject) => {
    let ready = false;
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (ready || !output.includes('mc-background-ready\n')) return;
      ready = true;
      let released = false;
      const release = async () => {
        if (!released) { released = true; child.stdin.destroy(); }
        // The holder may still own a copy of the pipe while discovery recovers.
        // Close, do not end: Node's stdio is a socket pair, so end would
        // half-close the holder's inherited endpoint too and unlock its start.
        child.unref?.();
        child.stdout.destroy?.();
        child.stderr?.destroy?.();
      };
      release.pipe = child.stdin;
      resolveLock(release);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error('could not start the persistent desk lock')));
    child.once('close', code => {
      if (!ready) reject(new Error(code === 1
        ? 'another entrance is selecting a persistent session for this desk; retry the entrance'
        : `persistent desk lock exited before acquisition (status ${code ?? 'unknown'})`));
    });
    if (!closed) child.stdin.write('mc-background-ready\n');
  });
}

/** Registration belongs to the provider lifetime, never the attaching client's exit. */
export function registerSession(record, session, { env = process.env, register = registerForeground } = {}) {
  return register({ ...record, pid: session.pid, env, onExit: () => {} });
}

/**
 * Why `--bg` is refused, named as the entrance says it: a tool whose session has no client but the
 * terminal (`tool`, given the tool's id), or an entrance with no persistent path (`terminal`).
 * The tools that can are the ones that declare `BACKGROUND`.
 */
export const BACKGROUND_REFUSALS = Object.freeze({
  tool: (id) => `--bg is for tools whose session outlives the terminal (${toolsDeclaring('BACKGROUND')
    .filter((name) => declared(name, 'BACKGROUND') === true).join(', ')}); a ${declared(id, 'LABEL') || id} session has no client but the terminal`,
  terminal: '--bg needs a configured server or an SSH entrance on Linux; here the session lives in this terminal',
});

/**
 * The conversations a running terminal session holds, as a Map of conversation id to the pid of the
 * session that holds it. A terminal session of a tool that records its own conversation id is held
 * three ways, by what its register row says: the conversation it resumed (`conversation`); the
 * launch nonce its opening message carries, matched to the conversation that has it (`launch`);
 * and, for a row with neither (a launch that carries no marker), every conversation with no nonce
 * that was created at or after the row's `started`. A row whose process is gone holds nothing.
 */
export function heldConversations({ env, areaName = null, items, records = readRegister, alive = pidAlive }) {
  const held = new Map();
  for (const row of records(env)) {
    if (!Number.isInteger(row.pid) || declared(row.tool, 'PERSISTENT_DRIVER') !== 'terminal'
      || (row.area || null) !== (areaName || null) || !alive(row.pid)) continue;
    const mine = items.filter(item => isSameTool(item.tool, row.tool));
    if (row.conversation) held.set(row.conversation, row.pid);
    if (row.launch) for (const item of mine) if (item.nonce === row.launch) held.set(item.id, row.pid);
    if (row.conversation || row.launch) continue;
    const since = Date.parse(row.started);
    for (const item of mine) if (!item.nonce && Number.isFinite(since) && (item.created_ms ?? 0) >= since) held.set(item.id, row.pid);
  }
  return held;
}

/**
 * A terminal tool's selection: the desk lock, held until the caller's register row is written, and
 * the conversations already held. A concurrent selector is refused with the lock's own retry text.
 */
export async function selectTerminal(options, { lock = lockDesk, records = readRegister, alive = pidAlive } = {}) {
  let release;
  try { release = await lock(options); }
  catch (error) { return { result: failure(error.message) }; }
  try {
    return { release, held: heldConversations({ env: options.env, areaName: options.areaName, items: options.items, records, alive }) };
  } catch (error) {
    await release();
    return { result: failure(error.message) };
  }
}

/** The refusal of a conversation a running terminal session holds; nothing was started. */
export function heldRefusal(launch, pid) {
  return { ok: false, code: 2, reason: `this conversation is held by a running ${declared(launch.id, 'LABEL') || launch.id} session (pid ${pid}); no second one was started` };
}

/**
 * `--bg` is the invocation's choice: the session keeps running for its app and the entrance returns
 * with two lines instead of attaching. A remote driver's join is the server half, which decides the
 * same way on its host, so the client only forwards the flag and adds nothing to what the host printed.
 */
export async function joinSession(options, session, driver, {
  alive = pidAlive, stdout = options.stdout || process.stdout } = {}) {
  const resumed = Boolean(options.joining || options.chosen);
  const started = options.starting && !options.chosen ? session.sessionId : null;
  const entrance = `mc ${options.verb}${options.programme ? ` ${options.programme}` : ''}`;
  if (options.bg && !driver.discover) {
    const on = options.host ? ` on ${options.host}` : '';
    stdout.write(`mc: ${session.name} is running${on}. Open it in the Claude app or at claude.ai/code: session "${session.name}".\n`);
    stdout.write(`mc: terminal view: ${entrance}\n`);
    return { ok: true, code: 0, background: session.id, conversation: session.sessionId, running: alive(session.pid),
      resumed, started, kept_nothing: false };
  }
  const result = await driver.join(options, session);
  if (options.bg) {
    return result.error ? failure(`could not reach ${session.name}: ${result.error.message}`)
      : { ok: true, code: result.status ?? 0, background: session.id, conversation: session.sessionId, running: alive(session.pid),
        resumed, started, kept_nothing: false };
  }
  let running;
  try { running = (await driver.list(options)).some(row => row.id === session.id && row.pid === session.pid && alive(row.pid)); }
  catch {
    stdout.write(`mc: could not list provider sessions after attach; rejoin with mc ${options.verb}${options.programme ? ` ${options.programme}` : ''}.\n`);
    return failure('could not list provider sessions after attach');
  }
  stdout.write(`mc: ${session.name} ${running ? 'is still running' : 'has ended'}; ${running ? 'rejoin' : 'open again'} with mc ${options.verb}${options.programme ? ` ${options.programme}` : ''}.\n`);
  log('work.closed', { area: options.areaRoot, tool: options.launch.id, exit_code: result.status ?? 0,
    resumed: options.chosen?.id || (options.joining ? session.sessionId : null),
    started: options.starting && !options.chosen ? session.sessionId : null,
    kept_nothing: false, background_id: session.id, running });
  return result.error ? failure(`could not attach to ${session.name}: ${result.error.message}`)
    : { ok: true, code: result.status ?? 0, background: session.id, conversation: session.sessionId, running,
      resumed: Boolean(options.joining || options.chosen),
      started: options.starting && !options.chosen ? session.sessionId : null, kept_nothing: false };
}

/** Selection stays in the caller's terminal; the detached holder starts and registers the provider. */
export async function prepareSessionEntrance(options, driver, {
  records = readRegister, alive = pidAlive,
  lock = lockDesk, choose = options.choose || select,
} = {}) {
  let release;
  try {
    release = await lock(options);
    const rows = await driver.list(options);
    const sessions = driver.discover ? rows : deskSessions(options, rows, records(options.env), alive);
    const held = new Set(rows.filter(row => driver.discover || (row.cwd === resolve(options.worktree.path) && alive(row.pid))).map(row => row.sessionId).filter(Boolean));
    let selected = options.chosen && sessions.find(session => session.sessionId === options.chosen.id);
    if (!options.chosen && options.pick !== 'new' && sessions.length) {
      const id = choose('join a session, or start a new one?', [
        ...sessions.map((session, index) => ({ key: index + 1, value: session.id, name: session.name,
          label: `${session.name}  started ${session.started}` })),
        { key: sessions.length + 1, value: 'new', name: 'start a new one', label: 'start a new one' },
      ], { stdout: options.stdout || process.stdout });
      if (!id) return { result: { ok: true, code: 0, cancelled: true }, release };
      selected = sessions.find(session => session.id === id);
      if (id !== 'new' && !selected) return { result: failure('the selected session was not listed'), release };
    }
    if (selected) {
      if (options.model || (options.resumeTool && !isSameTool(options.resumeTool, options.launch.id))) {
        return { result: failure('joining an existing session cannot apply --model or a different --tool; start a new one to apply them'), release };
      }
      await release();
      return { result: await joinSession({ ...options, joining: true }, selected, driver, { alive }), release };
    }
    if (options.chosen && held.has(options.chosen.id)) return { result: failure('this conversation is held by a provider process without matching desk registration; no second provider was started'), release };
    return { held, release, start: async plan => {
      const name = sessionName(options, sessions);
      const launched = await driver.start({ ...options, lockPipe: release.pipe }, plan, name);
      await release();
      if (!launched.ok) {
        log('work.open-failed', { area: options.areaRoot, error: launched.reason });
        return launched;
      }
      return await joinSession({ ...options, chosen: plan.chosen, starting: true }, launched.session, driver, { alive });
    } };
  } catch (error) {
    await release?.();
    return { result: failure(error.message) };
  }
}

