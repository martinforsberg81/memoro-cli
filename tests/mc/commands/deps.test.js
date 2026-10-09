/**
 * `mc deps bump` — one group of the reading turned into a pull request.
 *
 * Every outside call is injected: the reading, `addWorktree`, npm, git,
 * `mc publish` and `mc merge`. The fixture is one exact pin and one caret
 * range in the security group, one devDependency in the minor group, and one
 * package already newest in its major.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseWhat, workareaName } from '../../../src/mc/deps-bump.js';
import { run } from '../../../src/mc/commands/deps.js';

const MANIFEST = {
  name: 'fixture',
  dependencies: { wrangler: '4.116.0', tiny: '^0.20.2', settled: '^2.0.0' },
  devDependencies: { builder: '^4.1.0' },
};

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture' },
    'node_modules/wrangler': { version: '4.116.0' },
    'node_modules/tiny': { version: '0.20.2' },
    'node_modules/settled': { version: '2.3.0' },
    'node_modules/builder': { version: '4.1.0', dev: true },
  },
};

const row = (name, kind, installed, target, extra = {}) => ({
  name, kind, spec: MANIFEST.dependencies[name] || MANIFEST.devDependencies[name],
  installed, target, in_major: target, latest: target, severity: null, via: [], error: null, ...extra,
});

const READING = {
  repo: 'memoro',
  sha: 'abc1234def',
  read_at: '2026-10-09T10:00:00.000Z',
  audit: { counts: { critical: 2, high: 24, moderate: 1, low: 0 }, transitive_fixable: 5 },
  groups: {
    security: [
      row('wrangler', 'runtime', '4.116.0', '4.149.0', { severity: 'high' }),
      row('tiny', 'runtime', '0.20.2', '0.20.5', { severity: 'critical' }),
    ],
    minor: [row('builder', 'tool', '4.1.0', '4.12.0')],
    major: [],
  },
  unread: [],
  notes: [],
};

const EMPTY = { ...READING, audit: { counts: {}, transitive_fixable: 0 }, groups: { security: [], minor: [], major: [] } };

let root;
let env;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-deps-bump-'));
  env = { MC_WORK_ROOT: join(root, 'work') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

function harness({ reading = READING, porcelain = ' M package.json\n M package-lock.json\n', publishCode = 0, mergeCode = 0 } = {}) {
  const calls = { git: [], npm: [], addWorktree: [], publish: [], merge: [] };
  const git = async (args, { cwd } = {}) => {
    calls.git.push({ args, cwd });
    if (args[0] === 'show' && args[1] === 'origin/main:package.json') return { status: 0, stdout: JSON.stringify(MANIFEST), stderr: '' };
    if (args[0] === 'show' && args[1] === 'origin/main:package-lock.json') return { status: 0, stdout: JSON.stringify(LOCK), stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: porcelain, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const npm = async (args, { cwd } = {}) => {
    calls.npm.push({ args, cwd });
    return { status: 0, stdout: '', stderr: '' };
  };
  const addWorktree = (options) => {
    calls.addWorktree.push(options);
    const path = join(options.env.MC_WORK_ROOT, options.name, 'memoro');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify(MANIFEST));
    return { ok: true, path, branch: options.branch };
  };
  const publish = async (argv, deps) => {
    calls.publish.push({ argv, cwd: deps.cwd });
    if (publishCode === 0) deps.stdout.write(`${JSON.stringify({ number: 4242, url: 'https://example/pull/4242' })}\n`);
    return publishCode;
  };
  const merge = async (argv, deps) => {
    calls.merge.push(argv);
    deps.stdout.write(mergeCode === 0 ? 'merged #4242 into main\n' : 'red: tests failed\n');
    return mergeCode;
  };
  const stdout = sink();
  const stderr = sink();
  const deps = {
    env, stdout, stderr, git, npm, addWorktree, publish, merge,
    reading: async () => reading,
    resolveRepo: async () => join(root, 'memoro'),
    now: () => new Date(2026, 9, 9, 12, 0, 0),
  };
  return { calls, deps, stdout, stderr };
}

const commits = (calls) => calls.git.filter((call) => call.args[0] === 'commit');

describe('mc deps bump: what is asked', () => {
  it('splits a package on the last @ that is not the first character', () => {
    assert.deepEqual(parseWhat('wrangler'), { name: 'wrangler', version: null });
    assert.deepEqual(parseWhat('wrangler@4.149.0'), { name: 'wrangler', version: '4.149.0' });
    assert.deepEqual(parseWhat('@capacitor/ios@8.5.3'), { name: '@capacitor/ios', version: '8.5.3' });
    assert.deepEqual(parseWhat('@capacitor/ios'), { name: '@capacitor/ios', version: null });
    assert.deepEqual(parseWhat('security'), { group: 'security' });
  });

  it('names the workarea deps-<repo>-<what>-<yyyymmdd> with / and @ as -', () => {
    const day = new Date(2026, 9, 9);
    assert.equal(workareaName('memoro', 'minor', day), 'deps-memoro-minor-20261009');
    assert.equal(workareaName('memoro', '@capacitor/ios@8.5.3', day), 'deps-memoro--capacitor-ios-8.5.3-20261009');
  });

  it('refuses major, and says how a major goes', async () => {
    const { calls, deps, stderr } = harness();
    const code = await run(['bump', 'memoro', 'major'], deps);
    assert.equal(code, 1);
    assert.match(stderr.text, /mc: a major goes one package at a time — mc deps bump memoro <package>@<version>/u);
    assert.equal(calls.addWorktree.length, 0);
    assert.equal(calls.npm.length, 0);
  });

  it('refuses a package that is not a direct dependency, by name', async () => {
    const { calls, deps, stderr } = harness();
    const code = await run(['bump', 'memoro', 'left-pad'], deps);
    assert.equal(code, 1);
    assert.match(stderr.text, /left-pad is not a direct dependency of memoro's origin\/main package\.json/u);
    assert.equal(calls.addWorktree.length, 0);
  });

  it('refuses a named package already newest in its major', async () => {
    const { calls, deps, stderr } = harness();
    const code = await run(['bump', 'memoro', 'settled'], deps);
    assert.equal(code, 1);
    assert.match(stderr.text, /mc: settled 2\.3\.0 is the newest 2\.x — name the version to cross the major/u);
    assert.equal(calls.addWorktree.length, 0);
  });
});

describe('mc deps bump: the change', () => {
  it('security: one --save-exact call for the pin, one for the caret, then one npm audit fix — all lockfile-only', async () => {
    const { calls, deps } = harness();
    const code = await run(['bump', 'memoro', 'security'], deps);
    assert.equal(code, 0);

    assert.equal(calls.addWorktree.length, 1);
    const [made] = calls.addWorktree;
    assert.equal(made.name, 'deps-memoro-security-20261009');
    assert.equal(made.branch, 'deps-memoro-security-20261009');
    assert.equal(made.from, 'origin/main');
    assert.equal(made.repo, join(root, 'memoro'));

    const checkout = join(env.MC_WORK_ROOT, made.name, 'memoro');
    assert.equal(calls.npm.length, 3);
    for (const call of calls.npm) {
      assert.ok(call.args.includes('--package-lock-only'), `npm ${call.args.join(' ')} without --package-lock-only`);
      assert.ok(call.args.includes('--ignore-scripts'), `npm ${call.args.join(' ')} without --ignore-scripts`);
      assert.equal(call.cwd, checkout);
    }
    const [exact, ranged, fix] = calls.npm.map((call) => call.args);
    assert.deepEqual(exact, ['install', '--package-lock-only', '--ignore-scripts', '--save-exact', 'wrangler@4.149.0']);
    assert.deepEqual(ranged, ['install', '--package-lock-only', '--ignore-scripts', 'tiny@^0.20.5']);
    assert.deepEqual(fix.slice(0, 3), ['audit', 'fix', '--package-lock-only']);

    const [commit] = commits(calls);
    assert.equal(commit.cwd, checkout);
    const add = calls.git.find((call) => call.args[0] === 'add');
    assert.deepEqual(add.args, ['add', '--', 'package.json', 'package-lock.json']);
    assert.deepEqual(commit.args.slice(-3), ['--', 'package.json', 'package-lock.json']);
    assert.equal(commit.args[2], 'deps(memoro): security — wrangler 4.116.0 → 4.149.0, tiny 0.20.2 → 0.20.5');
    assert.match(commit.args[4], /Audit before: 2 critical, 24 high/u);
  });

  it('hands mc merge the repository and the number mc publish returned', async () => {
    const { calls, deps, stdout } = harness();
    const code = await run(['bump', 'memoro', 'minor', '--json'], deps);
    assert.equal(code, 0);
    assert.equal(calls.publish.length, 1);
    assert.deepEqual(calls.publish[0].argv, ['--json']);
    assert.equal(calls.publish[0].cwd, join(env.MC_WORK_ROOT, 'deps-memoro-minor-20261009', 'memoro'));
    assert.deepEqual(calls.merge, [['memoro', '4242']]);
    const printed = JSON.parse(stdout.text);
    assert.equal(printed.pr, 4242);
    assert.equal(printed.merged, true);
    assert.equal(printed.branch, 'deps-memoro-minor-20261009');
    assert.deepEqual(printed.changes.map((item) => [item.name, item.from, item.to, item.kind]), [['builder', '4.1.0', '4.12.0', 'tool']]);
  });

  it('a red gate is the bump\'s exit code, and leaves the pull request and the area', async () => {
    const { deps, stderr } = harness({ mergeCode: 1 });
    const code = await run(['bump', 'memoro', 'minor'], deps);
    assert.equal(code, 1);
    assert.match(stderr.text, /#4242 did not land — the pull request stays open and .*deps-memoro-minor-20261009 stays/u);
    assert.ok(existsSync(join(env.MC_WORK_ROOT, 'deps-memoro-minor-20261009')));
  });

  it('nothing to change makes no workarea and exits 0', async () => {
    const { calls, deps, stdout } = harness({ reading: EMPTY });
    assert.equal(await run(['bump', 'memoro', 'minor'], deps), 0);
    assert.equal(await run(['bump', 'memoro', 'security'], deps), 0);
    assert.match(stdout.text, /nothing to change/u);
    assert.equal(calls.addWorktree.length, 0);
    assert.equal(calls.npm.length, 0);
  });

  it('a dirty file other than the two stops before the commit, with the list', async () => {
    const { calls, deps, stderr } = harness({ porcelain: ' M package.json\n M package-lock.json\n?? node_modules/\n' });
    const code = await run(['bump', 'memoro', 'minor'], deps);
    assert.equal(code, 1);
    assert.match(stderr.text, /stopped before the commit/u);
    assert.match(stderr.text, /node_modules\//u);
    assert.equal(commits(calls).length, 0);
    assert.equal(calls.publish.length, 0);
    assert.equal(calls.merge.length, 0);
  });

  it('--dry-run prints the change and the workarea, and calls neither addWorktree nor npm', async () => {
    const { calls, deps, stdout } = harness();
    const code = await run(['bump', 'memoro', 'security', '--dry-run'], deps);
    assert.equal(code, 0);
    assert.equal(calls.addWorktree.length, 0);
    assert.equal(calls.npm.length, 0);
    assert.equal(calls.publish.length, 0);
    assert.match(stdout.text, /^mc deps bump memoro security — origin\/main abc1234/u);
    assert.match(stdout.text, /wrangler 4\.116\.0 → 4\.149\.0 \(runtime\)/u);
    assert.match(stdout.text, /tiny 0\.20\.2 → 0\.20\.5 \(runtime\)/u);
    assert.match(stdout.text, /transitive: 5 by npm audit fix/u);
    assert.match(stdout.text, /would make .*deps-memoro-security-20261009 on origin\/main and open a pull request/u);
    assert.ok(!existsSync(join(env.MC_WORK_ROOT, 'deps-memoro-security-20261009')));
  });

  it('a named package crosses the major only when its version is named', async () => {
    const { calls, deps, stdout } = harness();
    const code = await run(['bump', 'memoro', 'tiny@0.28.2', '--dry-run', '--json'], deps);
    assert.equal(code, 0);
    assert.equal(calls.npm.length, 0);
    const printed = JSON.parse(stdout.text);
    assert.deepEqual(printed.changes.map((item) => [item.name, item.from, item.to]), [['tiny', '0.20.2', '0.28.2']]);
    assert.equal(printed.pr, null);
    assert.equal(printed.merged, null);
    assert.equal(printed.workarea, join(env.MC_WORK_ROOT, 'deps-memoro-tiny-0.28.2-20261009'));
  });
});
