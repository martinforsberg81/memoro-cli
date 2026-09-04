/**
 * The plan's own rule, run as a merge.
 *
 * Every test here builds the three stages git holds during a conflicted merge
 * — the merge base, this branch, origin/main — as objects, because that is
 * what the rule is: a comparison between three plans. The git half (reading
 * `:1:`, `:2:`, `:3:` out of the index, writing the file back, staging it) is
 * `syncMain`'s and is covered in run.test.js.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlanPath, mergePlans, mergePlanText } from '../../src/mc/plan-merge.js';
import { validatePlan } from '../../src/mc/plan-schema.js';

/** A two-step plan, valid, with everything a plan must carry. */
function plan(overrides = {}) {
  return {
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing is true when this is done.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [
      { met: false, criterion: 'The first thing.', check: 'A test.' },
      { met: false, criterion: 'The second thing.', check: 'A row in runs.tsv.' },
    ],
    documents: [],
    steps: [
      { title: 'One', status: 'ready', done_when: 'x', instruction: ['Do x.'], comments: [], pr: null, blocked_by: null },
      { title: 'Two', status: 'ready', done_when: 'y', instruction: ['Do y.'], comments: [], pr: null, blocked_by: null },
    ],
    ...overrides,
  };
}

/** The three stages of the conflict measured 29 times in runner.log. */
function stages() {
  const base = plan();
  // A later round landed step 1 on main and ticked its criterion.
  const main = plan();
  main.steps[0] = { ...main.steps[0], status: 'done', pr: 601, comments: ['Step one landed.'] };
  main.success_criteria[0] = { ...main.success_criteria[0], met: true };
  // This branch is the session running step 2.
  const branch = plan();
  branch.steps[1] = { ...branch.steps[1], status: 'done', pr: 607, comments: ['Step two landed.'] };
  branch.success_criteria[1] = { ...branch.success_criteria[1], met: true };
  return { base, branch, main };
}

test('two sides on different steps merge, and the result is a plan', () => {
  const merged = mergePlans(stages());
  assert.equal(merged.ok, true, merged.why);
  assert.equal(validatePlan(merged.plan).ok, true);
  assert.deepEqual(merged.plan.steps.map((s) => [s.status, s.pr]), [['done', 601], ['done', 607]]);
  assert.deepEqual(merged.plan.steps.map((s) => s.comments[0]), ['Step one landed.', 'Step two landed.']);
  assert.deepEqual(merged.took, ['steps[0] from main', 'steps[1] from this branch']);
});

test('a criterion is met if either side met it, and the criterion itself is main\'s', () => {
  const three = stages();
  // Main rewrote the second criterion's check; the branch ticked it.
  three.main.success_criteria[1] = { met: false, criterion: 'The second thing.', check: 'A row in runs.tsv, with the kind.' };
  const merged = mergePlans(three);
  assert.equal(merged.ok, true, merged.why);
  assert.deepEqual(merged.plan.success_criteria.map((c) => c.met), [true, true]);
  assert.equal(merged.plan.success_criteria[1].check, 'A row in runs.tsv, with the kind.');
});

test('a criterion main inserted does not move the branch\'s `met` onto another line', () => {
  const three = stages();
  three.main.success_criteria.unshift({ met: false, criterion: 'A new first thing.', check: 'Something else.' });
  const merged = mergePlans(three);
  assert.equal(merged.ok, true, merged.why);
  assert.deepEqual(
    merged.plan.success_criteria.map((c) => [c.criterion, c.met]),
    [['A new first thing.', false], ['The first thing.', true], ['The second thing.', true]],
  );
});

test('the goal, the contract and the scope are main\'s, whatever the branch did to them', () => {
  const three = stages();
  three.branch.goal = ['Something the session widened.'];
  three.branch.contract = ['A term nobody agreed to.'];
  three.branch.out_of_scope = ['Less than before.'];
  const merged = mergePlans(three);
  assert.equal(merged.ok, true, merged.why);
  assert.deepEqual(merged.plan.goal, three.main.goal);
  assert.deepEqual(merged.plan.contract, three.main.contract);
  assert.deepEqual(merged.plan.out_of_scope, three.main.out_of_scope);
});

