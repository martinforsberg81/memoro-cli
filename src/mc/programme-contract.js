/**
 * Programme contract snapshots, not runtime state. An approved snapshot is
 * immutable; editing means a separate draft for the next revision. These pure
 * checks confer no permission to write, start sessions, merge or deploy.
 */
import { isDeepStrictEqual } from 'node:util';

export const PROGRAMME_SCHEMA = 'mc-programme';
export const PROGRAMME_VERSION = 1;
export const STABLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const VERIFICATION_PHASES = Object.freeze(['premerge', 'after-integration']);
export const PROGRAMME_AUTHORITY = Object.freeze({
  programme_revision: 'foreground-plan',
  goal_revision: 'plan',
  confirmation: 'plan',
  implementation: 'step',
  review: 'report-only',
});

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const prose = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const id = (value) => typeof value === 'string' && STABLE_ID_RE.test(value);

function keys(value, allowed, at, problems) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}.${key}: unknown key`);
}

/** Stable IDs are explicit, never derived from prose or array positions. */
export function criterionProblems(list, { instruction = false } = {}) {
  const problems = [];
  if (!Array.isArray(list) || !list.length) return ['success_criteria: at least one criterion'];
  const seen = new Set();
  list.forEach((item, index) => {
    const at = `success_criteria[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    keys(item, ['id', 'criterion', 'check', 'verification', ...(instruction ? ['instruction'] : [])], at, problems);
    if (!id(item.id)) problems.push(`${at}.id: a stable lower-case name`);
    if (seen.has(item.id)) problems.push(`${at}.id: duplicate criterion ID`);
    seen.add(item.id);
    if (!text(item.criterion)) problems.push(`${at}.criterion: what must be true`);
    if (!text(item.check)) problems.push(`${at}.check: how it is measured`);
    if (instruction && !prose(item.instruction)) problems.push(`${at}.instruction: at least one paragraph`);
    if (!VERIFICATION_PHASES.includes(item.verification)) problems.push(`${at}.verification: premerge or after-integration`);
  });
  return problems;
}

/** A complete draft or approved revision; approval is never inferred. */
export function validateProgrammeContract(value) {
  const problems = [];
  if (!plain(value)) return { ok: false, problems: ['the programme must be a JSON object'] };
  keys(value, ['schema', 'version', 'id', 'revision', 'based_on', 'status', 'approval', 'goal', 'specification', 'scope', 'success_criteria', 'authority', 'planned_stops'], 'programme', problems);
  if (value.schema !== PROGRAMME_SCHEMA) problems.push(`schema: must be "${PROGRAMME_SCHEMA}"`);
  if (value.version !== PROGRAMME_VERSION) problems.push(`version: must be ${PROGRAMME_VERSION}`);
  if (!id(value.id)) problems.push('id: a stable programme name');
  if (!positive(value.revision)) problems.push('revision: a positive safe integer');
  if (!Number.isSafeInteger(value.based_on) || value.based_on < 0 || value.based_on !== value.revision - 1) {
    problems.push('based_on: the preceding revision, or 0 for the first');
  }
  if (!['draft', 'approved'].includes(value.status)) problems.push('status: draft or approved');
  if (value.status === 'approved') {
    if (!plain(value.approval)) problems.push('approval: approved revisions name who approved them and when');
    else {
      keys(value.approval, ['by', 'at'], 'approval', problems);
      if (!text(value.approval.by)) problems.push('approval.by: the approving person');
      if (!(typeof value.approval.at === 'string' && /^\d{4}-\d\d-\d\dT/u.test(value.approval.at) && Number.isFinite(Date.parse(value.approval.at)))) {
        problems.push('approval.at: an ISO instant');
      }
    }
  } else if (value.approval !== undefined) problems.push('approval: only approved revisions carry approval');
  for (const field of ['goal', 'specification']) if (!prose(value[field])) problems.push(`${field}: at least one paragraph`);
  if (!plain(value.scope)) problems.push('scope: included and excluded work');
  else {
    keys(value.scope, ['included', 'excluded'], 'scope', problems);
    for (const field of ['included', 'excluded']) if (!prose(value.scope[field])) problems.push(`scope.${field}: at least one paragraph`);
  }
  problems.push(...criterionProblems(value.success_criteria));
  if (!plain(value.authority)) problems.push('authority: explicit plan, step and report-only review responsibilities');
  else {
    keys(value.authority, Object.keys(PROGRAMME_AUTHORITY), 'authority', problems);
    for (const [key, role] of Object.entries(PROGRAMME_AUTHORITY)) {
      if (value.authority[key] !== role) problems.push(`authority.${key}: must be ${role}`);
    }
  }
  if (!Array.isArray(value.planned_stops) || !value.planned_stops.length) problems.push('planned_stops: at least one agreed stopping point');
  else {
    const seen = new Set();
    value.planned_stops.forEach((stop, index) => {
      const at = `planned_stops[${index}]`;
      if (!plain(stop)) { problems.push(`${at}: must be an object`); return; }
      keys(stop, ['id', 'condition'], at, problems);
      if (!id(stop.id)) problems.push(`${at}.id: a stable stopping-point name`);
      if (seen.has(stop.id)) problems.push(`${at}.id: duplicate stop ID`);
      seen.add(stop.id);
      if (!text(stop.condition)) problems.push(`${at}.condition: when work must stop for agreement`);
    });
  }
  return { ok: problems.length === 0, problems };
}

/** Validate a successor against the current approved snapshot, not a draft. */
export function programmeRevisionProblems(approved, next) {
  const problems = [...validateProgrammeContract(approved).problems.map((p) => `current.${p}`), ...validateProgrammeContract(next).problems];
  if (problems.length) return problems;
  if (approved.status !== 'approved') problems.push('current: must be an approved revision');
  if (approved.id !== next.id) problems.push('id: a revision cannot change programme identity');
  if (next.revision === approved.revision) {
    if (!isDeepStrictEqual(approved, next)) problems.push('revision: an approved revision is immutable');
  } else if (next.revision !== approved.revision + 1 || next.based_on !== approved.revision) {
    problems.push('revision: the next revision must follow the approved revision exactly');
  }
  return problems;
}
