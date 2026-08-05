/**
 * Path resolution for the mc worktree lifecycle (§1).
 *
 * MC_HOME defaults to `~/.memoro/mc/` (existing memoro-cli dir, per plan §1
 * amendment). Tests override via the `MC_HOME` env var to a tmpdir.
 *
 * Worktrees live at `${MC_HOME}/worktrees/<repo-slug>/<name>`. The slug is
 * the basename of the primary worktree path; if two repos on this machine
 * share a basename, the second one's slug gets a short hash suffix so
 * worktree paths never collide silently.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';

export function mcHome() {
  return process.env.MC_HOME || join(homedir(), '.memoro', 'mc');
}

export function registryPath() {
  return join(mcHome(), 'registry.json');
}

export function sessionsRoot() {
  return join(mcHome(), 'sessions');
}

export function sessionNamesRoot() {
  return join(mcHome(), 'session-names');
}

export function sessionRunRoot() {
  return join(mcHome(), 'run', 'sessions');
}

export function worktreesRoot() {
  return join(mcHome(), 'worktrees');
}

export function devServersRoot(root = mcHome()) {
  return join(root, 'dev-servers');
}

/**
 * Slug for a repo, derived from the basename of its primary worktree path.
 *
 * Collision handling per §1: if a slug is already claimed by a *different*
 * absolute path (recorded in the registry under repo_slug ↔ primary path),
 * append a short hash of this primary path. We compute the hash deterministically
 * up front so callers don't need a registry round-trip — the caller only needs
 * to verify against the existing registry when *creating* a worktree.
 *
 * For now, `primaryPath` is always required (callers know their primary path).
 * The hash is omitted unless `collide=true`. The dispatcher passes `collide`
 * after a registry lookup.
 */
export function repoSlug(primaryPath, { collide = false, repositoryId = null } = {}) {
  const base = basename(primaryPath || '');
  if (!base) return 'unknown';
  if (!collide) return base;
  const h = repositoryId && /^repo_[a-f0-9]{24}$/u.test(repositoryId)
    ? repositoryId.slice(-6)
    : createHash('sha1').update(primaryPath).digest('hex').slice(0, 6);
  return `${base}-${h}`;
}

/**
 * The work root: `~/mc`.
 *
 * A piece of work is a directory. What lies under it belongs to it — the
 * worktrees it spans, one per repository, plus one small file recording the
 * tool conversation. Nothing else is stored, because nothing else is mc's to
 * know: git owns worktrees and branches, the tools own their transcripts, the
 * filesystem owns the directories.
 *
 * mc used to keep a copy of all of that and then had to hold the copy true.
 * Every refusal this week was that copy disagreeing with reality.
 */
export function workRoot(env = process.env) {
  return env.MC_WORK_ROOT || join(homedir(), 'mc');
}

export function workAreaPath(name, env = process.env) {
  return join(workRoot(env), name);
}

export function workAreaStatePath(name, env = process.env) {
  return join(workAreaPath(name, env), '.mc.json');
}

/**
 * Where a session's worktrees live: `<mc home>/worktrees/<mc session id>/<name>`.
 *
 * The session id is the directory. That makes the ownership rule structural
 * rather than a lookup — a worktree belongs to exactly one session because it
 * physically sits under it, and releasing a session is removing one path.
 *
 * The old layout keyed on repository slug and session *name*, so renaming a
 * session orphaned its directory, two sessions could land on one path, and
 * nothing about the filesystem said who owned what. This machine still holds
 * 54 directories from that scheme; they are read where they are and are not
 * moved by this function.
 */
export function sessionWorktreesRoot(mcSessionId, root = mcHome()) {
  return join(root, 'worktrees', mcSessionId);
}

export function sessionWorktreePath(mcSessionId, name, root = mcHome()) {
  return join(sessionWorktreesRoot(mcSessionId, root), name);
}

/**
 * Best-effort detection of whether MC_HOME exists. Callers create it lazily
 * on first write.
 */
export function mcHomeExists() {
  return existsSync(mcHome());
}
