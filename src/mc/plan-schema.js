// The plan file: one document, read by the runner and by whoever writes it.
//
// A plan used to be prose with frontmatter, and the parts the runner depended
// on — a `next:` line, a section named "Contract", a "done when" somewhere in
// it — were conventions nothing checked. Two of twenty-six plans were missing
// the sections the step role sends a session to, and `status: ready` was the
// entire admission test: a malformed plan cost a ninety-minute headless
// session before anyone noticed. The shape is a schema now, so a plan that
// cannot be run says so at the door instead.
//
// The whole file is `PLAN.json` in the project directory: the overall part
// first, then one entry per step carrying that step's instruction *and* its
// state. Prose fields are arrays of paragraphs rather than one string, so a
// diff stays line-oriented for the person reading the PR.

export const PLAN_SCHEMA = 'mc-plan';
export const PLAN_VERSION = 1;

// A step is `ready` (the runner may hand it out), `done`, or stopped: `blocked`
// on another project, `waiting-decision` on an answer from Martin. The plan has
// no status of its own — it is the state of the first step that is not done,
// which is the one fact the two used to disagree about.
export const STEP_STATUSES = Object.freeze(['ready', 'done', 'blocked', 'waiting-decision']);
export const BLOCKER_KINDS = Object.freeze(['decision', 'project']);

const STATUSES = new Set(STEP_STATUSES);
const KINDS = new Set(BLOCKER_KINDS);
const STOPPED = new Set(['blocked', 'waiting-decision']);

const TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const MODEL_RE = /^[a-z][a-z0-9._-]{0,63}$/u;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const PLAN_KEYS = Object.freeze([
  'schema',
  'version',
  'goal',
  'contract',
  'out_of_scope',
  'success_criteria',
  'what_the_code_taught_us',
  'documents',
  'runner',
  'steps',
]);

const STEP_KEYS = Object.freeze([
  'title',
  'status',
  'done_when',
  'instruction',
  'pr',
  'blocked_by',
]);

