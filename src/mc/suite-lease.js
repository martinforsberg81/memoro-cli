/**
 * The suite lease: one full test suite at a time on this machine — by agreement.
 *
 * The repository lease says who holds a gate round. It says nothing about who
 * may run a suite, and on an eight-gigabyte machine that is the resource that
 * actually runs out (D-0141: five suites at once, 91 % swap, a person's typing
 * stuttering). The suite right was handed out in messages all day and hoped
 * to be respected — and one session ran the suite eleven times on a clock
 * nobody could see (D-0155). A rule without a mechanism is a habit.
 *
 * So there is a lease, machine-wide rather than per repository, because the
 * memory is shared whatever repository the suite belongs to. Advisory like the
 * repository's: mc refuses a second claim and blocks no process. The gate
 * round takes it before it runs a suite and gives it back after, so the one
 * thing that runs suites by machine cannot run over somebody's right to. What
 * the status board adds is the other half — which processes are actually
 * running a suite right now, whoever holds the lease — so a suite nobody
 * claimed is visible rather than inferred from a slow machine.
 *
 * No expiry, for the repository lease's reason: a forgotten lease is a person
 * who walked away, and deciding that is a judgement a person or the PM makes
 * with `--force`, written down. A lease taken for the length of a process is
 * the exception that needs no judgement: it records the pid, and a pid that
 * is gone is a fact (`lease-owner.js`) — the next claim takes it as a reap.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { ownerState } from './lease-owner.js';
import { mcHome } from './paths.js';
import { currentHolder } from './work-identity.js';

export const SUITE_LEASE_SCHEMA = 'mc-suite-lease';
export const SUITE_LEASE_VERSION = 1;

export function suiteLeasePath(root = mcHome()) {
  return join(root, 'suite-lease.json');
}

export function suiteLeaseLogPath(root = mcHome()) {
  return join(root, 'suite-lease.log');
}

/** Who holds the suite right, and for how long — or nobody. */
export function readSuiteLease({ root = mcHome(), now = Date.now(), kill = null } = {}) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(suiteLeasePath(root), 'utf8')); } catch { return free(); }
  if (raw?.schema !== SUITE_LEASE_SCHEMA || raw?.version !== SUITE_LEASE_VERSION) return free();
  const since = Date.parse(raw.since);
  if (!Number.isFinite(since) || typeof raw.holder !== 'string') return free();
  return {
    held: true,
    holder: raw.holder,
    holder_kind: raw.holder_kind || 'work-area',
    errand: typeof raw.errand === 'string' ? raw.errand : '',
    since: raw.since,
    age_ms: Math.max(0, now - since),
    // The way back (lease-owner.js): a lease taken for the length of a
    // process says which, and a process that is gone makes it orphaned.
    ...ownerState(raw, kill ? { kill } : {}),
  };
}

function free() {
  return {
    held: false, holder: null, holder_kind: null, errand: '', since: null, age_ms: null,
    owner_pid: null, owner_alive: null, orphaned: false,
  };
}

/** Take it, or say who has it. Claiming what you already hold does not restart the clock. */
export function claimSuiteLease({
  errand, holder = currentHolder(), ownerPid = null, root = mcHome(), now = Date.now(), kill = null,
} = {}) {
  const current = readSuiteLease({ root, now, kill });
  // An orphaned lease is nobody's: its process is gone and cannot give it
  // back. Taking it is not a force — nothing is being overruled — but it is
  // a change of hands, so it is written down as what it was.
  const reaped = current.held && current.orphaned ? current : null;
  if (reaped) {
    log(root, `reap     by=${holder.name}  was=${reaped.holder}  pid=${reaped.owner_pid} gone  after=${Math.round(reaped.age_ms / 1000)}s  errand="${reaped.errand}"`);
  } else {
    if (current.held && current.holder !== holder.name) return { ok: false, reason: 'held', lease: current };
    if (current.held) return { ok: true, already: true, lease: current };
  }
  const lease = {
    schema: SUITE_LEASE_SCHEMA,
    version: SUITE_LEASE_VERSION,
    holder: holder.name,
    holder_kind: holder.kind,
    errand: String(errand || '').slice(0, 200),
    since: new Date(now).toISOString(),
    ...(Number.isInteger(ownerPid) && ownerPid > 0 ? { owner_pid: ownerPid } : {}),
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonAtomic(suiteLeasePath(root), lease);
  log(root, `claim    holder=${holder.name}  errand="${lease.errand}"${lease.owner_pid ? `  pid=${lease.owner_pid}` : ''}`);
  return { ok: true, already: false, reaped, lease: readSuiteLease({ root, now, kill }) };
}

/** Give it back — or take it away, which is a different act and is logged. */
export function releaseSuiteLease({
  holder = currentHolder(), force = false, root = mcHome(), now = Date.now(), kill = null,
} = {}) {
  const current = readSuiteLease({ root, now, kill });
  if (!current.held) return { ok: true, released: false, lease: current };
  const mine = current.holder === holder.name;
  // Releasing an orphaned lease is clearing up, not overruling: no force needed.
  if (!mine && !force && !current.orphaned) return { ok: false, reason: 'not-yours', lease: current };
  rmSync(suiteLeasePath(root), { force: true });
  log(root, mine
    ? `release  holder=${current.holder}  after=${Math.round(current.age_ms / 1000)}s`
    : current.orphaned
      ? `reap     by=${holder.name}  was=${current.holder}  pid=${current.owner_pid} gone  after=${Math.round(current.age_ms / 1000)}s  errand="${current.errand}"`
      : `force    by=${holder.name}  was=${current.holder}  after=${Math.round(current.age_ms / 1000)}s  errand="${current.errand}"`);
  return { ok: true, released: true, forced: !mine && !current.orphaned, reaped: !mine && current.orphaned, lease: current };
}

function log(root, line) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(suiteLeaseLogPath(root), `${new Date().toISOString()}  ${line}\n`, { mode: 0o600 });
  } catch { /* the lease file is the fact; the log is the history */ }
}
