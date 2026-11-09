/**
 * A branch the deploy produced, landed through a pull request.
 *
 * `scripts/deploy.mjs` must leave its checkout clean on `main`, so a change it
 * makes while it runs — memoro's own business — is committed on a branch from
 * the deployed sha and pushed, never to `main`, and the script says so in one
 * line as its last output:
 *
 *   Deploy branch: <branch>
 *
 * This is the only thing mc reads of it. mc knows nothing about what the branch
 * holds: it opens a pull request from the
 * branch to `main` and queues it for the merger, the way `mc publish` does, so
 * the change reaches `main` the one way anything does. Failing to open or queue
 * the pull request is reported and nothing else: the deploy's exit code and
 * recorded outcome are the script's.
 */

import { markedBody, messageParts } from './publish.js';

const BRANCH_LINE = /^Deploy branch: (\S+)$/u;

/** The branch the script named, from its output with the colours already stripped; the last line wins, null for none. */
export function branchNamed(lines) {
  let found = null;
  for (const line of lines) {
    const match = BRANCH_LINE.exec(line);
    if (match) found = match[1];
  }
  return found;
}

/**
 * Open the pull request from `branch` to main and queue it. Returns
 * `{ number, ref, url, queued, error }`: `error` is a sentence when any step failed
 * (the pull request, once opened, stays open and its number is still returned).
 * Never throws.
 */
export async function openBranchPr({ worktree, branch, short, repo, git, gh, merge, stdout, stderr }) {
  try {
    // The branch's own commit message is the title and description. The fetch
    // changes no checkout: it writes FETCH_HEAD and a remote-tracking ref.
    let title = `Land the branch the deploy of ${short} produced`;
    let body = `Made by scripts/deploy.mjs while it deployed ${short}, and pushed as \`${branch}\` so the deploy checkout could end clean on main.`;
    let head = '';
    if (git(worktree, ['fetch', '--quiet', 'origin', branch]) !== null) {
      head = git(worktree, ['rev-parse', 'FETCH_HEAD']) || '';
      const parts = messageParts(git(worktree, ['log', '-1', '--format=%B', 'FETCH_HEAD']));
      if (parts.title) { title = parts.title; body = parts.body || body; }
    }
    const made = gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', head ? markedBody(body, head) : body]);
    const number = made.ok ? Number(/\/pull\/(\d+)/u.exec(made.stdout || '')?.[1]) || null : null;
    if (!number) return { number: null, ref: '', url: '', queued: false, error: `gh pr create failed: ${made.text || 'no pull request number in its answer'}` };
    const url = (/\S*\/pull\/\d+/u.exec(made.stdout || '') || [''])[0];
    const ref = `${repo}#${number}`;
    const code = await merge([repo, String(number)], { stdout, stderr });
    if (code !== 0) return { number, ref, url, queued: false, error: `mc merge ${repo} ${number} exited ${code}` };
    return { number, ref, url, queued: true, error: '' };
  } catch (error) {
    return { number: null, ref: '', url: '', queued: false, error: error?.message || String(error) };
  }
}

/** What the row's note says of the pull request. */
export function pinNote(branch, pr) {
  if (pr.number && pr.queued) return `${branch} landed through ${pr.ref}, queued`;
  if (pr.number) return `${branch} opened as ${pr.ref}, not queued (${pr.error})`;
  return `${branch} has no pull request (${pr.error})`;
}
