/**
 * The lease: one repository, one gate round at a time — by agreement.
 *
 * Two sessions verifying and merging against the same repository at the same
 * minute is not a git problem. Git merges the text fine; what breaks is that
 * each one's "green" was measured against a main the other has already moved,
 * and the semantic collision is found later by whoever happens to run the
 * suite next. Add a source-linked installation, where `git pull` is the
 * deploy, and one round can change the code under another round's feet.
 *
 * So there is a lease, and it is advisory on purpose. mc is strict with
 * itself — `mc repo claim` refuses a repository somebody else is holding —
 * and never strict with git: nothing here blocks a push, a merge, or a pull,
 * because a tool that stands between a person and their repository is the
 * tool they stop using. The enforcement is the roles' own instructions; what
 * mc provides is the fact, visible to everyone in `mc repo status`.
 *
 * No expiry. A forgotten lease is not a lock to be timed out, it is a person
 * who walked away, and its age is on the page for anyone to see. Deciding
 * that a holder is gone is a judgement about the world, which mc does not
 * make on its own: a human or the PM says so with `--force`, and that is
 * written down.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { ownerState } from './lease-owner.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { currentHolder } from './work-identity.js';

// Who holds a lease is the same question as who sends a message, so the rule
// lives in one place now (`work-identity.js`). Re-exported because the lease
// was where it started and callers know it by this door.
export { currentHolder };

export const LEASE_SCHEMA = 'mc-repo-lease';
export const LEASE_VERSION = 1;

export function leaseRoot(root = mcHome()) {
  return join(root, 'repo-leases');
}

export function leasePath(repoPath, root = mcHome()) {
  return join(leaseRoot(root), `${repoFileSlug(repoPath)}.json`);
}

export function leaseLogPath(root = mcHome()) {
  return join(leaseRoot(root), 'leases.log');
}

/** Who holds this repository, and for how long — or nobody. */
export function readLease(repoPath, { root = mcHome(), now = Date.now(), kill = null } = {}) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(leasePath(repoPath, root), 'utf8')); } catch { return free(); }
  if (raw?.schema !== LEASE_SCHEMA || raw?.version !== LEASE_VERSION) return free();
  const since = Date.parse(raw.since);
  if (!Number.isFinite(since) || typeof raw.holder !== 'string') return free();
  return {
    held: true,
    repo: raw.repo || repoPath,
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

/**
 * Take it, or say who has it.
 *
 * Claiming a lease you already hold is not an error and does not restart the
 * clock: the age on the page is how long this round has been running, and a
 * second claim in the middle of it must not make a two-hour round look new.
 */
export function claimLease({
  repoPath, errand, holder = currentHolder(), ownerPid = null, root = mcHome(), now = Date.now(), kill = null,
} = {}) {
  const current = readLease(repoPath, { root, now, kill });
  // An orphaned lease is nobody's (lease-owner.js): taken, and logged as a
  // reap rather than a claim so the change of hands is legible afterwards.
  const reaped = current.held && current.orphaned ? current : null;
  if (reaped) {
    log(root, `reap     ${repoPath}  by=${holder.name}  was=${reaped.holder}  pid=${reaped.owner_pid} gone  after=${Math.round(reaped.age_ms / 1000)}s  errand="${reaped.errand}"`);
  } else {
    if (current.held && current.holder !== holder.name) {
      return { ok: false, reason: 'held', lease: current };
    }
    if (current.held) return { ok: true, already: true, lease: current };
  }

  const lease = {
    schema: LEASE_SCHEMA,
    version: LEASE_VERSION,
    repo: repoPath,
    holder: holder.name,
    holder_kind: holder.kind,
    errand: String(errand || '').slice(0, 200),
    since: new Date(now).toISOString(),
    ...(Number.isInteger(ownerPid) && ownerPid > 0 ? { owner_pid: ownerPid } : {}),
  };
  mkdirSync(leaseRoot(root), { recursive: true, mode: 0o700 });
  writeJsonAtomic(leasePath(repoPath, root), lease);
  log(root, `claim    ${repoPath}  holder=${holder.name}  errand="${lease.errand}"${lease.owner_pid ? `  pid=${lease.owner_pid}` : ''}`);
  return { ok: true, already: false, reaped, lease: readLease(repoPath, { root, now, kill }) };
}

/**
 * Give it back — or take it away, which is a different act and is logged.
 *
 * Releasing somebody else's lease is refused rather than silently allowed,
 * because the ordinary way to hit that is a session that thinks it is holding
 * a round it is not. `--force` is the deliberate override, and the log is
 * what makes it answerable afterwards.
 */
export function releaseLease({
  repoPath, holder = currentHolder(), force = false, root = mcHome(), now = Date.now(), kill = null,
} = {}) {
  const current = readLease(repoPath, { root, now, kill });
  if (!current.held) return { ok: true, released: false, lease: current };
  const mine = current.holder === holder.name;
  // Releasing an orphaned lease is clearing up, not overruling: no force needed.
  if (!mine && !force && !current.orphaned) return { ok: false, reason: 'not-yours', lease: current };
  rmSync(leasePath(repoPath, root), { force: true });
  // `--force` on your own lease is just a release; what has to be written
  // down is one holder ending another's round.
  log(root, mine
    ? `release  ${repoPath}  holder=${current.holder}  after=${Math.round(current.age_ms / 1000)}s`
    : current.orphaned
      ? `reap     ${repoPath}  by=${holder.name}  was=${current.holder}  pid=${current.owner_pid} gone  after=${Math.round(current.age_ms / 1000)}s  errand="${current.errand}"`
      : `force    ${repoPath}  by=${holder.name}  was=${current.holder}  after=${Math.round(current.age_ms / 1000)}s  errand="${current.errand}"`);
  return { ok: true, released: true, forced: !mine && !current.orphaned, reaped: !mine && current.orphaned, lease: current };
}

/**
 * Every change of hands, appended.
 *
 * `--force` must be logged (it is somebody overruling somebody else), and a
 * log that only ever records overrules reads like an accusation with no
 * context. So every claim and release goes in the same file, in order, and a
 * forced one is legible against what came before it.
 */
function log(root, line) {
  try {
    mkdirSync(leaseRoot(root), { recursive: true, mode: 0o700 });
    appendFileSync(leaseLogPath(root), `${new Date().toISOString()}  ${line}\n`, { mode: 0o600 });
  } catch { /* the lease itself is the record; the log is the courtesy */ }
}
