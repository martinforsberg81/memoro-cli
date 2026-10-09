/**
 * Which project is this pull request about?
 *
 * The runner reads two places — `origin/main` for the queue and the worktree
 * for the plan — and both of them can say `ready` while the step's work is
 * already sitting in an open pull request. On 2026-09-02T04:33 that started a
 * 120-minute Opus session to rebuild `action-window` step 4 while step 4's
 * work was open as #11241. GitHub is the third place to look, and this is the
 * one rule for reading its answer.
 *
 * A project's branches are `<name>` or `<name>-<suffix>` — that is the whole
 * convention, and the runner makes it true by construction: a workarea whose
 * branch has landed is moved to `<name>-<n>` before a session starts. The
 * longest name wins, because `mc`, `mc-cut`, `mc-log` and `mc-test` are all
 * project names and a pull request on `mc-cut-2` belongs to `mc-cut`, not to
 * `mc`.
 *
 * A pull request on a differently named branch is invisible to this. That is
 * deliberate: every open pull request on 2026-09-02 followed the convention,
 * and a second rule for a case nobody has seen would be a guess with a
 * session's cost behind it.
 */

/** The `--json` fields every caller of `gh pr list` here asks for. */
export const PR_FIELDS = 'number,headRefName,baseRefName,isDraft,title,updatedAt';

/** The whole question, once per repository: every open pull request it has. */
export const PR_LIST_ARGS = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', PR_FIELDS];

/**
 * The project a branch belongs to, or null. `<name>` itself, or `<name>-`
 * anything; the longest name that fits, so `mc-cut-2` is `mc-cut`'s.
 */
export function projectForBranch(branch, names = []) {
  if (!branch) return null;
  let best = null;
  for (const name of names) {
    if (!name) continue;
    if (branch !== name && !branch.startsWith(`${name}-`)) continue;
    if (!best || name.length > best.length) best = name;
  }
  return best;
}

/**
 * The open pull requests of one project, newest first as `gh` gave them.
 * `names` is every project name in play — without its siblings a name cannot
 * tell whether `mc-cut-2` is its own.
 */
export function openPrsFor({ prs = [], name, names = [], repo = null } = {}) {
  const known = names.length ? names : [name];
  return prs.filter((pr) => (repo == null || pr.repo == null || pr.repo === repo)
    && projectForBranch(pr.headRefName, known) === name);
}

/** `#11246 is open (title)` — how a pull request is named in a line a person reads. */
export function describePr(pr) {
  return `#${pr.number} is open (${pr.isDraft ? 'draft: ' : ''}${pr.title || 'no title'})`;
}

/**
 * Which step of its plan an open pull request is, counted from 1, or null.
 *
 * The step that names it when one does — a step the merger has handed back
 * keeps its `pr` — and otherwise the step the plan stands at, because that is
 * the one a session was on when it opened the pull request. On 2026-10-09
 * every one of the four open project pull requests was its plan's current
 * step and none of them was named by it: the register writes `pr` when the
 * merger answers, not when the session pushes.
 */
export function stepForPr(pr, plan) {
  const steps = Array.isArray(plan?.plan?.steps) ? plan.plan.steps : [];
  const named = steps.findIndex((step) => step?.pr != null && Number(step.pr) === Number(pr?.number));
  if (named >= 0) return named + 1;
  return Number.isInteger(plan?.step) ? plan.step : null;
}

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
 * could not answer, and the reason they got lost (Martin, 2026-10-09: twenty
 * projects in runner sessions and his own in a terminal). One of:
 *
 *   - `project`   its branch is a project's, by `projectForBranch`'s rule
 *   - `plan`      a plan session's: its branch is checked out under
 *                 `<root>/plan/<programme>/`, or it is called `plan/…`
 *   - `workarea`  checked out in a workarea, `<root>/<name>/`
 *   - `worktree`  checked out somewhere else, and `path` says where
 *   - `none`      nothing here has it checked out and no project explains it:
 *                 the one that waits on a person and nobody knows it
 *
 * The project rule goes first because it is the runner's own, and a project's
 * workarea is also a folder under `<root>` — the same pull request would
 * otherwise be both.
 */
export function prOwner(pr, { names = [], worktrees = [], root = '' } = {}) {
  const branch = pr?.headRefName || null;
  const project = projectForBranch(branch, names);
  if (project) return { kind: 'project', name: project, path: null };
  const held = branch ? worktrees.find((tree) => tree.branch === branch) : null;
  if (held) {
    const base = root ? `${root.replace(/\/+$/u, '')}/` : null;
    const inside = base && held.path.startsWith(base) ? held.path.slice(base.length).split('/') : null;
    if (inside && inside[0] === 'plan' && inside[1]) return { kind: 'plan', name: inside[1], path: held.path };
    if (inside && inside[0]) return { kind: 'workarea', name: inside[0], path: held.path };
    return { kind: 'worktree', name: null, path: held.path };
  }
  if (branch && /^plan[/-]/u.test(branch)) return { kind: 'plan', name: null, path: null };
  return { kind: 'none', name: null, path: null };
}
