/** Machine-checkable goal decision envelope. Prose scope remains plan's
 * responsibility; these decisions reference approved criteria and rationale. */
import { STABLE_ID_RE } from './programme-contract.js';
import { validateAutonomousProject } from './autonomous-project.js';

export const PLAN_PROJECT_OPERATIONS = Object.freeze(['send-project', 'revise-project', 'dependencies', 'resume-project', 'confirm-project']);
const stable = value => typeof value === 'string' && STABLE_ID_RE.test(value);
const text = value => typeof value === 'string' && !!value.trim();
export function planOperationProblems(intent, agreement) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return ['planner intent must be an object'];
  const problems = [];
  if (Object.keys(intent).some(key => !['id', 'kind', 'project', 'expected_revision', 'programme_revision', 'input', 'basis'].includes(key))) problems.push('unknown planner intent field');
  if (!stable(intent.id) || !PLAN_PROJECT_OPERATIONS.includes(intent.kind) || !stable(intent.project)
    || !Number.isSafeInteger(intent.expected_revision) || intent.expected_revision < 1) problems.push('planner intent needs operation, project and expected state revision');
  if (intent.programme_revision !== agreement.revision) problems.push('programme revision changed; replan pending effects');
  const basis = intent.basis;
  if (!basis || Object.keys(basis).some(key => !['criteria', 'reference'].includes(key)) || !text(basis.reference)
    || !Array.isArray(basis.criteria) || !basis.criteria.length || new Set(basis.criteria).size !== basis.criteria.length
    || basis.criteria.some(id => !agreement.success_criteria.some(criterion => criterion.id === id))) problems.push('decision needs approved programme criteria and a scope rationale reference');
  const input = intent.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [...problems, 'planner input must be an object'];
  if (intent.kind === 'revise-project') problems.push(...validateAutonomousProject(input, { programme: agreement }).problems);
  else if (intent.kind === 'dependencies') {
    if (Object.keys(input).join(',') !== 'projects' || !Array.isArray(input.projects)
      || input.projects.some(item => !item || Object.keys(item).sort().join(',') !== 'goal_revision,project'
        || !stable(item.project) || item.project === intent.project || !Number.isSafeInteger(item.goal_revision) || item.goal_revision < 1)
      || new Set(input.projects.map(item => item.project)).size !== input.projects.length) problems.push('dependencies need distinct programme projects and goal revisions');
  } else if (intent.kind === 'confirm-project') {
    if (Object.keys(input).sort().join(',') !== 'criteria,id,reference' || !stable(input.id) || !text(input.reference)
      || !Array.isArray(input.criteria) || input.criteria.some(item => !item || Object.keys(item).sort().join(',') !== 'criterion_id,reference'
        || !stable(item.criterion_id) || !text(item.reference))) problems.push('confirmation needs an ID, decision reference and explicit criterion evidence');
  } else if (Object.keys(input).length) problems.push('this planner operation takes empty input');
  return problems;
}
