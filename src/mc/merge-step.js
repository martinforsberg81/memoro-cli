/**
 * The stops the merger waits out rather than answers.
 *
 * Until 2026-11-03 this file also wrote a project step's register patches —
 * `landing`, `done` with its remainder, `ready` again or `failed` after a red.
 * Projects are goals now (goal mc/projects-to-goals): a goal's answer is
 * `tellGoal` in merger.js.
 */

/** The stops that mean "somebody else is measuring; wait": the gate lock and the repository lease. */
export const WAIT_STOPS = Object.freeze(['busy', 'lease']);

// `file-killed` (a test file ended by a signal from outside the round) and
// `red-under-load` (red files green alone on the base and the candidate, or
// cancelled with none failed) are not the change's red: the merger measures
// each once more, puts a second one back in line (`REQUEUE_STOPS`,
// merger.js), and answers it red as it stands only once its requeues are spent.

/** The stop is one the merger waits out, not one it answers. */
export function shouldWait(report) {
  return Boolean(report) && !report.ok && WAIT_STOPS.includes(report.stopped_at);
}
