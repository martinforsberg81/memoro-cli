/**
 * The door — `criteriaDoor` — over fake `git` and `gh`: nothing here starts a
 * process. This is the wiring around it — which branch names which project,
 * which step is the last, and when the question is never asked at all.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { criteriaDoor } from '../../src/mc/merge-boundary.js';

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

/** A fake `git`/`gh` pair: the branch names, and the plan texts on `origin/<base>` and `origin/<head>`. */
function tools({ headRef = 'step-lands-itself-2', baseRef = 'main', main = plan(), head = plan() } = {}) {
  const mainText = JSON.stringify(main);
  const headText = JSON.stringify(head);
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ headRefName: headRef, baseRefName: baseRef }) };
    }
    return { status: 1, stdout: '' };
  };
  const git = (args) => {
    if (args[0] === 'show' && args[1] === `origin/${baseRef}:${PATH}`) return { status: 0, stdout: mainText };
    if (args[0] === 'show' && args[1] === `origin/${headRef}:${PATH}`) return { status: 0, stdout: headText };
    return { status: 1, stdout: '' };
  };
  return { git, gh };
}

/** No register, and the plan under ~/mc/programs/ with criterion 1 unmet: the plan the door reads. */
const none = { root: '/r', programs: () => [{ project: 'step-lands-itself', text: JSON.stringify(plan()) }], read: () => null };

it('criteriaDoor refuses the last step while a criterion is unmet', async () => {
  const last = { project: 'step-lands-itself', index: 1 };
  const { git, gh } = tools();
  const refused = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last, ...none });
  assert.equal(refused.checked, true);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.unmet, [1]);
  assert.ok(refused.problems[0].startsWith('step 2 is the plan\'s last, and success criterion 1 is not met — run its check and record it with mc project criterion met'), refused.problems[0]);

  const registered = JSON.stringify({ project: 'step-lands-itself', steps: [], criteria: [{ criterion: 'x', met: true, at: null }] });
  const measured = { ...none, read: () => registered };
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last, ...measured }), { checked: true, ok: true, problems: [] }, 'the register holds it met');
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: { ...last, index: 0 }, ...none }), { checked: true, ok: true, problems: [] }, 'not the last step');
  assert.equal((await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: null, ...none })).checked, false, 'nobody\'s step');
  const ghDown = () => ({ status: 1, stdout: '' });
  assert.equal((await criteriaDoor({ repoPath: '/x', pr: 671, git, gh: ghDown, step: last, ...none })).checked, false, 'fails open');
});

it('criteriaDoor does not read the pull request\'s copy of met', async () => {
  const last = { project: 'step-lands-itself', index: 1 };
  const { git, gh } = tools({ head: plan({ success_criteria: [{ met: true, criterion: 'x', check: 'y' }] }) });
  const refused = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last, ...none });
  assert.equal(refused.ok, false, 'met true on the branch, no register entry: still refused');
  assert.deepEqual(refused.unmet, [1]);
});

it('criteriaDoor judges the programmes copy and asks git for no plan; with no programmes plan it is not checked', async () => {
  const last = { project: 'step-lands-itself', index: 1 };
  const { git: inner, gh } = tools({ main: plan({ success_criteria: [{ met: true, criterion: 'x', check: 'y' }] }) });
  const asked = [];
  const git = (args, options) => { asked.push(args[0]); return inner(args, options); };
  const judged = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last, ...none });
  assert.equal(judged.ok, false, 'the programmes copy, met false, is the one judged');
  assert.deepEqual(judged.unmet, [1]);
  assert.deepEqual(asked.filter((verb) => verb === 'ls-tree' || verb === 'show'), [], 'no repository copy is read');
  const unheld = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last, root: '/r', read: () => null, programs: () => [] });
  assert.equal(unheld.checked, false);
});

/** A branch-flow plan: two steps built before the review, which is the last; criterion 1 met as `met` says. */
function flowPlan(met = false) {
  const step = (title, extra = {}) => ({ title, status: 'ready', done_when: 'd', instruction: ['i'], comments: [], pr: null, blocked_by: null, ...extra });
  return plan({
    success_criteria: [{ met, criterion: 'x', check: 'y' }],
    steps: [step('first'), step('second'), step('the review', { kind: 'review' })],
  });
}

it('criteriaDoor refuses a step before the review with stop before-review, and the review with unmet-criteria', async () => {
  const text = JSON.stringify(flowPlan(false));
  const flow = { root: '/r', programs: () => [{ project: 'step-lands-itself', text }], read: () => null };
  const { git, gh } = tools();
  const early = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: { project: 'step-lands-itself', index: 0 }, ...flow });
  assert.equal(early.checked, true);
  assert.equal(early.ok, false);
  assert.equal(early.stop, 'before-review');
  assert.match(early.problems[0], /^step 1 is built on the project's branch and does not land by itself — the project lands with its review step, step 3$/u);

  const review = { project: 'step-lands-itself', index: 2 };
  const refused = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: review, ...flow });
  assert.equal(refused.ok, false);
  assert.equal(refused.stop, 'unmet-criteria');
  assert.deepEqual(refused.unmet, [1]);

  const registered = JSON.stringify({ project: 'step-lands-itself', steps: [], criteria: [{ criterion: 'x', met: true, at: null }] });
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: review, ...flow, read: () => registered }), { checked: true, ok: true, problems: [] }, 'the review passes with the criteria met');

  const oldStyle = { root: '/r', programs: () => [{ project: 'step-lands-itself', text: JSON.stringify(plan()) }], read: () => null };
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: { project: 'step-lands-itself', index: 0 }, ...oldStyle }), { checked: true, ok: true, problems: [] }, 'a plan without a review is not held before its last step');
});
