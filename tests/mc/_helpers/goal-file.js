/**
 * GOAL.json for tests: `goalJson(fields)` is the text `renderGoal` writes for
 * a goal with one unmet criterion unless `fields` say otherwise, keys in its
 * order, so a parsed fixture renders back to the same text. `goalField(text,
 * key)` reads one field back; `withGoal(text, fields)` is the text with
 * fields replaced.
 */
export const GOAL_BASE = Object.freeze({
  schema: 'mc-goal',
  version: 1,
  stage: 'build',
  status: 'ready',
  phase: 1,
  repos: ['memoro-cli'],
  class: 'large',
  created: '2026-11-01T20:00:00Z',
  prs: [],
  title: 'Make the goal plain',
  goal: ['Two files and a worktree.'],
  contract: [],
  out_of_scope: [],
  success_criteria: [{ criterion: 'it works', check: 'a test', met: false }],
  documents: [],
});

export function goalJson(fields = {}) {
  return `${JSON.stringify({ ...GOAL_BASE, ...fields }, null, 2)}\n`;
}

export function goalField(text, key) {
  return JSON.parse(text)[key];
}

export function withGoal(text, fields) {
  return `${JSON.stringify({ ...JSON.parse(text), ...fields }, null, 2)}\n`;
}
