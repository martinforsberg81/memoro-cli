/**
 * `mc repos migrate`: the facts, the plan, the dry run, and `--apply` carrying
 * it out (repos-migrate.js). Every case builds two real repositories in a
 * temporary `MC_REPOS_HOME`, each with two linked worktrees, the first with a
 * stash, and a fake npm link pointing at the second — never ~/memoro, ~/mc or
 * the machine's own npm link.
 */
import { strict as assert } from 'node:assert';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { run } from '../../src/mc/commands/repos.js';
import { gatherReposFacts, planReposMove, realApplyDeps, REPOS_LOG } from '../../src/mc/repos-migrate.js';
import { defaultRepos } from '../../src/mc/repos.js';
import { git } from './_helpers/git-fixture.js';

const NAMES = ['memoro', 'memoro-cli'];

let fx;

/** Two repositories on main, a stash in the first, two linked worktrees each, and the npm link at the second. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-repos-migrate-')));
  const home = join(root, 'home'); // MC_REPOS_HOME: the primary checkouts, the bare repositories and self/
  const work = join(root, 'mc'); // MC_WORK_ROOT
  const npmLink = join(root, 'npm', 'memoro-cli');
  mkdirSync(join(root, 'npm'), { recursive: true });
  for (const name of NAMES) {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init -q -b main');
    writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    git(dir, 'add -A');
    git(dir, 'commit -q -m "Initial commit"');
    git(dir, 'branch camera-test');
    for (const which of ['a', 'b']) {
      git(dir, `worktree add -q -b ${name}-${which} "${join(work, 'work', which, name)}" main`);
    }
  }
  writeFileSync(join(home, 'memoro', 'README.md'), 'stashed\n');
  git(join(home, 'memoro'), 'stash push -q -m wip');
  symlinkSync(join(home, 'memoro-cli'), npmLink);
  return {
    root,
    home,
    work,
    npmLink,
    env: { MC_REPOS_HOME: home, MC_WORK_ROOT: work },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

/** Nothing running, nothing served, no installation from a checkout — unless a case says so. */
const quiet = (overrides = {}) => ({
  servers: () => [], installs: () => [], npmLink: fx.npmLink, ...overrides,
});

const gather = (deps = quiet()) => gatherReposFacts({ env: fx.env, root: fx.work, deps });
const plan = (deps = quiet()) => planReposMove(gather(deps));

async function verb(argv, { facts = quiet(), moves } = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    env: fx.env, root: fx.work, home: fx.root, facts, moves,
    stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } },
  });
  return { code, out, err };
}

/** Every path under `dir`, sorted: what a refusal must leave exactly as it was. */
function tree(dir) {
  const seen = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      seen.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return seen.sort();
}

/** The state `--apply` must leave: both bare, every worktree working, self on main, the link moved, the old directories gone. */
function assertMoved() {
  for (const name of NAMES) {
    const bare = join(fx.home, `${name}.git`);
    const self = join(fx.home, 'self', name);
    assert.equal(git(bare, 'rev-parse --is-bare-repository'), 'true', `${name}.git is bare`);
    assert.equal(git(self, 'rev-parse --abbrev-ref HEAD'), 'main', `self/${name} is on main`);
    assert.equal(git(self, 'status --porcelain'), '', `self/${name} is clean`);
    const listed = git(bare, 'worktree list --porcelain');
    assert.ok(listed.includes(`worktree ${realpathSync(self)}`), `${name}'s bare repository names self/${name}`);
    for (const which of ['a', 'b']) {
      const wt = join(fx.work, 'work', which, name);
      git(wt, 'status --porcelain'); // throws unless the worktree still works
      assert.ok(listed.includes(`worktree ${realpathSync(wt)}`), `${name}'s bare repository names ${wt}`);
    }
    assert.equal(existsSync(join(fx.home, name)), false, `${name}'s primary checkout is gone`);
  }
  // `git stash list` refuses in a bare repository; its reflog is what it lists.
  assert.match(git(join(fx.home, 'memoro.git'), 'log -g --format=%gs refs/stash'), /wip/, 'the stash stays in the git directory');
  assert.equal(readlinkSync(fx.npmLink), join(fx.home, 'self', 'memoro-cli'), 'the link runs self/memoro-cli');
  for (const repo of defaultRepos(fx.env)) {
    assert.equal(repo.bare, true, `${repo.name} is bare`);
    assert.equal(repo.checkout, join(fx.home, 'self', repo.name));
  }
}

beforeEach(() => { fx = fixture(); });
afterEach(() => { fx.cleanup(); });

test('the facts: each repository on disk, its branch, its stash, its worktrees, the link', () => {
  const facts = gather();
  const memoro = facts.repos.find((repo) => repo.name === 'memoro');
  assert.equal(memoro.gitDir, true);
  assert.equal(memoro.branch, 'main');
  assert.equal(memoro.dirty, false);
  assert.equal(memoro.stashes, 1);
  assert.equal(memoro.worktrees.length, 3, 'the main worktree and two linked');
  assert.deepEqual(memoro.taken, []);
  assert.deepEqual(facts.live, []);
  assert.equal(facts.link.target, join(fx.home, 'memoro-cli'));
});

