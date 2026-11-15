/**
 * The red ledger, `~/mc/runner/check-red.json` (docs/technical/mc-deploy.md,
 * *The take-back*): one entry per red check, keyed by the row's `started`.
 *
 *   { version: 1, entries: { "<started>": {
 *       sha, parts[], pid, repair[], take_back, desk, reason, steps[], created, done } } }
 *
 *  - `pid`: the reaction that holds the entry while it runs (a pid lease: a
 *    second reaction for the row exits at once while that process is alive).
 *  - `repair`: the main-red member ids once asked; the reaction asks only while
 *    it is empty. `repair_skipped` says why none could be asked.
 *  - `take_back`: `taken-back`, `failed`, `not-made` or `none` (not decided).
 *  - `desk`: `Martin` (the desk is asked to act), `ended` (a later row shipped,
 *    or a person ended it) or `none`.
 *  - `done`: the repair is asked and the take-back, or the decision not to make
 *    one, is recorded. The runner's fallback starts a reaction for every red
 *    row whose entry is not done.
 *
 * The file is read strictly: one that cannot be parsed, or is not version 1, is
 * an error that is said, never an empty ledger. It is written whole under a lock
 * of its own (`check-red.json.lock`, `O_EXCL`, the writer's pid), not the
 * runner's: the repair request takes the runner's lock and must never nest in it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { processAlive } from './lease-owner.js';
import { workRoot } from './paths.js';

export const TAKE_BACKS = ['taken-back', 'failed', 'not-made', 'none'];
export const DESKS = ['Martin', 'ended', 'none'];
export const LOCK_WAIT_MS = 5000;

export function ledgerPath(env = process.env) {
  return join(workRoot(env), 'runner', 'check-red.json');
}

export class LedgerError extends Error {}

/**
 * `{ entries, from }`; a missing file is no entries, an unreadable one throws a
 * `LedgerError`. `from` is when the ledger began: a red check recorded before it
 * (a row from before this record existed) is not a reaction's to make.
 */
export function readLedger(env = process.env, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  let text;
  try { text = read(ledgerPath(env)); } catch (error) {
    if (error?.code === 'ENOENT') return { entries: {}, from: null };
    throw new LedgerError(`the red ledger ${ledgerPath(env)} cannot be read (${error?.message || error})`);
  }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new LedgerError(`the red ledger ${ledgerPath(env)} is not JSON (${error.message})`);
  }
  if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw new LedgerError(`the red ledger ${ledgerPath(env)} is not a version 1 ledger`);
  }
  return { entries: value.entries, from: Number.isFinite(Date.parse(value.from)) ? value.from : null };
}

/** The ledger as the desk reads it: an unreadable one is `{ entries: {}, error }`, never a throw. */
export function readLedgerSafe(env = process.env, options = {}) {
  try { return { ...readLedger(env, options), error: null }; } catch (error) {
    return { entries: {}, error: error.message };
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLedgerLock(env, fn, { alive = processAlive, waitMs = LOCK_WAIT_MS, clock = Date.now } = {}) {
  const lock = `${ledgerPath(env)}.lock`;
  const deadline = clock() + waitMs;
  for (;;) {
    try {
      mkdirSync(dirname(lock), { recursive: true });
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = NaN;
      try { holder = Number(readFileSync(lock, 'utf8')); } catch { /* gone */ }
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) { rmSync(lock, { force: true }); continue; }
      if (clock() > deadline) throw new LedgerError(`the red ledger is locked by pid ${holder} — try again`);
      sleepSync(25);
    }
  }
  try { return fn(); } finally {
    try { rmSync(lock, { force: true }); } catch { /* gone */ }
  }
}

/**
 * Read, change and write the ledger under its lock: `change(entries)` edits the
 * object in place and may return a value, which is returned. A ledger that does
 * not read is not written over.
 */
export function updateLedger(env, change, options = {}) {
  return withLedgerLock(env, () => {
    const { entries, from } = readLedger(env, options);
    const result = change(entries);
    writeJsonAtomic(ledgerPath(env), { version: 1, from: from || (options.now ? options.now() : new Date()).toISOString(), entries });
    return result;
  }, options);
}

/** A new entry for a red row. */
export function newEntry({ sha, parts = [], now = new Date() }) {
  return {
    sha, parts, pid: null, repair: [], take_back: 'none', desk: 'none', reason: '', steps: [],
    created: now.toISOString(), done: false,
  };
}

/** The entry is done: the repair is asked (or could not be) and the take-back, or the decision not to, is recorded. */
export function isDone(entry) {
  return Boolean(entry?.done);
}

/** Whether the reaction that holds `entry` is still there. */
export function heldBy(entry, { alive = processAlive, pid = process.pid } = {}) {
  const held = Number(entry?.pid);
  return Number.isInteger(held) && held > 0 && held !== pid && alive(held) === true;
}
