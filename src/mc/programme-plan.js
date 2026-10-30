/** Guarded headless plan facade. No production activation or model launch. */
import { goalCompletion } from './goal-followup.js';
import { applyProgrammeProjectOperation, readProgrammePlanSnapshot, readProgrammeState } from './autonomous-state.js';
import { createProgrammeJobProject, prepareProgrammeOperation, completeProgrammeOperation, reachProgrammeStop, holdProgrammePlan } from './programme-jobs.js';
import { projectRecovery, readProgrammeIncidents } from './programme-recovery.js';
import { SESSION_START_MAX_BYTES } from './session-handoff.js';
import { isDeepStrictEqual } from 'node:util';

export function decideProgrammePlan(options, intent) {
  if (['wait-programme', 'exception-programme'].includes(intent?.kind)) return holdProgrammePlan(options, intent);
  if (intent?.kind === 'reach-stop') {
    const { kind, ...input } = intent;
    return reachProgrammeStop(options, input);
  }
  if (['create-project', 'main-repair'].includes(intent?.kind)) return createProgrammeJobProject(options, intent);
  const state = prepareProgrammeOperation(options, intent);
  const operation = state.planner_jobs.operations.find(item => item.intent.id === intent.id);
  if (operation.status === 'applied') return operation.result;
  if (operation.status === 'cancelled') throw new Error('planner decision was cancelled; use a new operation ID');
  const result = applyProgrammeProjectOperation(options.root, options.programme, intent,
    { ...options.deps, actor: options.actor, token: options.token, revision: state.revision, now: () => options.now ?? Date.now() });
  const current = readProgrammeState(options.root, options.programme);
  completeProgrammeOperation({ ...options, revision: current.revision }, intent, result);
  return result;
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
