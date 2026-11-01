/** Revisioned v2 data only. No scheduler, launcher or v1 register interpretation. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-write.js';
import { realLock } from './register.js';
import { withPlanLock } from './plan-write.js';
import { createSessionControl, decideSessionControl, interruptSessionControl, controlResponse, validateControlState } from './session-control.js';
import { autonomousModelIdentity, independentModel, builderModels } from './autonomous-models.js';
import { reviewDigest, reviewInputProblems, cleanReviewInput } from './autonomous-review-report.js';
import { PLAN_FILE } from './plan-source.js';
import { PROGRAMS_HOME } from './paths.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { reviewedLanding, goalCompletion, followUpObservationProblems } from './goal-followup.js';
import { validateProgrammeMetadata } from './programme-metadata.js';
import { validateAutonomousProject, autonomousRevisionProblems, validateAutonomousEvidence, evidenceForRevision } from './autonomous-project.js';
import { assertProjectRecovery, projectRecovery, recoveryProgress, recoveryDiagnosisProblems, reserveMainRepairLocked, mainIncidentHold } from './programme-recovery.js';
import { readClaim, processAlive } from './resource-claim.js';

export const GOAL_STATE_VERSION = 2;
export const PROGRAMME_STATE_FILE = 'PROGRAMME_STATE.json';
export const AUTONOMOUS_STATE_FILE = 'AUTONOMOUS_STATE.json';
export const AUTONOMOUS_PHASES = Object.freeze(['ready', 'running', 'handoff_requested', 'closing', 'publishing', 'review_ready', 'reviewing', 'plan_pending', 'landing', 'landed']);
const PLAN_PROJECT_OPERATIONS = Object.freeze(['send-project', 'revise-project', 'dependencies', 'resume-project', 'confirm-project', 'diagnose-project', 'await-dependencies', 'send-goal', 'revise-goal', 'follow-up-goal']);
/** A foreground planner retries what this names; it is a refusal, not damage. */
export const planningContention = message => new Error(`contention: ${message}`);
export const emptyPlannerJobs = () => ({ version: 1, mode: 'inactive', wait: null, stop: null, events: [], pending: null, lease: null, operations: [], recoveries: [] });
const valid = result => { if (!result.ok) throw new Error(result.problems.join('; ')); };
const name = value => { if (typeof value !== 'string' || !STABLE_ID_RE.test(value)) throw new Error('a stable lower-case ID is required'); return value; };
const text = value => typeof value === 'string' && !!value.trim();
const read = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const actorCheck = actor => {
  name(actor?.run_id);
  if (Object.keys(actor).some(key => !['run_id', 'role'].includes(key))) throw new Error('run ownership takes only run_id and role');
  if (!['foreground-plan', 'plan', 'step', 'review'].includes(actor.role)) throw new Error('an explicit active role is required');
};
function owner(state, actor, roles, now = Date.now()) {
  actorCheck(actor);
  if (!roles.includes(actor.role) || !isDeepStrictEqual(state.active_run, actor)) throw new Error('active run/role ownership required');
  if (state.schema === 'mc-programme-state' && state.planner_jobs?.lease) {
    const lease = state.planner_jobs.lease;
    if (!isDeepStrictEqual(lease.actor, actor) || !Number.isSafeInteger(lease.expires_at)) throw new Error('invalid planner lease ownership');
    if (lease.expires_at <= now) throw new Error('planner lease expired; reconcile before writing');
  }
}
function expected(state, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision !== (state?.revision ?? 0)) throw planningContention('stale state revision — read the current state');
}
function checkState(state, schema) {
  if (state?.schema === schema && (state.version === 1 || ['approved', 'draft', 'programme_revision'].some(key => key in state)
    || (state.contract?.programme && typeof state.contract.programme === 'object' && 'revision' in state.contract.programme))) {
    throw new Error(`unsupported pre-ruling-60 format: ${schema}; preserve the existing files; automatic migration is not supported`);
  }
  if (!state || state.schema !== schema || state.version !== GOAL_STATE_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error(`invalid ${schema} state`);
  return state;
}
export function autonomousPaths(root, programme, project) {
  const dir = join(root, PROGRAMS_HOME, name(programme));
  return { dir, id: programme, projectId: project, programme: join(dir, PROGRAMME_STATE_FILE), ...(project ? {
    projectDir: join(dir, name(project)), project: join(dir, project, AUTONOMOUS_STATE_FILE), draft: join(dir, project, 'DRAFT.json'),
  } : {}) };
}
function locked(root, programme, project, fn, deps) {
  const paths = autonomousPaths(root, programme, project);
  return (deps.planLock || withPlanLock)(paths.dir, () => {
    const run = () => (deps.lock || ((where, operation) => realLock(where, operation, { strict: true })))(root, () => fn(paths));
    return project ? (deps.planLock || withPlanLock)(paths.projectDir, run) : run();
  });
}
function save(file, previous, next, deps) {
  next.revision = (previous?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(next.revision)) throw new Error('state revision exhausted');
  (deps.write || writeJsonAtomic)(file, next);
  return structuredClone(next);
}
function programmeState(paths) {
  const state = checkState(read(paths.programme), 'mc-programme-state');
  valid(validateProgrammeMetadata(state.metadata));
  if (state.metadata.id !== paths.id || state.execution_enabled !== false || !Array.isArray(state.runs)) throw new Error('invalid programme state identity; execution must remain disabled');
  if (state.active_run !== null) actorCheck(state.active_run);
  if (new Set(state.runs.map(run => { actorCheck(run); return run.run_id; })).size !== state.runs.length) throw new Error('duplicate run ID');
  if (state.active_run && !state.runs.some(run => isDeepStrictEqual(run, state.active_run))) throw new Error('active programme run is missing from history');
  const phases = state.phases;
  if (phases !== undefined && (!Array.isArray(phases) || phases.some((item, index) => !Number.isSafeInteger(item?.n) || item.n < 1 || !text(item.name) || !text(item.purpose)
    || (index > 0 && item.n <= phases[index - 1].n) || (item.closed !== null && !text(item.closed?.reference))))) throw new Error('invalid programme phases; preserve state for recovery');
  const autonomy = state.autonomy;
  if (autonomy !== undefined && (typeof autonomy?.enabled !== 'boolean' || (autonomy.stop !== null && !text(autonomy.stop)))) throw new Error('invalid programme autonomy; preserve state for recovery');
  return state;
}
/** Programme phases are ordering; a goal's runtime `phase` is its lifecycle.
 * An undeclared number has no ordering of its own, so goals written before
 * phases existed keep running; only declared, unclosed phases hold later ones. */
export function programmePhaseHold(state, programmePhase) {
  const phases = state.phases || [];
  if (phases.find(item => item.n === programmePhase)?.closed) return `programme phase ${programmePhase} is closed`;
  const earlier = phases.find(item => item.n < programmePhase && !item.closed);
  return earlier ? `programme phase ${earlier.n} is not closed` : null;
}
function assertGoalPhase(state, programmePhase) {
  const phases = state.phases || [];
  const phase = phases.find(item => item.n === programmePhase);
  if (phase?.closed) throw new Error(`programme phase ${programmePhase} is closed; create the goal in an open phase`);
  if (phases.length && !phase) throw new Error(`programme phase ${programmePhase} is not declared; add it with mc programme phase add`);
}
function emptyProgramme(programme) {
  return { schema: 'mc-programme-state', version: GOAL_STATE_VERSION,
    metadata: { id: programme, brief: `docs/project/${programme}/` }, active_run: null, runs: [], execution_enabled: false };
}
/** A foreground operation owns only this locked transaction. It never fabricates
 * a headless reservation or lease; a real headless plan must prove both. */
function planningActor(state, actor, deps) {
  const env = deps.env || process.env;
  const role = env.MC_AUTONOMOUS_ROLE;
  if (role && !['plan', 'foreground-plan'].includes(role)) throw new Error('only planning roles may change goal assignments');
  if (actor || role === 'plan') {
    actorCheck(actor);
    if (actor.role !== 'plan') throw new Error('foreground planning obtains its operation actor internally');
    owner(state, actor, ['plan'], deps.now?.());
    const lease = state.planner_jobs?.lease;
    if (!lease || lease.token !== (deps.token || env.MC_PROGRAMME_LEASE)) throw new Error('active planner lease ownership required');
    if (env.MC_PROGRAMME && env.MC_PROGRAMME !== state.metadata.id) throw new Error('planner target must match the owning programme');
    return actor;
  }
  if (state.active_run || state.planner_jobs?.lease) throw planningContention('the programme already has an active run');
  return { run_id: `foreground-${randomUUID()}`, role: 'foreground-plan' };
}
/** Ordinary verbs share plan's receipt: it commits with the effect, so a replay
 * repairs projections and writes nothing else. No receipt needs a live intent. */
function goalOperationReceipt(agreement, state, intent) {
  if (!intent) return null;
  const receipt = state.operation_receipts?.find(item => item.id === intent.id);
  if (receipt) {
    if (receipt.kind !== intent.kind || receipt.digest !== autonomousOperationDigest(intent)) throw new Error('project effect does not match planner intent');
    return receipt;
  }
  const operation = agreement.planner_jobs?.operations.find(item => item.intent.id === intent.id);
  if (operation?.status !== 'pending' || !isDeepStrictEqual(operation.intent, intent)) throw new Error('persisted planner intent required');
  return null;
}
function recordGoalReceipt(next, state, intent, actor) {
  if (!intent) return;
  next.operation_receipts = [...(state.operation_receipts || []), { id: intent.id, kind: intent.kind, digest: autonomousOperationDigest(intent),
    result: { project: intent.project, revision: state.revision + 1 }, run_id: actor.run_id }];
}
function recordPlanningOperation(next, actor, operation, revision) {
  next.planning_operations = [...(next.planning_operations || []), { actor, operation, expected_revision: revision, goal_revision: next.goal_revision }];
}
function projectState(paths) {
  const state = checkState(read(paths.project), 'mc-autonomous-state');
  valid(validateAutonomousProject(state.contract, { allowEmptyCriteria: !state.plan_sent }));
  valid(validateAutonomousEvidence(state.evidence));
  if (state.contract.project_id !== paths.projectId || state.contract.programme.id !== paths.id
    || state.goal_revision !== state.contract.goal_revision
    || !AUTONOMOUS_PHASES.includes(state.phase) || !Array.isArray(state.contracts) || !Array.isArray(state.attempts)
    || !Array.isArray(state.runs) || !Array.isArray(state.confirmations) || !Array.isArray(state.commits)
    || !state.ownership || typeof state.confirmed !== 'boolean') throw new Error('invalid autonomous state identity or history');
  state.contracts.forEach((contract, index) => {
    valid(validateAutonomousProject(contract, { allowEmptyCriteria: index === 0 }));
    if (index === 0 && contract.goal_revision !== 1) throw new Error('goal history must start at revision 1');
    if (index > 0) {
      const problems = autonomousRevisionProblems(state.contracts[index - 1], contract);
      if (problems.length) throw new Error(problems.join('; '));
      rejectRetiredCriteria(state.contracts.slice(0, index), state.contracts[index - 1], contract);
    }
  });
  if (!isDeepStrictEqual(state.contracts.at(-1), state.contract)) throw new Error('current assignment must match append-only goal history');
  if (state.active_run !== null) actorCheck(state.active_run);
  if (new Set(state.runs.map(run => { actorCheck(run); return run.run_id; })).size !== state.runs.length) throw new Error('duplicate run ID');
  if (state.active_run && !state.runs.some(run => isDeepStrictEqual(run, state.active_run))) throw new Error('active goal run is missing from history');
  goalCompletion(state); // Fail closed on damaged follow-up history.
  return state;
}
function rejectRetiredCriteria(history, current, next) {
  const live = new Set((current?.success_criteria || []).map(item => item.id));
  const retired = new Set(history.flatMap(contract => contract.success_criteria.map(item => item.id)).filter(id => !live.has(id)));
  if (next.success_criteria.some(item => retired.has(item.id))) throw new Error('retired criterion IDs cannot be reused');
}
function assignmentInProgramme(state, project) {
  valid(validateAutonomousProject(project, { programme: state.metadata }));
}
/** Internal durable journal validation for the ordinary goal operations. */
export function planOperationProblems(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return ['planner intent must be an object'];
  const problems = [];
  if (Object.keys(intent).some(key => !['id', 'kind', 'project', 'expected_revision', 'input'].includes(key))) problems.push('unknown planner intent field');
  if (typeof intent.id !== 'string' || !STABLE_ID_RE.test(intent.id) || !PLAN_PROJECT_OPERATIONS.includes(intent.kind)
    || typeof intent.project !== 'string' || !STABLE_ID_RE.test(intent.project)
    || !Number.isSafeInteger(intent.expected_revision) || intent.expected_revision < 1) problems.push('planner intent needs operation, project and expected state revision');
  const input = intent.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [...problems, 'planner input must be an object'];
  if (intent.kind === 'diagnose-project') problems.push(...recoveryDiagnosisProblems(input));
  else if (['revise-project', 'revise-goal'].includes(intent.kind)) problems.push(...validateAutonomousProject(input).problems);
  else if (intent.kind === 'follow-up-goal') return problems;
  else if (intent.kind === 'send-goal') {
    if (Object.keys(input).join(',') !== 'after' || !Array.isArray(input.after)) problems.push('send names the goals it waits for');
  }
  else if (intent.kind === 'dependencies') {
    if (Object.keys(input).join(',') !== 'projects' || !Array.isArray(input.projects)
      || input.projects.some(item => !item || Object.keys(item).sort().join(',') !== 'goal_revision,project'
        || typeof item.project !== 'string' || !STABLE_ID_RE.test(item.project) || item.project === intent.project
        || !Number.isSafeInteger(item.goal_revision) || item.goal_revision < 1)
      || new Set(input.projects.map(item => item.project)).size !== input.projects.length) problems.push('dependencies need distinct programme projects and goal revisions');
  } else if (intent.kind === 'confirm-project') {
    if (Object.keys(input).sort().join(',') !== 'criteria,id,reference' || typeof input.id !== 'string' || !STABLE_ID_RE.test(input.id) || !text(input.reference)
      || !Array.isArray(input.criteria) || input.criteria.some(item => !item || Object.keys(item).sort().join(',') !== 'criterion_id,reference'
        || typeof item.criterion_id !== 'string' || !STABLE_ID_RE.test(item.criterion_id) || !text(item.reference))) problems.push('confirmation needs an ID, decision reference and explicit criterion evidence');
  } else if (Object.keys(input).length) problems.push('this planner operation takes empty input');
  return problems;
}
// DRAFT is a compatibility projection, never a second authority. A crash after
// the state commit is recovered explicitly; readers always use state.contract.
function projectSave(paths, previous, next, deps) {
  const result = save(paths.project, previous, next, deps);
  (deps.writeDraft || writeJsonAtomic)(paths.draft, result.contract);
  return result;
}

/** One locked snapshot, never concatenated session transcripts. Detail is read
 * on demand through these references. Damaged goals are not omitted. */
export function readProgrammePlanSnapshot(root, programme, deps = {}) {
  return locked(root, programme, null, paths => {
    const state = programmeState(paths);
    const goals = readdirSync(paths.dir, { withFileTypes: true }).filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name))
      .sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
        const goalPaths = autonomousPaths(root, programme, item.name);
        if (existsSync(goalPaths.project)) return [{ project: item.name, state: projectState(goalPaths), reference: goalPaths.project }];
        const file = existsSync(join(goalPaths.projectDir, PLAN_FILE)) ? join(goalPaths.projectDir, PLAN_FILE) : goalPaths.draft;
        if (!existsSync(file)) return [];
        const plan = read(file);
        if (plan?.version !== 1 || !Array.isArray(plan.steps)) throw new Error(`unreadable programme goal: ${file}`);
        return [{ project: item.name, legacy: true, plan, register: read(join(goalPaths.projectDir, 'STATE.json')), reference: file }];
      });
    return structuredClone({ state, goals });
  }, deps);
}

