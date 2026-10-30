/** Reconcile an owned review, never respawn it or signal a discovered process.
 * The caller holds the shared project claim and runner slot. */
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, incompleteAutonomousReview } from './autonomous-state.js';
import { completeAutonomousReview } from './autonomous-review.js';
import { reviewProcessStatus } from './autonomous-review-process.js';

export async function verifyReviewPr(options, session, gh) {
  if (typeof gh !== 'function') throw new Error('published PR head is unknown');
  const response = await gh(['pr', 'view', String(session.pr), '--json', 'headRefOid,headRefName,baseRefName,state'], { cwd: options.cwd });
  if (!(response?.ok === true || response?.status === 0)) throw new Error('published PR head is unknown');
  const pr = JSON.parse(response.stdout);
  if (pr.headRefOid !== session.head || pr.headRefName !== session.branch || pr.baseRefName !== 'main' || pr.state !== 'OPEN') throw new Error('published PR head changed or is not open on main');
}

export async function recoverAutonomousReview(options, { gh } = {}) {
  const read = () => readAutonomousState(options.root, options.programme, options.project);
  const state = read();
  if (state.review_reports?.some(report => report.id === options.actor.run_id)) return state;
  if (options.actor.role !== 'review' || !isDeepStrictEqual(state.active_run, options.actor)) throw new Error('active review ownership required');
  try {
    const observed = reviewProcessStatus(options);
    // A living process is still doing its review, not an abandoned failure.
    if (observed.kind === 'live') return state;
    if (observed.kind === 'unknown' && observed.attempt.spawn_intent) throw new Error('review process unknown; ownership retained');
    const invalidReasons = [];
    if (observed.kind === 'completed') {
      try { await verifyReviewPr(options, state.review_session, gh); }
      catch (error) { invalidReasons.push(error.message); }
    }
    // This rechecks native closure, the gate, immutable bindings and both
    // fingerprints under the generation-safe process claim. Persisted reports
    // must replay exactly; stale evidence cannot overwrite a once-clean report.
    return completeAutonomousReview(options, null, { invalidReasons });
  } catch (error) {
    return incompleteAutonomousReview(options.root, options.programme, options.project,
      { actor: options.actor, revision: read().revision, reason: error.message });
  }
}
