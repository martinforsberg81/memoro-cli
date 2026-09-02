/**
 * Which project a pull request is about — the whole of project-prs.js, and
 * the branch names are the ones that were actually open on 2026-09-02.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describePr, openPrsFor, PR_LIST_ARGS, projectForBranch } from '../../src/mc/project-prs.js';

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
  assert.deepEqual(PR_LIST_ARGS, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName,isDraft,title']);
});
