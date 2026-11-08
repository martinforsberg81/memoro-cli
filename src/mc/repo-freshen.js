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
import { isNetworkFailure } from './network-failure.js';

import { runShell } from './child-async.js';
import { runAsync as runGitAsync } from './git.js';
import { existingCandidate } from './existing-candidate.js';
import { regenerateDerived } from './repo-derived.js';

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
 *
 * With a `declaration` carrying `derived`, the declared commands run after the
 * merge, exactly as they did in the gate's candidate (`repo-derived.js`). That
 * is also why a single round calls this: when the gate had to regenerate, the
 * branch has to be given the same commit before its squash.
 */
export async function freshenBranchForLanding({
  repoPath, branch, base, declaration = null, env = process.env, git = null, shell = null, say = () => {}, candidateCwds = undefined,
} = {}) {
  const askGit = git || ((args, options = {}) => runGitAsync(options.cwd, args, { env }));
  const askShell = shell || ((command, options = {}) => runShell(command, { cwd: options.cwd, env }));
  // A fetch that fails read nothing: the network's, not the branch's (`offline`).
  const fetched = await askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
  if (fetched && Number.isInteger(fetched.status) && fetched.status !== 0) {
    return { ok: false, offline: true, reason: `git fetch origin --prune failed before freshening ${branch} (${trim(fetched.stderr) || `exit ${fetched.status}`})` };
  }
  const head = await askGit(['rev-parse', `origin/${branch}`], { cwd: repoPath });
  if (head.status !== 0) return { ok: false, reason: trim(head.stderr) || `could not read origin/${branch}` };
  const borrowed = await existingCandidate({ repoPath, branch, sha: trim(head.stdout), git: askGit, cwds: candidateCwds });
  if (!borrowed.ok) return borrowed;
  const workspace = borrowed.dir;
  let result;
  try {
    result = await freshen();
  } finally {
    const restored = await borrowed.restore({ advanceTo: result?.ok ? result.sha : null });
    if (!restored.ok) result = { ok: false, reason: restored.reason };
  }
  return result;

  async function freshen() {
    const ready = await borrowed.start();
    if (!ready.ok) return ready;
    const merged = await askGit(['merge', '--no-edit', `origin/${base}`], { cwd: workspace });
    if (merged.status !== 0) {
      const conflicted = trim((await askGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workspace })).stdout).split('\n').filter(Boolean);
      await askGit(['merge', '--abort'], { cwd: workspace });
      return { ok: false, reason: `${branch} conflicts with ${base} in ${conflicted.slice(0, 5).join(', ') || 'unknown files'} — left exactly as it was` };
    }
    // The gate regenerated the declared derived artifacts after merging the
    // base into its candidate; the branch has to carry the same regeneration,
    // or the squash lands a stale snapshot and main is not the measured tree.
    // Nothing is pushed when it fails.
    const derived = declaration?.derived || [];
    if (derived.length) {
      if (declaration.prepare) {
        const ready = await askShell(declaration.prepare, { cwd: workspace });
        if (ready.status !== 0) return { ok: false, reason: `${declaration.prepare} failed before regenerating derived artifacts — ${trim(ready.stderr)}` };
      }
      const fresh = await regenerateDerived({ derived, cwd: workspace, env, git: askGit, shell: askShell, say });
      if (!fresh.ok) return { ok: false, reason: fresh.reason };
      if (fresh.commit) say(`regenerated ${fresh.regenerated.length} derived file${fresh.regenerated.length === 1 ? '' : 's'} on ${branch}`);
    }
    const pushed = await askGit(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workspace });
    if (pushed.status !== 0) {
      const error = trim(pushed.stderr);
      return { ok: false, ...(isNetworkFailure(error) ? { offline: true } : {}), reason: error || 'push refused' };
    }
    // The whole sha is what the squash is pinned to (`--match-head-commit`);
    // the seven characters are only what the progress line shows.
    const sha = trim((await askGit(['rev-parse', 'HEAD'], { cwd: workspace })).stdout);
    const at = sha.slice(0, 7);
    say(`freshened ${branch} for its landing: ${base} merged in at ${at}`);
    return { ok: true, at, sha };
  }
}

function trim(value) {
  return String(value ?? '').trim();
}
