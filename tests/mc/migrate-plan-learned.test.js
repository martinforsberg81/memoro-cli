import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lessonParagraphs, migratePlan, targetStep } from '../../scripts/migrate-plan-learned.js';
import { validatePlan } from '../../src/mc/plan-schema.js';

/**
 * The one-off that moved 259 entries off 38 plans on 2026-09-02. It is kept
 * with a test because the plans it rewrote are the runner's whole input, and
 * because the two shapes it had to survive are the reason the field moved at
 * all: a `body` that is a string (`new-user`, unreadable on origin/main for a
 * day) and a plan with no `done` step to attach to.
 */
const entry = { title: 'The onboarding section was dead on both sides', body: ['`const data = null`.', 'And `phase: null`.'] };

test('an entry becomes its title and its paragraphs', () => {
  assert.deepEqual(lessonParagraphs(entry), [
    '**The onboarding section was dead on both sides**',
    '`const data = null`.',
    'And `phase: null`.',
  ]);
});

/** `new-user`'s five entries each carried a `body` string. That is the fault that made the plan unreadable. */
test('a body that was a string becomes one paragraph', () => {
  assert.deepEqual(lessonParagraphs({ title: 'T', body: 'One sentence.' }), ['**T**', 'One sentence.']);
  assert.deepEqual(lessonParagraphs({ body: ['No title.'] }), ['No title.']);
});

/** Nothing in the old shape said which step taught it, so this is a rule about the plan, not a reading of it. */
test('entries land on the last done step, or on the first when none is done', () => {
  assert.equal(targetStep([{ status: 'done' }, { status: 'done' }, { status: 'ready' }]), 1);
  assert.equal(targetStep([{ status: 'blocked' }, { status: 'ready' }]), 0);
  assert.equal(targetStep([]), 0);
});

function plan(overrides = {}) {
  return {
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met: false, criterion: 'It is done.', check: 'The gate is green.' }],
    what_the_code_taught_us: [entry],
    documents: [],
    steps: [
      { title: 'One', status: 'done', done_when: 'x', instruction: [], pr: 1, blocked_by: null },
      { title: 'Two', status: 'ready', done_when: 'y', instruction: ['do it'], pr: null, blocked_by: null },
    ],
    ...overrides,
  };
}

test('the key goes, the paragraphs land on the step, and the result validates', () => {
  const { plan: after, entries, step } = migratePlan(plan());
  assert.equal(entries, 1);
  assert.equal(step, 0);
  assert.equal('what_the_code_taught_us' in after, false);
  assert.deepEqual(after.steps[0].learned, lessonParagraphs(entry));
  assert.deepEqual(after.steps[1].learned, undefined);
  // `learned` sits after `instruction`, so a step reads in the order it happened.
  assert.deepEqual(Object.keys(after.steps[0]), ['title', 'status', 'done_when', 'instruction', 'learned', 'pr', 'blocked_by']);
  assert.deepEqual(validatePlan(after), { ok: true, problems: [] });
});

test('a plan that has already been migrated is left alone', () => {
  const { plan: once } = migratePlan(plan());
  assert.equal(migratePlan(once), null);
});

test('an empty list still removes the key and touches no step', () => {
  const { plan: after, entries } = migratePlan(plan({ what_the_code_taught_us: [] }));
  assert.equal(entries, 0);
  assert.equal('what_the_code_taught_us' in after, false);
  assert.deepEqual(after.steps, plan().steps);
});
