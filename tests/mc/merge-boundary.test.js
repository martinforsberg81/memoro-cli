/**
 * The door — `planBoundary` — over fake `git` and `gh`: nothing here starts a
 * process. The comparison rules themselves (`unauthorisedChanges`) are
 * `tests/mc/plan-schema.test.js`'s; this is only the wiring around them — which
 * branch names which project, which two refs are compared, and when the
 * question is never asked at all.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { planBoundary } from '../../src/mc/merge-boundary.js';

const PATH = 'docs/project/mc/step-lands-itself/PLAN.json';

function plan(overrides = {}) {
  return {
    schema: 'mc-plan', version: 1,
    goal: ['The step session lands its own pull request.'],
    contract: ['A step may only touch its own writable fields.'],
    out_of_scope: ['Batches.'],
    success_criteria: [{ met: false, criterion: 'x', check: 'y' }],
    documents: [],
    steps: [
      { title: 'first', status: 'done', done_when: 'd', instruction: ['i'], comments: [], pr: 1, blocked_by: null },
      {
        title: 'the wait and the door', status: 'ready', done_when: 'd', instruction: ['i'], comments: [], pr: null,
        blocked_by: null,
      },
    ],
    ...overrides,
  };
}

/** A fake `git`/`gh` pair, scripted per test: `answers` keyed by a joined-args string. */
function tools({ headRef = 'step-lands-itself-2', baseRef = 'main', tree = [PATH], main = plan(), head = plan(), fetchFails = false } = {}) {
  const mainText = typeof main === 'string' ? main : JSON.stringify(main);
  const headText = typeof head === 'string' ? head : JSON.stringify(head);
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ headRefName: headRef, baseRefName: baseRef }) };
    }
    return { status: 1, stdout: '' };
  };
  const git = (args) => {
    if (args[0] === 'fetch') return { status: fetchFails ? 1 : 0, stdout: '' };
    if (args[0] === 'ls-tree') return { status: 0, stdout: tree.join('\n') };
    if (args[0] === 'show') {
      const ref = args[1];
      if (ref === `origin/${baseRef}:${PATH}`) return { status: 0, stdout: mainText };
      if (ref === `origin/${headRef}:${PATH}`) return { status: 0, stdout: headText };
      return { status: 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  return { git, gh };
}

it('a byte-identical plan passes without running the comparison', async () => {
  const { git, gh } = tools({});
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

it('an edited instruction on the step running is a trespass', async () => {
  const head = plan();
  head.steps[1].instruction = ['Something else.'];
  const { git, gh } = tools({ head });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /steps\[1\]\.instruction: a step session does not change it/u);
});

it('an edited goal is a trespass', async () => {
  const head = plan();
  head.goal = ['A different goal entirely.'];
  const { git, gh } = tools({ head });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /goal/u);
});

it('a head plan that no longer parses is a trespass, not a silent pass', async () => {
  const { git, gh } = tools({ head: '{ not json' });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /the plan no longer parses/u);
});

it('status, pr, comments, blocked_by and met are the session\'s to change — no trespass', async () => {
  const head = plan();
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  head.steps[1].comments = ['Done.'];
  head.steps[1].blocked_by = null;
  head.success_criteria[0].met = true;
  const { git, gh } = tools({ head });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

it('a branch naming no project is never checked at all', async () => {
  const { git, gh } = tools({ headRef: 'plan-mc', tree: [PATH] });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: false, ok: true, problems: [] });
});

it('gh unable to answer fails open, not closed', async () => {
  const gh = () => ({ status: 1, stdout: '' });
  const git = () => ({ status: 0, stdout: '' });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: false, ok: true, problems: [] });
});
