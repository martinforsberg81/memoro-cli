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

/**
 * A version 2 goal with every part filled, keys in the order `renderGoal` writes them: `goalJsonV2(fields)` is its
 * text with `fields` replaced, `goalMinimalV2(fields)` the one with only the parts a version 2 goal must say.
 */
export const GOAL_BASE_V2 = Object.freeze({
  schema: 'mc-goal',
  version: 2,
  stage: 'build',
  status: 'ready',
  phase: 1,
  repos: ['memoro-cli'],
  class: 'large',
  created: '2026-11-01T20:00:00Z',
  prs: [],
  title: 'Make the goal plain',
  aim: ['Why the goal exists.'],
  outcome: ['Two files and a worktree.', 'And nothing else.'],
  problem: [{ id: 'B1', text: 'The brief is one prose field.', basis: 'measured' }],
  premises: [{ id: 'P1', claim: 'goals.js has GOAL_VERSION = 1.', source: 'src/mc/goals.js line 27', basis: 'read', at: '4daf75f3' }],
  decisions: [{ id: 'D1', text: 'Parts are numbered.', by: 'Martin', on: '2026-11-14' }],
  change: [{ id: 'C1', where: 'src/mc/goals.js', what: 'Accept version 2.' }],
  latitude: ['The build chooses the wording.'],
  preserve: [{ id: 'V1', text: 'Version 1 is as before.', upheld_by: 'criterion 1' }],
  obligations: [{ area: 'Documentation', stand: 'touched', text: 'mc-goals.md says both versions.', standard: 'memoro-cli/docs/technical/mc-goals.md#GOAL.json' }, { area: 'Operations', stand: 'untouched', text: 'Nothing deploys.' }],
  risks: [{ id: 'R1', text: 'A writer drops the parts.', settled_by: 'criterion 1' }],
  success_criteria: [{ criterion: 'it works', check: 'a test', evidence: 'the gate log', met: false }],
  protection: ['Version 1 is untouched.'],
  out_of_scope: [{ id: 'X1', text: 'Converting version 1 goals.', owner: 'nobody' }],
  documents: [{ label: 'The design', path: 'memoro-cli/docs/technical/mc-goals.md' }],
  ids: { B: 1, P: 1, D: 1, C: 1, V: 1, R: 1, X: 1 },
});

export function goalJsonV2(fields = {}) {
  return `${JSON.stringify({ ...GOAL_BASE_V2, ...fields }, null, 2)}\n`;
}

/** The version 2 goal with only what it must say: an outcome, a change, obligations (none), a criterion; every other part empty. */
export function goalMinimalV2(fields = {}) {
  return goalJsonV2({
    aim: [], outcome: ['Only the outcome.'], problem: [], premises: [], decisions: [], change: [{ id: 'C1', where: 'src', what: 'Do it.' }], latitude: [], preserve: [],
    obligations: [], risks: [], success_criteria: [{ criterion: 'it works', check: 'a test', met: false }], protection: [], out_of_scope: [], documents: [],
    ids: { B: 0, P: 0, D: 0, C: 1, V: 0, R: 0, X: 0 }, ...fields,
  });
}