test('the dry run names every move in order, and refuses nothing', async () => {
  const { moves, refusals } = plan();
  assert.deepEqual(refusals, []);
  assert.deepEqual(moves.map((move) => `${move.name}:${move.how}`), [
    'memoro:rename', 'memoro:config', 'memoro:repair', 'memoro:worktree', 'memoro:remove',
    'memoro-cli:rename', 'memoro-cli:config', 'memoro-cli:repair', 'memoro-cli:worktree', 'memoro-cli:relink', 'memoro-cli:remove',
  ]);
  assert.deepEqual(moves[0], { name: 'memoro', how: 'rename', from: join(fx.home, 'memoro', '.git'), to: join(fx.home, 'memoro.git') });
  assert.deepEqual(moves[9], { name: 'memoro-cli', how: 'relink', from: fx.npmLink, to: join(fx.home, 'self', 'memoro-cli') });

  const dry = await verb(['migrate']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /dry run, nothing is written/);
  assert.match(dry.out, /11 moves, none refused/);
  assert.doesNotMatch(dry.out, /REFUSED/);
  assert.equal(existsSync(join(fx.home, 'memoro.git')), false, 'the dry run moved nothing');
});

test('the plan makes the repositories directory first, when it is missing', () => {
  const { moves } = planReposMove({ ...gather(), reposHomeExists: false });
  assert.deepEqual(moves[0], { name: 'memoro', how: 'mkdir', from: null, to: fx.home });
  assert.equal(moves.filter((move) => move.how === 'mkdir').length, 1);
});

test('the layout: primary checkouts before the move, bare with their checkouts after', async () => {
  const before = await verb([]);
  assert.equal(before.code, 0);
  assert.match(before.out, /repos — primary checkouts/);
  assert.match(before.out, /memoro\s+primary\s+git .*\s+checkout .*\s+2 linked worktrees/);

  const applied = await verb(['migrate', '--apply'], { moves: realApplyDeps() });
  assert.equal(applied.code, 0, applied.err);
  const after = await verb([]);
  assert.match(after.out, /repos — bare/);
  assert.match(after.out, /memoro\s+bare/);
});

test('a dirty primary checkout refuses, and nothing moves', async () => {
  writeFileSync(join(fx.home, 'memoro', 'scratch.txt'), 'wip\n');
  const before = tree(fx.root);
  const dry = await verb(['migrate']);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /REFUSED/);
  assert.match(dry.out, /memoro has uncommitted changes/);
  const applied = await verb(['migrate', '--apply']);
  assert.equal(applied.code, 1);
  assert.match(applied.out, /refused, nothing moved/);
  assert.deepEqual(tree(fx.root), before);
});

test('a target that exists refuses, and nothing moves', async () => {
  mkdirSync(join(fx.home, 'self', 'memoro'), { recursive: true });
  const before = tree(fx.root);
  const { refusals } = plan();
  assert.deepEqual(refusals, [`${join(fx.home, 'self', 'memoro')} already exists — memoro cannot move there`]);
  const applied = await verb(['migrate', '--apply']);
  assert.equal(applied.code, 1);
  assert.deepEqual(tree(fx.root), before);
});

test('a live runner refuses, naming its pid and what to do', async () => {
  mkdirSync(join(fx.work, 'runner'), { recursive: true });
  writeFileSync(join(fx.work, 'runner', 'runner.json'), JSON.stringify({ pid: process.pid, started: '2026-10-24T08:00:00Z' }));
  const { refusals } = plan({ ...quiet(), alive: (pid) => pid === process.pid });
  assert.deepEqual(refusals, [`the runner is running (pid ${process.pid}) — mc run stop, and wait for it to finish`]);
  const before = tree(fx.root);
  const applied = await verb(['migrate', '--apply'], { facts: { ...quiet(), alive: (pid) => pid === process.pid } });
  assert.equal(applied.code, 1);
  assert.deepEqual(tree(fx.root), before);
});

test('a dev server serving a primary checkout refuses', () => {
  const server = { pid: 4242, worktree_path: join(fx.home, 'memoro-cli') };
  const { refusals } = plan(quiet({ servers: () => [{ live: true, ...server }] }));
  assert.deepEqual(refusals, [`a dev server serves ${server.worktree_path} — mc test dev --stop in that worktree`]);
});

test('--apply carries the move out: bare, working worktrees, self on main, the link moved, the old directories gone', async () => {
  const applied = await verb(['migrate', '--apply'], { moves: realApplyDeps() });
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /moved .*memoro\.git/);
  assertMoved();

  const log = readFileSync(join(fx.work, REPOS_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.length, 11);
  assert.ok(log.every((entry) => entry.ok === true));

  const again = await verb(['migrate']);
  assert.equal(again.code, 0);
  assert.match(again.out, /repos — nothing to move/);
});

test('a failing move stops the run, names it, and a second run continues from what is left', async () => {
  const real = realApplyDeps();
  const failing = {
    ...real,
    run: (command, args, options) => {
      if (args.includes('add')) throw Object.assign(new Error('boom'), { stderr: 'git worktree add failed on purpose\n' });
      return real.run(command, args, options);
    },
  };
  const first = await verb(['migrate', '--apply'], { moves: failing });
  assert.equal(first.code, 1);
  assert.match(first.err, /move 4 of 11 failed/);
  assert.match(first.err, /git worktree add failed on purpose/);
  assert.equal(existsSync(join(fx.home, 'memoro.git')), true, 'the moves before it are done');
  assert.equal(existsSync(join(fx.home, 'memoro', '.git')), false);

  const second = await verb(['migrate', '--apply'], { moves: real });
  assert.equal(second.code, 0, second.err);
  assertMoved();
});

test('the verb takes --json on the dry run only, and no other name', async () => {
  const json = await verb(['migrate', '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(json.out)), ['moves', 'refusals']);

  const both = await verb(['migrate', '--apply', '--json']);
  assert.equal(both.code, 2);
  assert.match(both.err, /--json belongs to the dry run/);

  const unknown = await verb(['sideways']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /mc repos knows migrate, not sideways/);
});
