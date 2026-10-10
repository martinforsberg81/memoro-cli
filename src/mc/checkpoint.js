/**
 * A snapshot of a step workarea's uncommitted work, kept as a commit under
 * `refs/mc/checkpoint/<project>` (ruling 33).
 *
 * A restart does not lose files on disk; what loses uncommitted work is the
 * runner's own `git merge --abort` and a session's own `git checkout -- .` or
 * `reset --hard`. The snapshot is the one copy that survives those. Nothing
 * applies it: a person or a handover names the ref, and
 * `git checkout refs/mc/checkpoint/<project> -- .` restores from it.
 *
 * Built through a temporary index, so the worktree, the real index and HEAD
 * are exactly as they were: `git status` runs with optional locks off, so it
 * does not even refresh the real index under a session's own git.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export const CHECKPOINT_REF = 'refs/mc/checkpoint';

/** The ref a project's snapshot is kept under. */
export function checkpointRef(project) {
  return `${CHECKPOINT_REF}/${project}`;
}

const out = (r) => (r?.ok ? String(r.stdout ?? '').trim() : null);

/**
 * Snapshot `worktree` when it is dirty. `git(cwd, args, { env })` is the
 * runner's `deps.git`; `index` is a path for the temporary index, made fresh
 * and removed again. Returns the snapshot's sha, or null for a clean tree or
 * anything git refused — never throws into the lane.
 */
export function checkpoint({
  git, worktree, project, label, index, env = {}, now = new Date(),
  mkdir = (dir) => mkdirSync(dir, { recursive: true }),
  remove = (path) => rmSync(path, { force: true }),
}) {
  const quiet = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  try {
    const status = out(git(worktree, ['status', '--porcelain'], { env: quiet }));
    if (!status) return null;
    const head = out(git(worktree, ['rev-parse', '-q', '--verify', 'HEAD'], { env: quiet }));
    if (!head) return null;
    mkdir(dirname(index));
    remove(index);
    const temp = { env: { ...quiet, GIT_INDEX_FILE: index } };
    try {
      if (!git(worktree, ['read-tree', 'HEAD'], temp).ok) return null;
      if (!git(worktree, ['add', '-A'], temp).ok) return null;
      const tree = out(git(worktree, ['write-tree'], temp));
      if (!tree) return null;
      const message = `mc checkpoint ${project} ${label} ${now.toISOString()}`;
      const sha = out(git(worktree, ['commit-tree', tree, '-p', head, '-m', message], temp));
      if (!sha) return null;
      return git(worktree, ['update-ref', checkpointRef(project), sha], temp).ok ? sha : null;
    } finally {
      remove(index);
    }
  } catch {
    return null;
  }
}
