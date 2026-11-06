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
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
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

/** A file's JSON object, or null when it is missing, half-written or not an object. */
function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/**
 * A record is alive while its owner is: a placeholder while the `keep` that
 * reserved its id is, a session while its browser is. A placeholder whose browser
 * has started stays alive while that browser does, so its id is never reused.
 */
function recordAlive(record, deps) {
  if (!record.placeholder) return isAlive(record.pid, deps);
  return isAlive(record.owner_pid, deps) || isAlive(record.pid, deps);
}

/** A placeholder whose mc is gone while its browser lives: named as an orphaned browser, not reclaimed. */
export function isOrphan(record, deps = {}) {
  return Boolean(record.placeholder) && !isAlive(record.owner_pid, deps) && isAlive(record.pid, deps);
}

/**
 * Every record in the directory, placeholders included, each with `file` and
 * `alive`; a file that does not parse is skipped.
 */
export function readRecords(env = process.env, deps = {}) {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir).filter((entry) => /^s\d+\.json$/u.test(entry)).sort()) {
    const record = readRecord(join(dir, name));
    if (record) records.push({ ...record, file: join(dir, name), alive: recordAlive(record, deps) });
  }
  return records;
}

/** Every session file, each with `alive`. A placeholder is not a session yet. */
export function readSessions(env = process.env, deps = {}) {
  return readRecords(env, deps).filter((record) => !record.placeholder);
}

/**
 * The live records: sessions, and orphans (see `isOrphan`). Each record read as
 * dead is swept on the way, through its id's lock and only while it is still the
 * one read. `deps.onSweepRead`, when given, runs between the read and the sweep.
 */
export function liveSessions(env = process.env, deps = {}) {
  const all = readRecords(env, deps);
  for (const record of all.filter((entry) => !entry.alive)) {
    deps.onSweepRead?.(record);
    sweepRecord(record, env, deps);
  }
  return all.filter((entry) => entry.alive && (!entry.placeholder || isOrphan(entry, deps)));
}

/** A nonce: tells one session (or one reservation) from the next that takes its id. */
export function newNonce() {
  return randomBytes(8).toString('hex');
}

/** Create `path` exclusively with `record` as its JSON; false when it already exists. */
function createExclusive(path, record) {
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

const RECLAIM_AFTER_MS = 60_000;

/**
 * Is a lock's holder gone? A lock that parses is held by its `owner_pid`, gone
 * when that is dead. One that does not parse was written by a creator that died
 * between create and write: gone once it is a minute old.
 */
function lockGone(lock, deps) {
  const holder = readRecord(lock);
  if (holder) return !isAlive(holder.owner_pid, deps);
  try {
    return Date.now() - statSync(lock).mtimeMs >= RECLAIM_AFTER_MS;
  } catch {
    return true;
  }
}

/**
 * Hold `<id>.lock` exclusively while `inside` runs; true when it did. A lock whose
 * holder is gone is cleared and taken once more; a lock a live caller holds is
 * not waited for.
 */
function withLock(dir, id, deps, inside) {
  const lock = join(dir, `${id}.lock`);
  if (!createExclusive(lock, { owner_pid: process.pid })) {
    if (!lockGone(lock, deps)) return false;
    rmSync(lock, { force: true });
    if (!createExclusive(lock, { owner_pid: process.pid })) return false;
  }
  try {
    inside();
  } finally {
    rmSync(lock, { force: true });
  }
  return true;
}

/**
 * Clear `id` when its owner is gone: a dead placeholder, or a session whose
 * browser is. Callers serialise on `<id>.lock` (`withLock`), so two of them never
 * clear or take one id at once. True when the id is free.
 */
function reclaim(dir, id, deps) {
  const path = join(dir, `${id}.json`);
  let free = false;
  const held = withLock(dir, id, deps, () => {
    if (!existsSync(path)) {
      free = true;
      return;
    }
    const record = readRecord(path);
    // A file that does not parse may be another caller's write in progress: it waits a minute.
    if (record ? recordAlive(record, deps) : Date.now() - statSync(path).mtimeMs < RECLAIM_AFTER_MS) return;
    removeSession({ id, file: path, socket: join(dir, `${id}.sock`), log: join(dir, `${id}.log`) });
    free = true;
  });
  return held && free;
}

/**
 * Remove a record's file, socket and log. Only under its id's lock, and only while
 * the file still carries the nonce that was read: a caller that took the id in
 * between keeps its files, and a lock another caller holds leaves them be.
 */
export function sweepRecord(record, env = process.env, deps = {}) {
  const dir = sessionsDir(env);
  const file = join(dir, `${record.id}.json`);
  withLock(dir, record.id, deps, () => {
    const now = readRecord(file);
    if (!now || now.nonce !== record.nonce) return;
    removeSession({ id: record.id, file, socket: join(dir, `${record.id}.sock`), log: join(dir, `${record.id}.log`) });
  });
}

/** The browser's pid goes into its placeholder as soon as it starts, so a keep killed mid-capture leaves a named orphan. */
export function notePlaceholderPid(reservation, pid) {
  const record = readRecord(reservation.file);
  if (!record || record.nonce !== reservation.nonce) return;
  writeFileSync(reservation.file, `${JSON.stringify({ ...record, pid }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Reserve the lowest `s<n>` no record holds. Its file is created exclusively
 * (`wx`) as a placeholder owned by this process, so the create is the
 * reservation: no two callers get one id, and a record of an id is never
 * overwritten by a newcomer. `{ id, nonce, owner_pid, file }`.
 */
export function reserveSession(env = process.env, { owner = process.pid, deps = {}, now = new Date() } = {}) {
  const dir = ensureSessionsDir(env);
  for (let n = 1; n < 10_000; n += 1) {
    const id = `s${n}`;
    const file = join(dir, `${id}.json`);
    const reservation = {
      id, placeholder: true, owner_pid: owner, nonce: newNonce(), reserved: now.toISOString(),
    };
    if (createExclusive(file, reservation)) return { ...reservation, file };
    if (reclaim(dir, id, deps) && createExclusive(file, reservation)) return { ...reservation, file };
  }
  throw new Error('no session id is free');
}

/** A keep that did not launch gives its id back, if the file is still its own reservation. */
export function releaseReservation(env, reservation) {
  const record = readRecord(reservation.file);
  if (!record || record.nonce !== reservation.nonce) return;
  const dir = sessionsDir(env);
  removeSession({
    id: reservation.id, file: reservation.file, socket: join(dir, `${reservation.id}.sock`), log: join(dir, `${reservation.id}.log`),
  }, env);
}

/**
 * Is the session file still the one `session` was read from: the same nonce,
 * owner and browser? False when it is gone, or another keep has taken the id.
 */
export function sessionUnchanged(env, session) {
  const record = readRecord(join(sessionsDir(env), `${session.id}.json`));
  return Boolean(record)
    && record.nonce === session.nonce
    && record.owner_pid === session.owner_pid
    && record.pid === session.pid;
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
export function runKeep({
  worktree, declaration, request, env = process.env, log, deps = {}, onSpawn,
}) {
  return spawnDetached({
    worktree, declaration, request, env, log, timeoutMs: deps.timeoutMs ?? captureTimeoutMs(request), deps, onSpawn,
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
  sweepRecord(session, env, deps);
  return left;
}