function goalOwned(root, programme, state) {
  const claimPath = join(root, 'runner', 'autonomous-builds', programme, `${state.contract.project_id}.claim`);
  const claim = existsSync(claimPath) ? readClaim(claimPath) : null;
  return !!state.active_run || ['running', 'handoff_requested', 'closing', 'publishing', 'reviewing', 'landing'].includes(state.phase)
    || existsSync(claimPath) && (!claim || processAlive(claim.pid));
}
function plannerBoundary(root, programme, state) {
  if (goalOwned(root, programme, state)) {
    throw planningContention('affected runs must close at a safe boundary; preserve the open PR and retry with a fresh revision');
  }
}

/** Runner-backed plan effects. Receipt and authoritative effect commit together;
 * PLAN/DRAFT projections and the programme acknowledgement are replayable. */
export function applyProgrammeProjectOperation(root, programme, intent, { actor, revision, token, ...deps }) {
  return locked(root, programme, intent.project, paths => {
    const agreement = programmeState(paths); expected(agreement, revision);
    const operationActor = planningActor(agreement, actor, { ...deps, token });
    const operation = agreement.planner_jobs?.operations.find(item => item.intent.id === intent.id);
    if (!operation || operation.status !== 'pending' || !isDeepStrictEqual(operation.intent, intent)) throw new Error('persisted planner intent required');
    const state = projectState(paths);
    const digest = autonomousOperationDigest(intent);
    const receipt = state.operation_receipts?.find(item => item.id === intent.id);
    const project = () => {
      (deps.writeDraft || writeJsonAtomic)(paths.draft, state.contract);
      if (state.plan_sent) (deps.writePlan || writeJsonAtomic)(join(paths.projectDir, PLAN_FILE), state.contract);
    };
    if (receipt) {
      if (receipt.kind !== intent.kind || receipt.digest !== digest) throw new Error('project effect does not match planner intent');
      project(); return structuredClone(receipt.result);
    }
    const problems = planOperationProblems(intent);
    if (problems.length) throw new Error(problems.join('; '));
    expected(state, intent.expected_revision);
    plannerBoundary(root, programme, state);
    const next = structuredClone(state);
    if (intent.kind === 'confirm-project') throw new Error('confirmation is obsolete; record follow-up measurements with mc goal criterion evidence');
    if (state.phase === 'landed') throw new Error('delivered scope is immutable; create remaining work as another goal');
    if (intent.kind === 'revise-project') {
      assignmentInProgramme(agreement, intent.input);
      if (intent.input.programme_phase !== state.contract.programme_phase) assertGoalPhase(agreement, intent.input.programme_phase);
      const invalid = autonomousRevisionProblems(state.contract, intent.input);
      if (invalid.length) throw new Error(invalid.join('; '));
      rejectRetiredCriteria(state.contracts, state.contract, intent.input);
      next.contract = intent.input; next.contracts.push(intent.input); next.goal_revision = intent.input.goal_revision;
      next.evidence.confirmation = null; next.current_handoff = null; next.phase = 'plan_pending';
      // Immutable reports, evidence, attempts, commits and old contracts remain.
      for (const field of ['publication', 'review_session', 'review_submission', 'merge_handoff', 'landing', 'continuation', 'session_control', 'dependency_release']) delete next[field];
    } else if (intent.kind === 'send-project') {
      next.plan_sent = true;
    } else if (intent.kind === 'dependencies') {
      const walk = (project, seen = new Set()) => {
        if (project === intent.project) throw new Error('programme dependencies cannot form a cycle');
        if (seen.has(project)) return;
        seen.add(project);
        const dependency = projectState(autonomousPaths(root, programme, project));
        for (const item of dependency.plan_dependencies || []) walk(item.project, seen);
      };
      for (const item of intent.input.projects) {
        const dependency = projectState(autonomousPaths(root, programme, item.project));
        if (dependency.goal_revision !== item.goal_revision) throw new Error('stale dependency goal revision');
        walk(item.project);
      }
      next.plan_dependencies = intent.input.projects; next.phase = 'plan_pending';
      delete next.publication; delete next.merge_handoff; delete next.dependency_release;
    } else if (intent.kind === 'diagnose-project') {
      const recovery = projectRecovery(state);
      if (!isDeepStrictEqual(intent.input.attempt_ids, recovery.attempt_ids)) throw new Error('diagnosis must account for every incomplete attempt');
      if (intent.input.action === 'retry' && (recovery.exception || state.recovery_diagnoses?.some(item => item.approach === intent.input.approach))) throw new Error('recovery exception or repeated unsuccessful approach; retain a precise diagnosis');
      next.recovery_diagnoses = [...(state.recovery_diagnoses || []), { ...intent.input, goal_revision: state.goal_revision, run_id: operationActor.run_id }];
    } else if (intent.kind === 'await-dependencies') {
      if (state.phase !== 'plan_pending' || !state.plan_dependencies?.length || !isDeepStrictEqual(read(join(paths.projectDir, PLAN_FILE)), state.contract)) throw new Error('dependency release needs a sent pending goal and selected dependencies');
      assertProjectRecovery(state);
      next.dependency_release = { goal_revision: state.goal_revision, status: 'waiting', operation: intent.id };
    } else if (intent.kind === 'resume-project') {
      if (state.phase !== 'plan_pending' || !isDeepStrictEqual(read(join(paths.projectDir, PLAN_FILE)), state.contract)) throw new Error('resume needs a sent, pending goal');
      assertProgrammeDispatch(root, programme, state);
      assertProjectRecovery(state);
      next.phase = 'ready';
      delete next.publication; delete next.merge_handoff; delete next.dependency_release;
    }
    next.plan_sent ||= existsSync(join(paths.projectDir, PLAN_FILE));
    next.plan_decisions = [...(state.plan_decisions || []), { intent, run_id: operationActor.run_id,
      previous: Object.fromEntries(['publication', 'review_session', 'merge_handoff', 'landing', 'continuation', 'session_control', 'current_handoff'].filter(key => state[key] !== undefined).map(key => [key, state[key]])) }];
    const result = { project: intent.project, revision: state.revision + 1 };
    next.operation_receipts = [...(state.operation_receipts || []), { id: intent.id, kind: intent.kind, digest, result, run_id: operationActor.run_id }];
    valid(validateAutonomousEvidence(next.evidence));
    const saved = projectSave(paths, state, next, deps);
    if (saved.plan_sent) (deps.writePlan || writeJsonAtomic)(join(paths.projectDir, PLAN_FILE), saved.contract);
    return result;
  }, deps);
}

