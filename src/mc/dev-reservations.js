/**
 * `<registry>/.pool/reservations.json` — the dev-server slots that are taken
 * but not yet registered.
 *
 * Until 2026-11-05 admission read the registry, said yes, and forgot: the
 * ticket was dropped before the spawn, and a server is only in the registry
 * once its wrapper has built, listened and registered — minutes later for the
 * app. Every start that asked in those minutes saw the same free slot, so the
 * cap held only for servers that had already registered. On 2026-11-05 the
 * machine ran one MAIN, three worktree apps and a static server it never
 * counted.
 *
 * A reservation is the slot from the moment admission says yes until the
 * server it was for registers (`consumeReservation`, under the same lock as the
 * registry write), and capacity is the registered servers plus the
 * reservations, each counted once. A reservation names the processes that may
 * still create its server (`pids`): the asker, the child it spawned, and any
 * wrapper that adopted it. It is held while one of them is alive and swept only
 * when none is — never on time alone, because a slow build that is still
 * running will still register.
 *
 * Every change goes through `withFileLock`, which fails closed: a lock that
 * cannot be taken is an error the caller refuses on, never a write that goes
 * ahead anyway.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';

/**
 * `status-collect.js`'s liveness test, the only one mc uses, repeated here
 * because importing that module from here closes an import cycle through
 * `dev-servers.js`.
 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The hard ceiling on servers other than MAIN. `MC_DEV_MAX_SERVERS` may lower it, never raise it. */
export const SLOT_LIMIT = 3;

/** `MC_DEV_MAX_SERVERS` as a whole number from 0 to SLOT_LIMIT; anything else, or above, is SLOT_LIMIT. */
export function slotCapOf(env = process.env) {
  const raw = env?.MC_DEV_MAX_SERVERS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return SLOT_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, SLOT_LIMIT) : SLOT_LIMIT;
}

/** What a reservation id looks like: what `MC_DEV_ADMITTED` carries from mc to a wrapper. */
export const RESERVATION_ID = /^res-[A-Za-z0-9-]{8,64}$/u;

export const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 20;
/** A lock file with no pid in it yet is a writer between open and write; this old, it is a crash. */
const EMPTY_LOCK_STALE_MS = 5000;

/** The lock could not be taken: the caller refuses, it does not go ahead. */
export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
    this.code = 'MC_DEV_LOCK';
  }
}

/** The reservation file is there and does not parse: refused rather than read as empty. */
export class PoolStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolStateError';
    this.code = 'MC_DEV_POOL_STATE';
  }
}

