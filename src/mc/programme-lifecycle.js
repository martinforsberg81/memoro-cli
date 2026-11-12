/** Durable, installation-local programme holds shared by backup and writers. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { realLock } from './runner-lock.js';
import { runnerDir, workRoot } from './paths.js';

export const LIFECYCLE_VERSION = 1;
const SCHEMA = 'mc-programme-lifecycle';
const TRANSACTION_SCHEMA = 'mc-programme-transfer';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function lifecyclePaths(env = process.env) {
  const runner = runnerDir(env);
  return {
    runner,
    directory: join(runner, 'programme-lifecycle'),
    transactions: join(runner, 'programme-transfers'),
    leases: join(runner, 'programme-writer-leases'),
    installation: join(runner, 'installation.json'),
  };
}

function durableWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function readRecord(path, schema) {
  if (!existsSync(path)) return null;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`unreadable lifecycle record ${path}: ${error.message}`); }
  if (!value || value.schema !== schema || value.version !== LIFECYCLE_VERSION) throw new Error(`unknown lifecycle record at ${path}`);
  return value;
}

function transactionPath(id, env) { return join(lifecyclePaths(env).transactions, `${id}.json`); }
function fencePath(programme, env) { return join(lifecyclePaths(env).directory, `${programme}.json`); }

function underLock(env, fn, lock = realLock) {
  return lock(workRoot(env), fn, { strict: true, name: 'programme-lifecycle' });
}

export function installationId({ env = process.env, lock = realLock } = {}) {
  const paths = lifecyclePaths(env);
  return underLock(env, () => {
    const current = readRecord(paths.installation, SCHEMA);
    if (current) {
      if (typeof current.id !== 'string' || !current.id) throw new Error('invalid installation identity');
      return current.id;
    }
    const id = randomUUID();
    durableWrite(paths.installation, { schema: SCHEMA, version: LIFECYCLE_VERSION, id });
    return id;
  }, lock);
}

function validateSelection(selection) {
  if (!Array.isArray(selection) || !selection.length) throw new Error('programme selection must be non-empty');
  const names = selection.map(String);
  if (names.some((name) => !NAME.test(name))) throw new Error('invalid programme name in selection');
  if (new Set(names).size !== names.length) throw new Error('duplicate programme in selection');
  return names.sort();
}

/** Atomically fence a complete selection before draining begins. */
export function beginBackup(selection, { id = randomUUID(), env = process.env, lock = realLock, now = () => new Date().toISOString() } = {}) {
  const selected = validateSelection(selection);
  if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error('invalid transaction id');
  const paths = lifecyclePaths(env);
  return underLock(env, () => {
    for (const programme of selected) {
      const existing = readRecord(fencePath(programme, env), SCHEMA);
      if (existing) throw new Error(`${programme} is already fenced by transaction ${existing.transaction_id}`);
    }
    const install = readRecord(paths.installation, SCHEMA);
    const installation = install || { schema: SCHEMA, version: LIFECYCLE_VERSION, id: randomUUID() };
    if (!install) durableWrite(paths.installation, installation);
    const transaction = {
      schema: TRANSACTION_SCHEMA, version: LIFECYCLE_VERSION, id, generation: randomUUID(), kind: 'backup',
      selection: selected, installation_id: installation.id,
      root: resolve(workRoot(env)), state: 'draining', created_at: now(), updated_at: now(), receipts: [],
    };
    durableWrite(transactionPath(id, env), transaction);
    // Fences are not published until every binding is durable. A crash halfway
    // leaves the transaction authoritative; readers fail closed on its state.
    for (const programme of selected) durableWrite(fencePath(programme, env), {
      schema: SCHEMA, version: LIFECYCLE_VERSION, transaction_id: id,
      generation: transaction.generation, state: 'draining',
    });
    return transaction;
  }, lock);
}

function loadTransaction(id, env) {
  const value = readRecord(transactionPath(id, env), TRANSACTION_SCHEMA);
  if (!value) throw new Error(`unknown lifecycle transaction ${id}`);
  if (!Array.isArray(value.selection) || !value.generation || value.kind !== 'backup') throw new Error(`invalid lifecycle transaction ${id}`);
  return value;
}

function selectedLeases(selection, env) {
  const dir = lifecyclePaths(env).leases;
  if (!existsSync(dir)) return [];
  const selected = new Set(selection);
  return readdirSync(dir).filter((file) => file.endsWith('.json')).flatMap((file) => {
    const record = readRecord(join(dir, file), SCHEMA);
    if (!Array.isArray(record.programmes)) throw new Error(`invalid writer lease ${file}`);
    return record.programmes.some((name) => selected.has(name)) ? [record] : [];
  });
}

