/** Bounded programme planning: low work is an event; proposals have a daily cadence. */
import { FINISHED, stageSince } from './goals.js';

export const PROPOSAL_REVIEW_MS = 24 * 60 * 60_000;
export const PROGRAMME_PLAN_REASONS = ['one_goal_remaining', 'no_goals_remaining', 'daily_proposals'];
export const isProgrammePlan = (goal) => PROGRAMME_PLAN_REASONS.includes(goal?.reason) || goal?.reason === 'next_step';

/** Identity survives archives, phase renumbering and ordinary build/review/log changes. */
export function programmeWorkKey(goals) {
  return JSON.stringify(goals.map((goal) => [
    goal.goal, goal.created ?? null,
    FINISHED.includes(goal.stage) ? goal.stage : 'unfinished',
    FINISHED.includes(goal.stage) ? stageSince(goal) : null,
  ]).sort(([a], [b]) => a.localeCompare(b)));
}

export function programmePlanning({ goals, proposals, receipt, now }) {
  if (goals.some((goal) => goal.problems?.length)) return null;
  const remaining = goals.filter((goal) => !FINISHED.includes(goal.stage));
  const key = programmeWorkKey(goals);
  // Old all-done receipts already consumed that completion. Do not wake it again on upgrade.
  const legacyKey = JSON.stringify(goals.map((goal) => [goal.goal, goal.created ?? null, stageSince(goal)])
    .sort(([a], [b]) => a.localeCompare(b)));
  const consumed = receipt?.work_key === key || (!receipt?.version && !remaining.length
    && goals.every((goal) => goal.stage === 'done') && receipt?.key === legacyKey);
  const triggers = [];
  if (remaining.length <= 1 && !consumed) triggers.push(remaining.length ? 'one_goal_remaining' : 'no_goals_remaining');
  const lastProposals = Date.parse(receipt?.proposal_at ?? '');
  if (proposals.length && (!Number.isFinite(lastProposals) || now.getTime() - lastProposals >= PROPOSAL_REVIEW_MS)) triggers.push('daily_proposals');
  if (!triggers.length) return null;
  return { key, remaining: remaining.map((goal) => goal.goal), proposals, triggers, reason: triggers[0] };
}

export function programmePlanningReceipt(previous, decision, at) {
  return {
    version: 2,
    work_key: decision.remaining.length <= 1 ? decision.key : previous?.work_key ?? null,
    proposal_at: decision.proposals.length ? at : previous?.proposal_at ?? null,
    at, outcome: 'started', reason: decision.reason, triggers: decision.triggers,
    remaining: decision.remaining, proposals: decision.proposals,
  };
}

export function programmePlanPrompt({ programme, dir, decision }) {
  return [
    `You are the headless plan session for programme ${programme} (reason: ${decision.reason}). No goal is assigned to this session.`,
    `Triggers: ${decision.triggers.join(', ')}. Remaining goals: ${decision.remaining.join(', ') || 'none'}. Open proposals: ${decision.proposals.join(', ') || 'none'}.`,
    `Read ${dir}/README.md, PLAN.md, current goals and their logs, proposals/ and proposals/archive/. Inspect actual prerequisite delivery evidence, including relevant cross-programme dependencies.`,
    'For one remaining goal, prepare justified follow-up work. With none remaining, reconsider the next step and previously unmet dependencies. For daily proposals, decide whether each should advance, wait for a named condition, or be archived with a reason.',
    'Continue within the approved programme direction. Complete concrete briefs and executable acceptance before activating build. Preserve phase ordering, acceptance requirements, approved test scope and decisions waiting on Martin. Record any decision requiring Martin with a concrete recommendation; never silently clear it.',
    'Respect existing session/worktree ownership and resource limits. Do not duplicate active work or start another plan or Manager session. Use mc goal verbs for justified work.',
    `Record the decision in ${dir}/PLAN.md: what changed, what remains waiting, named dependencies and what should cause reconsideration. Doing nothing now is a valid outcome. Report assessed, activated, queued and started work as separate facts.`,
  ].join('\n');
}
