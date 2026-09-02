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
export const PR_FIELDS = 'number,headRefName,baseRefName,isDraft,title';

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
