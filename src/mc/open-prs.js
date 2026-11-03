/**
 * Open pull requests, as `gh pr list` gives them: the fields every caller
 * asks for, the worktrees that hold their branches, and whose each one is
 * (`prOwner`). The page's PULL REQUESTS section and `mc prs` read them here.
 */
import { areaOfPath } from './paths.js';

/** The `--json` fields every caller of `gh pr list` here asks for. */
export const PR_FIELDS = 'number,headRefName,baseRefName,isDraft,title,updatedAt';

/** The whole question, once per repository: every open pull request it has. */
export const PR_LIST_ARGS = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', PR_FIELDS];

/**
 * `git worktree list --porcelain`, as `{ path, branch }` — the branch without
 * `refs/heads/`, null for a detached one.
 */
export function parseWorktrees(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      out.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '');
    }
  }
  return out;
}

/**
 * Who a pull request belongs to — the question a list of open pull requests
 * could not answer, and the reason they got lost (Martin, 2026-10-09). One of:
 *
 *   - `plan`      a plan session's: its branch is checked out under
 *                 `<root>/plan/<programme>/` or `<root>/programs/<programme>/`,
 *                 or it is called `plan/…`
 *   - `workarea`  checked out in a step, deps, work or legacy area, and
 *                 `name` is the area's without its kind (`areaOfPath`)
 *   - `worktree`  checked out somewhere that is no area, and `path` says where
 *   - `none`      nothing here has it checked out: the one that waits on a
 *                 person and nobody knows it
 */
export function prOwner(pr, { worktrees = [], root = '' } = {}) {
  const branch = pr?.headRefName || null;
  const held = branch ? worktrees.find((tree) => tree.branch === branch) : null;
  if (held) {
    const area = root ? areaOfPath(held.path, root.replace(/\/+$/u, '')) : null;
    if (area?.kind === 'plan') return { kind: 'plan', name: area.name, path: held.path };
    if (area) return { kind: 'workarea', name: area.name, path: held.path };
    return { kind: 'worktree', name: null, path: held.path };
  }
  if (branch && /^plan[/-]/u.test(branch)) return { kind: 'plan', name: null, path: null };
  return { kind: 'none', name: null, path: null };
}