/** Called under the programme lock by every dispatch admission, not just plan. */
function assertProgrammeDispatch(root, programme, state) {
  const incident = mainIncidentHold(root, programme, state.contract.project_id);
  if (incident) throw new Error(`shared main incident ${incident.id} awaits its owning programme plan`);
  const hold = programmePhaseHold(programmeState(autonomousPaths(root, programme)), state.contract.programme_phase);
  if (hold) throw new Error(`goal waits: ${hold}`);
  for (const item of state.plan_dependencies || []) {
    const dependency = projectState(autonomousPaths(root, programme, item.project));
    if (!reviewedLanding(dependency) || dependency.goal_revision !== item.goal_revision) throw new Error(`dependency ${item.project} awaits verified landing`);
  }
}
export function readProgrammeState(root, programme, deps = {}) {
  return locked(root, programme, null, paths => structuredClone(programmeState(paths)), deps);
}
/** Trusted scheduler transaction, sharing the programme/strict register locks.
 * Returning unchanged data is a read, not a new revision. Never exposed by CLI. */
export function updateProgrammeRegister(root, programme, update, deps = {}) {
  return locked(root, programme, null, paths => {
    const state = programmeState(paths);
    const next = update(structuredClone(state), paths);
    return isDeepStrictEqual(state, next) ? structuredClone(state) : save(paths.programme, state, next, deps);
  }, deps);
}
export function readAutonomousState(root, programme, project, deps = {}) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    return structuredClone(state);
  }, deps);
}

