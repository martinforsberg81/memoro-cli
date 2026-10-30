/** Unit-test readback of a trusted landing; integration tests use the real merger. */
import { reviewDigest } from '../../src/mc/autonomous-review-report.js';
import { reportBinding } from '../../src/mc/autonomous-outcomes.js';

export function measuredLanding(state, sha = 'b'.repeat(40)) {
  state.phase = 'landed';
  state.ownership = { branch: state.contract.project_id, pr: 42 };
  state.publication = { head: 'a'.repeat(40), phase: 'handoff_committed', goal_revision: state.goal_revision };
  const session = { assignment: structuredClone(state.contract), head: state.publication.head, ...state.ownership };
  const report = { id: `review-${state.contract.project_id}`, clean: true, invalid_reasons: [], session,
    session_digest: reviewDigest(session), result: { defects: [], uncertainty: [], criteria: state.contract.success_criteria.map(item => ({
      criterion_id: item.id, status: item.verification === 'premerge' ? 'verified' : 'deferred', evidence: ['Measured by fixture.'], uncertainty: [],
    })) } };
  state.review_reports = [report];
  state.landing = { binding: reportBinding(report), merge_commit: sha, merged_into: 'main', observed_at: new Date().toISOString() };
  return state;
}
