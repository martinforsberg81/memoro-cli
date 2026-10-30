/** Transitional durable goal operation shape. No programme approval authority. */
import { STABLE_ID_RE } from './goal-contract.js';
import { recoveryDiagnosisProblems } from './programme-recovery.js';
import { validateAutonomousProject } from './autonomous-project.js';

export const PLAN_PROJECT_OPERATIONS = Object.freeze(['send-project', 'revise-project', 'dependencies', 'resume-project', 'confirm-project', 'diagnose-project', 'await-dependencies']);
const stable = value => typeof value === 'string' && STABLE_ID_RE.test(value);
const text = value => typeof value === 'string' && !!value.trim();
export function planOperationProblems(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return ['planner intent must be an object'];
  const problems = [];
  if (Object.keys(intent).some(key => !['id', 'kind', 'project', 'expected_revision', 'input'].includes(key))) problems.push('unknown planner intent field');
  if (!stable(intent.id) || !PLAN_PROJECT_OPERATIONS.includes(intent.kind) || !stable(intent.project)
    || !Number.isSafeInteger(intent.expected_revision) || intent.expected_revision < 1) problems.push('planner intent needs operation, project and expected state revision');
  const input = intent.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [...problems, 'planner input must be an object'];
  if (intent.kind === 'diagnose-project') problems.push(...recoveryDiagnosisProblems(input));
  else if (intent.kind === 'revise-project') problems.push(...validateAutonomousProject(input).problems);
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
