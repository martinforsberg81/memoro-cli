/**
 * One dependency tree, one directory above the workareas.
 *
 * `mc work add` used to hand a session a checkout with nothing to import
 * from. Five of this repository's test files need `@xterm/addon-serialize`,
 * `@xterm/headless` or `node-pty` — measured 2026-09-02 on a clean
 * `origin/main` worktree: 14 failing files without a dependency tree, 9 with,
 * and the five in the difference fail with `ERR_MODULE_NOT_FOUND`. A session
 * reading that sees its own change blamed for a missing package.
 *
 * The tree goes at `~/mc/node_modules` (`paths.js`), above every workarea and
 * inside none of them, because node resolves a bare specifier by walking
 * `node_modules` up every parent of the importing file. `npm ci` per workarea
 * is what this avoids: 40 directories under `~/mc` on 2026-09-02 and the same
 * three packages for all of them.
 *
 * ## What the directory holds, and why this and not the other one
 *
 * An `npm ci` of its own, run in the work root against a copy of the
 * repository's `package.json` and `package-lock.json`. The alternative
 * measured first was symlinks into `~/memoro-cli/node_modules`, which costs
 * nothing to make and ties every workarea's tests to one checkout's install:
 * the packages a workarea resolves would then be whatever the user's own
 * checkout last installed, at whatever version its lockfile said, and an
 * `npm ci` there while a session is running would pull them out from under
 * it. This form owns what it holds. It costs one `npm ci` — measured
 * 2026-09-02 in a temporary directory with these two files: exit 0, 4
 * packages, 6 s — and it is paid once, not once per workarea.
 *
 * The price is keeping the copy in step with the repository, so that is the
 * only question asked on the way in: the repository's lockfile against the
 * copy at the work root. Same bytes and a tree already there means nothing
 * runs. A lockfile that has moved means one `npm ci`, for the workarea that
 * happened to be next and every workarea after it.
 *
 * The copy is the repository's manifest minus `scripts` and `bin`. `npm ci`
 * runs the root package's lifecycle scripts, and this repository's
 * `postinstall` is `node scripts/postinstall.js` — a path that does not exist
 * in the work root, so a verbatim copy fails the install. Dropping the two
 * fields that name files leaves the dependency declaration, which is the
 * whole of what `npm ci` needs to agree with the lockfile.
 *
 * The manifest copied is the repository's own — `~/memoro-cli`, on whatever
 * it has checked out, which is main — and not the new workarea's branch. One
 * directory holds one tree, so reading each branch's manifest would have two
 * workareas on two branches reinstalling over each other. The cost is that a
 * branch which adds a dependency does not get it until it lands; the session
 * on that branch installs it itself, and nothing here stops it.
 *
 * ## The gate's candidate resolves the same directory
 *
 * The merge gate builds its throwaway worktree under the work root too
 * (`paths.js`, `WORK_GATE` beside `WORK_DEPS`), so the tree is two parents
 * above the candidate and there is one copy of it rather than one per place
 * that runs the tests. The round calls this on the candidate itself and names
 * the repository with `repoName`: a pull request that changes the lockfile is
 * measured against a tree installed from *its* lockfile, which is the one
 * reading of "what this change does to the suite" that is not a lie. The
 * shared tree then stands at that pull request's lockfile until the next
 * caller moves it — one directory, one lockfile, and the price of that is
 * paid here rather than hidden.
 *
 * ## One repository's tree, named rather than inferred
 *
 * One directory holds one manifest, so it can serve one repository, and the
 * one it serves is written down here rather than decided by whichever
 * workarea was made first. memoro is not it: it declares `prepare: 'npm ci'`
 * in `repo-gate-table.js` (measured, D-0089) and its dependencies are its
 * own. A repository that is not on this list is left alone and told so.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  workDepsLockPath,
  workDepsManifestPath,
  workDepsPath,
  workRoot,
} from './paths.js';

/**
 * The repositories whose dependency tree mc keeps above the workareas.
 *
 * A list of one, and it is a list rather than a constant because the shape of
 * the question is "which repositories", not "is it memoro-cli" — but adding a
 * second name is not free: two repositories cannot share one `package.json`,
 * so a second one needs a second directory, and that is a change here rather
 * than an edit to this line.
 */
