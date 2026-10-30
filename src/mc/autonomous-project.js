/**
 * The opt-in v2 goal contract and revision-attributed observations. No launch
 * path: builder progress and independent review are separate
 * facts. Shape validation is not gate evidence or authorization to merge.
 */
import {
  STABLE_ID_RE, VERIFICATION_PHASES, criterionProblems,
} from './goal-contract.js';

export const AUTONOMOUS_PLAN_VERSION = 2;
export const AUTONOMOUS_EXECUTION_ENABLED = false;

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const id = (value) => typeof value === 'string' && STABLE_ID_RE.test(value);
const prose = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
function keys(value, allowed, at, problems) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}.${key}: unknown key`);
}

/** Validate assignments only: programme identity is not approval authority. */
export function validateAutonomousProject(value, { programme, allowEmptyCriteria = false } = {}) {
  const problems = [];
  if (!plain(value)) return { ok: false, problems: ['the autonomous project must be a JSON object'] };
  if (plain(value.programme) && 'revision' in value.programme) problems.push('unsupported pre-ruling-60 goal format; preserve existing files; automatic migration is not supported');
  keys(value, ['schema', 'version', 'project_id', 'repo', 'execution', 'programme', 'goal_revision', 'work_class', 'programme_phase', 'goal', 'instruction', 'contract', 'out_of_scope', 'success_criteria', 'documents'], 'project', problems);
  if (value.schema !== 'mc-plan') problems.push('schema: must be "mc-plan"');
  if (value.version !== AUTONOMOUS_PLAN_VERSION) problems.push('version: must be 2');
  if (!id(value.project_id)) problems.push('project_id: a stable project name');
  if (!id(value.repo)) problems.push('repo: the repository this goal belongs to');
  if (!plain(value.execution)) problems.push('execution.kind: must be autonomous');
  else {
    keys(value.execution, ['kind'], 'execution', problems);
    if (value.execution.kind !== 'autonomous') problems.push('execution.kind: must be autonomous');
  }
  if (!plain(value.programme)) problems.push('programme: a programme identity');
  else {
    keys(value.programme, ['id'], 'programme', problems);
    if (!id(value.programme.id)) problems.push('programme.id: a stable programme name');
  }
  if (!['fast', 'large'].includes(value.work_class)) problems.push('work_class: fast or large');
  if (!positive(value.programme_phase)) problems.push('programme_phase: a positive safe integer, not a runtime phase');
  if (!positive(value.goal_revision)) problems.push('goal_revision: a positive safe integer');
  for (const field of ['goal', 'instruction', 'contract', 'out_of_scope']) {
    if (!prose(value[field])) problems.push(`${field}: at least one paragraph`);
  }
  if (allowEmptyCriteria && Array.isArray(value.success_criteria) && value.success_criteria.length === 0) {
    // A goal may be composed as a draft before its first criterion is added.
  } else problems.push(...criterionProblems(value.success_criteria, { instruction: true }));
  if (!Array.isArray(value.documents)) problems.push('documents: an array, possibly empty');
  else value.documents.forEach((doc, index) => {
    const at = `documents[${index}]`;
    if (!plain(doc)) { problems.push(`${at}: must be an object`); return; }
    keys(doc, ['label', 'path'], at, problems);
    if (!text(doc.label)) problems.push(`${at}.label: what the reader should read`);
    if (!text(doc.path)) problems.push(`${at}.path: a path or URL`);
  });
  if (programme !== undefined) {
    if (!plain(programme) || programme.id !== value.programme?.id) problems.push('programme: must match programme identity');
    if (plain(programme)) {
      keys(programme, ['id', 'brief'], 'programme context', problems);
      if ('brief' in programme && !text(programme.brief)) problems.push('programme context.brief: a description source path');
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Every assignment change gets a revision; identity and repository do not. */
export function autonomousRevisionProblems(previous, next) {
  const problems = [...validateAutonomousProject(previous, { allowEmptyCriteria: true }).problems.map((p) => `current.${p}`), ...validateAutonomousProject(next).problems];
  if (problems.length) return problems;
  for (const key of ['project_id', 'repo']) if (previous[key] !== next[key]) problems.push(`${key}: a revision cannot change project ownership`);
  if (previous.programme.id !== next.programme.id) problems.push('programme.id: a revision cannot change programme ownership');
  if (next.goal_revision !== previous.goal_revision + 1) problems.push('goal_revision: must advance by exactly one');
  return problems;
}

/** The merge door measures premerge criteria, not checks requiring integration. */
export function criteriaForPhase(project, phase) {
  const { ok, problems } = validateAutonomousProject(project);
  if (!ok) throw new Error(problems.join('; '));
  if (!VERIFICATION_PHASES.includes(phase)) throw new Error('verification phase: premerge or after-integration');
  return project.success_criteria.filter((criterion) => criterion.verification === phase);
}

/**
 * Durable observations are append-only history in the later state writer.
 * Revision tags belong to each record, never to an index in a criteria array.
 * Review and confirmation cannot masquerade as builder progress (or vice versa).
 */
export function validateAutonomousEvidence(value) {
  const problems = [];
  if (!plain(value)) return { ok: false, problems: ['evidence: must be an object'] };
  keys(value, ['builder', 'reviews', 'confirmation'], 'evidence', problems);
  const seen = new Set();
  const attribution = (record, at, allowed) => {
    if (!plain(record)) { problems.push(`${at}: must be an object`); return false; }
    keys(record, allowed, at, problems);
    for (const key of ['id', 'run_id', 'project_id', 'programme_id']) if (!id(record[key])) problems.push(`${at}.${key}: a stable ID`);
    if (seen.has(record.id)) problems.push(`${at}.id: duplicate evidence ID`);
    seen.add(record.id);
    for (const key of ['goal_revision']) if (!positive(record[key])) problems.push(`${at}.${key}: a positive safe integer`);
    return true;
  };
  if (!Array.isArray(value.builder)) problems.push('builder: an array of progress observations');
  else value.builder.forEach((record, index) => {
    const at = `builder[${index}]`;
    if (!attribution(record, at, ['id', 'run_id', 'project_id', 'programme_id', 'goal_revision', 'criterion_id', 'status', 'reference'])) return;
    if (!id(record.criterion_id)) problems.push(`${at}.criterion_id: a stable criterion ID`);
    if (!['pending', 'working', 'verified', 'failed', 'unknown'].includes(record.status)) problems.push(`${at}.status: pending, working, verified, failed or unknown`);
    if (record.status === 'verified' ? !text(record.reference) : record.reference !== null && !text(record.reference)) problems.push(`${at}.reference: verified progress requires an evidence reference; otherwise a reference or null`);
  });
  if (!Array.isArray(value.reviews)) problems.push('reviews: an array of independent reports');
  else value.reviews.forEach((record, index) => {
    const at = `reviews[${index}]`;
    if (!attribution(record, at, ['id', 'run_id', 'project_id', 'programme_id', 'goal_revision', 'reference', 'criteria', 'findings'])) return;
    if (!text(record.reference)) problems.push(`${at}.reference: an immutable report reference`);
    if (!Array.isArray(record.findings) || !record.findings.every(text)) problems.push(`${at}.findings: an array of findings, possibly empty`);
    if (!Array.isArray(record.criteria) || !record.criteria.length) problems.push(`${at}.criteria: explicit criterion observations`);
    else {
      const criteria = new Set();
      record.criteria.forEach((criterion, i) => {
        const path = `${at}.criteria[${i}]`;
        if (!plain(criterion)) { problems.push(`${path}: must be an object`); return; }
        keys(criterion, ['criterion_id', 'status', 'reference'], path, problems);
        if (!id(criterion.criterion_id)) problems.push(`${path}.criterion_id: a stable criterion ID`);
        if (criteria.has(criterion.criterion_id)) problems.push(`${path}.criterion_id: duplicate criterion ID`);
        criteria.add(criterion.criterion_id);
        if (!['verified', 'finding', 'unknown', 'deferred'].includes(criterion.status)) problems.push(`${path}.status: verified, finding, unknown or deferred`);
        if (!text(criterion.reference)) problems.push(`${path}.reference: evidence or the reason it remains unknown/deferred`);
      });
    }
  });
  if (value.confirmation !== null) {
    const at = 'confirmation';
    const record = value.confirmation;
    if (attribution(record, at, ['id', 'run_id', 'project_id', 'programme_id', 'role', 'goal_revision', 'reference'])) {
      if (record.role !== 'plan') problems.push('confirmation.role: only plan confirms a goal');
      if (!text(record.reference)) problems.push('confirmation.reference: the planner decision reference');
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Select current observations without rewriting or deleting history. A revised
 * goal conservatively invalidates all earlier evidence, including confirmation.
 * This is a view, not a green verdict: completeness/head/gate checks come later.
 */
export function evidenceForRevision(project, evidence) {
  const problems = [...validateAutonomousProject(project).problems, ...validateAutonomousEvidence(evidence).problems];
  if (problems.length) throw new Error(problems.join('; '));
  const current = (record) => record.project_id === project.project_id && record.programme_id === project.programme.id
    && record.goal_revision === project.goal_revision;
  const ids = new Set(project.success_criteria.map((criterion) => criterion.id));
  return {
    builder: evidence.builder.filter((record) => current(record) && ids.has(record.criterion_id)),
    reviews: evidence.reviews.filter(current),
    confirmation: evidence.confirmation && current(evidence.confirmation) ? evidence.confirmation : null,
  };
}
