/**
 * Does this branch conflict with origin/main? Asked of git, after a fetch.
 *
 * `mc publish` and `mc goal stage <g> review|merge` ask it before they send a
 * branch on: a branch whose merge with main conflicts cannot land as it is,
 * and build found that out only at the merger or at GitHub (memoro-cli#1369
 * went six commits behind main with a content conflict, and `gh` reported
 * `mergeable: UNKNOWN`). A branch merely behind main merges cleanly and is not
 * asked about here: the merger re-checks the head it lands.
 *
 * `git merge-tree --write-tree --name-only origin/main HEAD` exits 1 on a
 * content conflict and prints the tree id, then the conflicted paths, then a
 * blank line and the messages. Any other failure (no origin/main, no git) is
 * no answer, and it refuses nothing. A fetch that fails is reported by the
 * caller as a warning, not a refusal.
 */
import { run as runGit } from './git.js';

/** `git fetch -q origin` in `cwd`: `{ ok, text }`, the text git said when it failed. */
export function fetchOrigin(cwd, { run = runGit } = {}) {
  const r = run(cwd, ['fetch', '-q', 'origin']);
  if (r.status === 0) return { ok: true, text: '' };
  return { ok: false, text: String(r.stderr || r.error?.message || 'git fetch failed').trim() };
}

/**
 * The paths that conflict when `head` is merged into `base`: `{ paths }`, empty
 * when the merge is clean or cannot be asked.
 */
export function mainConflicts(cwd, { run = runGit, base = 'origin/main', head = 'HEAD' } = {}) {
  const r = run(cwd, ['merge-tree', '--write-tree', '--name-only', base, head]);
  if (r.status !== 1) return { paths: [] };
  const lines = String(r.stdout || '').split('\n').slice(1);
  const end = lines.indexOf('');
  const paths = (end < 0 ? lines : lines.slice(0, end)).map((line) => line.trim()).filter(Boolean);
  return { paths };
}

/** The check both callers make: `{ fetch: { ok, text }, paths }` for the worktree at `cwd`. */
export function checkAgainstMain(cwd, { run = runGit } = {}) {
  const fetch = fetchOrigin(cwd, { run });
  return { fetch, paths: mainConflicts(cwd, { run }).paths };
}

/** The reason a conflicting branch is not sent on, naming its paths: one sentence, for `mc:` and the goal's refusal. */
export function conflictReason(paths) {
  return `the branch conflicts with origin/main in ${paths.join(', ')} — rebase onto origin/main, then run this again`;
}