/** Publish an assignment and make an unblocked goal eligible for dispatch. */
export function sendAutonomousProject(root, programme, project, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    const agreement = programmeState(paths);
    const operationActor = planningActor(agreement, actor, deps);
    const file = join(paths.projectDir, PLAN_FILE);
    if (goalOperationReceipt(agreement, state, deps.operation)) {
      (deps.writeDraft || writeJsonAtomic)(paths.draft, state.contract);
      if (state.plan_sent) (deps.writePlan || writeJsonAtomic)(file, state.contract);
      return structuredClone(state.contract);
    }
    expected(state, revision);
    plannerBoundary(root, programme, state);
    assignmentInProgramme(agreement, state.contract);
    // A send without --after keeps the selected goals, pinned to their current revisions.
    const after = deps.after?.length ? deps.after : (state.plan_dependencies || []).map(item => item.project);
    if (!Array.isArray(after) || after.some(item => typeof item !== 'string' || !STABLE_ID_RE.test(item))) throw new Error('dependencies must be goal names');
    if (new Set(after).size !== after.length) throw new Error('duplicate goal dependency');
    if (after.includes(project)) throw new Error('a goal cannot depend on itself');
    const walk = (candidate, visited = new Set()) => {
      if (candidate === project) throw new Error('goal dependencies cannot form a cycle');
      if (visited.has(candidate)) return;
      visited.add(candidate);
      const dependencyPaths = autonomousPaths(root, programme, candidate);
      if (!existsSync(dependencyPaths.project)) throw new Error(`unknown goal dependency: ${candidate}`);
      const dependency = projectState(dependencyPaths);
      for (const item of dependency.plan_dependencies || []) walk(item.project, visited);
    };
    for (const candidate of after) walk(candidate);
    const dependencies = after.map(item => ({ project: item, goal_revision: projectState(autonomousPaths(root, programme, item)).goal_revision }));
    if (existsSync(file) && !isDeepStrictEqual(read(file), state.contract)) throw new Error('a different PLAN.json already exists');
    if (state.plan_sent && existsSync(file)) {
      const sent = (state.planning_operations || []).filter(item => item.operation === 'send').at(-1)?.goal_revision;
      if ((state.phase !== 'plan_pending' || sent === state.goal_revision)
        && !isDeepStrictEqual(state.plan_dependencies || [], dependencies)) throw new Error('sent goal dependencies are immutable; revise the goal before changing them');
      if (state.phase !== 'plan_pending') {
        if (!deps.operation) return structuredClone(state.contract);
        // Nothing to send, and the journal still gets its receipt.
        const settled = structuredClone(state); recordGoalReceipt(settled, state, deps.operation, operationActor);
        return save(paths.project, state, settled, deps).contract;
      }
    }
    const next = structuredClone(state);
    next.plan_sent = true;
    if (dependencies.length || state.plan_dependencies) next.plan_dependencies = dependencies;
    if (state.phase === 'plan_pending') {
      assertProjectRecovery(state);
      const waiting = dependencies.some(item => {
        const dependency = projectState(autonomousPaths(root, programme, item.project));
        return !reviewedLanding(dependency) || dependency.goal_revision !== item.goal_revision;
      });
      if (waiting) {
        next.dependency_release = { goal_revision: state.goal_revision, status: 'waiting', operation: `goal-send-${state.goal_revision}` };
      } else {
        next.phase = 'ready';
        delete next.dependency_release;
      }
    }
    recordPlanningOperation(next, operationActor, 'send', revision);
    recordGoalReceipt(next, state, deps.operation, operationActor);
    const saved = projectSave(paths, state, next, deps);
    (deps.writePlan || writeJsonAtomic)(file, saved.contract);
    return structuredClone(saved.contract);
  }, deps);
}

