/**
 * Archiving a finished goal (goal-archive.js): when the runner archives one, and
 * what `archiveGoal` refuses. Git, gh and the file system are faked; nothing
 * touches a repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ARCHIVE_HOLD_MS, archiveGoal, finalizeDroppedGoal, goalArchiveDue } from '../../src/mc/goal-archive.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { goalJson } from './_helpers/goal-file.js';
import { goalReferences } from '../../src/mc/goals.js';
import { beginBackup } from '../../src/mc/programme-lifecycle.js';

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
function ctxOf({ git = () => ok(), gh = () => ok('[]'), move, now = new Date(NOW), exists = () => true } = {}) {
  const calls = { git: [], gh: [], moved: [], appended: [] };
  const ctx = {
    home: '/w/programs',
    git: (cwd, args) => { calls.git.push([cwd, ...args]); return git(cwd, args); },
    gh: (cwd, args) => { calls.gh.push([cwd, ...args]); return gh(cwd, args); },
    known: () => ['/home/memoro'],
    exists,
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
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T10:00Z', 'dropped'), nowMs: NOW }), { due: true, why: 'dropped — abandoned work is finalized immediately' });
  assert.deepEqual(goalArchiveDue({ goal: done('2026-08-31T10:00Z'), nowMs: NOW - 60 * 60 * 1000, holdMs: 60 * 60 * 1000 }).due, true, 'takes the hold it is given');
});

test('a goal is not due when it is not finished, or the log does not say when it was finished', () => {
  const open = goal({ stage: 'build', log: [{ at: '2026-08-01T10:00Z', stage: 'build', status: 'ready' }] });
  assert.deepEqual(goalArchiveDue({ goal: open, nowMs: NOW }), { due: false, why: 'the goal is in build' });
  const handSet = goal({ stage: 'done', log: [{ at: '2026-08-01T10:00Z', stage: 'build', status: 'ready' }] });
  assert.deepEqual(goalArchiveDue({ goal: handSet, nowMs: NOW }), { due: false, why: 'the log does not say when it was done' });
});

test('dropped goals are due without a stage timestamp; done retains its hold', () => {
  assert.equal(goalArchiveDue({ goal: goal({ stage: 'dropped', log: [] }), nowMs: NOW }).due, true);
  assert.equal(goalArchiveDue({ goal: goal({ stage: 'done', log: [] }), nowMs: NOW }).due, false);
});

test('drop finalization closes exclusive PRs, removes their queue row under lock, then archives', () => {
  const queueRoot = '/w';
  let queueText = JSON.stringify([{ repo: 'memoro', pr: 7, state: 'queued' }, { repo: 'memoro', pr: 8, state: 'red' }]);
  let state = 'OPEN';
  const { ctx, calls } = ctxOf({ gh: (cwd, args) => {
    if (args[1] === 'list') return ok('[]');
    if (args[1] === 'view') return ok(JSON.stringify({ state }));
    if (args[1] === 'close') { state = 'CLOSED'; return ok(); }
    return ok();
  } });
  const result = finalizeDroppedGoal(goal({ stage: 'dropped', prs: [{ repo: 'memoro', pr: 7 }] }), {
    ...ctx, root: queueRoot, allGoals: () => [], lock: (_root, fn, options) => { assert.equal(options.name, 'merges'); return fn(); },
    readQueue: (path) => { assert.equal(path, mergesPath(queueRoot)); return queueText; },
    writeQueue: (_path, entries) => { queueText = JSON.stringify(entries); },
  });
  assert.equal(result.to, '/w/programs/mc/goals/.archive/g');
  assert.ok(calls.gh.some((call) => call.includes('close')));
  assert.deepEqual(parseQueue(queueText).map(({ repo, pr, state: s }) => [repo, pr, s]), [['memoro', 8, 'red']]);
  assert.equal(calls.appended.length, 1, 'one archive row');
});

test('drop finalization discovers and closes an open PR on the goal branch even when it is not registered', () => {
  let state = 'OPEN';
  let lists = 0;
  const { ctx, calls } = ctxOf({ gh: (_cwd, args) => {
    if (args[1] === 'list') return ok(++lists === 1 ? '[{"number":12}]' : '[]');
    if (args[1] === 'view') return ok(JSON.stringify({ state }));
    if (args[1] === 'close') { state = 'CLOSED'; return ok(); }
    return ok();
  } });
  let saved = goalJson({ stage: 'dropped', repos: ['memoro'], title: 'g', goal: [], prs: [] });
  const result = finalizeDroppedGoal(goal({ stage: 'dropped', prs: [] }), {
    ...ctx, read: (path) => path === `${DIR}/GOAL.json` ? saved : null,
    write: (path, text) => { if (path === `${DIR}/GOAL.json`) saved = text; },
    allGoals: () => [],
  });
  assert.equal(result.to, '/w/programs/mc/goals/.archive/g');
  assert.ok(calls.gh.some((call) => call.join(' ').includes('close 12')));
  assert.deepEqual(JSON.parse(saved).prs, ['memoro#12'], 'the discovered PR remains an ownership reference until archive');
});

test('goal references retain the original dropped owner and PR identity from a collision-named archive', () => {
  const name = 'g-20261108T1840';
  const text = goalJson({ stage: 'dropped', repos: ['memoro'], prs: ['memoro#12'] });
  const list = (path) => path === '/w/programs' ? ['mc']
    : path === '/w/programs/mc/goals' ? ['.archive']
      : path === '/w/programs/mc/goals/.archive' ? [name] : [];
  const read = (path) => path === `/w/programs/mc/goals/.archive/${name}/GOAL.json` ? text : null;
  const [ref] = goalReferences({ home: '/w/programs', list, read });
  assert.deepEqual([ref.programme, ref.goal, ref.stage, ref.prs], ['mc', 'g', 'dropped', [{ repo: 'memoro', pr: 12 }]]);
});

test('drop finalization preserves a shared PR and queue row, but records the unfinished owner', () => {
  const { ctx } = ctxOf({ gh: (_cwd, args) => args[1] === 'list' ? ok('[{"number":9}]') : ok('{"state":"OPEN"}') });
  let queueText = JSON.stringify([{ repo: 'memoro', pr: 9, state: 'queued' }]);
  const owner = { programme: 'other', goal: 'still-working', stage: 'build', prs: [{ repo: 'memoro', pr: 9 }] };
  const result = finalizeDroppedGoal(goal({ stage: 'dropped', prs: [{ repo: 'memoro', pr: 9 }] }), {
    ...ctx, allGoals: () => [owner], root: '/w', lock: (_root, fn) => fn(),
    readQueue: () => queueText, writeQueue: (_path, entries) => { queueText = JSON.stringify(entries); },
  });
  assert.equal(result.to, '/w/programs/mc/goals/.archive/g');
  assert.deepEqual(result.preserved.map(({ pr, owners }) => [pr, owners.map(({ goal: name }) => name)]), [[{ repo: 'memoro', pr: 9 }, ['still-working']]]);
  assert.deepEqual(parseQueue(queueText).map(({ pr }) => pr), [9]);
});

test('drop finalization refuses uncertain GitHub close without archiving or cancelling evidence', () => {
  const { ctx, calls } = ctxOf({ gh: (_cwd, args) => args[1] === 'list' ? ok('[]') : args[1] === 'view' ? ok('{"state":"OPEN"}') : ({ ok: false, stderr: 'offline' }) });
  const result = finalizeDroppedGoal(goal({ stage: 'dropped', prs: [{ repo: 'memoro', pr: 7 }] }), { ...ctx, allGoals: () => [] });
  assert.match(result.refused, /could not close memoro#7/u);
  assert.equal(calls.moved.length, 0);
  assert.equal(calls.appended.length, 0);
});

test('drop finalization retries a failed GitHub read safely and archives on the next attempt', () => {
  let fail = true;
  let state = 'OPEN';
  const { ctx, calls } = ctxOf({ gh: (_cwd, args) => {
    if (args[1] === 'list') return ok('[]');
    if (args[1] === 'view' && fail) { fail = false; return { ok: false, stdout: '', stderr: 'offline' }; }
    if (args[1] === 'view') return ok(JSON.stringify({ state }));
    if (args[1] === 'close') { state = 'CLOSED'; return ok(); }
    return ok();
  } });
  const dropped = goal({ stage: 'dropped', prs: [{ repo: 'memoro', pr: 7 }] });
  assert.match(finalizeDroppedGoal(dropped, { ...ctx, allGoals: () => [] }).refused, /could not say where memoro#7 stands/u);
  assert.equal(calls.moved.length, 0, 'the uncertain first attempt retains the goal');
  const result = finalizeDroppedGoal(dropped, { ...ctx, allGoals: () => [] });
  assert.equal(result.to, '/w/programs/mc/goals/.archive/g');
  assert.equal(state, 'CLOSED');
  assert.equal(calls.moved.length, 1);
  assert.equal(calls.appended.filter(([, text]) => text.includes('| 2026-09-01 | g | dropped |')).length, 1);
});

test('drop finalization leaves live-session worktrees and makes no external cleanup calls', () => {
  const { ctx, calls } = ctxOf();
  const result = finalizeDroppedGoal(goal({ stage: 'dropped' }), { ...ctx, allGoals: () => [], active: () => true });
  assert.match(result.refused, /live session still owns mc\/g/u);
  assert.deepEqual(calls.gh, []);
  assert.deepEqual(calls.git, []);
  assert.equal(calls.moved.length, 0);
});

test('a dirty dropped worktree and its shared-owner note survive repeated unsafe archive attempts', () => {
  const owner = { programme: 'other', goal: 'still-working', stage: 'build', prs: [{ repo: 'memoro', pr: 9 }] };
  const { ctx, calls } = ctxOf({
    git: (_cwd, args) => args[0] === 'status' ? { ok: true, stdout: ' M important.js', stderr: '' } : ok(),
    gh: (_cwd, args) => args[1] === 'list' ? ok('[{"number":9}]') : ok('{"state":"OPEN"}'),
  });
  let log = '';
  ctx.read = () => log;
  ctx.appendText = (_path, text) => { log += text; };
  const dropped = goal({ stage: 'dropped', prs: [{ repo: 'memoro', pr: 9 }] });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = finalizeDroppedGoal(dropped, { ...ctx, allGoals: () => [owner] });
    assert.match(result.refused, /worktree has uncommitted changes/u);
    assert.equal(calls.moved.length, 0, 'neither attempt removes or archives the dirty worktree');
  }
  assert.equal((log.match(/preserved memoro#9/gu) ?? []).length, 1, 'the preserved-owner evidence is idempotent');
});

test('a dropped worktree whose Git status is unknown is retained, not treated as clean', () => {
  const { ctx, calls } = ctxOf({ git: () => ({ ok: false, stdout: '', stderr: 'unavailable' }) });
  const result = finalizeDroppedGoal(goal({ stage: 'dropped' }), { ...ctx, allGoals: () => [] });
  assert.match(result.refused, /could not be inspected/u);
  assert.equal(calls.moved.length, 0);
});

test('a positively absent dropped worktree is safe to archive, including retry after removal before a failed move', () => {
  let present = false;
  let failMove = true;
  const { ctx, calls } = ctxOf({
    exists: () => present,
    git: (cwd, args) => args[0] === 'status' ? { ok: false, stdout: '', stderr: 'path does not exist' }
      : args[0] === 'rev-parse' ? { ok: false, stdout: '', stderr: 'not a worktree' }
        : args[0] === 'show-ref' ? { ok: false, stdout: '', stderr: 'no branch' } : ok(),
    move: () => { if (failMove) { failMove = false; throw new Error('archive move interrupted'); } calls.moved.push(['retry']); },
  });
  const dropped = goal({ stage: 'dropped' });
  const first = finalizeDroppedGoal(dropped, { ...ctx, allGoals: () => [] });
  assert.match(first.refused, /could not be moved .*archive move interrupted/u);
  assert.equal(calls.moved.length, 0);
  const second = finalizeDroppedGoal(dropped, { ...ctx, allGoals: () => [] });
  assert.deepEqual(second, { to: '/w/programs/mc/goals/.archive/g', renumbered: [] });
  assert.deepEqual(calls.moved, [['retry']]);
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

test('manual archive and dropped-goal finalization refuse a selected programme before remote or cleanup calls', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-goal-archive-hold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_WORK_ROOT: root };
  beginBackup(['mc'], { env, id: '00000000-0000-4000-8000-000000000010' });
  const { ctx, calls } = ctxOf();
  const shared = { ...ctx, env };

  const direct = archiveGoal(goal(), shared);
  assert.match(direct.refused, /draining/u, 'direct archive admission is refused');
  const dropped = finalizeDroppedGoal(goal({ stage: 'dropped' }), { ...shared, allGoals: () => [] });
  assert.match(dropped.refused, /draining/u, 'drop finalization is refused before closing a PR');
  assert.deepEqual(calls.gh, []);
  assert.deepEqual(calls.git, []);
  assert.deepEqual(calls.moved, []);
  assert.deepEqual(calls.appended, []);
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
