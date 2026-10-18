/**
 * One dependency tree, one directory above the workareas.
 *
 * `mc work add` used to hand a session a checkout with nothing to import
 * from. Five of this repository's test files needed `@xterm/addon-serialize`,
 * `@xterm/headless` or `node-pty` — measured 2026-09-02 on a clean
 * `origin/main` worktree: 14 failing files without a dependency tree, 9 with,
 * and the five in the difference failed with `ERR_MODULE_NOT_FOUND`. A session
 * reading that sees its own change blamed for a missing package.
 *
 * Those five went with `src/runtime/session-host/` in #561 on 2026-09-03, one
 * day after they were measured, and no test file imports the three packages
 * today. `package.json` still declares them and `scripts/mc-live-page-check.mjs`
 * still imports two, so the tree is still what a checkout resolves through —
 * and what makes that safe to say is no longer this paragraph but
 * `dependency-tree.js`, which the gate asks every round.
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
 * ## The gate's candidate resolves the same directory — until it differs
 *
 * The merge gate builds its throwaway worktree under the work root too
 * (`paths.js`, `WORK_GATE` beside `WORK_DEPS`), so the tree is two parents
 * above the candidate and there is one copy of it rather than one per place
 * that runs the tests. The round calls this on the candidate itself, names
 * the repository with `repoName` and passes `ownTree`: the candidate's own
 * directory. A candidate whose lockfile is the one the shared tree holds
 * resolves through it and nothing runs. One whose lockfile differs gets
 * `npm ci` in its own checkout instead (`installed-own`), so it is measured
 * against a tree installed from *its* lockfile — and the shared tree, which
 * every live session resolves through, is never flipped under them by a
 * merge round. Until 2026-10-18 the round reinstalled the shared tree at the
 * pull request's lockfile and left it there.
 *
 * ## Installed means installed
 *
 * `npm ci` reads the two copies in the work root, so they are written before
 * it runs — and an install that then failed used to leave them matching, so
 * the next caller read `current` over a broken tree. A tree is current only
 * when it carries `INSTALLED_MARK`, written inside it after a successful
 * install with the hash of the two files it was installed from; `npm ci`
 * empties `node_modules` first, so a failed one leaves no mark.
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
import { createHash } from 'node:crypto';
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

/** The file inside the tree that says a successful install made it, and from what. */
export const INSTALLED_MARK = '.mc-installed';

/** What the mark holds: sha256 over the lockfile, NUL, the manifest copy. */
export function installedHash(lock, manifest) {
  return createHash('sha256').update(lock).update('\0').update(manifest).digest('hex');
}

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
 * it took — as a promise when `install` returns one, as the result otherwise.
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
 * `current`, `installed`, `installed-own`, `failed`.
 *
 * `ownTree` is the merge gate's: a directory to run `npm ci` in, with its own
 * two files, when the shared tree is not current for them — instead of
 * reinstalling the shared tree. The shared tree and its copies are then left
 * exactly as they were.
 */
export function ensureWorkDeps({ repo, repoName = null, env = process.env, install = npmCi, ownTree = null } = {}) {
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
    const hash = installedHash(lock, wanted);
    if (existsSync(path) && read(join(path, INSTALLED_MARK)) === `${hash}\n`
      && read(workDepsLockPath(env)) === lock && read(workDepsManifestPath(env)) === wanted) {
      return { ok: true, state: 'current', path, why: `${name}'s lockfile is the one this tree was installed from` };
    }
    if (ownTree) {
      const own = join(ownTree, 'node_modules');
      const installedOwn = { ok: true, state: 'installed-own', path: own, why: `${name}'s lockfile here is not the one the shared tree holds, so it was installed in ${ownTree} and the shared tree was left alone` };
      return settle(install(ownTree), () => installedOwn, own);
    }
    mkdirSync(workRoot(env), { recursive: true });
    writeFileSync(workDepsManifestPath(env), wanted);
    writeFileSync(workDepsLockPath(env), lock);
    const installed = { ok: true, state: 'installed', path, why: `${name}'s lockfile changed` };
    // The mark goes in only once npm said yes; a failed install leaves none.
    return settle(install(workRoot(env)), () => { writeFileSync(join(path, INSTALLED_MARK), `${hash}\n`); return installed; }, path);
  } catch (error) {
    return { ok: false, state: 'failed', path, why: whyItFailed(error) };
  }
}

/**
 * The install's outcome, as a promise when `install` returned one, as the
 * result otherwise. The merge gate's install returns a promise, so the
 * merger's process is not held for the ten minutes `npm ci` may take;
 * `mc work add` keeps the synchronous one and gets its answer synchronously.
 */
function settle(pending, done, path) {
  const failed = (error) => ({ ok: false, state: 'failed', path, why: whyItFailed(error) });
  if (typeof pending?.then === 'function') {
    return pending.then(() => { try { return done(); } catch (error) { return failed(error); } }, failed);
  }
  return done();
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
