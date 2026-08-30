/**
 * Bringing a branch up to date with main — for the branch that is landing,
 * and for no other.
 *
 * ## What used to be here, and why it is gone
 *
 * Until 2026-08-30 a green merge round ended by freshening **every open pull
 * request on the repository** (A6): check each one out, merge the new main
 * into it, run its declared `affected`, push, and write a line into its
 * owner's inbox. It came from a real measurement — one branch rebased twice in
 * forty minutes because main moved under it — and it was still the wrong
 * shape.
 *
 * A round that lands #482 has one subject: #482. Everything it does to a
 * branch nobody asked it about is where the surprises come from. In practice
 * that meant every round reported that two unrelated pull requests from six
 * days earlier conflicted with main — a fact about those branches, restated by
 * every round that had nothing to do with them, until it read as though
 * something were wrong with the merge that had just succeeded.
 *
 * It was also redundant. Drift is already handled at the moment it matters:
 * the gate merges the current base *into the candidate* before measuring, so a
 * pull request is always measured as the state it would leave behind. A branch
 * that has fallen behind main finds out in its own round — the round that can
 * actually do something about it. Martin, the same day: *"ta EN PR, merga med
 * main. Bry sig NADA om allt annat. Det problemet får tas när det är den
 * PR:ens tur."*
 *
 * A conflict has to be resolved by a person either way. All the sweep bought
 * was learning about it earlier, at the price of pushing to branches and
 * messaging people from a round that was about something else.
 *
 * ## What is left
 *
 * One function, for the one case where the branch being freshened *is* part of
 * the round's subject: a batch, whose pull requests were named on the command
 * line.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { gateRoot } from './repo-gate.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';

/**
 * One branch, freshened for its landing inside a batch (A3's found limit).
 *
 * The batch verifies together and lands sequentially — and every squash-merge
 * makes the next pull request in the batch unmergeable to the forge, because
 * the squash is a commit none of the other branches has. Measured on the first
 * live batch (2026-08-23): five verified green on one candidate, one landed,
 * the second refused with "Pull Request has merge conflicts", four left for
 * hands. So between landings the just-made main is merged into the next branch
 * and pushed.
 *
 * Every branch this touches was named on the command line. That is the whole
 * difference between this and the sweep that used to sit above it.
 *
 * The branch is freshened by merging the base *into* it, never by rebasing:
 * the repository's convention since #363→#364 is "merge main in, no
 * force-push". A rebase rewrites history under the branch owner's feet; a
 * merge commit pushed plainly needs nothing from them.
 *
 * A conflict aborts and touches nothing; the caller stops the batch there.
 */
export function freshenBranchForLanding({
  repoPath, branch, base, root = mcHome(), env = process.env, git = null, say = () => {},
} = {}) {
  const run = (tool) => (args, options = {}) => spawnSync(tool, args, {
    cwd: options.cwd, env, encoding: 'utf8',
  });
  const askGit = git || run('git');
  const workspace = join(gateRoot(root), `${repoFileSlug(repoPath)}-freshen`);
  askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
  rmSync(workspace, { recursive: true, force: true });
  askGit(['worktree', 'prune'], { cwd: repoPath });
  const added = askGit(['worktree', 'add', '--detach', workspace, `origin/${branch}`], { cwd: repoPath });
  if (added.status !== 0) return { ok: false, reason: trim(added.stderr) || `could not check out origin/${branch}` };
  try {
    const merged = askGit(['merge', '--no-edit', `origin/${base}`], { cwd: workspace });
    if (merged.status !== 0) {
      const conflicted = trim(askGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workspace }).stdout).split('\n').filter(Boolean);
      askGit(['merge', '--abort'], { cwd: workspace });
      return { ok: false, reason: `${branch} conflicts with ${base} in ${conflicted.slice(0, 5).join(', ') || 'unknown files'} — left exactly as it was` };
    }
    const pushed = askGit(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workspace });
    if (pushed.status !== 0) return { ok: false, reason: trim(pushed.stderr) || 'push refused' };
    const at = trim(askGit(['rev-parse', 'HEAD'], { cwd: workspace }).stdout).slice(0, 7);
    say(`freshened ${branch} for its landing: ${base} merged in at ${at}`);
    return { ok: true, at };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    askGit(['worktree', 'prune'], { cwd: repoPath });
  }
}

function trim(value) {
  return String(value ?? '').trim();
}
