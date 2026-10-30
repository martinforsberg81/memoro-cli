/** The planning journal both planners share: prepare, apply, receipt. Headless
 * proves its lease; foreground never pretends to hold one. No model launch. */
import { createHash } from 'node:crypto';
import { goalCompletion } from './goal-followup.js';
import { applyProgrammeProjectOperation, mutateAutonomousProject, readAutonomousState, readProgrammePlanSnapshot, readProgrammeState, sendAutonomousProject } from './autonomous-state.js';
import { acknowledgeProgrammeEvents, createProgrammeJobProject, prepareProgrammeOperation, programmeOperationCommitted, completeProgrammeOperation, reachProgrammeStop, holdProgrammePlan, withdrawProgrammeOperation } from './programme-jobs.js';
import { projectRecovery, readProgrammeIncidents } from './programme-recovery.js';
import { SESSION_START_MAX_BYTES } from './session-handoff.js';
import { isDeepStrictEqual } from 'node:util';

/** Identity is what the command says, never when it ran: a repeat is a replay. */
export const planningOperationId = (...parts) => `op-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;

function applyGoalVerb(options, intent, shared) {
  const { root, programme } = options;
  const { project, input, expected_revision: revision } = intent;
  if (intent.kind === 'send-goal') sendAutonomousProject(root, programme, project, { ...shared, revision, after: input.after, operation: intent });
  else mutateAutonomousProject(root, programme, project, intent.kind === 'revise-goal' ? 'revise' : 'follow-up', input, { ...shared, revision, operation: intent });
  return readAutonomousState(root, programme, project).operation_receipts.find(item => item.id === intent.id).result;
}

export function decideProgrammePlan(options, intent) {
  if (['wait-programme', 'exception-programme'].includes(intent?.kind)) return holdProgrammePlan(options, intent);
  if (intent?.kind === 'reach-stop') {
    const { kind, ...input } = intent;
    return reachProgrammeStop(options, input);
  }
  if (['create-project', 'main-repair', 'new-goal'].includes(intent?.kind)) return createProgrammeJobProject(options, intent);
  const state = prepareProgrammeOperation(options, intent);
  const operation = state.planner_jobs.operations.find(item => item.intent.id === intent.id);
  if (operation.status === 'applied') return operation.result;
  if (operation.status === 'cancelled') throw new Error('planner decision was cancelled; use a new operation ID');
  const shared = { ...options.deps, actor: options.actor, token: options.token, now: () => options.now ?? Date.now() };
  const result = ['send-goal', 'revise-goal', 'follow-up-goal'].includes(intent.kind) ? applyGoalVerb(options, intent, shared)
    : applyProgrammeProjectOperation(options.root, options.programme, intent, { ...shared, revision: state.revision });
  const current = readProgrammeState(options.root, options.programme);
  completeProgrammeOperation({ ...options, revision: current.revision }, intent, result);
  return result;
}

/** Finish what committed before anything new: the receipt says it happened, and
 * replay repairs its projections. An intent without one waits for its own command. */
function settlePlanningOperations(options) {
  const operations = readProgrammeState(options.root, options.programme).planner_jobs?.operations || [];
  for (const { intent, status } of operations) {
    if (status === 'pending' && programmeOperationCommitted(options.root, options.programme, intent)) decideProgrammePlan({ ...options, anyRevision: true }, intent);
  }
}

/** The ordinary verbs' door, for either planner. */
export function runPlanningOperation(options, { kind, project, input, revision }) {
  // A cancelled command is a decision not taken: saying it again takes it.
  const journaled = { ...options, anyRevision: true, reopen: true };
  settlePlanningOperations(journaled);
  const intent = { id: planningOperationId(kind, project, revision, input), kind, project, expected_revision: revision, input };
  try { return decideProgrammePlan(journaled, intent); }
  catch (error) { withdrawProgrammeOperation(journaled, intent.id, error.message); throw error; }
}

export function acknowledgePlanningEvents(options, input) {
  settlePlanningOperations(options);
  return acknowledgeProgrammeEvents(options, input);
}

const short = text => typeof text === 'string' ? text.slice(0, 384) : null;
/** All goals, full agreement, concise results, immutable detail references.
 * The entire prompt is bounded; excess fails rather than dropping goals. */
export function programmePlanContext(options) {
  const { state, goals } = readProgrammePlanSnapshot(options.root, options.programme);
  const lease = state.planner_jobs?.lease;
  if (!lease || lease.token !== options.token || !isDeepStrictEqual(lease.actor, options.actor)
    || lease.expires_at <= (options.now ?? Date.now())) throw new Error('active planner lease ownership required');
  const agreement = state.metadata;
  const context = {
    schema: 'mc-programme-plan-context', version: 1, programme: agreement,
    // The programme's shape and stop condition: a session needs them in full.
    phases: (state.phases || []).map(item => ({ n: item.n, name: item.name, purpose: item.purpose, closed: item.closed?.reference ?? null })),
    autonomy: { enabled: !!state.autonomy?.enabled, stop: state.autonomy?.stop ?? null },
    state_revision: state.revision, job: { id: lease.job_id, event_ids: lease.event_ids,
      events: state.planner_jobs.events.filter(item => lease.event_ids.includes(item.id)), token: lease.token },
    pending_operations: state.planner_jobs.operations.filter(item => item.status === 'pending'),
    recovery: { mode: state.planner_jobs.mode, wait: state.planner_jobs.wait, exception: state.planner_jobs.exception || null },
    main_incidents: readProgrammeIncidents(options.root).filter(item => item.owner === options.programme || item.dependents.some(item => item.programme === options.programme))
      .map(item => ({ id: item.id, repo: item.repo, failure: item.failure, owner: item.owner, status: item.status, repair: item.repair, dependent_count: item.dependents.length, reference: `${options.root}/runner/programme-incidents.json#${item.id}` })),
    goals: goals.map(goal => {
      if (goal.legacy) return { project: goal.project, version: 1, repo: goal.plan.repo, goal: short(goal.plan.goal?.[0]),
        status: goal.register?.steps?.map(item => item.status) || goal.plan.steps.map(item => item.status), reference: goal.reference, authority: 'read-only legacy goal' };
      const value = goal.state;
      const review = value.review_reports?.at(-1);
      return { project: goal.project, version: 2, repo: value.contract.repo, goal: short(value.contract.goal[0]),
        state_revision: value.revision, goal_revision: value.goal_revision,
        programme_phase: value.contract.programme_phase, phase: value.phase, active_run: value.active_run, ownership: value.ownership, ...goalCompletion(value),
        dependencies: value.plan_dependencies || [], dependency_release: value.dependency_release || null, recovery: projectRecovery(value),
        criteria: value.contract.success_criteria.map(item => ({ id: item.id, verification: item.verification,
          status: value.evidence.builder.filter(record => record.goal_revision === value.goal_revision && record.criterion_id === item.id).at(-1)?.status || 'unknown' })),
        latest_review: review ? { id: review.id, clean: review.clean,
          goal_revision: review.session?.assignment.goal_revision,
          reference: `${goal.reference}#review_reports/${review.id}` } : null,
        attempts: { count: value.attempts.length, latest_reason: short(value.attempts.at(-1)?.reason), reference: `${goal.reference}#attempts` },
        handoff: value.current_handoff, landing: value.landing || null, reference: goal.reference };
    }),
    programme_state_reference: `${options.root}/programs/${options.programme}/PROGRAMME_STATE.json`,
  };
  const prompt = JSON.stringify(context);
  if (Buffer.byteLength(prompt) > SESSION_START_MAX_BYTES) throw new Error('programme context exceeds bounded start size; keep detail referenced');
  return prompt;
}