/** Trusted control-plane seam: reserve an owner, not a command or a launch. */
export function reserveProgrammeRun(root, programme, actor, revision, deps = {}) {
  actorCheck(actor);
  if (!['foreground-plan', 'plan'].includes(actor.role)) throw new Error('only plan owns a programme run');
  return locked(root, programme, null, paths => {
    const before = read(paths.programme);
    if (before) programmeState(paths);
    expected(before, revision);
    if (before?.active_run) throw new Error('the programme already has an active run');
    if (before?.runs.some(run => run.run_id === actor.run_id)) throw new Error('run ID already used');
    return save(paths.programme, before, { ...(before || emptyProgramme(programme)),
      active_run: actor, runs: [...(before?.runs || []), actor], execution_enabled: false }, deps);
  }, deps);
}
/** Release checks the same owner and revision as every other mutation. */
export function releaseProgrammeRun(root, programme, actor, revision, deps = {}) {
  return locked(root, programme, null, paths => {
    const state = programmeState(paths); expected(state, revision); owner(state, actor, ['foreground-plan', 'plan']);
    if (state.planner_jobs?.lease) throw new Error('finish the planner job before releasing its reservation');
    return save(paths.programme, state, { ...state, active_run: null }, deps);
  }, deps);
}
function addPhase(state, input) {
  const phases = state.phases || [];
  if (Object.keys(input).sort().join(',') !== 'n,name,purpose' || !Number.isSafeInteger(input.n) || input.n < 1 || !text(input.name) || !text(input.purpose)) throw new Error('a phase needs a positive number, a name and a purpose');
  if (phases.some(item => item.n === input.n)) throw new Error(`programme phase ${input.n} already exists`);
  if (phases.some(item => item.closed && item.n > input.n)) throw new Error('a new phase cannot precede a closed phase');
  return [...phases, { ...input, closed: null }].sort((a, b) => a.n - b.n);
}
/** Explicit, never automatic: an empty phase holds later ones until closed. */
function closePhase(root, programme, paths, state, input, actor, deps) {
  const phases = state.phases || [];
  const phase = phases.find(item => item.n === input.n);
  if (!phase) throw new Error(`programme phase ${input.n} is not declared`);
  if (!text(input.reference)) throw new Error('closing a phase needs a completion reference');
  const earlier = phases.find(item => item.n < input.n && !item.closed);
  if (earlier) throw new Error(`close programme phase ${earlier.n} first`);
  const goals = readdirSync(paths.dir, { withFileTypes: true }).filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name))
    .map(item => autonomousPaths(root, programme, item.name)).filter(goal => existsSync(goal.project)).map(projectState);
  for (const goal of goals.filter(item => item.contract.programme_phase === input.n)) {
    const name = goal.contract.project_id;
    if (goalOwned(root, programme, goal)) throw new Error(`phase goal ${name} is still owned`);
    const completion = goalCompletion(goal);
    if (!completion.done) throw new Error(`phase goal ${name} has not landed`);
    if (completion.pending_follow_ups.length) throw new Error(`phase goal ${name} has unmeasured follow-ups: ${completion.pending_follow_ups.join(', ')}`);
  }
  const closed = { reference: input.reference, run_id: actor.run_id, role: actor.role, at: new Date(deps.now?.() ?? Date.now()).toISOString() };
  return phases.map(item => item.n === input.n ? { ...item, closed } : item);
}
/** Programme effect and receipt fit in one write, so no crash separates them. */
function programmeReceipt(next, operation) {
  if (!operation) return next;
  const journal = next.planner_jobs ?? emptyPlannerJobs();
  const record = { intent: operation, status: 'applied', result: { programme: next.metadata.id, revision: (next.revision ?? 0) + 1 } };
  return { ...next, planner_jobs: { ...journal, operations: [...journal.operations, record] } };
}
/** Minimal programme context, without draft/approval or launch authority. */
export function mutateProgramme(root, programme, operation, input, { actor, revision, ...deps }) {
  return locked(root, programme, null, paths => {
    const previous = existsSync(paths.programme) ? programmeState(paths) : null;
    const applied = deps.operation && previous?.planner_jobs?.operations.find(item => item.intent.id === deps.operation.id);
    if (applied) {
      planningActor(previous, actor, deps);
      if (!isDeepStrictEqual(applied.intent, deps.operation)) throw new Error('planner operation ID already used with different content');
      return structuredClone(previous);
    }
    if (operation === 'phase-close') {
      const closed = previous?.phases?.find(item => item.n === input.n)?.closed;
      if (closed && closed.reference !== input.reference) throw new Error(`programme phase ${input.n} is already closed with another reference`);
      if (closed) return structuredClone(previous);
    }
    expected(previous, revision);
    const state = previous || emptyProgramme(programme);
    const operationActor = planningActor(state, actor, deps);
    if (operation === 'phase-add') return save(paths.programme, previous, programmeReceipt({ ...state, phases: addPhase(state, input) }, deps.operation), deps);
    if (operation === 'phase-close') return save(paths.programme, previous, programmeReceipt({ ...state, phases: closePhase(root, programme, paths, state, input, operationActor, deps) }, deps.operation), deps);
    if (operation !== 'metadata') throw new Error('unsupported programme operation; draft/approve are not goal assignment authority');
    valid(validateProgrammeMetadata(input));
    if (input.id !== programme) throw new Error('programme identity cannot change');
    const next = { ...state, metadata: input, metadata_history: [...(state.metadata_history || []), { metadata: input, actor: operationActor }] };
    return save(paths.programme, previous, programmeReceipt(next, deps.operation), deps);
  }, deps);
}
// Object key ordering is not operation identity; array order remains significant.
export function autonomousOperationDigest(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function createAutonomousDraft(root, programme, project, input, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = programmeState(paths); expected(state, revision);
    const operationActor = planningActor(state, actor, deps);
    // The receipt commits with the effect, not with its later programme journal
    // acknowledgement. A restarted planner can read it without creating twice.
    const receipt = deps.operationId ? { id: name(deps.operationId), kind: deps.operationKind || 'create-project',
      digest: autonomousOperationDigest(input) } : null;
    if (receipt && existsSync(paths.project)) {
      const current = projectState(paths);
      const previous = current.operation_receipts?.find(item => item.id === receipt.id);
      const { run_id: ignoredCreator, ...identity } = previous || {};
      if (!previous && receipt.kind === 'new-goal') throw new Error('project already exists');
      if (!previous || !isDeepStrictEqual(identity, receipt)) throw new Error('project effect does not match operation intent');
      (deps.writeDraft || writeJsonAtomic)(paths.draft, current.contract);
      return structuredClone(current);
    }
    if (receipt && !state.planner_jobs?.operations.some(item => item.intent.id === receipt.id && item.status === 'pending')) throw new Error('persisted planner intent required');
    valid(validateAutonomousProject(input, { programme: state.metadata, allowEmptyCriteria: true }));
    assertGoalPhase(state, input.programme_phase);
    if (input.project_id !== project || input.programme.id !== programme || input.goal_revision !== 1) throw new Error('new draft needs matching identity and goal revision 1');
    if (existsSync(paths.project)) projectState(paths); // diagnose old format without overwriting it
    if ([PLAN_FILE, 'DRAFT.json', 'STATE.json', AUTONOMOUS_STATE_FILE].some(file => existsSync(join(paths.projectDir, file)))) throw new Error('project already exists');
    if (deps.mainIncident) reserveMainRepairLocked(root, { incident: deps.mainIncident, programme, project, operation: deps.operationId, repo: input.repo });
    return projectSave(paths, null, {
      schema: 'mc-autonomous-state', version: GOAL_STATE_VERSION, contract: input, contracts: [input], active_run: null,
      phase: 'plan_pending', goal_revision: 1,
      ownership: { branch: null, pr: null }, commits: [], current_handoff: null,
      attempts: [], runs: [], follow_up_observations: [], evidence: { builder: [], reviews: [], confirmation: null }, confirmations: [], confirmed: false,
      planning_operations: [{ actor: operationActor, operation: 'create', expected_revision: revision, goal_revision: 1 }],
      ...(receipt ? { operation_receipts: [{ ...receipt, run_id: operationActor.run_id }] } : {}),
    }, deps);
  }, deps);
}
/** Trusted runner seam; this launches nothing. */
export function reserveProjectRun(root, programme, project, actor, revision, deps = {}) {
  actorCheck(actor);
  if (!['plan', 'step', 'review'].includes(actor.role)) throw new Error('project runs belong to plan, step or review');
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    if (actor.role === 'plan') {
      const agreement = programmeState(paths);
      if (agreement.planner_jobs) owner(agreement, actor, ['plan'], deps.now?.());
    }
    if (state.active_run) throw new Error('the project already has an active run');
    if (state.runs.some(run => run.run_id === actor.run_id)) throw new Error('run ID already used');
    return save(paths.project, state, { ...state, active_run: actor, runs: [...state.runs, actor] }, deps);
  }, deps);
}
export function mutateAutonomousProject(root, programme, project, operation, input, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    if (!deps.operation) expected(state, revision);
    if (operation === 'confirm') throw new Error('confirmation is obsolete; record follow-up measurements with mc goal criterion evidence');
    const planning = ['revise', 'recover', 'follow-up'].includes(operation);
    const operationActor = planning ? planningActor(programmeState(paths), actor, deps) : actor;
    if (planning && goalOperationReceipt(programmeState(paths), state, deps.operation)) {
      (deps.writeDraft || writeJsonAtomic)(paths.draft, state.contract);
      if (state.plan_sent) (deps.writePlan || writeJsonAtomic)(join(paths.projectDir, PLAN_FILE), state.contract);
      return structuredClone(state);
    }
    if (deps.operation) expected(state, revision);
    if (planning) plannerBoundary(root, programme, state);
    const roles = { progress: ['step'], report: ['review'], attempt: ['step', 'review', 'plan'], release: ['step', 'review', 'plan'] };
    if (!planning) owner(state, actor, roles[operation] || []);
    if (state.review_session?.run_id === operationActor.run_id && operation !== 'report') throw new Error('independent review may only submit its report');
    if (operation === 'progress' && state.session_control) ownedControl(state, actor);
    const next = structuredClone(state);
    if (!planning && actor.role === 'plan') {
      const agreement = programmeState(paths);
      // Preserve pre-outbox reservation/release behavior. Once jobs are in use,
      // every planner write is fenced, including attempts and releases.
      if (agreement.planner_jobs) owner(agreement, actor, ['plan'], deps.now?.());
    }
    if (operation === 'recover') {
      (deps.writeDraft || writeJsonAtomic)(paths.draft, state.contract);
      if (state.plan_sent || existsSync(join(paths.projectDir, PLAN_FILE))) (deps.writePlan || writeJsonAtomic)(join(paths.projectDir, PLAN_FILE), state.contract);
      return structuredClone(state);
    }
    if (state.phase === 'landed' && !['follow-up', 'release'].includes(operation)) throw new Error('delivered scope is immutable; create another goal');
    if (operation === 'follow-up') {
      const landing = reviewedLanding(state);
      if (!landing) throw new Error('follow-up measurements require verified landing of the current reviewed goal');
      const record = { ...input, run_id: operationActor.run_id, project_id: project, programme_id: programme };
      const problems = followUpObservationProblems(record);
      if (problems.length) throw new Error(problems.join('; '));
      if (record.goal_revision !== state.goal_revision || record.integrated_sha !== landing.merge_commit) throw new Error('stale follow-up measurement: goal revision and integrated SHA must match the landing');
      if (!state.contract.success_criteria.some(item => item.id === record.criterion_id && item.verification === 'after-integration')) throw new Error('follow-up measurement needs an after-integration criterion');
      const previous = state.follow_up_observations?.find(item => item.id === record.id);
      if (previous) {
        if (!isDeepStrictEqual(previous, record)) throw new Error('follow-up observation is immutable');
        return structuredClone(state);
      }
      next.follow_up_observations = [...(state.follow_up_observations || []), record];
      recordGoalReceipt(next, state, deps.operation, operationActor);
    } else if (operation === 'revise') {
      assignmentInProgramme(programmeState(paths), input);
      if (input.programme_phase !== state.contract.programme_phase) assertGoalPhase(programmeState(paths), input.programme_phase);
      const problems = autonomousRevisionProblems(state.contract, input);
      if (problems.length) throw new Error(problems.join('; '));
      rejectRetiredCriteria(state.contracts, state.contract, input);
      next.contract = input; next.contracts.push(input); next.goal_revision = input.goal_revision;
      next.confirmed = false;
      next.evidence.confirmation = null; next.current_handoff = null; next.phase = 'plan_pending';
      for (const field of ['publication', 'review_session', 'review_submission', 'merge_handoff', 'landing', 'continuation', 'session_control', 'dependency_release']) delete next[field];
      recordPlanningOperation(next, operationActor, 'revise', revision);
      recordGoalReceipt(next, state, deps.operation, operationActor);
    } else if (operation === 'progress' || operation === 'report') {
      const record = { ...input, run_id: actor.run_id, project_id: project, programme_id: programme,
        goal_revision: state.goal_revision };
      const records = [...state.evidence.builder, ...state.evidence.reviews, ...state.confirmations];
      if (records.some(item => item.id === record.id)) throw new Error('evidence ID already used');
      const ids = new Set(state.contract.success_criteria.map(item => item.id));
      if (operation === 'progress') {
        if (!ids.has(record.criterion_id)) throw new Error('unknown criterion ID');
        next.evidence.builder.push(record);
      } else if (operation === 'report') {
        if (state.review_session) {
          if (state.review_session.run_id !== actor.run_id || state.phase !== 'reviewing') throw new Error('active independent review session required');
          const problems = reviewInputProblems(input, state.review_session.assignment);
          if (problems.length) throw new Error(problems.join('; '));
          if (state.review_submission) throw new Error('review submission is immutable');
          next.review_submission = structuredClone(input);
          return save(paths.project, state, next, deps);
        }
        if (!Array.isArray(record.criteria) || record.criteria.length !== ids.size || new Set(record.criteria.map(item => item.criterion_id)).size !== ids.size) throw new Error('review must cover every criterion exactly once');
        if (record.criteria?.some(item => !ids.has(item.criterion_id))) throw new Error('unknown criterion ID');
        next.evidence.reviews.push(record);
      }
      valid(validateAutonomousEvidence(next.evidence));
    } else if (operation === 'attempt') {
      // This is an incomplete attempt, never a green handoff or launch permit.
      name(input.id);
      if (state.attempts.some(item => item.id === input.id)) throw new Error('attempt ID already used');
      if (Object.keys(input).some(key => !['id', 'reason', 'commits', 'branch', 'pr', 'handoff'].includes(key))) throw new Error('unknown attempt field');
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('attempt needs a reason');
      if (!Array.isArray(input.commits) || !input.commits.every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha))) throw new Error('attempt commits must be full SHAs');
      if (actor.role === 'review' && (input.commits.length || input.branch !== undefined || input.pr !== undefined || input.handoff !== undefined)) throw new Error('review records failures only, not implementation or publication');
      if (input.branch !== undefined && (typeof input.branch !== 'string' || !input.branch.trim())) throw new Error('branch must be nonempty');
      if (input.pr !== undefined && (!Number.isSafeInteger(input.pr) || input.pr < 1)) throw new Error('PR must be a positive integer');
      for (const key of ['branch', 'pr']) {
        if (input[key] !== undefined && state.ownership[key] !== null && state.ownership[key] !== input[key]) throw new Error('branch/PR ownership cannot change');
        if (input[key] !== undefined) next.ownership[key] = input[key];
      }
      if (input.handoff !== undefined && (typeof input.handoff !== 'string' || !input.handoff.trim())) throw new Error('handoff must be a reference');
      next.commits = [...new Set([...state.commits, ...input.commits])];
      next.current_handoff = input.handoff || null;
      next.attempts.push({ ...input, run_id: actor.run_id, role: actor.role, goal_revision: state.goal_revision, outcome: 'incomplete', progress: recoveryProgress(state) });
      next.phase = 'plan_pending'; next.confirmed = false; next.evidence.confirmation = null; delete next.dependency_release;
    } else if (operation === 'release') next.active_run = null;
    else throw new Error('unknown autonomous project operation');
    if (operation === 'revise') {
      next.plan_sent ||= existsSync(join(paths.projectDir, PLAN_FILE));
      const saved = projectSave(paths, state, next, deps);
      if (saved.plan_sent) (deps.writePlan || writeJsonAtomic)(join(paths.projectDir, PLAN_FILE), saved.contract);
      return saved;
    }
    return save(paths.project, state, next, deps);
  }, deps);
}
export function currentAutonomousEvidence(state) {
  return evidenceForRevision(state.contract, state.evidence);
}

