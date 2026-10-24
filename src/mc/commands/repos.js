/**
 * `mc repos` — which layout mc's two repositories are in, and the move from the
 * primary checkouts to the bare layout (repos.js, `repos-migrate.js`).
 *
 *   mc repos                     each repository: bare or primary, its git
 *                                directory, its checkout, its linked worktrees
 *   mc repos [--json]           the same, as one object
 *   mc repos migrate             the dry run: every move in order, every refusal,
 *                                a count; writes nothing. Exit 0 with no refusal, 1 otherwise
 *   mc repos migrate --json      `{ moves, refusals }`
 *   mc repos migrate --apply     the move: the plan made again, every move carried
 *                                out in order and logged to ~/mc/runner/log/repos-migrate.log.
 *                                A refusal moves nothing; the first move that fails stops
 *                                it (exit 1), and a second run continues from there
 *
 * A person runs the move once, from a terminal outside both checkouts, with the
 * runner, the merger and the dev servers stopped. Nothing in mc calls it.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { tildePath } from '../layout-migrate.js';
import { workRoot } from '../paths.js';
import { applyReposMove, dryRunLines, gatherReposFacts, parseWorktrees, planReposMove, refusedLines } from '../repos-migrate.js';
import { defaultRepos } from '../repos.js';
import { scanArgs } from './flags.js';

export function usage() {
  return 'usage — mc repos [--json] · mc repos migrate [--json] · mc repos migrate --apply\n';
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const home = deps.home ?? homedir();
  const scanned = scanArgs(argv, { booleans: ['--json', '--apply'] });
  const [sub, ...rest] = scanned.positional;
  let error = scanned.error;
  if (!error && sub !== undefined && sub !== 'migrate') error = `mc repos knows migrate, not ${sub}`;
  if (!error && rest.length) error = `mc repos ${sub} takes no name`;
  if (!error && scanned.flags.apply && sub !== 'migrate') error = '--apply belongs to mc repos migrate';
  if (!error && scanned.flags.apply && scanned.flags.json) error = '--json belongs to the dry run, not --apply';
  if (error) {
    stderr.write(`mc: ${error}\n`);
    stderr.write(usage());
    return 2;
  }
  const json = Boolean(scanned.flags.json);
  if (sub === undefined) return showRepos({ env, home, json, stdout });
  if (scanned.flags.apply) return apply({ root, env, home, stdout, stderr, facts: deps.facts, moves: deps.moves });
  return migrate({ root, env, home, json, stdout, facts: deps.facts });
}

/** Linked worktrees of a repository: every worktree but its main one. Null when git cannot say. */
function linkedWorktrees(repo) {
  try {
    const listed = execFileSync('git', repo.bare
      ? ['--git-dir', repo.git, 'worktree', 'list', '--porcelain']
      : ['-C', repo.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Math.max(parseWorktrees(listed).length - 1, 0);
  } catch { return null; }
}

/** The layout: each repository, and whether it is bare. */
function showRepos({ env, home, json, stdout }) {
  const repos = defaultRepos(env).map((repo) => ({ ...repo, linked: linkedWorktrees(repo) }));
  if (json) {
    stdout.write(`${JSON.stringify({ repos }, null, 2)}\n`);
    return 0;
  }
  const bare = repos.filter((repo) => repo.bare).length;
  stdout.write(`repos — ${bare === repos.length ? 'bare' : bare ? 'half moved' : 'primary checkouts'}\n`);
  for (const repo of repos) {
    const linked = repo.linked === null ? 'worktrees unknown' : `${repo.linked} linked worktree${repo.linked === 1 ? '' : 's'}`;
    stdout.write(`  ${repo.name.padEnd(11)} ${repo.bare ? 'bare   ' : 'primary'}  git ${tildePath(repo.git, home)}  checkout ${repo.checkout ? tildePath(repo.checkout, home) : 'none'}  ${linked}\n`);
  }
  return 0;
}

/** The dry run: exit 0 with nothing refused, 1 otherwise. */
function migrate({ root, env, home, json, stdout, facts: factDeps }) {
  const facts = gatherReposFacts({ env, root, deps: factDeps });
  const plan = planReposMove(facts);
  if (json) stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else stdout.write(`${dryRunLines({ ...plan, installs: facts.installs }, home).join('\n')}\n`);
  return plan.refusals.length ? 1 : 0;
}

/**
 * The move: the facts read and the plan made again, never an earlier dry run's.
 * A refusal moves nothing (exit 1); otherwise every move in order, and exit 1 at
 * the first that fails.
 */
function apply({ root, env, home, stdout, stderr, facts: factDeps, moves: moveDeps }) {
  const facts = gatherReposFacts({ env, root, deps: factDeps });
  const plan = planReposMove(facts);
  if (plan.refusals.length) {
    stdout.write(`${refusedLines(plan.refusals, home).join('\n')}\n`);
    return 1;
  }
  if (!plan.moves.length) {
    stdout.write('repos — nothing to move\n');
    return 0;
  }
  return applyReposMove(plan, { root, home, stdout, stderr, deps: moveDeps });
}