/** The reservations of a registry root: inside it, in a directory `listServers` does not read. */
export function devPoolPath(root) {
  return join(resolve(root), '.pool', 'reservations.json');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function ageMs(path, clock) {
  try {
    return clock() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Is this lock file abandoned: its pid dead, or empty for longer than a write takes. */
function abandoned(path, holder, { alive, clock }) {
  if (holder === null) return false;
  if (holder === '') return ageMs(path, clock) > EMPTY_LOCK_STALE_MS;
  return !alive(Number(holder));
}

function createExclusive(path, pid) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove a lock whose holder is dead — under a second lock, so two takers that
 * both saw the dead pid cannot remove each other's fresh lock: the one that
 * holds the breaker reads the lock again and removes it only when it still
 * names the pid that was seen dead.
 */
function breakAbandoned(path, seen, { alive, clock, pid }) {
  const breaker = `${path}.break`;
  try {
    createExclusive(breaker, pid);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new LockError(`cannot take ${breaker}: ${error.message}`);
    const holder = readText(breaker);
    if (abandoned(breaker, holder, { alive, clock })) rmSync(breaker, { force: true });
    return;
  }
  try {
    const now = readText(path);
    if (now === seen && abandoned(path, now, { alive, clock })) rmSync(path, { force: true });
  } finally {
    if (readText(breaker) === String(pid)) rmSync(breaker, { force: true });
  }
}

/**
 * One writer at a time: `<file>.lock`, created with `O_EXCL` and naming the
 * writer's pid. A lock whose pid is dead is broken (`breakAbandoned`); a live
 * one is waited on for `waitMs` and then refused with a LockError. Not
 * reentrant: `fn` must not take the same lock.
 */
export function withFileLock(file, fn, {
  alive = pidAlive, waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, clock = Date.now, pause = sleepSync, pid = process.pid,
} = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new LockError(`cannot make ${dirname(file)}: ${error.message}`);
  }
  const path = `${file}.lock`;
  const deadline = clock() + waitMs;
  for (;;) {
    try {
      createExclusive(path, pid);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new LockError(`cannot take ${path}: ${error.message}`);
      const holder = readText(path);
      if (abandoned(path, holder, { alive, clock })) {
        breakAbandoned(path, holder, { alive, clock, pid });
        continue;
      }
      if (clock() >= deadline) {
        throw new LockError(`${path} is held by pid ${holder || '?'} — gave up after ${waitMs} ms`);
      }
      pause(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    if (readText(path) === String(pid)) rmSync(path, { force: true });
  }
}

/** The reservations as written; none when the file is missing; a PoolStateError when it does not parse. */
export function readReservations(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new PoolStateError(`cannot read ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PoolStateError(`${file} is not JSON — remove it once no dev server is starting`);
  }
  if (!Array.isArray(parsed?.reservations)) throw new PoolStateError(`${file} has no reservations list`);
  return parsed.reservations.filter((item) => item && typeof item.id === 'string');
}

function writeReservations(file, reservations) {
  writeJsonAtomic(file, { schema_version: 1, reservations });
}

/** Held while any process that may still create its server is alive. */
export function reservationHeld(reservation, alive = pidAlive) {
  return Array.isArray(reservation?.pids) && reservation.pids.some((pid) => alive(Number(pid)));
}

/** Is this reservation the one for `service` in `worktree`? */
export function reservationFor(reservation, { service, worktree }) {
  return Boolean(worktree && reservation?.worktree_path)
    && resolve(reservation.worktree_path) === resolve(worktree)
    && reservation.service === service;
}

/**
 * Under the lock: the held reservations, the swept ones removed and handed to
 * `onSwept`, and `change` applied to what is left. `change` returns the new
 * list (written when it differs) and a result, `{ reservations, result }`.
 */
export function updateReservations(file, change, { alive = pidAlive, onSwept = () => {}, lock = {} } = {}) {
  return withFileLock(file, () => {
    const before = readReservations(file);
    const held = before.filter((item) => reservationHeld(item, alive));
    for (const gone of before.filter((item) => !held.includes(item))) onSwept(gone);
    const { reservations = held, result } = change(held) || {};
    if (reservations !== held || held.length !== before.length) writeReservations(file, reservations);
    return result;
  }, { alive, ...lock });
}

/** The held reservations as they stand, without writing anything: what `mc dev status` reads. */
export function peekReservations(file, { alive = pidAlive } = {}) {
  try {
    return readReservations(file).filter((item) => reservationHeld(item, alive));
  } catch {
    return [];
  }
}

/** A new reservation, for `admit` to write under the lock. */
export function newReservation({
  service, worktree, pid, main = false, session = null, now = Date.now(), id = `res-${randomUUID()}`,
}) {
  return {
    id,
    service,
    worktree_path: worktree,
    main: Boolean(main),
    pids: [pid],
    adopted_by: null,
    ...(session ? { session } : {}),
    created_at: new Date(now).toISOString(),
  };
}

/**
 * A wrapper takes over a reservation mc made for it: `MC_DEV_ADMITTED` names
 * it, and `pid` is the wrapper that will create the server. Refused when the
 * reservation is gone, is for another service or worktree, or was already
 * adopted by a process that is still alive — so an inherited id admits one
 * starter, not every process that sees it.
 */
export function adoptReservation({
  file, id, service, worktree, pid, alive = pidAlive, onSwept, lock,
}) {
  return updateReservations(file, (held) => {
    const found = held.find((item) => item.id === id);
    if (!found) return { result: { ok: false, reason: 'no-reservation' } };
    if (!reservationFor(found, { service, worktree })) return { result: { ok: false, reason: 'mismatch' } };
    if (found.adopted_by && found.adopted_by !== pid && alive(Number(found.adopted_by))) {
      return { result: { ok: false, reason: 'adopted', by: found.adopted_by } };
    }
    const next = { ...found, adopted_by: pid, pids: [...new Set([...found.pids, pid])] };
    return { reservations: held.map((item) => (item === found ? next : item)), result: { ok: true, reservation: id } };
  }, { alive, onSwept, lock });
}

/** One more process that may create the reservation's server: the child mc just spawned. */
export function addReservationPid({ file, id, pid, alive = pidAlive, lock }) {
  return updateReservations(file, (held) => {
    const found = held.find((item) => item.id === id);
    if (!found || !Number.isInteger(pid) || pid <= 0) return { result: false };
    const next = { ...found, pids: [...new Set([...found.pids, pid])] };
    return { reservations: held.map((item) => (item === found ? next : item)), result: true };
  }, { alive, lock });
}

/**
 * These processes will not create the server: their pids leave the
 * reservation, and the reservation goes when no live pid is left. A wrapper
 * that adopted it keeps it however many others let go.
 */
export function disownReservation({ file, id, pids, alive = pidAlive, lock }) {
  return updateReservations(file, (held) => {
    const found = held.find((item) => item.id === id);
    if (!found) return { result: { removed: false, held: false } };
    const left = found.pids.filter((pid) => !pids.includes(pid));
    if (!left.some((pid) => alive(Number(pid)))) {
      return { reservations: held.filter((item) => item !== found), result: { removed: true, held: false } };
    }
    return { reservations: held.map((item) => (item === found ? { ...found, pids: left } : item)), result: { removed: false, held: true } };
  }, { alive, lock });
}

/**
 * The reservation a registering manifest fulfils: the one it names in
 * `reservation_id`, or else the one for its service and worktree (an older
 * wrapper does not name it). Pure; `registerManifest` calls it under the lock.
 */
export function consumeReservation(reservations, manifest) {
  const named = typeof manifest?.reservation_id === 'string'
    ? reservations.find((item) => item.id === manifest.reservation_id)
    : null;
  const found = named || reservations.find((item) => reservationFor(item, { service: manifest?.service, worktree: manifest?.worktree_path }));
  return found
    ? { reservations: reservations.filter((item) => item !== found), consumed: found.id }
    : { reservations, consumed: null };
}
