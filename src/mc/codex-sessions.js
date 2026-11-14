/**
 * A Codex entrance session is its own `codex app-server`, started by mc and
 * detached from every terminal; the person's terminal runs `codex --remote` as
 * a client of it. The server keeps the conversation when the terminal goes.
 *
 * Everything Codex-specific about the persistent entrance lives here; the desk
 * rules (join or new, naming, one transcript one process) are
 * `session-entrance.js`'s and reach this file only through the driver.
 *
 * A session is a directory under `<work root>/runner/codex-sessions/`, mode
 * 0700, holding the server's socket, its log, `session.json` (who started it,
 * where, and for which conversation) and `clients/` (one file per attached mc).
 * Which conversation the session holds is never remembered: it is read from the
 * session's own server (`codex-rpc.js`), never from another server or from
 * Codex's global store.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writeJsonAtomic } from './atomic-write.js';
import { gatewayLaunch } from './billing-route.js';
import { CodexServerError, readThreads } from './codex-rpc.js';
import { foregroundDir, registerForeground } from './foreground.js';
import { log } from './logger.js';
import { workRoot } from './paths.js';
import { scrubProviderApiKeysFromEnv, scrubRuntimeSecretsFromEnv } from './runtime-secrets.js';
import { registerSession, terminalEnvironment } from './session-entrance.js';
import { pidAlive } from './status-collect.js';

const READY_MS = 15_000;
const READY_ASK_MS = 2_000;
const POLL_MS = 100;
const STOP_MS = 5_000;
const LOG_TAIL_BYTES = 600;
const failure = reason => ({ ok: false, reason });

/** Flags of the TUI that the server has no flag for are the same setting as `-c`. */
const CONFIG_FLAGS = {
  '-m': value => `model=${JSON.stringify(value)}`,
  '--sandbox': value => `sandbox_mode=${JSON.stringify(value)}`,
  '--ask-for-approval': value => `approval_policy=${JSON.stringify(value)}`,
};

/**
 * The launch plan's argv is the TUI's. A session splits it in two: what is
 * configuration goes to the server. Codex 0.168.0 takes a new thread's access
 * from the client, so access flags also stay with a client starting a thread.
 * A remote resume rejects them. Role, model, effort and roots stay server-only.
 */
