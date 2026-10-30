/** Landing completes execution. Follow-up measurements never grant merge authority. */
import { isDeepStrictEqual } from 'node:util';
import { cleanReviewInput, reviewDigest } from './autonomous-review-report.js';
import { STABLE_ID_RE } from './goal-contract.js';

export function reviewedLanding(state) {
  const landing = state.landing; const binding = landing?.binding;
  const report = state.review_reports?.at(-1);
  if (state.phase !== 'landed' || !binding || !report?.session || !report.clean || !cleanReviewInput(report.result, state.contract)
    || !isDeepStrictEqual(report.session.assignment, state.contract)
    || report.session_digest !== reviewDigest(report.session)
    || report.invalid_reasons?.length !== 0
    || binding.report_id !== report.id || binding.report_digest !== reviewDigest(report)
    || binding.goal_revision !== state.goal_revision || state.goal_revision !== state.contract.goal_revision
    || binding.head !== report.session.head || binding.head !== state.publication?.head
    || state.publication?.goal_revision !== state.goal_revision || state.publication.phase !== 'handoff_committed'
    || binding.branch !== report.session.branch || binding.branch !== state.ownership.branch
    || binding.pr !== report.session.pr || binding.pr !== state.ownership.pr
    || landing.merged_into !== 'main' || !/^[a-f0-9]{40}$/u.test(landing.merge_commit || '')) return null;
  return landing;
}

export function followUpObservationProblems(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['follow-up must be an observation'];
  const problems = [];
  const allowed = ['id', 'criterion_id', 'goal_revision', 'integrated_sha', 'reference', 'outcome', 'run_id', 'project_id', 'programme_id'];
  if (Object.keys(record).some(key => !allowed.includes(key))) problems.push('unknown follow-up observation field');
  for (const key of ['id', 'criterion_id', 'run_id', 'project_id', 'programme_id']) {
    if (typeof record[key] !== 'string' || !STABLE_ID_RE.test(record[key])) problems.push(`follow-up ${key} needs a stable ID`);
  }
  if (!Number.isSafeInteger(record.goal_revision) || record.goal_revision < 1) problems.push('follow-up needs a goal revision');
  if (!/^[a-f0-9]{40}$/u.test(record.integrated_sha || '')) problems.push('follow-up needs the integrated SHA');
  if (typeof record.reference !== 'string' || !record.reference.trim()) problems.push('follow-up needs a measurement reference');
  if (!['passed', 'failed', 'unknown'].includes(record.outcome)) problems.push('follow-up outcome must be passed, failed or unknown');
  return problems;
}

export function goalCompletion(state) {
  const landing = reviewedLanding(state);
  if (state.follow_up_observations !== undefined && !Array.isArray(state.follow_up_observations)) throw new Error('follow-up observations must be an array');
  const observations = state.follow_up_observations || [];
  const ids = new Set();
  for (const record of observations) {
    const problems = followUpObservationProblems(record);
    if (ids.has(record.id)) problems.push('duplicate follow-up observation ID');
    if (problems.length) throw new Error(problems.join('; '));
    ids.add(record.id);
  }
  const follow_ups = state.contract.success_criteria.filter(item => item.verification === 'after-integration').map(item => {
    const observation = landing ? observations.filter(record => record.criterion_id === item.id
      && record.goal_revision === state.goal_revision && record.integrated_sha === landing.merge_commit
      && record.project_id === state.contract.project_id && record.programme_id === state.contract.programme.id).at(-1) : null;
    return { criterion_id: item.id, outcome: observation?.outcome || 'missing', reference: observation?.reference || null };
  });
  return { done: !!landing, follow_ups, pending_follow_ups: follow_ups.filter(item => item.outcome !== 'passed').map(item => item.criterion_id) };
}
