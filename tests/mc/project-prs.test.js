/**
 * Which project a pull request is about — the whole of project-prs.js, and
 * the branch names are the ones that were actually open on 2026-09-02.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describePr, openPrsFor, parseWorktrees, PR_LIST_ARGS, prOwner, projectForBranch, stepForPr,
} from '../../src/mc/project-prs.js';

const NAMES = ['mc', 'mc-cut', 'mc-log', 'mc-test', 'action-window', 'runner-open-prs'];

test('projectForBranch: the name itself, or the name and a hyphen', () => {
  assert.equal(projectForBranch('action-window', NAMES), 'action-window');
  assert.equal(projectForBranch('action-window-2', NAMES), 'action-window');
  assert.equal(projectForBranch('action-window-step-4', NAMES), 'action-window');
  assert.equal(projectForBranch('mc', NAMES), 'mc');
});

/**
 * The reason the longest wins: `mc`, `mc-cut`, `mc-log` and `mc-test` are all
 * project names, and `mc-cut-2` read as `mc`'s would stop the wrong project
 * and leave the right one running on top of its own open work.
 */
test('projectForBranch: the longest name wins', () => {
  assert.equal(projectForBranch('mc-cut-2', NAMES), 'mc-cut');
  assert.equal(projectForBranch('mc-test-x', NAMES), 'mc-test');
  assert.equal(projectForBranch('mc-2', NAMES), 'mc');
});

test('projectForBranch: a branch no project explains is nobody\'s', () => {
  assert.equal(projectForBranch('main', NAMES), null);
  assert.equal(projectForBranch('spike/action-window', NAMES), null);
  assert.equal(projectForBranch('actionwindow', NAMES), null);
  assert.equal(projectForBranch('', NAMES), null);
  assert.equal(projectForBranch('mc-cut', []), null);
});

test('openPrsFor: one project\'s pull requests, in the order gh gave them', () => {
  const prs = [
    { repo: 'memoro-cli', number: 11246, headRefName: 'action-window-4', title: 'Step 4' },
    { repo: 'memoro-cli', number: 11241, headRefName: 'action-window', title: 'Step 4 again' },
    { repo: 'memoro-cli', number: 11250, headRefName: 'mc-cut-2', title: 'Elsewhere' },
    { repo: 'memoro', number: 12, headRefName: 'action-window-9', title: 'Another repository' },
  ];
  const mine = openPrsFor({ prs, name: 'action-window', names: NAMES, repo: 'memoro-cli' });
  assert.deepEqual(mine.map((pr) => pr.number), [11246, 11241]);
  assert.deepEqual(openPrsFor({ prs, name: 'mc', names: NAMES, repo: 'memoro-cli' }), []);
  assert.deepEqual(openPrsFor({ prs, name: 'action-window', names: NAMES }).map((pr) => pr.number), [11246, 11241, 12]);
  assert.deepEqual(openPrsFor({ prs: [], name: 'action-window', names: NAMES }), []);
});

test('describePr: the line a person reads, and a draft says so', () => {
  assert.equal(describePr({ number: 11246, title: 'Step 4' }), '#11246 is open (Step 4)');
  assert.equal(describePr({ number: 9, title: 'Half done', isDraft: true }), '#9 is open (draft: Half done)');
  assert.equal(describePr({ number: 9 }), '#9 is open (no title)');
});

test('PR_LIST_ARGS: one question, with the fields the round and the page both need', () => {
  assert.deepEqual(PR_LIST_ARGS, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName,isDraft,title,updatedAt']);
});

/**
 * The step a pull request is: the one that names it, else the one the plan
 * stands at. On 2026-10-09 all four open project pull requests were the
 * second kind — the register writes `pr` when the merger answers.
 */
test('stepForPr: the step that names it, else the step the plan stands at', () => {
  const plan = { step: 4, plan: { steps: [{ pr: 12283 }, { pr: 12288 }, { pr: 12310 }, { pr: null }] } };
  assert.equal(stepForPr({ number: 12314 }, plan), 4);
  assert.equal(stepForPr({ number: 12288 }, plan), 2);
  assert.equal(stepForPr({ number: 1 }, {}), null);
});

test('parseWorktrees: path and branch, and a detached tree has none', () => {
  const text = [
    'worktree /Users/m/memoro', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree /Users/m/mc/plan/email/memoro', 'HEAD def', 'branch refs/heads/plan/email', '',
    'worktree /Users/m/mc/plan/docx/memoro', 'HEAD 123', 'detached', '',
  ].join('\n');
  assert.deepEqual(parseWorktrees(text), [
    { path: '/Users/m/memoro', branch: 'main' },
    { path: '/Users/m/mc/plan/email/memoro', branch: 'plan/email' },
    { path: '/Users/m/mc/plan/docx/memoro', branch: null },
  ]);
  assert.deepEqual(parseWorktrees(null), []);
});

/**
 * The pull requests open on 2026-10-09, and whose each one was: four of eight
 * were not on the page at all, and #12900 was nobody's.
 */
test('prOwner: a project, a plan session, a workarea, a folder elsewhere, or nobody', () => {
  const root = '/Users/m/mc';
  const worktrees = [
    { path: '/Users/m/mc/plan/entity-detail/memoro', branch: 'plan/trip-project-detail' },
    { path: '/Users/m/mc/plan/staff/memoro', branch: 'plan-staff-chat-chain' },
    { path: '/Users/m/mc/deps-memoro-minor/memoro', branch: 'deps-memoro-minor' },
    { path: '/Users/m/memoro-cli', branch: 'deps-read-for-the-tree' },
    { path: '/Users/m/mc/sql-size-trim/memoro', branch: 'sql-size-trim-2' },
  ];
  const names = ['sql-size-trim', 'mosaic-sessions'];
  const owner = (headRefName) => prOwner({ headRefName }, { names, worktrees, root });
  assert.deepEqual(owner('sql-size-trim-2'), { kind: 'project', name: 'sql-size-trim', path: null });
  assert.deepEqual(owner('plan/trip-project-detail'), { kind: 'plan', name: 'entity-detail', path: '/Users/m/mc/plan/entity-detail/memoro' });
  assert.equal(owner('plan-staff-chat-chain').name, 'staff');
  assert.deepEqual(owner('deps-memoro-minor'), { kind: 'workarea', name: 'deps-memoro-minor', path: '/Users/m/mc/deps-memoro-minor/memoro' });
  assert.deepEqual(owner('deps-read-for-the-tree'), { kind: 'worktree', name: null, path: '/Users/m/memoro-cli' });
  assert.deepEqual(owner('plan/email'), { kind: 'plan', name: null, path: null });
  assert.deepEqual(owner('remove-bookshop-recipes'), { kind: 'none', name: null, path: null });
});
