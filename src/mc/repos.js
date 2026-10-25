/**
 * mc's two repositories, in whichever of the two layouts this machine has.
 *
 * The first layout is the primary checkouts `~/memoro` and `~/memoro-cli`:
 * each is a working tree, every worktree mc makes hangs off its `.git`, and
 * `/opt/homebrew/bin/mc` runs whatever `~/memoro-cli` has checked out. The
 * second splits the two jobs a primary checkout did (Martin, 2026-10-24,
 * proposal 2026-10-24-mc-environment-model, part 3): `~/mc/repos/<name>.git`
 * is a bare repository every worktree hangs off, and `~/mc/self/<name>` is a
 * worktree of it on `main` — the one mc links to (memoro-cli) and the one
 * `mc shot` and `mc test dev` serve outside a worktree (memoro).
 *
 * Every caller asks `defaultRepos` and takes the field it needs, so the same
 * code runs before and after the move:
 *
 * - `path` — the directory to run git plumbing in: `fetch`, `show`,
 *   `rev-parse`, `log`, `branch`, `worktree add|list|prune|repair`, and `gh`.
 *   The bare directory, or the primary checkout.
 * - `checkout` — a working tree on `main` to read a file from or run a
 *   porcelain command (`pull`, `status`, `checkout`) in: `self/<name>` when it
 *   exists, else the primary checkout when there is one, else null. A caller
 *   that needs one says in words what it does without.
 * - `git` — the git directory, what `--git-common-dir` of any worktree names:
 *   how a directory is recognised as one of these repositories.
 *
 * `MC_REPOS_HOME` moves all of it at once — the primary checkouts, the bare
 * repositories and `self/` — so a test's fixture never reaches this machine's.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { reposHome, selfHome } from './paths.js';

/** The repositories that carry projects. */
export const REPO_NAMES = Object.freeze(['memoro', 'memoro-cli']);

/** `{ name, git, path, bare, checkout }` per repository in `REPO_NAMES`. */
export function defaultRepos(env = process.env, { exists = existsSync } = {}) {
  const home = env.MC_REPOS_HOME || homedir();
  return REPO_NAMES.map((name) => {
    const bareGit = join(reposHome(env), `${name}.git`);
    const bare = exists(bareGit);
    const primary = join(home, name);
    const self = join(selfHome(env), name);
    const git = bare ? bareGit : join(primary, '.git');
    const checkout = exists(self) ? self : (bare ? null : primary);
    return { name, git, path: bare ? bareGit : primary, bare, checkout };
  });
}

/** A repository's git directory: its `git`, or `<path>/.git` for a `{ name, path }` a caller built itself. */
export function gitDirOf(repo) {
  return repo.git || join(repo.path, '.git');
}

/**
 * The repository a `--git-common-dir` belongs to: the directory around a
 * `.git`, or the bare repository itself — whose common directory is the
 * repository, so its parent is `~/mc/repos/`, which is no repository at all.
 */
export function repositoryDir(commonDir) {
  const dir = String(commonDir).replace(/\/+$/u, '');
  return basename(dir) === '.git' ? dirname(dir) : dir;
}

/** A repository's name from its directory: `memoro-cli` for `~/memoro-cli` and for `~/mc/repos/memoro-cli.git`. */
export function repoNameOf(path) {
  return String(path || '').replace(/\/+$/u, '').split('/').pop().replace(/\.git$/u, '');
}
