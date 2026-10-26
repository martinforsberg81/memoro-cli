/**
 * The filesystem an interactive mc session operates on, not just its cwd.
 * A programme's cwd is not a git repository. Its two worktrees share git
 * metadata elsewhere, and mc verbs write their register and runtime outside
 * the programme. Resolve these paths here; adapters only render them.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mcHome, workRoot } from './paths.js';
import { defaultRepos } from './repos.js';

export function interactiveWorkspaceDirectories({
  areaRoot,
  cwd,
  env = process.env,
  repos = defaultRepos(env),
  exists = existsSync,
  git = (path) => spawnSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }),
} = {}) {
  const candidates = [areaRoot, workRoot(env), mcHome(env), ...repos.map(repo => repo.git)];
  if (cwd) {
    const result = git(cwd);
    if (result.status === 0 && result.stdout?.trim()) candidates.push(result.stdout.trim());
  }
  return [...new Set(candidates.filter(Boolean).map(path => resolve(path)))].filter(exists);
}
