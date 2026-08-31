/**
 * Path resolution for mc's two roots.
 *
 * MC_HOME defaults to `~/.memoro/mc/` (existing memoro-cli dir). Tests
 * override via the `MC_HOME` env var to a tmpdir. It holds what mc runs on:
 * the registry, sessions, the broker's sockets and logs, auth, dev servers.
 *
 * It does *not* hold worktrees. `${MC_HOME}/worktrees/<repo-slug>/<name>`
 * was the first design — a worktree lifecycle keyed on repository and
 * session, reached through `mc worktree` and measured by `mc worktrees`.
 * `workRoot()` below replaced it: a piece of work is a directory under
 * `~/mc`, and the directory is the record. Both roots were live at once and
 * only one was ever used; the old one was removed 2026-08-29 on Martin's
 * word, together with `mc task`, the tracker that shared its era.
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
 * `~/mc/plan/` — mc's own directory for planning sessions, beside `runner/`,
 * `intake/` and `brief/`. A programme's session is `~/mc/plan/<programme>/`.
 *
 * It is deliberately *not* a work area, and the reason is structural rather
 * than a rule about names: `mc run`'s `workareas()` and `mc status`'s
 * `areasWithCheckout()` both list top-level directories under the work root
 * that hold a checkout, and this one holds none — the checkouts are a level
 * further down, under each programme. So the runner cannot reach a planning
 * session, and nothing has to remember not to.
 *
 * The name lives here, with the rest of the work root's shape, because three
 * modules need it — `commands/plan.js` to build the directory, `work-area.js`
 * to keep it off the area list, `brief-collect.js` to find the decisions one
 * level deeper — and three copies of one word is how the three drift apart.
 */
export const PLAN_HOME = 'plan';

export function planHome(env = process.env) {
  return join(workRoot(env), PLAN_HOME);
}

/**
 * Best-effort detection of whether MC_HOME exists. Callers create it lazily
 * on first write.
 */
export function mcHomeExists() {
  return existsSync(mcHome());
}
