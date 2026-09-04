/**
 * A `PLAN.json` conflict, resolved by the rule the plan already carries.
 *
 * 29 of the 166 conflicting files measured in `~/mc/runner/log/runner.log`
 * were a plan, and the shape was always the same: `main` carries the plan a
 * later round wrote to, the branch carries the same plan with its own step
 * edited. Nothing about that needs a session to read code — it is the
 * comparison `unauthorisedChanges` already makes, run as a merge instead of
 * as a check. Who may write what is the whole rule:
 *
 * - **a step** goes to whichever side changed it against the merge base;
 * - **a criterion** is met if either side met it, and the criterion and its
 *   check themselves are main's — they are Martin's words, and the planning
 *   session's edit is the one on main;
 * - **`goal`, `contract`, `out_of_scope`, `schema`, `version`** are main's
 *   outright. A step session may not change them, so a branch that did is
 *   carrying a trespass, and a merge is not the place to launder it;
 * - **everything else at the top of the plan** (`documents`, `runner`) goes
 *   to whichever side changed it, like a step.
 *
 * And it refuses rather than guesses. Both sides on the same step, a side
 * that is not JSON, a step added or removed, a result `validatePlan` would
 * reject: none of those is resolved here, and the file is left conflicted for
 * the session that has to read the code anyway. A resolver that guesses on a
 * plan produces a plan the next session acts on without checking, which is
 * the most expensive kind of wrong in this system.
 *
 * Pure over three objects — the three sides git holds in the index during a
 * conflicted merge (`:1:` base, `:2:` ours, `:3:` theirs) — so the rule is
 * tested without a git repository. `run.js` is what reads them out.
 */
import { PLAN_FROZEN_FIELDS, validatePlan } from './plan-schema.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The side that changed this value against the base, or a refusal when both
 * did and they disagree. Both sides making the *same* change is not a
 * disagreement — it is one change that arrived twice.
 */
function takeChanged(atBase, onBranch, onMain) {
  if (same(onBranch, onMain)) return { ok: true, value: onMain };
  if (same(onBranch, atBase)) return { ok: true, value: onMain };
  if (same(onMain, atBase)) return { ok: true, value: onBranch };
  return { ok: false };
}

function mergeSteps(base, branch, main) {
  const steps = (plan) => (Array.isArray(plan.steps) ? plan.steps : null);
  const [atBase, onBranch, onMain] = [steps(base), steps(branch), steps(main)];
  if (!atBase || !onBranch || !onMain) return { ok: false, why: 'steps: one of the three sides has none' };
  // A plan that gained or lost a step is a plan somebody rewrote, and then
  // "the same step" is not a question an index can answer.
  if (atBase.length !== onBranch.length || atBase.length !== onMain.length) {
    return {
      ok: false,
      why: `steps: ${atBase.length} in the merge base, ${onBranch.length} on this branch, ${onMain.length} on main — one was added or removed`,
    };
  }
  const value = [];
  const took = [];
  for (let i = 0; i < atBase.length; i += 1) {
    const pick = takeChanged(atBase[i], onBranch[i], onMain[i]);
    if (!pick.ok) return { ok: false, why: `steps[${i}]: changed on this branch and on main both` };
    value.push(pick.value);
    if (same(pick.value, atBase[i])) continue;
    const from = same(onBranch[i], onMain[i]) ? 'both sides' : (same(pick.value, onBranch[i]) ? 'this branch' : 'main');
    took.push(`steps[${i}] from ${from}`);
  }
  return { ok: true, value, took };
}

/**
 * Main's criteria, ticked by either side. Matched on the criterion's own text
 * rather than on its index, so a criterion inserted on main does not move a
 * `met` onto the wrong line.
 */
function mergeCriteria(branch, main) {
  const onMain = Array.isArray(main.success_criteria) ? main.success_criteria : null;
  if (!onMain) return { ok: false, why: 'success_criteria: main has none' };
  const onBranch = Array.isArray(branch.success_criteria) ? branch.success_criteria : [];
  const met = new Map(onBranch.filter(plain).map((item) => [String(item.criterion), Boolean(item.met)]));
  const value = onMain.map((item) => (plain(item) && !item.met && met.get(String(item.criterion)) ? { ...item, met: true } : item));
  return { ok: true, value };
}

/**
 * Merge the three sides of a conflicted plan.
 *
 * `branch` is ours — the project branch the round is on — and `main` is
 * theirs, `origin/main`. Getting those two the wrong way round would hand the
 * branch's step edits to main's authority and lose them, so they are named
 * rather than ordered.
 *
 * Returns `{ ok: true, plan, took }` — `took` being what the result took from
 * where, for the runner's log — or `{ ok: false, why }`, one sentence, which
 * is what a reader of `runner.log` gets.
 */
export function mergePlans({ base, branch, main }) {
  for (const [what, side] of [['the merge base', base], ['this branch', branch], ['main', main]]) {
    if (!plain(side)) return { ok: false, why: `${what} is not a plan object` };
  }

  const steps = mergeSteps(base, branch, main);
  if (!steps.ok) return steps;
  const criteria = mergeCriteria(branch, main);
  if (!criteria.ok) return criteria;

  // Main's key order, so the merged file reads like the one the planning
  // session wrote; a key only the branch has keeps its place at the end.
  const merged = {};
  for (const key of [...new Set([...Object.keys(main), ...Object.keys(branch)])]) {
    if (key === 'steps') { merged.steps = steps.value; continue; }
    if (key === 'success_criteria') { merged.success_criteria = criteria.value; continue; }
    if (PLAN_FROZEN_FIELDS.includes(key)) {
      if (key in main) merged[key] = main[key];
      continue;
    }
    const pick = takeChanged(base[key], branch[key], main[key]);
    if (!pick.ok) return { ok: false, why: `${key}: changed on this branch and on main both` };
    if (pick.value !== undefined) merged[key] = pick.value;
  }

  const check = validatePlan(merged);
  if (!check.ok) return { ok: false, why: `the merged plan would not be a plan: ${check.problems[0]}` };
  return { ok: true, plan: merged, took: steps.took };
}

/**
 * The same rule over the three texts git hands out, and the text to write
 * back.
 *
 * The result is re-serialised rather than patched, so a resolved plan comes
 * out canonically formatted (two spaces, one trailing newline) whatever the
 * two sides looked like. Nothing reads a plan as text — the trespass check,
 * the page and the runner all parse it — so the cost is one wide diff on the
 * merge commit, and the gain is that the rule never has to reason about
 * whitespace.
 */
export function mergePlanText({ base, branch, main }) {
  const sides = [['the merge base', base], ['this branch', branch], ['main', main]];
  const parsed = [];
  for (const [what, text] of sides) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, why: `${what} could not be read out of the index` };
    try {
      parsed.push(JSON.parse(text));
    } catch (err) {
      return { ok: false, why: `${what} is not JSON: ${err.message}` };
    }
  }
  const merged = mergePlans({ base: parsed[0], branch: parsed[1], main: parsed[2] });
  if (!merged.ok) return merged;
  return { ...merged, text: `${JSON.stringify(merged.plan, null, 2)}\n` };
}

/** Is this conflicted path a plan this rule knows? */
export function isPlanPath(path) {
  return String(path || '').endsWith('/PLAN.json') || String(path || '') === 'PLAN.json';
}
