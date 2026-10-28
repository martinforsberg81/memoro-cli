/** Revisioned v2 data only. No scheduler, launcher or v1 register interpretation. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-write.js';
import { realLock } from './register.js';
import { withPlanLock } from './plan-write.js';
import { createSessionControl, decideSessionControl, interruptSessionControl, controlResponse, validateControlState } from './session-control.js';
import { PLAN_FILE } from './plan-source.js';
import { PROGRAMS_HOME } from './paths.js';
import { STABLE_ID_RE, validateProgrammeContract, programmeRevisionProblems } from './programme-contract.js';
import { validateAutonomousProject, autonomousRevisionProblems, validateAutonomousEvidence, evidenceForRevision } from './autonomous-project.js';

export const PROGRAMME_STATE_FILE = 'PROGRAMME_STATE.json';
export const AUTONOMOUS_STATE_FILE = 'AUTONOMOUS_STATE.json';
export const AUTONOMOUS_PHASES = Object.freeze(['ready', 'running', 'handoff_requested', 'closing', 'publishing', 'review_ready', 'reviewing', 'plan_pending', 'landing', 'landed', 'confirmed']);
const valid = result => { if (!result.ok) throw new Error(result.problems.join('; ')); };
const name = value => { if (typeof value !== 'string' || !STABLE_ID_RE.test(value)) throw new Error('a stable lower-case ID is required'); return value; };
const read = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const actorCheck = actor => {
  name(actor?.run_id);
  if (Object.keys(actor).some(key => !['run_id', 'role'].includes(key))) throw new Error('run ownership takes only run_id and role');
  if (!['foreground-plan', 'plan', 'step', 'review'].includes(actor.role)) throw new Error('an explicit active role is required');
};
function owner(state, actor, roles) {
  actorCheck(actor);
  if (!roles.includes(actor.role) || !isDeepStrictEqual(state.active_run, actor)) throw new Error('active run/role ownership required');
}
function expected(state, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision !== (state?.revision ?? 0)) throw new Error('stale state revision — read the current state');
}
function checkState(state, schema) {
  if (!state || state.schema !== schema || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error(`invalid ${schema} state`);
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
  if (state.execution_enabled !== false || !Array.isArray(state.approved) || !Array.isArray(state.runs)) throw new Error('invalid programme state; execution must remain disabled');
  state.approved.forEach((contract, index) => {
    valid(validateProgrammeContract(contract));
    if (contract.status !== 'approved' || contract.id !== paths.id || contract.revision !== index + 1) throw new Error('invalid approved revision history');
  });
  if (state.active_run !== null) actorCheck(state.active_run);
  if (new Set(state.runs.map(run => { actorCheck(run); return run.run_id; })).size !== state.runs.length) throw new Error('duplicate run ID');
  if (state.draft) {
    valid(validateProgrammeContract(state.draft));
    if (state.draft.id !== paths.id || state.draft.status !== 'draft' || state.draft.revision !== state.approved.length + 1) throw new Error('invalid programme draft revision');
  }
  return state;
}
function projectState(paths) {
  const state = checkState(read(paths.project), 'mc-autonomous-state');
  valid(validateAutonomousProject(state.contract));
  valid(validateAutonomousEvidence(state.evidence));
  if (state.contract.project_id !== paths.projectId || state.contract.programme.id !== paths.id
    || state.goal_revision !== state.contract.goal_revision || state.programme_revision !== state.contract.programme.revision
    || !AUTONOMOUS_PHASES.includes(state.phase) || !Array.isArray(state.contracts) || !Array.isArray(state.attempts)
    || !Array.isArray(state.runs) || !Array.isArray(state.confirmations) || !Array.isArray(state.commits)
    || !state.ownership || typeof state.confirmed !== 'boolean') throw new Error('invalid autonomous state identity or history');
  return state;
}
function rejectRetiredCriteria(history, current, next) {
  const live = new Set((current?.success_criteria || []).map(item => item.id));
  const retired = new Set(history.flatMap(contract => contract.success_criteria.map(item => item.id)).filter(id => !live.has(id)));
  if (next.success_criteria.some(item => retired.has(item.id))) throw new Error('retired criterion IDs cannot be reused');
}
function approved(state, project) {
  const contract = state.approved.find(item => item.revision === project.programme.revision);
  if (!contract) throw new Error('the referenced approved programme revision does not exist');
  valid(validateAutonomousProject(project, { programme: contract }));
}
// DRAFT is a compatibility projection, never a second authority. A crash after
// the state commit is recovered explicitly; readers always use state.contract.
function projectSave(paths, previous, next, deps) {
  const result = save(paths.project, previous, next, deps);
  (deps.writeDraft || writeJsonAtomic)(paths.draft, result.contract);
  return result;
}
export function readProgrammeState(root, programme, deps = {}) {
  return locked(root, programme, null, paths => structuredClone(programmeState(paths)), deps);
}
export function readAutonomousState(root, programme, project, deps = {}) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths);
    return structuredClone(state);
  }, deps);
}

/** Publish the authoritative contract as an inert PLAN; never reserve or launch work. */
export function sendAutonomousProject(root, programme, project, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision); owner(state, actor, ['plan']);
    const agreement = programmeState(paths); owner(agreement, actor, ['plan']);
    approved(agreement, state.contract);
    const file = join(paths.projectDir, PLAN_FILE);
    if (existsSync(file)) {
      if (!isDeepStrictEqual(read(file), state.contract)) throw new Error('a different PLAN.json already exists');
    } else (deps.writePlan || writeJsonAtomic)(file, state.contract);
    return structuredClone(state.contract);
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
    return save(paths.programme, before, { ...(before || { schema: 'mc-programme-state', version: 1, approved: [], draft: null, runs: [] }),
      active_run: actor, runs: [...(before?.runs || []), actor], execution_enabled: false }, deps);
  }, deps);
}
/** Release checks the same owner and revision as every other mutation. */
export function releaseProgrammeRun(root, programme, actor, revision, deps = {}) {
  return locked(root, programme, null, paths => {
    const state = programmeState(paths); expected(state, revision); owner(state, actor, ['foreground-plan', 'plan']);
    return save(paths.programme, state, { ...state, active_run: null }, deps);
  }, deps);
}
export function mutateProgramme(root, programme, operation, input, { actor, revision, ...deps }) {
  return locked(root, programme, null, paths => {
    const state = programmeState(paths); expected(state, revision); owner(state, actor, ['foreground-plan']);
    if (operation === 'progress' && state.session_control) ownedControl(state, actor);
    const next = structuredClone(state);
    if (operation === 'draft') {
      valid(validateProgrammeContract(input));
      if (input.id !== programme || input.status !== 'draft') throw new Error('a matching programme draft is required');
      const current = state.approved.at(-1);
      if (current) {
        const problems = programmeRevisionProblems(current, input);
        if (problems.length) throw new Error(problems.join('; '));
        if (input.revision !== current.revision + 1) throw new Error('draft must follow the approved revision');
      } else if (input.revision !== 1) throw new Error('the first draft must be revision 1');
      rejectRetiredCriteria(state.approved, current, input);
      next.draft = input;
    } else if (operation === 'approve') {
      if (!state.draft) throw new Error('no draft to approve');
      const contract = { ...state.draft, status: 'approved', approval: input };
      valid(validateProgrammeContract(contract));
      next.approved.push(contract); next.draft = null;
    } else throw new Error('unknown programme operation');
    return save(paths.programme, state, next, deps);
  }, deps);
}
export function createAutonomousDraft(root, programme, project, input, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = programmeState(paths); expected(state, revision); owner(state, actor, ['plan']);
    approved(state, input);
    if (input.project_id !== project || input.programme.id !== programme || input.goal_revision !== 1) throw new Error('new draft needs matching identity and goal revision 1');
    if ([PLAN_FILE, 'DRAFT.json', 'STATE.json', AUTONOMOUS_STATE_FILE].some(file => existsSync(join(paths.projectDir, file)))) throw new Error('project already exists');
    return projectSave(paths, null, {
      schema: 'mc-autonomous-state', version: 1, contract: input, contracts: [input], active_run: actor,
      phase: 'plan_pending', programme_revision: input.programme.revision, goal_revision: 1,
      ownership: { branch: null, pr: null }, commits: [], current_handoff: null,
      attempts: [], runs: [actor], evidence: { builder: [], reviews: [], confirmation: null }, confirmations: [], confirmed: false,
    }, deps);
  }, deps);
}
/** Trusted runner seam; execution remains disabled and this launches nothing. */
export function reserveProjectRun(root, programme, project, actor, revision, deps = {}) {
  actorCheck(actor);
  if (!['plan', 'step', 'review'].includes(actor.role)) throw new Error('project runs belong to plan, step or review');
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    if (state.active_run) throw new Error('the project already has an active run');
    if (state.runs.some(run => run.run_id === actor.run_id)) throw new Error('run ID already used');
    return save(paths.project, state, { ...state, active_run: actor, runs: [...state.runs, actor] }, deps);
  }, deps);
}
export function mutateAutonomousProject(root, programme, project, operation, input, { actor, revision, ...deps }) {
  return locked(root, programme, project, paths => {
    const state = projectState(paths); expected(state, revision);
    const roles = { revise: ['plan'], recover: ['plan'], confirm: ['plan'], progress: ['step'], report: ['review'], attempt: ['step', 'review', 'plan'], release: ['step', 'review', 'plan'] };
    owner(state, actor, roles[operation] || []);
    if (operation === 'progress' && state.session_control) ownedControl(state, actor);
    const next = structuredClone(state);
    if (operation === 'revise' || operation === 'confirm' || operation === 'recover') {
      owner(programmeState(paths), actor, ['plan']);
    }
    if (operation === 'recover') {
      if (existsSync(join(paths.projectDir, PLAN_FILE))) throw new Error('cannot recover a sent draft');
      (deps.writeDraft || writeJsonAtomic)(paths.draft, state.contract);
      return structuredClone(state);
    }
    if (operation === 'revise') {
      if (existsSync(join(paths.projectDir, PLAN_FILE))) throw new Error('sent v2 revisions are not supported yet');
      approved(programmeState(paths), input);
      const problems = autonomousRevisionProblems(state.contract, input);
      if (problems.length) throw new Error(problems.join('; '));
      rejectRetiredCriteria(state.contracts, state.contract, input);
      next.contract = input; next.contracts.push(input); next.goal_revision = input.goal_revision;
      next.programme_revision = input.programme.revision; next.confirmed = false;
      next.evidence.confirmation = null; next.current_handoff = null; next.phase = 'plan_pending';
    } else if (operation === 'progress' || operation === 'report' || operation === 'confirm') {
      const record = { ...input, run_id: actor.run_id, project_id: project, programme_id: programme,
        programme_revision: state.programme_revision, goal_revision: state.goal_revision };
      const records = [...state.evidence.builder, ...state.evidence.reviews, ...state.confirmations];
      if (records.some(item => item.id === record.id)) throw new Error('evidence ID already used');
      const ids = new Set(state.contract.success_criteria.map(item => item.id));
      if (operation === 'progress') {
        if (!ids.has(record.criterion_id)) throw new Error('unknown criterion ID');
        next.evidence.builder.push(record);
      } else if (operation === 'report') {
        if (record.criteria?.some(item => !ids.has(item.criterion_id))) throw new Error('unknown criterion ID');
        next.evidence.reviews.push(record);
      } else {
        record.role = 'plan'; next.evidence.confirmation = record; next.confirmations.push(record); next.confirmed = true; next.phase = 'confirmed';
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
      next.attempts.push({ ...input, run_id: actor.run_id, role: actor.role, programme_revision: state.programme_revision, goal_revision: state.goal_revision, outcome: 'incomplete' });
      next.phase = 'plan_pending'; next.confirmed = false; next.evidence.confirmation = null;
    } else if (operation === 'release') next.active_run = null;
    else throw new Error('unknown autonomous project operation');
    return operation === 'revise' ? projectSave(paths, state, next, deps) : save(paths.project, state, next, deps);
  }, deps);
}
export function currentAutonomousEvidence(state) {
  return evidenceForRevision(state.contract, state.evidence);
}

// Inactive trusted runner seams. No CLI operation accepts profiles, clocks or
// measured progress. Keep control and project ownership in one atomic record.
function controlBinding(state, actor) {
  return { programme_id: state.contract.programme.id, programme_revision: state.programme_revision,
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
    const session_control = decideSessionControl(ownedControl(state, actor), controlObservation(state, observation));
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
