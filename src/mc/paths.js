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

export function devServersRoot() {
  return join(mcHome(), 'dev-servers');
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

export function worktreePath(primaryPath, name, { collide = false, repositoryId = null } = {}) {
  return join(worktreesRoot(), repoSlug(primaryPath, { collide, repositoryId }), name);
}

/**
 * Best-effort detection of whether MC_HOME exists. Callers create it lazily
 * on first write.
 */
export function mcHomeExists() {
  return existsSync(mcHome());
}
