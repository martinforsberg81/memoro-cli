/** An amendment changes instructions, never execution history or the release door. */
import { isDeepStrictEqual } from 'node:util';
import { planState, validatePlan } from './plan-schema.js';
import { applyEntry, stepKey } from './register.js';
import { dependencyWords, sendProblems, testDirectories } from './plan-write.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function onlyKeys(value, allowed, where) {
  if (!plain(value)) throw new Error(`${where} must be an object`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${where}: unknown fields ${extra.join(', ')}`);
}

/** A person-held block, not a timer/deploy/dependency the runner can release. */
export function amendmentStanding(plan, entry) {
  if (!entry || entry.steps.length !== plan.steps.length
    || entry.steps.some((step, i) => step.key !== stepKey(plan.steps[i]))) {
    throw new Error('the register must match the plan before an amendment');
  }
  if (entry.steps.some(step => ['running', 'landing'].includes(step.status) || step.session)) {
    throw new Error('a running/landing step or retained session prevents an amendment');
  }
  const state = planState(applyEntry({ plan }, entry).plan);
  if (state.status !== 'blocked' || !['decision', 'workarea'].includes(state.step.blocked_by?.kind)) {
    throw new Error('the first unfinished step must stay blocked on a decision or workarea');
  }
  // A changed contract can invalidate any earlier proof. Never carry that proof
  // into the new plan, nor write a second state file during the plan commit.
  if (entry.criteria?.some(criterion => criterion.met)) {
    throw new Error('record met criteria unmet with mc project criterion unmet before amending');
  }
  return state.index;
}

/** Strict partial input, not an alternate way to replace a whole PLAN.json. */
export function amendedPlan(plan, entry, amendment) {
  const first = amendmentStanding(plan, entry);
  onlyKeys(amendment, ['contract', 'steps', 'success_criteria'], 'amendment');
  const next = structuredClone(plan);
  if (own(amendment, 'contract')) next.contract = amendment.contract;
  if (own(amendment, 'success_criteria')) {
    if (!Array.isArray(amendment.success_criteria)) throw new Error('success_criteria must be an array');
    next.success_criteria = amendment.success_criteria.map((criterion) => {
      onlyKeys(criterion, ['criterion', 'check'], 'criterion');
      return { ...criterion, met: false };
    });
  }
  if (own(amendment, 'steps')) {
    if (!Array.isArray(amendment.steps)) throw new Error('steps must be an array');
    const seen = new Set();
    for (const change of amendment.steps) {
      onlyKeys(change, ['number', 'instruction', 'done_when', 'model', 'effort'], 'step amendment');
      const index = change.number - 1;
      if (!Number.isInteger(change.number) || index < first || index >= plan.steps.length || seen.has(index)) {
        throw new Error(`step ${change.number}: use a distinct remaining step number`);
      }
      seen.add(index);
      const held = entry.steps[index];
      if (plan.steps[index].kind === 'review' || !['ready', 'blocked'].includes(held.status) || held.landed) {
        throw new Error(`step ${change.number}: completed, built and review steps cannot be amended`);
      }
      const step = next.steps[index];
      for (const key of ['instruction', 'done_when']) if (own(change, key)) step[key] = change[key];
      for (const key of ['model', 'effort']) {
        if (own(change, key)) step.runner = { ...step.runner, [key]: change[key] };
      }
    }
  }
  // send's authorship checks do not accept the review step that send itself
  // added. Validate the intact plan, then the authored portion with send's rules.
  const problems = [...new Set([
    ...validatePlan(next).problems,
    ...sendProblems({ ...next, steps: next.steps.filter(step => step.kind !== 'review') }),
  ])];
  for (const [index, criterion] of next.success_criteria.entries()) {
    if (next.success_criteria.findIndex(other => other.criterion === criterion.criterion) !== index) {
      problems.push(`criterion ${index + 1}: duplicate criterion text`);
    }
    if (dependencyWords(criterion.criterion).length || dependencyWords(criterion.check).length) {
      problems.push(`criterion ${index + 1}: a dependency belongs in a step's dependency field`);
    }
    if (testDirectories(criterion.check).length) problems.push(`criterion ${index + 1}: name test files, not directories`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  if (isDeepStrictEqual(next, plan)) throw new Error('the amendment changes nothing');
  return next;
}
