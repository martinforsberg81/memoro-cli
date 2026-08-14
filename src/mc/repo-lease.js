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
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import { mcHome, workRoot } from './paths.js';
import { repoFileSlug, writeJsonAtomic } from './repo-snapshot.js';

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

/**
 * Who is asking.
 *
 * A work area is the unit that holds a lease, because that is the unit that
 * does a round: one directory, one branch per repository, one conversation
 * (or a few) working on one thing. The area is read from the working
 * directory rather than declared, so nobody can hold a lease under a name
 * they are not working in.
 *
 * Outside the work root — Martin's own shell, a script — the holder is the
 * person at the keyboard. That is honest about what it is, and it is exactly
 * who `--force` exists for.
 */
export function currentHolder({ cwd = process.cwd(), env = process.env } = {}) {
  // Both sides resolved: a shell's working directory comes back through the
  // symlinks the temporary and home directories are made of on macOS, and a
  // string comparison against the unresolved work root said "not in a work
  // area" for a directory plainly inside one.
  const root = canonical(workRoot(env));
  const here = canonical(cwd);
  if (here === root || here.startsWith(`${root}/`)) {
    const [area] = here.slice(root.length + 1).split('/').filter(Boolean);
    if (area) return { name: area, kind: 'work-area' };
  }
  let who = 'someone';
  try { who = `${userInfo().username}@${hostname()}`; } catch { /* nameless shell */ }
  return { name: who, kind: 'shell' };
}

/** Who holds this repository, and for how long — or nobody. */
export function readLease(repoPath, { root = mcHome(), now = Date.now() } = {}) {
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
  };
}

function canonical(path) {
  try { return realpathSync(path); } catch { return path; }
}

function free() {
  return { held: false, holder: null, holder_kind: null, errand: '', since: null, age_ms: null };
}

/**
 * Take it, or say who has it.
 *
 * Claiming a lease you already hold is not an error and does not restart the
 * clock: the age on the page is how long this round has been running, and a
 * second claim in the middle of it must not make a two-hour round look new.
 */
export function claimLease({
  repoPath, errand, holder = currentHolder(), root = mcHome(), now = Date.now(),
} = {}) {
  const current = readLease(repoPath, { root, now });
  if (current.held && current.holder !== holder.name) {
    return { ok: false, reason: 'held', lease: current };
  }
  if (current.held) return { ok: true, already: true, lease: current };

  const lease = {
    schema: LEASE_SCHEMA,
    version: LEASE_VERSION,
    repo: repoPath,
    holder: holder.name,
    holder_kind: holder.kind,
    errand: String(errand || '').slice(0, 200),
    since: new Date(now).toISOString(),
  };
  mkdirSync(leaseRoot(root), { recursive: true, mode: 0o700 });
  writeJsonAtomic(leasePath(repoPath, root), lease);
  log(root, `claim    ${repoPath}  holder=${holder.name}  errand="${lease.errand}"`);
  return { ok: true, already: false, lease: readLease(repoPath, { root, now }) };
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
  repoPath, holder = currentHolder(), force = false, root = mcHome(), now = Date.now(),
} = {}) {
  const current = readLease(repoPath, { root, now });
  if (!current.held) return { ok: true, released: false, lease: current };
  const mine = current.holder === holder.name;
  if (!mine && !force) return { ok: false, reason: 'not-yours', lease: current };
  rmSync(leasePath(repoPath, root), { force: true });
  // `--force` on your own lease is just a release; what has to be written
  // down is one holder ending another's round.
  log(root, mine
    ? `release  ${repoPath}  holder=${current.holder}  after=${Math.round(current.age_ms / 1000)}s`
    : `force    ${repoPath}  by=${holder.name}  was=${current.holder}  after=${Math.round(current.age_ms / 1000)}s  errand="${current.errand}"`);
  return { ok: true, released: true, forced: !mine, lease: current };
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
