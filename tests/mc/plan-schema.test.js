/**
 * The plan file's shape, and the two questions the runner asks it.
 *
 * Before this, `status: ready` in a markdown frontmatter was the whole
 * admission test. A plan could be missing the sections the step role sends a
 * session to — two of twenty-six were — and the cost was a ninety-minute
 * headless session that guessed. The faults below are the ones actually found
 * in `docs/project/` on 2026-08-30, written as tests so they cannot come back
 * as conventions nobody checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deliverableStep,
  planState,
  unauthorisedChanges,
  validatePlan,
  PLAN_SCHEMA,
  PLAN_VERSION,
} from '../../src/mc/plan-schema.js';

function plan(overrides = {}) {
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    goal: ['The project detail page answers where a project stands.'],
    contract: ['The sections the page ends with are not changed without Martin.'],
    out_of_scope: ['Trip detail, and every other entity detail surface.'],
    success_criteria: [
      { met: false, criterion: 'The hero draws a visual object.', check: 'Seen in the running app, light and dark.' },
    ],
    what_the_code_taught_us: [],
    documents: [],
    steps: [
      {
        title: 'The purpose line',
        status: 'done',
        done_when: 'The description is edited in the hero.',
        instruction: [],
        pr: 11085,
        blocked_by: null,
      },
      {
        title: 'The hero object',
        status: 'ready',
        done_when: 'A project page draws the object in light and in dark.',
        instruction: ['Generate the light and dark siblings, register the token, wire the hero.'],
        pr: null,
        blocked_by: null,
      },
    ],
    ...overrides,
  };
}

describe('the plan schema', () => {
  it('accepts a well-formed plan', () => {
    assert.deepEqual(validatePlan(plan()), { ok: true, problems: [] });
  });

  it('reports every fault at once, because the caller is deciding whether to spend a session', () => {
    const { ok, problems } = validatePlan(plan({ goal: [], contract: [], out_of_scope: [] }));
    assert.equal(ok, false);
    assert.equal(problems.length, 3);
  });

  it('requires both directions of the boundary', () => {
    const { problems } = validatePlan(plan({ out_of_scope: [] }));
    assert.match(problems.join('\n'), /out_of_scope/u);
  });

  it('requires a criterion to say how it is checked', () => {
    const { problems } = validatePlan(plan({
      success_criteria: [{ met: false, criterion: 'The card looks right.', check: '' }],
    }));
    assert.match(problems.join('\n'), /success_criteria\[0\]\.check/u);
  });

  it('requires a done_when on every step, done ones included', () => {
    const steps = plan().steps.map((step) => ({ ...step, done_when: '' }));
    const { problems } = validatePlan(plan({ steps }));
    assert.equal(problems.filter((p) => p.includes('done_when')).length, 2);
  });

  it('requires an instruction for a step that has not run, and forgives one that has', () => {
    const [done, ready] = plan().steps;
    assert.equal(validatePlan(plan({ steps: [done, { ...ready, instruction: [] }] })).ok, false);
    assert.equal(validatePlan(plan({ steps: [{ ...done, instruction: [] }, ready] })).ok, true);
  });

  it('makes a stopped step name what it waits for', () => {
    const [done, ready] = plan().steps;
    const stopped = { ...ready, status: 'waiting-decision', blocked_by: null };
    assert.match(validatePlan(plan({ steps: [done, stopped] })).problems.join('\n'), /blocked_by/u);
    assert.equal(
      validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'decision', name: 'entity-detail-2' } }] })).ok,
      true,
    );
  });

  it('refuses a key nobody reads, so a plan cannot carry a field it believes is enforced', () => {
    const { problems } = validatePlan({ ...plan(), needs: ['home-on-msr'] });
    assert.match(problems.join('\n'), /needs: unknown key/u);
  });
});

describe('the plan has no status of its own', () => {
  it('is the state of the first step that is not done', () => {
    assert.deepEqual(planState(plan()).status, 'ready');
    const steps = plan().steps.map((step) => ({ ...step, status: 'done' }));
    assert.deepEqual(planState({ steps }).status, 'done');
  });

  it('does not skip a stopped step to reach a later ready one', () => {
    const [done, ready] = plan().steps;
    const stopped = { ...ready, status: 'blocked', blocked_by: { kind: 'project', name: 'docx-editor' } };
    const later = { ...ready, title: 'Later', status: 'ready' };
    const { step, why } = deliverableStep(plan({ steps: [done, stopped, later] }));
    assert.equal(step, null);
    assert.match(why, /step 2 is blocked on project docx-editor/u);
  });

  it('hands out the first ready step, and refuses a plan that does not parse', () => {
    assert.equal(deliverableStep(plan()).step.title, 'The hero object');
    assert.match(deliverableStep(plan({ contract: [] })).why, /does not parse/u);
  });
});

describe('what a step session may have changed', () => {
  const before = plan();

  it('lets it finish its own step', () => {
    const after = structuredClone(before);
    after.steps[1].status = 'done';
    after.steps[1].pr = 11150;
    after.success_criteria[0].met = true;
    after.what_the_code_taught_us.push({ title: 'The hero hydrates twice', body: ['Once on mount, once on theme.'] });
    assert.deepEqual(unauthorisedChanges(before, after, 1), { ok: true, problems: [] });
  });

  it('catches a rewritten step that has not run', () => {
    const after = structuredClone(before);
    after.steps[1].instruction = ['Something else entirely.'];
    const { ok, problems } = unauthorisedChanges(before, after, 0);
    assert.equal(ok, false);
    assert.match(problems.join('\n'), /steps\[1\]: changed by the session that ran step 1/u);
  });

  it('catches an added step and a moved boundary', () => {
    const added = structuredClone(before);
    added.steps.push({ title: 'One more', status: 'ready', done_when: 'x', instruction: ['y'], pr: null, blocked_by: null });
    assert.match(unauthorisedChanges(before, added, 1).problems.join('\n'), /never adds or removes one/u);

    const widened = structuredClone(before);
    widened.out_of_scope = [];
    assert.match(unauthorisedChanges(before, widened, 1).problems.join('\n'), /out_of_scope/u);
  });

  it('lets a criterion be ticked but not rewritten', () => {
    const after = structuredClone(before);
    after.success_criteria[0].check = 'Looks fine.';
    assert.match(unauthorisedChanges(before, after, 1).problems.join('\n'), /only `met` is the session's/u);
  });
});