test('a top-level field only one side changed is that side\'s', () => {
  const three = stages();
  three.branch.documents = [{ label: 'What the branch found', path: '../x/PLAN.json' }];
  const merged = mergePlans(three);
  assert.equal(merged.ok, true, merged.why);
  assert.deepEqual(merged.plan.documents, three.branch.documents);
});

test('the same change on both sides is one change, not a disagreement', () => {
  const three = stages();
  three.branch.steps[0] = { ...three.main.steps[0] };
  const merged = mergePlans(three);
  assert.equal(merged.ok, true, merged.why);
  assert.equal(merged.plan.steps[0].pr, 601);
  assert.deepEqual(merged.took, ['steps[0] from both sides', 'steps[1] from this branch']);
});

test('both sides on the same step is refused, and the refusal names it', () => {
  const three = stages();
  three.branch.steps[0] = { ...three.branch.steps[0], comments: ['The branch wrote here too.'] };
  const merged = mergePlans(three);
  assert.equal(merged.ok, false);
  assert.match(merged.why, /steps\[0\]: changed on this branch and on main both/u);
  assert.equal(merged.plan, undefined, 'a refusal carries no plan for a caller to use by accident');
});

test('a step added or removed is refused — an index cannot say what "the same step" means', () => {
  const three = stages();
  three.main.steps.push({ title: 'Three', status: 'ready', done_when: 'z', instruction: ['Do z.'], comments: [], pr: null, blocked_by: null });
  const merged = mergePlans(three);
  assert.equal(merged.ok, false);
  assert.match(merged.why, /steps: 2 in the merge base, 2 on this branch, 3 on main/u);
});

test('a merged result that is not a plan is refused rather than written', () => {
  const three = stages();
  // `blocked` with nothing said about what it waits for: the branch's own step,
  // so the step rule would take it, and validatePlan is what catches it.
  three.branch.steps[1] = { ...three.branch.steps[1], status: 'blocked', blocked_by: null };
  const merged = mergePlans(three);
  assert.equal(merged.ok, false);
  assert.match(merged.why, /the merged plan would not be a plan: steps\[1\]\.blocked_by/u);
});

test('a top-level field both sides changed differently is refused', () => {
  const three = stages();
  three.branch.documents = [{ label: 'Branch', path: 'a' }];
  three.main.documents = [{ label: 'Main', path: 'b' }];
  const merged = mergePlans(three);
  assert.equal(merged.ok, false);
  assert.match(merged.why, /documents: changed on this branch and on main both/u);
});

test('a side that is not a plan object is refused, not thrown on', () => {
  for (const side of ['base', 'branch', 'main']) {
    const three = { ...stages(), [side]: null };
    const merged = mergePlans(three);
    assert.equal(merged.ok, false);
    assert.match(merged.why, /is not a plan object/u);
  }
});

test('the text form parses all three sides and returns the file to write', () => {
  const three = stages();
  const merged = mergePlanText({
    base: JSON.stringify(three.base, null, 2),
    branch: JSON.stringify(three.branch),
    main: JSON.stringify(three.main, null, 4),
  });
  assert.equal(merged.ok, true, merged.why);
  assert.equal(merged.text.endsWith('\n'), true, 'a file the next merge reads ends in a newline');
  assert.deepEqual(JSON.parse(merged.text), merged.plan);
  assert.match(merged.text, /^\{\n {2}"schema"/u, 'two spaces, canonically — nothing reads a plan as text');
});

test('a side that is not JSON, or that git could not show, is refused', () => {
  const three = stages();
  const text = (value) => JSON.stringify(value);
  assert.match(mergePlanText({ base: '{oh no', branch: text(three.branch), main: text(three.main) }).why, /the merge base is not JSON/u);
  assert.match(mergePlanText({ base: text(three.base), branch: '<<<<<<< HEAD', main: text(three.main) }).why, /this branch is not JSON/u);
  assert.match(mergePlanText({ base: text(three.base), branch: text(three.branch), main: null }).why, /main could not be read out of the index/u);
});

test('a plan is recognised by its name, at the root or under a project directory', () => {
  assert.equal(isPlanPath('docs/project/mc/no-reconcile/PLAN.json'), true);
  assert.equal(isPlanPath('PLAN.json'), true);
  assert.equal(isPlanPath('docs/project/project_log.md'), false);
  assert.equal(isPlanPath('src/mc/PLAN.json.js'), false);
  assert.equal(isPlanPath(null), false);
});