/** Runner-only continuation door, after publication and worker reconciliation.
 * Builder reports route work, never confirm a goal or authorize review/merge. */
export function settleAutonomousBuild(root, programme, project, { actor, revision, handoff, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision); ownedControl(state, actor);
    if (state.phase !== 'publishing' || state.publication?.run_id !== actor.run_id
      || state.publication.goal_revision !== state.goal_revision
      || state.publication.phase !== 'handoff_committed' || state.current_handoff !== handoff.artifact
      || !handoff.observed.normal_exit || handoff.observed.head !== state.publication.head
      || handoff.handoff.run_id !== actor.run_id || handoff.handoff.goal_revision !== state.goal_revision
      || !['continue', 'review-ready'].includes(handoff.outcome)) throw new Error('settled normal publication required');
    const latest = new Map(currentAutonomousEvidence(state).builder.map(item => [item.criterion_id, item]));
    const reported = new Map(handoff.handoff.evidence.map(item => [item.criterion_id, item]));
    for (const item of reported.values()) {
      const proof = latest.get(item.criterion_id);
      if (proof?.status !== 'verified' || proof.reference !== item.reference) throw new Error('published criterion reports changed before continuation');
    }
    const done = state.contract.success_criteria.filter(item => item.verification === 'premerge').every(item => {
      const proof = latest.get(item.id);
      return proof?.status === 'verified' && reported.get(item.id)?.reference === proof.reference;
    });
    if (handoff.outcome === 'review-ready' && !done) throw new Error('review-ready requires all current premerge reports');
    const phase = done ? 'review_ready' : 'ready';
    return save(paths.project, state, { ...state, phase, active_run: null,
      continuation: { run_id: actor.run_id, goal_revision: state.goal_revision,
        handoff: handoff.artifact, phase } }, deps);
  }, deps);
}