export const SHARED_TREE_REPOS = Object.freeze(['memoro-cli']);

/**
 * What gets written to the work root: the repository's manifest, minus the
 * two fields that name files inside the repository.
 */
export function workDepsManifest(text) {
  const manifest = JSON.parse(text);
  delete manifest.scripts;
  delete manifest.bin;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Make sure the tree above the workareas matches the repository, and say what
 * it took.
 *
 * `repo` is where the two files are read from; `repoName` is which repository
 * they belong to, for the caller that reads them from somewhere that is not
 * the checkout itself. The merge gate is that caller: its candidate is a
 * worktree called `candidate`, and the tree it resolves through is the same
 * one directory the workareas resolve through, one level under the work root.
 *
 * Never throws and never fatal to its caller: a workarea whose tests cannot
 * resolve a package is worse off than one whose tests can, and both are
 * better off than no workarea at all. The gate leans on the same property
 * from the other end — it measures whether the candidate resolves anything
 * (`dependency-tree.js`) rather than trusting what this returned. `state` is
 * one of `not-shared`, `no-manifest`, `no-lockfile`, `no-dependencies`,
 * `current`, `installed`, `failed`.
 */
export function ensureWorkDeps({ repo, repoName = null, env = process.env, install = npmCi } = {}) {
  const name = String(repoName || repo || '').replace(/\/+$/u, '').split('/').pop() || '';
  const path = workDepsPath(env);
  if (!SHARED_TREE_REPOS.includes(name)) {
    return { ok: true, state: 'not-shared', path, why: `${name || 'this repository'} keeps its own dependencies` };
  }
  try {
    // A checkout without either file is not a failure to report — a fixture
    // repository and a repository between clone and install both look like
    // this, and neither is asking for a tree.
    if (!existsSync(join(repo, 'package.json'))) return { ok: true, state: 'no-manifest', path, why: `${name} has no package.json` };
    if (!existsSync(join(repo, 'package-lock.json'))) return { ok: true, state: 'no-lockfile', path, why: `${name} has no package-lock.json` };
    const lock = readFileSync(join(repo, 'package-lock.json'), 'utf8');
    const wanted = workDepsManifest(readFileSync(join(repo, 'package.json'), 'utf8'));
    if (!Object.keys(JSON.parse(wanted).dependencies || {}).length) {
      return { ok: true, state: 'no-dependencies', path, why: `${name} declares no dependencies` };
    }
    if (existsSync(path) && read(workDepsLockPath(env)) === lock && read(workDepsManifestPath(env)) === wanted) {
      return { ok: true, state: 'current', path, why: `${name}'s lockfile is the one this tree was installed from` };
    }
    mkdirSync(workRoot(env), { recursive: true });
    writeFileSync(workDepsManifestPath(env), wanted);
    writeFileSync(workDepsLockPath(env), lock);
    install(workRoot(env));
    return { ok: true, state: 'installed', path, why: `${name}'s lockfile changed` };
  } catch (error) {
    return { ok: false, state: 'failed', path, why: whyItFailed(error) };
  }
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * `npm ci` in the work root. Not `--ignore-scripts`: `node-pty` is native and
 * its install script is how it comes to have a binding to load.
 */
function npmCi(cwd) {
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60 * 1000,
  });
}

/** npm narrates before it fails; the last thing it said is the diagnosis. */
function whyItFailed(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines.findLast((line) => /^npm (error|ERR!)/iu.test(line)) || lines.at(-1) || 'unknown').slice(0, 200);
}
