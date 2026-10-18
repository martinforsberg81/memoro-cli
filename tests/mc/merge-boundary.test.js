/**
 * The door — `planBoundary` — over fake `git` and `gh`: nothing here starts a
 * process. The comparison rules themselves (`unauthorisedChanges`) are
 * `tests/mc/plan-schema.test.js`'s; this is only the wiring around them — which
 * branch names which project, which two refs are compared, and when the
 * question is never asked at all.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { criteriaDoor, planBoundary } from '../../src/mc/merge-boundary.js';

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
function tools({ headRef = 'step-lands-itself-2', baseRef = 'main', tree = [PATH], main = plan(), head = plan(), fetchFails = false, mergeBase = main, mergeBaseFails = false } = {}) {
  const mainText = typeof main === 'string' ? main : JSON.stringify(main);
  const baseText = typeof mergeBase === 'string' ? mergeBase : JSON.stringify(mergeBase);
  const headText = typeof head === 'string' ? head : JSON.stringify(head);
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ headRefName: headRef, baseRefName: baseRef }) };
    }
    return { status: 1, stdout: '' };
  };
  const git = (args) => {
    if (args[0] === 'fetch') return { status: fetchFails ? 1 : 0, stdout: '' };
    if (args[0] === 'merge-base') {
      return mergeBaseFails ? { status: 1, stdout: '' } : { status: 0, stdout: 'abc123\n' };
    }
    if (args[0] === 'ls-tree') return { status: 0, stdout: tree.join('\n') };
    if (args[0] === 'show') {
      const ref = args[1];
      if (ref === `origin/${baseRef}:${PATH}`) return { status: 0, stdout: mainText };
      if (ref === `abc123:${PATH}`) return { status: 0, stdout: baseText };
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

/** A plan as it stood when the branch was cut, main's edit to steps[3] after, and the head's own. */
function started() {
  const steps = [...plan().steps,
    { title: 'third', status: 'ready', done_when: 'd', instruction: ['i'], comments: [], pr: null, blocked_by: null },
    { title: 'fourth', status: 'ready', done_when: 'd', instruction: ['i'], comments: [], pr: null, blocked_by: null }];
  return plan({ steps });
}

it('a plan edit that landed on main after the branch started is not the session\'s', async () => {
  const p0 = started();
  const p1 = started();
  p1.steps[3].instruction = ['Rewritten on main while the step ran.'];
  const head = started();
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  head.steps[1].comments = ['Done.'];
  const { git, gh } = tools({ main: p1, mergeBase: p0, head });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

it('the session editing the same step main edited is still a trespass, against the merge base', async () => {
  const p0 = started();
  const p1 = started();
  p1.steps[3].instruction = ['Rewritten on main while the step ran.'];
  const head = started();
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  head.steps[3].instruction = ['Rewritten by the session.'];
  const { git, gh } = tools({ main: p1, mergeBase: p0, head });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /steps\[3\]: changed by the session/u);
});

it('a merge base that cannot be read falls back to main as it is now', async () => {
  const p0 = started();
  const p1 = started();
  p1.steps[3].instruction = ['Rewritten on main while the step ran.'];
  const head = started();
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  const { git, gh } = tools({ main: p1, mergeBase: p0, head, mergeBaseFails: true });
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /steps\[3\]/u);
});

it('a plan absent at the merge base falls back to main as it is now', async () => {
  const head = plan();
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  const { git: inner, gh } = tools({ head });
  const git = (args) => (args[0] === 'show' && args[1] === `abc123:${PATH}` ? { status: 128, stdout: '' } : inner(args));
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

/** `tools`, with the stacked step's tip readable at `tip`. */
function stackedTools(options, tipPlan) {
  const { git: inner, gh } = tools(options);
  const git = (args) => (args[0] === 'show' && args[1] === `tip:${PATH}` ? { status: 0, stdout: JSON.stringify(tipPlan) } : inner(args));
  return { git, gh };
}

it('stacked: main\'s plan edit, brought in after the tip was recorded, is not the session\'s', async () => {
  const tip = started();
  const p1 = started();
  p1.steps[3].instruction = ['Rewritten on main while the step below landed.'];
  const head = started();
  head.steps[3].instruction = p1.steps[3].instruction;
  const { git, gh } = stackedTools({ main: p1, mergeBase: p1, head }, tip);
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh, from: 'tip' });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

it('stacked: the step below\'s own plan edit, not yet on main, is not the session\'s', async () => {
  const tip = started();
  tip.steps[0].comments = ['Landed below.'];
  tip.steps[3].instruction = ['Rewritten by the step below.'];
  const head = started();
  head.steps[0].comments = tip.steps[0].comments;
  head.steps[3].instruction = tip.steps[3].instruction;
  head.steps[1].status = 'done';
  head.steps[1].pr = 671;
  const { git, gh } = stackedTools({ head }, tip);
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh, from: 'tip' });
  assert.deepEqual(result, { checked: true, ok: true, problems: [] });
});

it('stacked: an edit neither the tip nor main has is still a trespass, named against the tip', async () => {
  const tip = started();
  const head = started();
  head.steps[3].instruction = ['Rewritten by the session.'];
  const { git, gh } = stackedTools({ head }, tip);
  const result = await planBoundary({ repoPath: '/x', pr: 671, git, gh, from: 'tip' });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /steps\[3\]: changed by the session/u);
});

it('the register\'s step index is the one judged, not the plan\'s first unfinished step', async () => {
  const head = started();
  head.steps[2].status = 'done';
  head.steps[2].comments = ['Done.'];
  const { git, gh } = tools({ main: started(), mergeBase: started(), head });
  assert.deepEqual(await planBoundary({ repoPath: '/x', pr: 671, git, gh, index: 2 }), { checked: true, ok: true, problems: [] });
  const guessed = await planBoundary({ repoPath: '/x', pr: 671, git, gh });
  assert.equal(guessed.ok, false, 'without the index the plan names step 2 (index 1), and step 3\'s edit is a trespass');
});

it('criteriaDoor refuses the last step while a criterion is unmet', async () => {
  const last = { project: 'step-lands-itself', index: 1 };
  const { git, gh } = tools({});
  const refused = await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: last });
  assert.equal(refused.checked, true);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.unmet, [1]);
  assert.ok(refused.problems[0].startsWith('step 2 is the plan\'s last, and success criterion 1 is not met on main'), refused.problems[0]);

  const measured = tools({ head: plan({ success_criteria: [{ met: true, criterion: 'x', check: 'y' }] }) });
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, ...measured, step: last }), { checked: true, ok: true, problems: [] });
  assert.deepEqual(await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: { ...last, index: 0 } }), { checked: true, ok: true, problems: [] }, 'not the last step');
  assert.equal((await criteriaDoor({ repoPath: '/x', pr: 671, git, gh, step: null })).checked, false, 'nobody\'s step');
  const ghDown = () => ({ status: 1, stdout: '' });
  assert.equal((await criteriaDoor({ repoPath: '/x', pr: 671, git, gh: ghDown, step: last })).checked, false, 'fails open');
});
