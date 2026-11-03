/**
 * Archiving a finished goal (goal-archive.js): when the runner archives one, and
 * what `archiveGoal` refuses. Git, gh and the file system are faked; nothing
 * touches a repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARCHIVE_HOLD_MS } from '../../src/mc/project-archive.js';
import { archiveGoal, goalArchiveDue } from '../../src/mc/goal-archive.js';

const DIR = '/w/programs/mc/goals/g';
const NOW = Date.parse('2026-09-01T10:00:00Z');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

/** A goal as `programsGoals` gives it, with the fields `archiveGoal` reads. */
function goal(extra = {}) {
  return { programme: 'mc', goal: 'g', dir: DIR, stage: 'done', status: 'ready', repos: ['memoro'], prs: [], log: [], problems: [], phase: 1, ...extra };
}

/**
 * The context `archiveGoal` is given: `git` and `gh` answer what the test says
 * (`git(cwd, args)`, `gh(cwd, args)`), and every call and move is recorded.
 */
function ctxOf({ git = () => ok(), gh = () => ok('[]'), move, now = new Date(NOW) } = {}) {
  const calls = { git: [], gh: [], moved: [], appended: [] };
  const ctx = {
    home: '/w/programs',
    git: (cwd, args) => { calls.git.push([cwd, ...args]); return git(cwd, args); },
    gh: (cwd, args) => { calls.gh.push([cwd, ...args]); return gh(cwd, args); },
    known: () => ['/home/memoro'],
    move: move ?? ((from, to) => { calls.moved.push([from, to]); }),
    appendText: (path, text) => { calls.appended.push([path, text]); },
    read: () => null,
    now,
  };
  return { ctx, calls };
}

test('a goal is due once it has been done or dropped for the hold, counted from the entry that set the stage', () => {
  assert.equal(ARCHIVE_HOLD_MS, 24 * 60 * 60 * 1000);
  const done = (at, stage = 'done') => goal({ stage, log: [{ at, stage, status: 'ready', tool: 'claude', done: 'x' }] });
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T11:00Z'), nowMs: NOW }), { due: false, why: 'done 23h ago — archived after 24h' });
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T10:00Z'), nowMs: NOW }), { due: true, why: 'done 24h ago' });
  assert.equal(goalArchiveDue({ goal: done('2026-08-31T10:00Z'), nowMs: NOW - 60_000 }).due, false, 'a minute short is not due');
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T10:00Z', 'dropped'), nowMs: NOW }), { due: true, why: 'dropped 24h ago' });
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T10:00Z'), nowMs: NOW - 60 * 60 * 1000, holdMs: 60 * 60 * 1000 }).due, true, 'takes the hold it is given');
});

test('a goal is not due when it is not finished, or the log does not say when it was finished', () => {
  const open = goal({ stage: 'build', log: [{ at: '2026-08-01T10:00Z', stage: 'build', status: 'ready' }] });
  assert.deepEqual(goalArchiveDue({ goal: open, nowMs: NOW }), { due: false, why: 'the goal is in build' });
  const handSet = goal({ stage: 'done', log: [{ at: '2026-08-01T10:00Z', stage: 'build', status: 'ready' }] });
  assert.deepEqual(goalArchiveDue({ goal: handSet, nowMs: NOW }), { due: false, why: 'the log does not say when it was done' });
});

test('archiveGoal of a done goal with nothing open: worktree and branch removed through git, the directory moved, one row written', () => {
  const { ctx, calls } = ctxOf();
  assert.deepEqual(archiveGoal(goal(), ctx), { to: '/w/programs/mc/goals/.archive/g', renumbered: [] });
  assert.ok(calls.git.some((call) => call.join(' ') === `/home/memoro worktree remove ${DIR}/memoro`), 'its worktree goes through git');
  assert.ok(calls.git.some((call) => call.join(' ') === '/home/memoro branch -D goal/g'), 'its branch is deleted');
  assert.deepEqual(calls.moved, [[DIR, '/w/programs/mc/goals/.archive/g']]);
  assert.equal(calls.appended[0][0], '/w/programs/mc/goals/goal_log.md');
  assert.match(calls.appended[0][1], /^# Archived goals\n/u, 'a new goal_log.md has its heading');
  assert.match(calls.appended[0][1], /\| 2026-09-01 \| g \| done \| — \| — \|\n$/u);
});

test('archiveGoal refuses, and touches nothing, for each reason mc goal archive gives', () => {
  const cases = [
    { what: 'an open pull request on the branch', goal: goal(), ctx: { gh: (cwd, args) => (args[1] === 'list' ? ok('[{"number":7}]') : ok()) }, pattern: /memoro #7 on goal\/g is open/u },
    { what: 'uncommitted changes in the worktree', goal: goal(), ctx: { git: (cwd, args) => (args[0] === 'status' ? ok(' M a.js') : ok()) }, pattern: /memoro's worktree has uncommitted changes/u },
    { what: 'a pull request the goal carries, open', goal: goal({ prs: [{ repo: 'memoro', pr: 9 }] }), ctx: { gh: (cwd, args) => (args[1] === 'view' ? ok('{"state":"OPEN"}') : ok('[]')) }, pattern: /memoro#9 is open/u },
    { what: 'a repository mc does not know', goal: goal({ repos: ['elsewhere'] }), ctx: {}, pattern: /elsewhere is not a repository mc knows/u },
    { what: 'a goal not finished', goal: goal({ stage: 'build' }), ctx: {}, pattern: /it is in build; only a done or dropped goal/u },
    { what: 'a dropped branch with commits no remote holds', goal: goal({ stage: 'dropped' }), ctx: { git: (cwd, args) => (args[0] === 'rev-list' ? ok('2') : ok()) }, pattern: /commits no remote holds/u },
  ];
  for (const { what, goal: subject, ctx: options, pattern } of cases) {
    const { ctx, calls } = ctxOf(options);
    const result = archiveGoal(subject, ctx);
    assert.match(result.refused ?? '', pattern, what);
    assert.equal(calls.moved.length, 0, `${what}: nothing moved`);
    assert.equal(calls.git.some((call) => call.includes('remove')), false, `${what}: no worktree removed`);
    assert.equal(calls.appended.length, 0, `${what}: no row written`);
  }
});

test('archiveGoal says a directory it cannot move, and that its worktrees are gone, rather than throwing', () => {
  const { ctx } = ctxOf({ move: () => { throw new Error('exists'); } });
  const result = archiveGoal(goal(), ctx);
  assert.match(result.refused, /could not be moved .* \(exists\); its worktrees are gone/u);
});
