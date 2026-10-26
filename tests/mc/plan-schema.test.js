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
  readPlanText,
  branchFlow,
  deliverableStep,
  planState,
  planSummary,
  validatePlan,
  PLAN_SCHEMA,
  PLAN_VERSION,
  BLOCKER_KINDS,
} from '../../src/mc/plan-schema.js';
import { WORKAREA_BLOCK_NAMES } from '../../src/mc/run-plan.js';

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
    documents: [],
    steps: [
      {
        title: 'The purpose line',
        status: 'done',
        done_when: 'The description is edited in the hero.',
        instruction: [],
        comments: ['The hero hydrates twice: once on mount, once on theme.'],
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

  it('takes a repo naming the repository a programs plan runs in, and refuses one that is not a name', () => {
    assert.deepEqual(validatePlan(plan({ repo: 'memoro-cli' })), { ok: true, problems: [] });
    assert.deepEqual(validatePlan(plan({ repo: 'Not a name' })).problems, [
      'repo: the repository the steps run in, by name — memoro or memoro-cli',
    ]);
    assert.deepEqual(validatePlan(plan({ repo: 3 })).problems, [
      'repo: the repository the steps run in, by name — memoro or memoro-cli',
    ]);
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
    const stopped = { ...ready, status: 'blocked', blocked_by: null };
    assert.match(validatePlan(plan({ steps: [done, stopped] })).problems.join('\n'), /blocked_by/u);
    assert.equal(
      validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'decision', name: 'entity-detail-2' } }] })).ok,
      true,
    );
  });

  it('refuses a sentence where a blocker name belongs', () => {
    const [done, ready] = plan().steps;
    const stopped = { ...ready, status: 'blocked' };
    // The three that got through: a project name, an em dash, and a paragraph
    // saying which step of it was meant. A sentence matches no project, and
    // the page read every one of them as a blocker that had finished.
    const sentence = 'sql-target-dispositions — its S6.W5 step records what authority proves a delete';
    const bad = validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'project', name: sentence } }] }));
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join('\n'), /blocked_by\.name: a name, not a sentence/u);
    // The name it should have been.
    assert.equal(
      validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'project', name: 'sql-target-dispositions' } }] })).ok,
      true,
    );
    // Still refused for being empty, and the message still says what it wants.
    assert.match(
      validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'project', name: '  ' } }] })).problems.join('\n'),
      /blocked_by\.name: the decision, the project or the workarea fault it waits for/u,
    );
  });

  /**
   * The third kind, and the runner's own (2026-09-08): a step `mc run` could
   * not start, blocked on a fault in the workarea rather than on anybody's
   * judgement. The name is one of `WORKAREA_BLOCKS` and every one of them is a
   * name by `NAME_RE`, which is what the schema checks here.
   */
  it('takes `workarea` as a blocker kind, with a name from the runner\'s fixed list', () => {
    const [done, ready] = plan().steps;
    const stopped = { ...ready, status: 'blocked' };
    for (const name of WORKAREA_BLOCK_NAMES) {
      assert.equal(
        validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'workarea', name } }] })).ok,
        true,
        `${name} is a name a plan can carry`,
      );
    }
    assert.ok(BLOCKER_KINDS.includes('workarea'));
    assert.match(
      validatePlan(plan({ steps: [done, { ...stopped, blocked_by: { kind: 'worktree', name: 'dirty-worktree' } }] })).problems.join('\n'),
      /blocked_by\.kind: one of decision, project, workarea/u,
    );
  });

  /**
   * The two kinds that release by themselves (ruling 35): a time, and an
   * earlier step's deploy plus a delay. Each carries its own fields, and
   * nothing else may carry them.
   */
  it('takes `time` and `deploy` blockers with their fields, and refuses a malformed one', () => {
    const [done, ready] = plan().steps;
    const stopped = { ...ready, status: 'blocked' };
    const check = (blocked_by) => validatePlan(plan({ steps: [done, { ...stopped, blocked_by }] }));
    assert.ok(BLOCKER_KINDS.includes('time') && BLOCKER_KINDS.includes('deploy'));
    assert.equal(check({ kind: 'time', name: 'until-20261014-0800', at: '2026-10-14T08:00:00Z' }).ok, true);
    assert.equal(check({ kind: 'deploy', name: 'deploy-step-1-24h', step: 1, hours: 24 }).ok, true);
    assert.equal(check({ kind: 'deploy', name: 'deploy-step-1', step: 1 }).ok, true, 'hours defaults to 0');
    assert.match(check({ kind: 'time', name: 'until-x', at: 'next tuesday' }).problems.join('\n'), /steps\[1\]\.blocked_by\.at: the ISO instant/u);
    assert.match(check({ kind: 'time', name: 'until-x' }).problems.join('\n'), /blocked_by\.at/u);
    assert.match(check({ kind: 'deploy', name: 'deploy-step-2', step: 2 }).problems.join('\n'), /blocked_by\.step: the number of an earlier step of this plan, below 2/u);
    assert.match(check({ kind: 'deploy', name: 'deploy-step-3', step: 3 }).problems.join('\n'), /blocked_by\.step/u);
    assert.match(check({ kind: 'deploy', name: 'deploy-step', step: 1.5 }).problems.join('\n'), /blocked_by\.step/u);
    assert.match(check({ kind: 'deploy', name: 'deploy-step-1', step: 1, hours: -1 }).problems.join('\n'), /blocked_by\.hours: a number of 0 or more/u);
    assert.match(check({ kind: 'project', name: 'y', at: '2026-10-14T08:00:00Z' }).problems.join('\n'), /blocked_by\.at: only a time blocker has one/u);
    assert.match(check({ kind: 'decision', name: 'y', step: 1 }).problems.join('\n'), /blocked_by\.step: only a deploy blocker has one/u);
    assert.match(check({ kind: 'time', name: 'y', at: '2026-10-14T08:00:00Z', hours: 2 }).problems.join('\n'), /blocked_by\.hours: only a deploy blocker has one/u);
  });

  it('takes `comments` on a step as prose, and refuses the old shared field', () => {
    const [done, ready] = plan().steps;
    assert.equal(validatePlan(plan({ steps: [{ ...done, comments: [] }, ready] })).ok, true);
    assert.equal(validatePlan(plan({ steps: [{ ...done, comments: 'One paragraph.' }, ready] })).ok, false);
    assert.match(
      validatePlan(plan({ steps: [{ ...done, comments: [{ title: 'x', body: ['y'] }] }, ready] })).problems.join('\n'),
      /steps\[0\]\.comments: an array of paragraphs/u,
    );
    assert.match(
      validatePlan({ ...plan(), what_the_code_taught_us: [] }).problems.join('\n'),
      /what_the_code_taught_us: unknown key/u,
    );
  });

  // The three plans the runner refused on 2026-09-02, in the shape their
  // sessions actually wrote. Two were refused by the plan's own checks and one —
  // `new-user`, whose five entries each carry a `body` string — sat unreadable
  // on origin/main for a day. None of these is a fault any more: prose on a
  // step is prose, and the only thing a wrong paragraph can spoil is itself.
  it('validates what made three plans unreadable on 2026-09-02', () => {
    const [done, ready] = plan().steps;
    // email-window-layout: `what_the_code_taught_us[0].body: at least one paragraph`
    const emptyBody = { ...done, comments: [] };
    // inbox-finish: `what_the_code_taught_us[0]: must be an object` — a bare paragraph
    const bareParagraph = {
      ...done,
      comments: ['THE CANONICAL G7a CASE: the automation run rows were not under-dressed. The row was a `<button>`, and `.item-row.email-row` was written for the `<div>` the deleted view drew.'],
    };
    // new-user: five entries whose `body` was a string, not an array
    const wasAString = {
      ...done,
      comments: [
        '**The onboarding section was dead on both sides**',
        '`home-onboarding-step-view.js` hardcoded `const data = null` and `src/users/lifecycle.js` returned `phase: null`, `gaps: []`, `nextStep: null` for every user.',
        '**Number(null) is 0, so the age gate has to check the type**',
      ],
    };
    for (const step of [emptyBody, bareParagraph, wasAString]) {
      assert.deepEqual(validatePlan(plan({ steps: [step, ready] })), { ok: true, problems: [] });
    }
  });

  it('refuses a key nobody reads, so a plan cannot carry a field it believes is enforced', () => {
    const { problems } = validatePlan({ ...plan(), needs: ['home-on-msr'] });
    assert.match(problems.join('\n'), /needs: unknown key/u);
  });

  /**
   * Ruling 18: what a session runs on is the plan's `runner`, and a step's
   * own `runner` for the three keys a step may differ on. `tool`,
   * `check_in_minutes` and `stall_minutes` stay the plan's — one lane, one
   * tool, one watch on the session. `budget_minutes` is gone: nothing is
   * killed for how long it ran.
   */
  it('takes effort and advisor in the plan\'s runner, and refuses what is not one', () => {
    const runner = { tool: 'claude', model: 'sonnet', effort: 'medium', advisor: 'opus', check_in_minutes: 60, stall_minutes: 20 };
    assert.deepEqual(validatePlan(plan({ runner })), { ok: true, problems: [] });
    assert.match(validatePlan(plan({ runner: { budget_minutes: 90 } })).problems.join('\n'), /runner\.budget_minutes: unknown key/u);
    for (const key of ['check_in_minutes', 'stall_minutes']) {
      for (const bad of [0, -5, 1.5, '60']) {
        assert.match(validatePlan(plan({ runner: { [key]: bad } })).problems.join('\n'), new RegExp(`runner\\.${key}: must be a positive whole number of minutes`, 'u'), `${key}: ${bad}`);
      }
    }
    assert.equal(validatePlan(plan({ runner: { advisor: 'off' } })).ok, true);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(validatePlan(plan({ runner: { effort } })).ok, true, effort);
    assert.match(validatePlan(plan({ runner: { effort: 'extreme' } })).problems.join('\n'), /runner\.effort: one of low, medium, high, xhigh, max/u);
    assert.match(validatePlan(plan({ runner: { advisor: 'Opus 5' } })).problems.join('\n'), /runner\.advisor: a model name, or off/u);
  });

  it('pairs each model with its tool: the Codex names on a codex plan, haiku and opus on a claude one', () => {
    const [done, ready] = plan().steps;
    const onPlan = (runner, model) => validatePlan(plan({ ...(runner ? { runner } : {}), steps: [done, { ...ready, runner: { model } }] }));
    for (const model of ['gpt-6.1-sol', 'gpt-6.1-luna']) {
      assert.deepEqual(onPlan({ tool: 'codex' }, model), { ok: true, problems: [] }, model);
      assert.match(onPlan(null, model).problems.join('\n'), /steps\[1\]\.runner\.model: gpt-6\.1-(?:sol|luna) is a Codex model — it needs runner\.tool codex/u);
      assert.match(onPlan({ tool: 'claude' }, model).problems.join('\n'), /is a Codex model/u);
    }
    for (const model of ['haiku', 'opus']) {
      assert.deepEqual(onPlan(null, model), { ok: true, problems: [] }, model);
      assert.deepEqual(onPlan({ tool: 'claude' }, model), { ok: true, problems: [] }, model);
      assert.match(onPlan({ tool: 'codex' }, model).problems.join('\n'), new RegExp(`steps\\[1\\]\\.runner\\.model: ${model} is a Claude model — a codex plan names gpt-6\\.1-sol or gpt-6\\.1-luna`, 'u'));
    }
    assert.match(validatePlan(plan({ runner: { tool: 'codex', model: 'opus' } })).problems.join('\n'), /runner\.model: opus is a Claude model/u);
  });

  it('takes a runner with model, effort and advisor on a step, and nothing else there', () => {
    const [done, ready] = plan().steps;
    const onStep = (runner) => validatePlan(plan({ steps: [done, { ...ready, runner }] }));
    assert.deepEqual(onStep({ model: 'opus', effort: 'high', advisor: 'off' }), { ok: true, problems: [] });
    assert.equal(onStep({ effort: 'low' }).ok, true);
    assert.match(onStep({ effort: 'lots' }).problems.join('\n'), /steps\[1\]\.runner\.effort: one of/u);
    assert.match(onStep({ advisor: 'x y' }).problems.join('\n'), /steps\[1\]\.runner\.advisor: a model name, or off/u);
    assert.match(onStep({ model: 'Sonnet 5' }).problems.join('\n'), /steps\[1\]\.runner\.model: must be a model name/u);
    assert.match(onStep({ tool: 'codex' }).problems.join('\n'), /steps\[1\]\.runner\.tool: a plan-level key/u);
    assert.match(onStep({ check_in_minutes: 30 }).problems.join('\n'), /steps\[1\]\.runner\.check_in_minutes: a plan-level key/u);
    assert.equal(onStep({ subagents: 'on' }).ok, true);
    assert.equal(onStep({ subagents: 'off' }).ok, true);
    assert.match(onStep({ subagents: true }).problems.join('\n'), /steps\[1\]\.runner\.subagents: on or off/u);
    assert.match(onStep({ stall_minutes: 30 }).problems.join('\n'), /steps\[1\]\.runner\.stall_minutes: a plan-level key/u);
    assert.match(onStep({ temperature: 1 }).problems.join('\n'), /steps\[1\]\.runner\.temperature: unknown key/u);
    assert.match(onStep('opus').problems.join('\n'), /steps\[1\]\.runner: must be an object/u);
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

  it('steps past a landing step to the next one — the next step does not wait for the merger (ruling 30)', () => {
    const [done, ready] = plan().steps;
    const landing = { ...ready, status: 'landing', pr: 9 };
    const later = { ...ready, title: 'Later', status: 'ready' };
    const close = { ...ready, title: 'The close', status: 'ready' };
    assert.equal(deliverableStep(plan({ steps: [done, landing, later, close] })).step.title, 'Later');
    assert.equal(deliverableStep(plan({ steps: [done, landing, later, close] })).index, 2);
    const state = planState({ steps: [done, landing] });
    assert.equal(state.status, 'landing');
    assert.match(deliverableStep(plan({ steps: [done, landing] })).why, /step 2 is landing — #9 is in the merge queue/u);
  });

  it('a close-out waits for the steps before it to land rather than stacking on them (2026-10-10, step-recovery)', () => {
    const [done, ready] = plan().steps;
    const landing = { ...ready, status: 'landing', pr: 9 };
    const close = { ...ready, title: 'The close', status: 'ready' };
    assert.match(deliverableStep(plan({ steps: [done, landing, close] })).why, /step 2 is landing — #9 is in the merge queue/u, 'the last step waits');
    const measures = { ...ready, title: 'Measure', status: 'ready', done_when: 'Steps 1–2 are `done` with their PRs; the gauge reads green.' };
    const after = { ...ready, title: 'After', status: 'ready' };
    assert.equal(deliverableStep(plan({ steps: [done, landing, measures, after] })).step, null, 'a done_when that asks for the steps done waits too');
    assert.equal(deliverableStep(plan({ steps: [done, { ...landing, status: 'done' }, close] })).step.title, 'The close', 'once landed it starts');
  });

  it('hands out the first ready step, and refuses a plan that does not parse', () => {
    assert.equal(deliverableStep(plan()).step.title, 'The hero object');
    assert.match(deliverableStep(plan({ contract: [] })).why, /does not parse/u);
  });

  it('says why a failed step failed, one line at most 200 characters, and what starts it again (ruling 45 § 4)', () => {
    const [done, ready] = plan().steps;
    const failed = { ...ready, status: 'failed', reason: 'the gate was red' };
    assert.equal(deliverableStep(plan({ steps: [done, failed] })).why, 'step 2 failed: the gate was red; mc step ready starts it again');
    const folded = { ...failed, reason: 'the gate\n   was  red' };
    assert.equal(deliverableStep(plan({ steps: [done, folded] })).why, 'step 2 failed: the gate was red; mc step ready starts it again', 'whitespace folds to single spaces');
    const long = { ...failed, reason: 'x'.repeat(250) };
    assert.equal(deliverableStep(plan({ steps: [done, long] })).why, `step 2 failed: ${'x'.repeat(199)}…; mc step ready starts it again`);
    const bare = { ...failed, reason: null };
    assert.equal(deliverableStep(plan({ steps: [done, bare] })).why, 'step 2 failed; mc step ready starts it again', 'without a reason, today\'s text');
  });

  it('every step done with a criterion unmet is unmet, with its numbers', () => {
    const steps = plan().steps.map((step) => ({ ...step, status: 'done', instruction: [] }));
    const criterion = (met) => ({ met, criterion: 'The hero draws a visual object.', check: 'Seen in the running app.' });
    const unmet = plan({ steps, success_criteria: [criterion(true), criterion(false), criterion(false)] });
    assert.deepEqual(planState(unmet), { status: 'unmet', index: -1, step: null, unmet: [2, 3] });
    assert.equal(planSummary(unmet).status, 'unmet');
    assert.equal(planSummary(unmet).next, 'every step is done, but success criteria 2, 3 are not met — run their checks and record each with mc project criterion met <project> <n>, or add a step that does');
    assert.equal(deliverableStep(unmet).reason, 'unmet');
    const met = plan({ steps, success_criteria: [criterion(true), criterion(true), criterion(true)] });
    assert.equal(planState(met).status, 'done');
    const one = plan({ steps, success_criteria: [criterion(true), criterion(false)] });
    assert.equal(planSummary(one).next, 'every step is done, but success criterion 2 is not met — run its check and record it with mc project criterion met <project> 2, or add a step that does');
  });
});

describe('a review step ends a branch-flow plan', () => {
  const [done, ready] = plan().steps;
  const review = { ...ready, title: 'Review the branch', kind: 'review' };

  it('takes kind review on the last step, and refuses it elsewhere, twice, or as another value', () => {
    assert.deepEqual(validatePlan(plan({ steps: [done, review] })), { ok: true, problems: [] });
    const middle = validatePlan(plan({ steps: [done, { ...review, title: 'Middle' }, ready] })).problems.join('\n');
    assert.match(middle, /steps\[1\]\.kind: only the last step may be the review step/u);
    const twice = validatePlan(plan({ steps: [done, { ...ready, kind: 'review' }, review] })).problems.join('\n');
    assert.match(twice, /steps\[1\]\.kind: only the last step may be the review step/u);
    assert.match(validatePlan(plan({ steps: [done, { ...ready, kind: 'build' }] })).problems.join('\n'), /steps\[1\]\.kind: review, or absent/u);
  });

  it('takes a built step, which is behind the plan the way a landing one is', () => {
    const built = { ...ready, title: 'Built', status: 'built', pr: 12 };
    assert.deepEqual(validatePlan(plan({ steps: [done, built, review] })), { ok: true, problems: [] });
    const state = planState({ steps: [built, { ...built, title: 'Built too' }, review] });
    assert.equal(state.status, 'ready');
    assert.equal(state.index, 2);
  });

  it('is a branch-flow plan when its last step is the review step, and never for no plan', () => {
    assert.equal(branchFlow(plan({ steps: [done, review] })), true);
    assert.equal(branchFlow(plan()), false);
    assert.equal(branchFlow(null), false);
  });
});

/**
 * Three sessions on 2026-09-03 wrote the pull request's URL into `pr`, and each
 * parked its project on a plan that would not parse. The number is what the
 * field holds; a URL or `#N` reads as that number, anything else is refused.
 */
it('pr: a URL or #N reads as the number; other strings are still refused', () => {
  const plan = (pr) => JSON.stringify({
    schema: 'mc-plan', version: 1, goal: ['g'], contract: ['c'], out_of_scope: ['o'],
    success_criteria: [{ met: false, criterion: 'x', check: 'y' }], documents: [],
    steps: [{ title: 't', status: 'done', done_when: 'd', instruction: [], comments: [], pr, blocked_by: null }],
  });
  assert.equal(readPlanText(plan('https://github.com/martinforsberg81/memoro/pull/11300')).plan.steps[0].pr, 11300);
  assert.equal(readPlanText(plan('#11301')).plan.steps[0].pr, 11301);
  assert.equal(readPlanText(plan('11275')).plan.steps[0].pr, 11275);
  assert.equal(readPlanText(plan(560)).plan.steps[0].pr, 560);
  assert.match(readPlanText(plan('pull request 5')).problems.join('\n'), /steps\[0\]\.pr: a pull request number, or null/u);
});
