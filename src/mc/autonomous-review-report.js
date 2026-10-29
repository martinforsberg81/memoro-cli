/** Pure review protocol: reports are observations, never criterion state patches. */
import { createHash } from 'node:crypto';
export const reviewDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && !!value.trim();
const texts = value => Array.isArray(value) && value.every(text);
export function reviewInputProblems(input, assignment) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['review report must be an object'];
  const problems = [];
  if (Object.keys(input).sort().join(',') !== 'criteria,defects,uncertainty') problems.push('review takes only criteria, defects and uncertainty');
  if (!texts(input.defects) || !texts(input.uncertainty)) problems.push('defects and uncertainty must be explicit arrays of text');
  const criteria = input.criteria;
  const ids = assignment.success_criteria.map(item => item.id);
  if (!Array.isArray(criteria) || criteria.length !== ids.length || new Set(criteria?.map?.(item => item?.criterion_id)).size !== ids.length) {
    problems.push('review must cover every criterion exactly once');
  }
  if (Array.isArray(criteria)) for (const item of criteria) {
    if (!item || !ids.includes(item.criterion_id)) { problems.push('unknown criterion'); continue; }
    if (Object.keys(item).sort().join(',') !== 'criterion_id,evidence,status,uncertainty') problems.push('criterion takes only criterion_id, status, evidence and uncertainty');
    if (!['verified', 'finding', 'unknown', 'deferred'].includes(item.status)) problems.push('criterion result is unknown');
    if (!texts(item.evidence) || !item.evidence.length || !texts(item.uncertainty)) problems.push('each criterion needs evidence (or an explicit reason) and uncertainty');
    if (item.status === 'deferred' && assignment.success_criteria.find(c => c.id === item.criterion_id).verification !== 'after-integration') problems.push('premerge criterion cannot be deferred');
  }
  return problems;
}
export function cleanReviewInput(input, assignment) {
  return !reviewInputProblems(input, assignment).length && !input.defects.length && !input.uncertainty.length
    && input.criteria.every(item => !item.uncertainty.length && (item.status === 'verified'
      || (item.status === 'deferred' && assignment.success_criteria.find(c => c.id === item.criterion_id).verification === 'after-integration')));
}
export function unknownReviewInput(assignment, reason) {
  return { criteria: assignment.success_criteria.map(c => ({ criterion_id: c.id, status: 'unknown', evidence: [reason], uncertainty: [reason] })), defects: [], uncertainty: [reason] };
}
