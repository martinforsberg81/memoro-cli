/**
 * The dependency tree above the workareas.
 *
 * Five test files in this repository imported `@xterm/addon-serialize`,
 * `@xterm/headless` or `node-pty`, and a workarea mc made had nowhere to
 * resolve them from — so they failed in every workarea and in the gate's
 * candidate, and a session read its own change as the cause. `work-deps.js`
 * puts one tree at `~/mc/node_modules`, above every workarea and inside none.
 * (#561 deleted those five with `src/runtime/session-host/` on 2026-09-03;
 * the manifest still declares the packages, and what the gate now checks is
 * whether they resolve, not whether somebody wrote down that they need to.)
 *
 * `npm` is never run here. What it would be asked to do is the injected
 * `install`, so these tests are about *when* it runs and *where* it writes,
 * which is the whole of the mechanism; that `npm ci` against these two files
 * works is measured on the real repository and written in the PR body.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { workDepsLockPath, workDepsManifestPath, workDepsPath } from '../../src/mc/paths.js';
import { createRunner, realDeps } from '../../src/mc/run.js';
import { areasWithCheckout } from '../../src/mc/status-collect.js';
import { addWorktree } from '../../src/mc/work-area.js';
import { ensureWorkDeps, workDepsManifest } from '../../src/mc/work-deps.js';

const MANIFEST = {
  name: 'memoro-cli',
  version: '0.7.11',
  type: 'module',
  bin: { mc: 'src/mc-cli.js' },
  // The trap: `npm ci` runs the root package's lifecycle scripts, and this
  // one names a file that exists in the repository and not in the work root.
  scripts: { postinstall: 'node scripts/postinstall.js', test: 'node --test' },
  dependencies: { '@xterm/addon-serialize': '^0.14.0', 'node-pty': '^1.1.0' },
};

/** A work root and a "repository" that declares dependencies and a lockfile. */
function fixture({ name = 'memoro-cli', manifest = MANIFEST, lock = '{"lockfileVersion":3,"one":1}' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-deps-'));
  const work = join(root, 'work');
  const repo = join(root, name);
  mkdirSync(work, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (lock !== null) writeFileSync(join(repo, 'package-lock.json'), lock);
  const installs = [];
  const install = (cwd) => { installs.push(cwd); mkdirSync(join(cwd, 'node_modules'), { recursive: true }); };
  return {
    root,
    work,
    repo,
    installs,
    env: { MC_WORK_ROOT: work, MC_REPOS_HOME: root },
    ensure: (extra = {}) => ensureWorkDeps({ repo, env: { MC_WORK_ROOT: work, MC_REPOS_HOME: root }, install, ...extra }),
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('the dependency tree above the workareas', () => {
  it('installs it in the work root, from a copy of the repository\'s two files', () => {
    const fx = fixture();
    try {
      const out = fx.ensure();
      assert.equal(out.ok, true, out.why);
      assert.equal(out.state, 'installed');
      assert.deepEqual(fx.installs, [fx.work], 'npm is asked in the work root and nowhere else');
      assert.equal(out.path, workDepsPath(fx.env));
      assert.equal(existsSync(workDepsPath(fx.env)), true);
      assert.equal(readFileSync(workDepsLockPath(fx.env), 'utf8'), readFileSync(join(fx.repo, 'package-lock.json'), 'utf8'));
    } finally { fx.cleanup(); }
  });

  it('copies the manifest without the fields that name files in the repository', () => {
    const fx = fixture();
    try {
      fx.ensure();
      const copied = JSON.parse(readFileSync(workDepsManifestPath(fx.env), 'utf8'));
      // `npm ci` would run `node scripts/postinstall.js` from the work root,
      // where that file does not exist, and fail the install.
      assert.equal(copied.scripts, undefined);
      assert.equal(copied.bin, undefined);
      assert.deepEqual(copied.dependencies, MANIFEST.dependencies, 'what npm ci has to agree with the lockfile about');
    } finally { fx.cleanup(); }
  });

  it('writes nothing into the repository it copied from', () => {
    const fx = fixture();
    try {
      fx.ensure();
      for (const entry of ['node_modules', 'package-lock.json.bak']) {
        assert.equal(existsSync(join(fx.repo, entry)), false, `${entry} in the checkout`);
      }
    } finally { fx.cleanup(); }
  });

  it('asks npm for nothing when the tree is the one this lockfile installed', () => {
    const fx = fixture();
    try {
      fx.ensure();
      const again = fx.ensure();
      assert.equal(again.state, 'current');
      assert.equal(fx.installs.length, 1, 'the second workarea pays nothing');
    } finally { fx.cleanup(); }
  });

  it('installs again when the repository\'s lockfile moves', () => {
    const fx = fixture();
    try {
      fx.ensure();
      writeFileSync(join(fx.repo, 'package-lock.json'), '{"lockfileVersion":3,"one":2}');
      assert.equal(fx.ensure().state, 'installed');
      assert.equal(fx.installs.length, 2);
      assert.equal(readFileSync(workDepsLockPath(fx.env), 'utf8'), '{"lockfileVersion":3,"one":2}');
    } finally { fx.cleanup(); }
  });

  it('installs again when the tree itself has been taken away', () => {
    const fx = fixture();
    try {
      fx.ensure();
      rmSync(workDepsPath(fx.env), { recursive: true, force: true });
      assert.equal(fx.ensure().state, 'installed');
      assert.equal(fx.installs.length, 2);
    } finally { fx.cleanup(); }
  });

  it('leaves a repository it does not serve alone, and says so', () => {
    // One directory holds one manifest, so it serves one repository. memoro
    // declares `prepare: npm ci` of its own (repo-gate-table.js) and is not
    // this tree's business.
    const fx = fixture({ name: 'memoro' });
    try {
      const out = fx.ensure();
      assert.equal(out.ok, true);
      assert.equal(out.state, 'not-shared');
      assert.deepEqual(fx.installs, []);
      assert.equal(existsSync(workDepsManifestPath(fx.env)), false);
    } finally { fx.cleanup(); }
  });

  it('is quiet about a checkout with no lockfile rather than calling it a failure', () => {
    const fx = fixture({ lock: null });
    try {
      const out = fx.ensure();
      assert.equal(out.ok, true);
      assert.equal(out.state, 'no-lockfile');
      assert.deepEqual(fx.installs, []);
    } finally { fx.cleanup(); }
  });

  it('never throws when npm fails, and repeats what npm said', () => {
    const fx = fixture();
    try {
      const out = fx.ensure({
        install: () => {
          const error = new Error('Command failed');
          error.stderr = 'npm warn ...\nnpm error code EUSAGE\nnpm error `npm ci` can only install with an existing package-lock.json\n';
          throw error;
        },
      });
      assert.equal(out.ok, false);
      assert.equal(out.state, 'failed');
      assert.match(out.why, /npm error `npm ci` can only install/u);
    } finally { fx.cleanup(); }
  });
});

describe('the tree is not a piece of work', () => {
  // Neither listing needs a filter for it, and this is why: both name a
  // directory under the work root only when it holds a checkout of a
  // repository mc knows, and `node_modules` holds none. Asserted rather than
  // built, so that a future change to either rule is caught here.
  const root = mkdtempSync(join(tmpdir(), 'mc-work-deps-root-'));
  const work = join(root, 'work');
  after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

  mkdirSync(join(work, 'alpha', 'memoro-cli', '.git'), { recursive: true });
  mkdirSync(join(work, 'node_modules', '@xterm', 'headless'), { recursive: true });
  const env = { MC_WORK_ROOT: work, MC_REPOS_HOME: root };

  it('is not on the page', () => {
    assert.deepEqual(areasWithCheckout(work).map((area) => area.name), ['alpha']);
  });

  it('is not a workarea to the runner', () => {
    const runner = createRunner({ deps: { ...realDeps(env), log: () => {}, tmuxHas: () => false } });
    assert.deepEqual(runner.workareas(), ['alpha']);
  });
});

describe('mc work add, and the tree it leaves the session', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-deps-add-'));
  const repo = join(root, 'memoro-cli');
  const work = join(root, 'work');
  after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('asks for the tree with the repository it just checked out, and puts none of it in the checkout', () => {
    mkdirSync(repo, { recursive: true });
    mkdirSync(work, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'mc-test']);
    // Dependencies declared, no lockfile: enough to prove the call arrived
    // with this repository and this work root, and it asks npm for nothing.
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'a repository with dependencies']);

    const added = addWorktree({ name: 'area', repo, branch: 'area', env: { MC_WORK_ROOT: work } });
    assert.equal(added.ok, true, added.reason);
    assert.equal(added.dependencies.state, 'no-lockfile');
    assert.equal(added.dependencies.path, join(work, 'node_modules'));
    // The reading this step exists to protect: anything under the checkout is
    // a changed path to `scripts/affected-tests.js`, and a `node_modules`
    // symlink there is not matched by `.gitignore`'s `node_modules/`.
    assert.equal(existsSync(join(work, 'area', 'memoro-cli', 'node_modules')), false);
    assert.equal(git(join(work, 'area', 'memoro-cli'), ['status', '--porcelain']), '');
  });
});

describe('workDepsManifest', () => {
  it('leaves everything npm ci has to agree with the lockfile about', () => {
    const copied = JSON.parse(workDepsManifest(JSON.stringify({
      name: 'memoro-cli', version: '1.0.0', scripts: { postinstall: 'x' }, bin: { mc: 'y' },
      dependencies: { a: '^1' }, devDependencies: { b: '^2' }, optionalDependencies: { c: '^3' },
    })));
    assert.deepEqual(copied, {
      name: 'memoro-cli', version: '1.0.0',
      dependencies: { a: '^1' }, devDependencies: { b: '^2' }, optionalDependencies: { c: '^3' },
    });
  });
});