export function splitLaunchArgs(args) {
  const config = [];
  const access = [];
  const roots = [];
  const positional = [];
  const rest = [...args];
  const resuming = rest[0] === 'resume';
  if (resuming) rest.shift();
  const value = (flag, index) => {
    if (index >= rest.length) throw new Error(`codex launch flag ${flag} has no value`);
    return rest[index];
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-c') config.push(value(arg, ++i));
    else if (arg === '--add-dir') roots.push(value(arg, ++i));
    else if (CONFIG_FLAGS[arg]) {
      const setting = value(arg, ++i);
      config.push(CONFIG_FLAGS[arg](setting));
      if (arg === '--sandbox' || arg === '--ask-for-approval') access.push(arg, setting);
    }
    else if (arg.startsWith('-')) throw new Error(`codex launch flag ${arg} has no app-server equivalent`);
    else positional.push(arg);
  }
  if (roots.length) config.push(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
  if (resuming && !positional.length) throw new Error('codex resume launch names no conversation');
  if (positional.length > (resuming ? 2 : 1)) throw new Error('codex launch has more positional arguments than a conversation and a prompt');
  const [resume, prompt] = resuming ? positional : [null, positional[0]];
  return { config, access, resume, prompt: prompt ?? null };
}

/** Server configuration is root-level `-c`; new-thread access also needs the client flags below. */
export function serverArgs(socket, config) {
  return [...config.flatMap(entry => ['-c', entry]), 'app-server', '--listen', `unix://${socket}`];
}

/** Only a new thread carries access; all other configuration comes from its server. */
export function clientArgs(socket, { resume = null, prompt = null, access = [] } = {}) {
  return [...(resume ? ['resume', resume] : access), '--remote', `unix://${socket}`,
    ...(prompt ? (prompt.startsWith('-') ? ['--', prompt] : [prompt]) : [])];
}

/** The server runs the session's tools: the role's identity, no provider key, no runtime secret. */
export function serverEnvironment(plan) {
  return scrubRuntimeSecretsFromEnv(scrubProviderApiKeysFromEnv(plan.identity));
}

/**
 * Which loaded thread is the session's. A server also loads short-lived helper
 * threads (an ephemeral title thread, spawned agents with a parent); the
 * session's is neither. One that has had a turn (a preview) is the one a later
 * join resumes, then the most recently updated.
 */
export function sessionThread(threads) {
  return threads.filter(thread => !thread.ephemeral && thread.parentThreadId == null)
    .sort((a, b) => Boolean(b.preview) - Boolean(a.preview) || (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

/** A turn is running when any thread the server holds says it is active. */
export const turnRunning = threads => threads.some(thread => thread.status?.type === 'active');

const rootOf = env => join(workRoot(env), 'runner', 'codex-sessions');

/** The socket's directory is the only thing standing between it and another user: refuse one that is not private. */
function createSessionDirectory(env, io) {
  io.mkdirSync(rootOf(env), { recursive: true, mode: 0o700 });
  const directory = io.mkdtempSync(join(rootOf(env), 'session-'));
  io.chmodSync(directory, 0o700);
  const stat = io.statSync(directory);
  if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    io.rmSync(directory, { recursive: true, force: true });
    throw new Error(`session directory ${directory} is not private (mode ${(stat.mode & 0o777).toString(8)}, owner ${stat.uid})`);
  }
  return directory;
}

const sessionFile = directory => join(directory, 'session.json');

function readSession(directory, io) {
  try { return JSON.parse(io.readFileSync(sessionFile(directory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

/** Remove everything a finished session left: its directory and its register entry. */
function forget(session, env, io) {
  io.rmSync(session.directory, { recursive: true, force: true });
  try { io.unlinkSync(join(foregroundDir(env), `${session.pid}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const expiryNotice = directory => join(dirname(directory), `expired-${basename(directory)}.json`);

/** Called by the trusted wrapper only after its server exits. Keep a one-shot expiry notice for the desk. */
export function finishCodexGatewaySession(directory, { expired = false, env = process.env, io = fs, write = writeJsonAtomic } = {}) {
  const session = readSession(directory, io);
  if (!session) return;
  if (expired) write(expiryNotice(directory), { name: session.name, cwd: session.cwd });
  forget({ directory, pid: session.pid }, env, io);
}

function logTail(directory, io) {
  try { return io.readFileSync(join(directory, 'server.log'), 'utf8').slice(-LOG_TAIL_BYTES).trim(); }
  catch { return ''; }
}

/** Mechanics of Codex sessions behind the entrance's driver contract; every boundary is injectable. */
export function codexSessionDriver({
  io = fs, spawnProcess = spawn, run = spawnSync, threads = readThreads, alive = pidAlive,
  register = registerForeground, kill = (pid, signal) => process.kill(pid, signal),
  now = Date.now, sleep = delay, mcPid = process.pid, write = writeJsonAtomic,
} = {}) {
  const waitFor = async (done, ms) => {
    const deadline = now() + ms;
    while (!done()) {
      if (now() >= deadline) return false;
      await sleep(POLL_MS);
    }
    return true;
  };

  async function start(options, plan, name) {
    if (plan.billing.billing === 'unavailable') return failure(`Codex billing unavailable: ${plan.billing.why}`);
    let split;
    try { split = splitLaunchArgs(plan.args); } catch (error) { return failure(error.message); }
    const directory = createSessionDirectory(options.env, io);
    const socket = join(directory, 'app.sock');
    const cwd = resolve(options.worktree.path);
    const abandon = (reason, pid) => {
      if (pid && alive(pid)) { try { kill(pid, 'SIGTERM'); } catch { /* it just exited */ } }
      const tail = logTail(directory, io);
      io.rmSync(directory, { recursive: true, force: true });
      return failure(tail ? `${reason}; server log: ${tail}` : reason);
    };
    // Codex's own provider id: the gateway wrapper is named by the provider it fronts.
    const launch = gatewayLaunch({ provider: 'codex', model: null, bin: options.launch.spec.bin,
      args: serverArgs(socket, split.config), billing: plan.billing.billing, sessionDirectory: directory });
    const output = io.openSync(join(directory, 'server.log'), 'a', 0o600);
    let spawnError = null;
    let child;
    try {
      child = spawnProcess(launch.bin, launch.args, { cwd, env: serverEnvironment(plan), detached: true,
        stdio: ['ignore', output, output] });
      child.once?.('error', error => { spawnError = error; });
      child.unref?.();
    } finally { io.closeSync(output); }
    const pid = child?.pid;
    if (!Number.isInteger(pid)) return abandon(`could not start the Codex server: ${spawnError?.message || 'no process id'}`);
    const session = { name, pid, cwd, socket, resume: split.resume, access: split.access,
      started: new Date(now()).toISOString() };
    write(sessionFile(directory), session);

    let answered = false;
    for (const deadline = now() + READY_MS; !answered;) {
      if (spawnError) return abandon(`could not start the Codex server: ${spawnError.message}`);
      if (!alive(pid)) return abandon(`Codex server exited before answering on its socket ${socket}`);
      try { await threads(socket, { timeoutMs: READY_ASK_MS }); answered = true; }
      catch (error) {
        if (!(error instanceof CodexServerError) || error.kind === 'overflow') return abandon(error.message, pid);
        if (now() >= deadline) return abandon(`Codex server not answering on its socket ${socket} within ${READY_MS} ms`, pid);
        await sleep(POLL_MS);
      }
    }
    log('work.open', plan.openEvent);
    registerSession(plan.record, { pid }, { env: options.env, register });
    return { ok: true, session: { id: directory.slice(rootOf(options.env).length + 1), name, pid, cwd, socket,
      sessionId: split.resume, resume: split.resume, prompt: split.prompt, access: split.access, started: session.started } };
  }

  /** The sessions of this desk's worktree, each read from its own server; dead ones are cleared away. */
  async function list(options) {
    const root = rootOf(options.env);
    let names;
    try { names = io.readdirSync(root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const cwd = resolve(options.worktree.path);
    const rows = [];
    for (const name of names.filter(name => name.startsWith('expired-') && name.endsWith('.json'))) {
      const path = join(root, name);
      let notice;
      try { notice = JSON.parse(io.readFileSync(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (notice.cwd !== cwd) continue;
      (options.stderr || process.stderr).write(`mc: ${notice.name}: session ended because its gateway grant expired; resume the conversation with --resume <id> in a new session\n`);
      io.rmSync(path, { force: true });
    }
    for (const id of names.filter(name => name.startsWith('session-'))) {
      const directory = join(root, id);
      const session = readSession(directory, io);
      if (!session) continue;
      if (!alive(session.pid)) { forget({ directory, pid: session.pid }, options.env, io); continue; }
      if (session.cwd !== cwd) continue;
      let held;
      try { held = await threads(session.socket); }
      catch (error) {
        if (!(error instanceof CodexServerError)) throw error;
        if (error.kind === 'unreachable') {
          (options.stderr || process.stderr).write(`mc: ${session.name}: server gone (${error.message}); session registration removed\n`);
          forget({ directory, pid: session.pid }, options.env, io);
          continue;
        }
        throw new Error(`Codex session ${session.name} (pid ${session.pid}) is running but ${error.message}; stop it with kill ${session.pid} to clear it`);
      }
      const thread = sessionThread(held);
      rows.push({ id, name: session.name, pid: session.pid, cwd: session.cwd, socket: session.socket,
        sessionId: thread?.id ?? session.resume ?? null,
        resume: thread ? (thread.preview ? thread.id : null) : session.resume ?? null, access: session.access ?? [] });
    }
    return rows;
  }

  /** Other mc processes attached to this server: their pids, from `clients/`, those still alive. */
  const otherClients = (directory) => {
    let names = [];
    try { names = io.readdirSync(join(directory, 'clients')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return names.map(Number).filter(pid => pid !== mcPid && alive(pid));
  };

  /**
   * End rule. The session ends only when its person left it: the client exited
   * 0 (not a hangup, a signal or an error), no one else is attached and no turn
   * is running. Anything else leaves it for the next entrance.
   */
  async function conclude(options, session, result, directory) {
    const say = line => (options.stderr || process.stderr).write(`mc: ${session.name}: ${line}\n`);
    // The wrapper owns credit expiry and may have removed this session while
    // its terminal was attached. Never signal a pid after that ownership ends.
    if (!readSession(directory, io)) return;
    if (result.error) return say(`the client did not start (${result.error.message}); the session was left running`);
    if (result.signal) return say(`the client ended on ${result.signal}; the session was left running`);
    if (result.status !== 0) return say(`the client exited with status ${result.status}; the session was left running`);
    if (otherClients(directory).length) return say('another terminal is attached; the session was left running');
    let held;
    try { held = await threads(session.socket); }
    catch (error) { return say(`could not tell whether a turn is running (${error.message}); the session was left running`); }
    if (turnRunning(held)) return say('a turn is still running; the session was left running');
    try { kill(session.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await waitFor(() => !alive(session.pid), STOP_MS)) return say(`server pid ${session.pid} did not exit within ${STOP_MS} ms; the session was left running`);
    forget({ directory, pid: session.pid }, options.env, io);
  }

  async function attach(options, session) {
    const directory = join(rootOf(options.env), session.id);
    if (!readSession(directory, io)) return { status: 1, signal: null };
    const clients = join(directory, 'clients');
    io.mkdirSync(clients, { recursive: true, mode: 0o700 });
    io.writeFileSync(join(clients, String(mcPid)), '', { mode: 0o600 });
    let result;
    try {
      result = run(options.launch.spec.bin, clientArgs(session.socket, session), {
        cwd: options.worktree.path, stdio: 'inherit', env: terminalEnvironment(options.env),
      });
    } finally { io.rmSync(join(clients, String(mcPid)), { force: true }); }
    await conclude(options, session, result, directory);
    return result;
  }

  return { list, start, join: attach };
}