export const PUBLICATION_PHASES = Object.freeze(['started', 'gate_verified', 'committed', 'pushed', 'pr_resolved', 'handoff_committed']);

/** Trusted publication seam, not a model-supplied state patch. The owner is
 * retained through handoff; only the later reconciliation door can release it. */
export function saveAutonomousPublication(root, programme, project, { actor, revision, publication, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    const control = ownedControl(state, actor);
    if (control.phase !== 'closing' || !['running', 'closing', 'publishing'].includes(state.phase)) throw new Error('finish requires closing control');
    if (publication.run_id !== actor.run_id || publication.goal_revision !== state.goal_revision) throw new Error('publication assignment changed');
    const previous = state.publication?.run_id === actor.run_id ? state.publication : null;
    const index = PUBLICATION_PHASES.indexOf(publication.phase);
    const before = previous ? PUBLICATION_PHASES.indexOf(previous.phase) : -1;
    if (index < 0 || index < before || index > before + 1) throw new Error('invalid publication phase');
    if (previous && (!isDeepStrictEqual(previous.input, publication.input)
      || previous.branch !== publication.branch || previous.goal_revision !== publication.goal_revision)) throw new Error('publication intent cannot change');
    if (publication.branch !== state.ownership.branch || (state.ownership.pr !== null && publication.pr != null
      && publication.pr !== state.ownership.pr)) throw new Error('branch/PR ownership cannot change');
    const next = { ...state, phase: 'publishing', publication,
      ownership: { ...state.ownership, pr: publication.pr ?? state.ownership.pr } };
    if (publication.head) next.commits = [...new Set([...state.commits, publication.head])];
    if (publication.phase === 'handoff_committed') next.current_handoff = publication.handoff;
    return save(paths.project, state, next, deps);
  }, deps);
}

// Trusted runner seams. No CLI operation accepts profiles, clocks or
// measured progress. Keep control and project ownership in one atomic record.
function controlBinding(state, actor) {
  return { programme_id: state.contract.programme.id,
    project_id: state.contract.project_id, goal_revision: state.goal_revision, run_id: actor.run_id };
}
function controlObservation(state, observation) {
  if (observation.progress?.criterion_id && !state.contract.success_criteria.some(item => item.id === observation.progress.criterion_id)) throw new Error('unknown measured criterion ID');
  return observation;
}
function ownedControl(state, actor) {
  owner(state, actor, ['step']);
  if (!state.session_control || !isDeepStrictEqual(state.session_control.binding, controlBinding(state, actor))) throw new Error('no control for this run/revision');
  return validateControlState(state.session_control);
}
export function startProjectSessionControl(root, programme, project, { actor, revision, profile, observation, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision); owner(state, actor, ['step']);
    const session_control = createSessionControl({ binding: controlBinding(state, actor), profile, observation: controlObservation(state, observation), previous: state.session_control || null });
    return save(paths.project, state, { ...state, session_control }, deps);
  }, deps);
}
export function observeProjectSessionControl(root, programme, project, { actor, revision, observation, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    const criteria = state.contract.success_criteria.filter(item => item.verification === 'premerge').map(item => item.id);
    const session_control = decideSessionControl(ownedControl(state, actor), controlObservation(state, observation), { criteria });
    return save(paths.project, state, { ...state, session_control }, deps);
  }, deps);
}
export function interruptProjectSessionControl(root, programme, project, { actor, revision, reason, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    const session_control = interruptSessionControl(ownedControl(state, actor), reason);
    return save(paths.project, state, { ...state, session_control }, deps);
  }, deps);
}
export function projectSessionCheckpoint(root, programme, project, operation, input, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    let state = projectState(paths); expected(state, revision);
    const control = ownedControl(state, actor);
    if (!['status', 'checkpoint', 'criterion'].includes(operation)) throw new Error('unknown control callback');
    const allowed = operation === 'criterion' ? ['reference', 'criterion_id'] : operation === 'checkpoint' ? ['reference'] : [];
    if (!input || Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('callback cannot supply observations or budgets');
    if (allowed.length && (typeof input.reference !== 'string' || !input.reference.trim() || Buffer.byteLength(input.reference) > 2048)) throw new Error('checkpoint reference required');
    if (operation === 'criterion' && !state.contract.success_criteria.some(item => item.id === input.criterion_id)) throw new Error('unknown criterion ID');
    if (operation !== 'status') {
      // A callback is a request for measurement, not measured progress itself.
      const session_control = { ...control, request: { operation, ...input, observation_sequence: control.observation.sequence } };
      state = save(paths.project, state, { ...state, session_control }, deps);
    }
    return { ...controlResponse(state.session_control), revision: state.revision };
  }, deps);
}

/** Runner-only admission. Reservation, branch binding and fresh control commit
 * together before git or a worker can mutate the checkout. No CLI calls this. */
export function startAutonomousBuild(root, programme, project, { actor, revision, assignment, branch, profile, observation, model, reviewer, ...deps }) {
  actorCheck(actor);
  if (actor.role !== 'step') throw new Error('autonomous builds use the step role');
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    if (state.active_run || state.phase !== 'ready') throw new Error('project is not ready or already has an owner');
    assertProgrammeDispatch(root, programme, state);
    if (!isDeepStrictEqual(state.contract, assignment) || !isDeepStrictEqual(read(join(paths.projectDir, PLAN_FILE)), assignment)) throw new Error('assignment changed or is not sent');
    assignmentInProgramme(programmeState(paths), assignment);
    if (state.runs.some(run => run.run_id === actor.run_id)) throw new Error('run ID already used');
    if (typeof branch !== 'string' || !branch.trim() || ['main', 'master'].includes(branch)
      || (state.ownership.branch !== null && state.ownership.branch !== branch)) throw new Error('branch ownership cannot change');
    autonomousModelIdentity(model); autonomousModelIdentity(reviewer);
    if (state.reviewer_model && !isDeepStrictEqual(state.reviewer_model, reviewer)) throw new Error('reviewer reservation cannot change');
    if (!independentModel(reviewer, [model])) throw new Error('reviewer model is reserved from builders');
    const session_control = createSessionControl({ binding: controlBinding(state, actor), profile, observation,
      previous: state.session_control || null });
    return save(paths.project, state, { ...state, phase: 'running', active_run: actor,
      reviewer_model: reviewer, model_history: [...(state.model_history || []), { run_id: actor.run_id, model, goal_revision: state.goal_revision }],
      runs: [...state.runs, actor], ownership: { ...state.ownership, branch }, session_control }, deps);
  }, deps);
}

