/**
 * `mc repos` — which layout mc's two repositories are in (repos.js).
 *
 *   mc repos                     each repository: bare or primary, its git
 *                                directory, its checkout, its linked worktrees
 *   mc repos [--json]           the same, as one object
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { tildePath } from '../layout-migrate.js';
import { parseWorktrees } from '../project-prs.js';
import { defaultRepos } from '../repos.js';
import { scanArgs } from './flags.js';

export function usage() {
  return 'usage — mc repos [--json]\n';
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const home = deps.home ?? homedir();
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  let error = scanned.error;
  if (!error && scanned.positional.length) error = `mc repos takes no ${scanned.positional[0]}`;
  if (error) {
    stderr.write(`mc: ${error}\n`);
    stderr.write(usage());
    return 2;
  }
  return showRepos({ env, home, json: Boolean(scanned.flags.json), stdout });
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