const CRITERION_KEYS = Object.freeze(['met', 'criterion', 'check']);
const LESSON_KEYS = Object.freeze(['title', 'body']);
const DOCUMENT_KEYS = Object.freeze(['label', 'path']);
const RUNNER_KEYS = Object.freeze(['tool', 'model', 'budget_minutes']);
const BLOCKER_KEYS = Object.freeze(['kind', 'name']);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Prose is an array of paragraphs. `min` is 1 where the field is the reason the
// plan exists, and 0 where a plan may honestly have nothing yet to say.
function prose(value, { min = 1 } = {}) {
  return Array.isArray(value) && value.length >= min && value.every(text);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateRunner(runner, problems) {
  if (runner === null || runner === undefined) return;
  if (!plain(runner)) { problems.push('runner: must be an object, or absent for the defaults'); return; }
  for (const key of unknownKeys(runner, RUNNER_KEYS)) problems.push(`runner.${key}: unknown key`);
  if (runner.tool !== undefined && !TOOL_RE.test(String(runner.tool))) {
    problems.push('runner.tool: must name a tool mc can launch');
  }
  if (runner.model !== undefined && runner.model !== null && !MODEL_RE.test(String(runner.model))) {
    problems.push('runner.model: must be a model name');
  }
  if (runner.budget_minutes !== undefined && !positiveInteger(runner.budget_minutes)) {
    problems.push('runner.budget_minutes: must be a positive whole number of minutes');
  }
}

function validateCriteria(list, problems) {
  if (!Array.isArray(list) || list.length < 1) {
    problems.push('success_criteria: at least one criterion — a project with none cannot be finished');
    return;
  }
  list.forEach((item, index) => {
    const at = `success_criteria[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, CRITERION_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (typeof item.met !== 'boolean') problems.push(`${at}.met: true or false`);
    if (!text(item.criterion)) problems.push(`${at}.criterion: what must be true`);
    // The check is the half a criterion is usually missing: "done" is not a
    // judgement the session makes about its own work.
    if (!text(item.check)) problems.push(`${at}.check: how it is checked — the assertion, the query, the measurement in the running app`);
  });
}

function validateLessons(list, problems) {
  if (!Array.isArray(list)) {
    problems.push('what_the_code_taught_us: an array, empty until the code teaches something');
    return;
  }
  list.forEach((item, index) => {
    const at = `what_the_code_taught_us[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, LESSON_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (!text(item.title)) problems.push(`${at}.title: what was learned, in a line`);
    if (!prose(item.body)) problems.push(`${at}.body: at least one paragraph`);
  });
}

function validateDocuments(list, problems) {
  if (!Array.isArray(list)) { problems.push('documents: an array, possibly empty'); return; }
  list.forEach((item, index) => {
    const at = `documents[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, DOCUMENT_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (!text(item.label)) problems.push(`${at}.label: what the reader is being sent to`);
    if (!text(item.path)) problems.push(`${at}.path: a path or URL a checkout can follow`);
  });
}

function validateBlocker(step, at, problems) {
  const blocker = step.blocked_by;
  if (STOPPED.has(step.status)) {
    if (!plain(blocker)) {
      problems.push(`${at}.blocked_by: a ${step.status} step names what it waits for`);
      return;
    }
    for (const key of unknownKeys(blocker, BLOCKER_KEYS)) problems.push(`${at}.blocked_by.${key}: unknown key`);
    if (!KINDS.has(blocker.kind)) problems.push(`${at}.blocked_by.kind: one of ${BLOCKER_KINDS.join(', ')}`);
    if (!text(blocker.name)) problems.push(`${at}.blocked_by.name: the decision or the project it waits for`);
    return;
  }
  if (blocker !== null && blocker !== undefined) {
    problems.push(`${at}.blocked_by: null unless the step is blocked or waiting-decision`);
  }
}

function validateSteps(steps, problems) {
  if (!Array.isArray(steps) || steps.length < 1) {
    problems.push('steps: at least one step — the plan holds every step, written before the work');
    return;
  }
  steps.forEach((step, index) => {
    const at = `steps[${index}]`;
    if (!plain(step)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(step, STEP_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (!text(step.title)) problems.push(`${at}.title: what the step does`);
    if (!STATUSES.has(step.status)) problems.push(`${at}.status: one of ${STEP_STATUSES.join(', ')}`);
    // The sentence the runner's prompt calls the session's success criterion.
    // A step without one sends a session off with nothing to verify.
    if (!text(step.done_when)) problems.push(`${at}.done_when: when this step is finished`);
    // A step that has run is history; one that has not is an instruction, and
    // an under-specified instruction is the expensive kind — the session fills
    // the gap with a guess and the plan cannot tell it not to.
    if (!prose(step.instruction, { min: step.status === 'done' ? 0 : 1 })) {
      problems.push(`${at}.instruction: at least one paragraph for a step that has not run`);
    }
    if (step.pr !== null && step.pr !== undefined && !positiveInteger(step.pr)) {
      problems.push(`${at}.pr: a pull request number, or null`);
    }
    validateBlocker(step, at, problems);
  });
}

/**
 * Read a plan and say everything wrong with it, not the first thing.
 *
 * The caller is deciding whether to spend a session on this plan, or telling
 * Martin why it did not, so one reason code at a time would cost a round trip
 * per fault.
 */
export function validatePlan(value) {
  const problems = [];

  if (!plain(value)) return { ok: false, problems: ['the plan must be a JSON object'] };
  for (const key of unknownKeys(value, PLAN_KEYS)) problems.push(`${key}: unknown key`);

  if (value.schema !== PLAN_SCHEMA) problems.push(`schema: must be "${PLAN_SCHEMA}"`);
  if (value.version !== PLAN_VERSION) problems.push(`version: must be ${PLAN_VERSION}`);

  if (!prose(value.goal)) problems.push('goal: at least one paragraph — what is true when this project is done');
  // Both directions of the boundary. A boundary nobody wrote down is one every
  // session redraws.
  if (!prose(value.contract)) problems.push('contract: at least one entry — what may not change without Martin');
  if (!prose(value.out_of_scope)) problems.push('out_of_scope: at least one entry — name what this project does not do');

  validateCriteria(value.success_criteria, problems);
  validateLessons(value.what_the_code_taught_us, problems);
  validateDocuments(value.documents, problems);
  validateRunner(value.runner, problems);
  validateSteps(value.steps, problems);

  return { ok: problems.length === 0, problems };
}

/**
 * The plan's state, derived rather than declared: the first step that is not
 * done decides. A plan whose steps are all done is done.
 *
 * The runner considers that first unfinished step and no other. Steps are an
 * order, and skipping over a stopped one to reach a later `ready` step is how a
 * plan ends up half-built in an order nobody chose.
 */
export function planState(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const index = steps.findIndex((step) => step?.status !== 'done');
  if (index === -1) return { status: 'done', index: -1, step: null };
  const step = steps[index];
  return { status: STATUSES.has(step?.status) ? step.status : 'invalid', index, step };
}

/**
 * The step `mc run` would hand out, or the reason it would not — the whole
 * admission test, in one place, before a session is spent.
 */
export function deliverableStep(plan) {
  const { ok, problems } = validatePlan(plan);
  if (!ok) return { step: null, index: -1, why: `the plan does not parse: ${problems[0]}`, problems };

  const state = planState(plan);
  if (state.status === 'done') return { step: null, index: -1, why: 'every step is done', problems: [] };
  if (state.status !== 'ready') {
    const waiting = state.step?.blocked_by;
    return {
      step: null,
      index: state.index,
      why: `step ${state.index + 1} is ${state.status} on ${waiting?.kind || 'something'} ${waiting?.name || '(unnamed)'}`,
      problems: [],
    };
  }
  return { step: state.step, index: state.index, why: null, problems: [] };
}

/**
 * What a step session is allowed to have changed, checked on the way back in.
 *
 * The instruction said it and could be read past; this is the same rule as a
 * comparison. A session edits the step it ran, the criteria it met, and what
 * the code taught it — never a step that has not run, and never the goal, the
 * contract or the scope.
 */
export function unauthorisedChanges(before, after, index) {
  const problems = [];
  const frozen = ['goal', 'contract', 'out_of_scope', 'schema', 'version'];
  for (const key of frozen) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      problems.push(`${key}: a step session does not change it`);
    }
  }

  const from = Array.isArray(before?.steps) ? before.steps : [];
  const to = Array.isArray(after?.steps) ? after.steps : [];
  if (from.length !== to.length) {
    problems.push(`steps: ${from.length} before, ${to.length} after — a step session never adds or removes one`);
  }
  const shared = Math.min(from.length, to.length);
  for (let i = 0; i < shared; i += 1) {
    if (i === index) continue;
    if (JSON.stringify(from[i]) !== JSON.stringify(to[i])) {
      problems.push(`steps[${i}]: changed by the session that ran step ${index + 1}`);
    }
  }

  // The criteria may be ticked, never rewritten.
  const criteriaBefore = Array.isArray(before?.success_criteria) ? before.success_criteria : [];
  const criteriaAfter = Array.isArray(after?.success_criteria) ? after.success_criteria : [];
  if (criteriaBefore.length !== criteriaAfter.length) {
    problems.push('success_criteria: a step session does not add or remove one');
  } else {
    criteriaBefore.forEach((criterion, i) => {
      const next = criteriaAfter[i] || {};
      if (criterion.criterion !== next.criterion || criterion.check !== next.check) {
        problems.push(`success_criteria[${i}]: the criterion itself is Martin's, only \`met\` is the session's`);
      }
    });
  }

  return { ok: problems.length === 0, problems };
}
