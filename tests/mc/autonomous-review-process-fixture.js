/** Synthetic trusted process facts for report/merge protocol fixtures only. */
import { beginReviewProcess, readReviewProcess, recordReviewSpawn } from '../../src/mc/autonomous-review-process.js';
export const reviewCompletion = { status: 0, signal: null, error: null, process_closed: true,
  group_dead: true, tools_closed: true, transport_completed: true, normal_exit: true, interrupted: false };
export function reviewSpawn(options) {
  if (!readReviewProcess(options).spawn_intent) beginReviewProcess(options);
  recordReviewSpawn(options, 2147483647);
}