/** Trusted review reservation: fixed assignment, publication, base and model. */
export function startAutonomousReview(root, programme, project, { actor, revision, session, ...deps }) {
  actorCheck(actor);
  if (actor.role !== 'review') throw new Error('review role required');
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    if (state.active_run || state.phase !== 'review_ready') throw new Error('project is not review ready');
    assertProgrammeDispatch(root, programme, state);
    if (state.runs.some(run => run.run_id === actor.run_id)) throw new Error('run ID already used');
    assignmentInProgramme(programmeState(paths), state.contract);
    if (!isDeepStrictEqual(state.contract, read(join(paths.projectDir, PLAN_FILE)))
      || !isDeepStrictEqual(session.assignment, state.contract)) throw new Error('review assignment changed');
    if (session.assignment_digest !== reviewDigest(state.contract)
      || session.criteria_digest !== reviewDigest(state.contract.success_criteria)) throw new Error('review revision binding changed');
    if (session.run_id !== actor.run_id || session.head !== state.publication?.head
      || state.publication?.goal_revision !== state.goal_revision
      || state.publication.phase !== 'handoff_committed' || session.pr !== state.ownership.pr
      || session.branch !== state.ownership.branch || !session.base || !session.checkout) throw new Error('review requires settled published head and comparison base');
    if (!isDeepStrictEqual(session.model, state.reviewer_model) || !independentModel(session.model, builderModels(state))) throw new Error('review model must be independent of all historical builders');
    return save(paths.project, state, { ...state, phase: 'reviewing', active_run: actor,
      runs: [...state.runs, actor], review_session: session, review_submission: null }, deps);
  }, deps);
}

/** Persist the complete immutable result for plan. No build job or merge is created. */
export function recordAutonomousReview(root, programme, project, { actor, revision, report, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    const previous = (state.review_reports || []).find(item => item.id === report.id);
    if (previous) {
      const { reference: ignored, ...stored } = previous;
      if (!isDeepStrictEqual(stored, report)) throw new Error('review report is immutable');
      return structuredClone(state);
    }
    expected(state, revision); owner(state, actor, ['review']);
    const session = state.review_session;
    if (!session || session.run_id !== actor.run_id || !['reviewing', 'plan_pending'].includes(state.phase) || report.id !== actor.run_id || report.session_digest !== reviewDigest(session)
      || !isDeepStrictEqual(report.session, session)) throw new Error('review session binding changed');
    if (report.schema !== 'mc-autonomous-review-report' || report.version !== 1
      || !Array.isArray(report.invalid_reasons) || !report.invalid_reasons.every(item => typeof item === 'string' && item.trim())
      || report.clean !== (!report.invalid_reasons.length && cleanReviewInput(report.result, session.assignment))) throw new Error('invalid review verdict');
    const problems = reviewInputProblems(report.result, session.assignment);
    if (problems.length) throw new Error(problems.join('; '));
    const reference = `${paths.project}#review_reports/${report.id}`;
    const observation = { id: report.id, run_id: actor.run_id, project_id: project, programme_id: programme,
      goal_revision: session.assignment.goal_revision,
      reference, findings: [...report.result.defects, ...report.invalid_reasons, ...report.result.uncertainty,
        ...report.result.criteria.flatMap(item => item.uncertainty.map(text => `${item.criterion_id}: ${text}`))],
      criteria: report.result.criteria.map(item => ({ criterion_id: item.criterion_id, status: item.status, reference: item.evidence.join('\n') })) };
    const next = { ...state, phase: 'plan_pending', active_run: null,
      plan_events: [...(state.plan_events || []), { id: `review-${reviewDigest(report)}`, type: 'review-reported',
        report_id: report.id, reference, goal_revision: session.assignment.goal_revision,
        clean: report.clean }],
      review_reports: [...(state.review_reports || []), { ...report, reference }],
      evidence: { ...state.evidence, reviews: [...state.evidence.reviews, observation] } };
    valid(validateAutonomousEvidence(next.evidence));
    return save(paths.project, state, next, deps);
  }, deps);
}

/** Trusted recovery observation, not a review command or ownership release.
 * An unknown old process remains owned, but its failure is delivered to plan. */
export function incompleteAutonomousReview(root, programme, project, { actor, revision, reason, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision); owner(state, actor, ['review']);
    if (state.attempts.some(item => item.id === actor.run_id)) return structuredClone(state);
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('review recovery needs a reason');
    const binding = state.review_session?.assignment || state.contract;
    return save(paths.project, state, { ...state, phase: 'plan_pending', confirmed: false,
      evidence: { ...state.evidence, confirmation: null },
      attempts: [...state.attempts, { id: actor.run_id, run_id: actor.run_id, role: 'review', reason, commits: [],
        goal_revision: binding.goal_revision,
        outcome: 'incomplete', progress: recoveryProgress(state) }] }, deps);
  }, deps);
}

/** Trusted outcome writer. Events precede queue cleanup; replay never requests
 * another merge, resurrects an answered handoff or rewrites a later assignment. */
export function recordAutonomousMergeEvent(root, programme, project, { binding, type, details = {}, ticket = null, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    if (!['merge-queued', 'merge-refused', 'merge-failed', 'merge-unknown', 'merge-landed'].includes(type)) throw new Error('unknown autonomous merge event');
    const report = state.review_reports?.find(item => item.id === binding.report_id);
    const bound = !!report && reviewDigest(report) === binding.report_digest
      && report.session.head === binding.head && report.session.assignment.goal_revision === binding.goal_revision
      && report.session.branch === binding.branch && report.session.pr === binding.pr;
    if (state.ownership.pr !== binding.pr || state.ownership.branch !== binding.branch
      || (!bound && ['merge-queued', 'merge-landed'].includes(type))) throw new Error('merge event report/ownership binding changed');
    if (type === 'merge-landed') {
      if (!report?.clean || !cleanReviewInput(report.result, report.session.assignment) || report.invalid_reasons?.length !== 0
        || details.merged_into !== 'main' || !/^[a-f0-9]{40}$/u.test(details.merge_commit || '')) throw new Error('landing requires a clean independent review and verified main commit');
      details = { merge_commit: details.merge_commit, merged_into: 'main' };
    }
    // Missing/damaged evidence can carry a refusal to plan, never permission
    // to queue or attribute a successful landing to that evidence.
    const event = { id: `${type}-${reviewDigest({ binding, details })}`, type, binding, binding_verified: bound, details };
    const previous = state.plan_events || [];
    if (previous.some(item => item.id === event.id)) return structuredClone(state);
    const current = state.goal_revision === binding.goal_revision
      && state.publication?.head === binding.head && (!state.review_reports?.length || state.review_reports.at(-1).id === binding.report_id);
    if (current && type === 'merge-landed' && state.landing && !isDeepStrictEqual(state.landing.binding, binding)) throw new Error('landed assignment cannot change');
    if (current && type === 'merge-landed' && state.landing && state.landing.merge_commit !== details.merge_commit) throw new Error('landed commit cannot change');
    const next = { ...state, plan_events: [...previous, event] };
    if (type === 'merge-queued') {
      if (!current || state.active_run || !['plan_pending', 'landing'].includes(state.phase)
        || (state.merge_handoff?.status === 'answered' && isDeepStrictEqual(state.merge_handoff.binding, binding))) throw new Error('autonomous merge handoff is no longer pending');
      if (!ticket || ticket.head !== binding.head || ticket.review_id !== binding.report_id
        || ticket.review_digest !== binding.report_digest) throw new Error('merge ticket does not match report');
      next.phase = 'landing'; next.merge_handoff = { binding, ticket, status: 'pending' };
    } else if (current && (type === 'merge-landed' || state.phase !== 'landed')) {
      next.merge_handoff = { binding, ticket: ticket || state.merge_handoff?.ticket || null, status: 'answered' };
      // A late failure cannot undo a read-back landing or a planner decision.
      if (type === 'merge-landed') {
        next.landing = { ...details, binding, observed_at: new Date(deps.now?.() ?? Date.now()).toISOString() };
        if (!reviewedLanding({ ...next, phase: 'landed' })) throw new Error('landing does not match the current reviewed assignment');
      }
      if (!state.active_run) {
        if (type === 'merge-landed') next.phase = 'landed';
        else if (state.phase !== 'landed') next.phase = 'plan_pending';
      }
    }
    return save(paths.project, state, next, deps);
  }, deps);
}
