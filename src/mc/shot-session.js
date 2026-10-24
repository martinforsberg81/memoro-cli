/**
 * A kept browser — the pieces: where a session lives, which ones are alive,
 * and the one JSON line each way on its socket.
 *
 * `mc shot … --keep` spawns memoro's capture script in mode `session`; the
 * script answers its first capture as a shot does and then listens on a unix
 * socket for steps (docs/technical/mc-shot.md § A kept browser). mc keeps a
 * session file beside the socket so later calls find it. Neither carries a
 * token, a cookie or a prod sign-in URL: those were in the request file, which
 * is gone by the time the first answer is read. The directory is 0700, the
 * session file 0600, and mc narrows the socket to 0600 once the script made it.
 *
 * Every read on a socket has a timeout, so a dead session is a line, not a hang.
 */
import { createConnection } from 'node:net';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { captureTimeoutMs, resultLine, spawnDetached } from './shot.js';

export const SESSION_LIMIT = 4;
export const CLOSE_WAIT_MS = 5_000;

/** `<mcHome>/shots/sessions`. */
export function sessionsDir(env = process.env) {
  return join(mcHome(env), 'shots', 'sessions');
}

/** The directory, made and kept the user's alone. */
export function ensureSessionsDir(env = process.env) {
  const dir = sessionsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Is the process there? Signal 0 asks without sending anything; EPERM is someone's, and alive. */
export function isAlive(pid, deps = {}) {
  if (deps.alive) return deps.alive(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Every session file, each with `alive`; a file that does not parse is skipped. */
export function readSessions(env = process.env, deps = {}) {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return [];
  const sessions = [];
  for (const name of readdirSync(dir).filter((entry) => /^s\d+\.json$/u.test(entry)).sort()) {
    try {
      const session = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      sessions.push({ ...session, file: join(dir, name), alive: isAlive(session.pid, deps) });
    } catch { /* half-written or foreign: not a session */ }
  }
  return sessions;
}

/** The live sessions, the files of the dead ones removed on the way. */
export function liveSessions(env = process.env, deps = {}) {
  const all = readSessions(env, deps);
  for (const session of all.filter((entry) => !entry.alive)) removeSession(session);
  return all.filter((entry) => entry.alive);
}

/** `s<n>`, the lowest number no live session holds. */
export function nextSessionId(live) {
  const held = new Set(live.map((session) => session.id));
  let n = 1;
  while (held.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** The session file, 0600; `file` and `alive` are read, never written. */
export function writeSession(env, session) {
  const { file: _file, alive: _alive, ...kept } = session;
  const path = join(sessionsDir(env), `${session.id}.json`);
  writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Its file, its socket and its log. */
export function removeSession(session, env = process.env) {
  const dir = session.file ? null : sessionsDir(env);
  for (const path of [session.file || join(dir, `${session.id}.json`), session.socket, session.log]) {
    if (path) rmSync(path, { force: true });
  }
}

/** Whole minutes since the session was last used. */
export function idleMinutes(session, now = new Date()) {
  const last = Date.parse(session.last_used || session.started || '');
  return Number.isNaN(last) ? 0 : Math.max(0, Math.floor((now.getTime() - last) / 60_000));
}

/** The log's last non-empty line, which is what a script that died said last. */
export function lastLogLine(log) {
  try {
    const lines = readFileSync(log, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.at(-1)?.slice(0, 300) || 'its log is empty';
  } catch {
    return 'it left no log';
  }
}

/**
 * One JSON line out on the socket, one result line back. `{ ok: true, result }`;
 * `{ ok: false, refused: true }` when nobody answers — the socket is gone,
 * refuses, or closes before a line; `{ ok: false, timedOut: true }` when the
 * line did not come within `timeoutMs`.
 */
export function sendLine({ socket, message, timeoutMs, deps = {} }) {
  return new Promise((settle) => {
    let done = false;
    let buffered = '';
    let conn = null;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn?.destroy();
      settle(outcome);
    };
    const timer = setTimeout(() => finish({
      ok: false, timedOut: true, error: `no answer within ${Math.round(timeoutMs / 1000)}s`,
    }), timeoutMs);
    try {
      conn = (deps.connect || createConnection)(socket);
    } catch (error) {
      finish({ ok: false, refused: true, error: error.code || error.message });
      return;
    }
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(message)}\n`));
    conn.on('data', (chunk) => {
      buffered += chunk;
      const at = buffered.indexOf('\n');
      if (at < 0) return;
      const line = buffered.slice(0, at);
      const result = resultLine(line);
      finish(result
        ? { ok: true, result }
        : { ok: false, error: `the browser answered with a line that is not a result: ${line.slice(0, 200)}` });
    });
    conn.on('error', (error) => finish({ ok: false, refused: true, error: error.code || error.message }));
    conn.on('close', () => finish({ ok: false, refused: true, error: 'the socket closed before an answer' }));
  });
}

/**
 * The script in mode `session`, as `runOpen` spawns one: detached, stderr to
 * the session's log, the request removed once the first result line is read.
 * That line is the first capture's result.
 */
export function runKeep({ worktree, declaration, request, env = process.env, log, deps = {} }) {
  return spawnDetached({
    worktree, declaration, request, env, log, timeoutMs: deps.timeoutMs ?? captureTimeoutMs(request), deps,
  });
}

/**
 * Ask the session to close, wait up to 5 s for its process to leave, else
 * end its process group; then its files go. True when it left on its own.
 */
export async function closeSession(session, { env = process.env, deps = {} } = {}) {
  const waitMs = deps.closeWaitMs ?? CLOSE_WAIT_MS;
  const deadline = Date.now() + waitMs;
  if (isAlive(session.pid, deps)) {
    await sendLine({ socket: session.socket, message: { close: true }, timeoutMs: waitMs, deps });
  }
  while (isAlive(session.pid, deps) && Date.now() < deadline) {
    await new Promise((done) => { setTimeout(done, 50); });
  }
  const left = !isAlive(session.pid, deps);
  if (!left) {
    const kill = deps.kill || ((pid, signal) => {
      // Detached, so the script leads its own group: the browser goes with it.
      try { process.kill(-pid, signal); } catch { process.kill(pid, signal); }
    });
    try { kill(session.pid, 'SIGTERM'); } catch { /* gone in between */ }
  }
  removeSession(session, env);
  return left;
}