/** Persist a lifecycle boundary; holds survive process death and have no TTL. */
export function transitionBackup(id, generation, state, { env = process.env, lock = realLock, now = () => new Date().toISOString() } = {}) {
  if (!['held', 'released'].includes(state)) throw new Error(`invalid backup transition ${state}`);
  return underLock(env, () => {
    const transaction = loadTransaction(id, env);
    if (transaction.generation !== generation) throw new Error('stale lifecycle generation');
    if (state === 'held') {
      if (transaction.state !== 'draining') throw new Error(`cannot hold backup from ${transaction.state}`);
      const leases = selectedLeases(transaction.selection, env);
      if (leases.length) throw new Error(`backup still has ${leases.length} admitted writer lease(s)`);
    } else if (transaction.state !== 'held') throw new Error(`cannot release backup from ${transaction.state}`);
    transaction.state = state;
    transaction.updated_at = now();
    durableWrite(transactionPath(id, env), transaction);
    for (const programme of transaction.selection) {
      if (state === 'released') rmSync(fencePath(programme, env), { force: true });
      else durableWrite(fencePath(programme, env), { schema: SCHEMA, version: LIFECYCLE_VERSION, transaction_id: id, generation, state });
    }
    return transaction;
  }, lock);
}

/**
 * Reconcile a backup drain after a caller or machine restart. A drain is a
 * durable hold on admission, not a timed lease: it can advance only when every
 * writer admitted before the fence has completed and removed its lease.
 */
export function resumeBackup(id, { env = process.env, lock = realLock, now = () => new Date().toISOString() } = {}) {
  const snapshot = backupStatus(id, { env });
  if (snapshot.transaction.state !== 'draining') {
    throw new Error(`cannot resume backup from ${snapshot.transaction.state}`);
  }
  if (snapshot.pending_writers.length) {
    throw new Error(`backup still has ${snapshot.pending_writers.length} admitted writer lease(s)`);
  }
  return transitionBackup(id, snapshot.transaction.generation, 'held', { env, lock, now });
}

/**
 * Admit one cooperative writer across its entire caller-owned operation.
 * Lease files have no expiry: a restart cannot mistake an in-flight writer
 * for a completed one. The caller must always invoke release in `finally`.
 */
export function admitWriter(programmes, { env = process.env, lock = realLock, name = 'writer' } = {}) {
  const selected = validateSelection(programmes);
  const paths = lifecyclePaths(env);
  const lease = underLock(env, () => {
    // A multi-programme transaction is the authority for its entire selection.
    // This closes the crash window between persisting the transaction and
    // publishing all per-programme index records.
    const transactions = lifecyclePaths(env).transactions;
    if (existsSync(transactions)) {
      for (const file of readdirSync(transactions).filter((item) => item.endsWith('.json'))) {
        const transaction = readRecord(join(transactions, file), TRANSACTION_SCHEMA);
        if (!Array.isArray(transaction.selection) || !transaction.id || !transaction.generation || !['draining', 'held', 'captured', 'moved-away', 'importing', 'verified', 'inactive', 'activating', 'released', 'active', 'aborted'].includes(transaction.state)) throw new Error(`invalid lifecycle transaction ${file}`);
        if (!['draining', 'held', 'captured', 'moved-away', 'importing', 'verified', 'inactive', 'activating'].includes(transaction.state)) continue;
        const overlap = selected.filter((name) => transaction.selection.includes(name));
        if (overlap.length) throw new Error(`programme ${overlap.join(', ')} is ${transaction.state} under transaction ${transaction.id}`);
      }
    }
    for (const programme of selected) {
      const fence = readRecord(fencePath(programme, env), SCHEMA);
      if (!fence) continue;
      // No new writer may enter once draining starts; held/inactive/moved are
      // likewise non-runnable. A corrupt fence fails closed in readRecord.
      throw new Error(`programme ${programme} is ${fence.state} under transaction ${fence.transaction_id}`);
    }
    const record = { schema: SCHEMA, version: LIFECYCLE_VERSION, id: randomUUID(), programmes: selected, name, pid: process.pid, created_at: new Date().toISOString() };
    durableWrite(join(paths.leases, `${record.id}.json`), record);
    return record;
  }, lock);
  let released = false;
  return {
    ...lease,
    release() {
      if (released) return;
      underLock(env, () => { rmSync(join(paths.leases, `${lease.id}.json`), { force: true }); }, lock);
      released = true;
    },
  };
}

export function backupStatus(id, { env = process.env } = {}) {
  const transaction = loadTransaction(id, env);
  return { transaction, pending_writers: selectedLeases(transaction.selection, env).map(({ id: leaseId, programmes, name, pid, created_at }) => ({ id: leaseId, programmes, name, pid, created_at })) };
}

/** Legacy absence is active; any present malformed fence refuses admission. */
export function programmeLifecycle(programme, { env = process.env } = {}) {
  if (!NAME.test(programme)) throw new Error('invalid programme name');
  const fence = readRecord(fencePath(programme, env), SCHEMA);
  if (!fence) return { state: 'active', transaction_id: null };
  return { state: fence.state, transaction_id: fence.transaction_id, generation: fence.generation };
}
