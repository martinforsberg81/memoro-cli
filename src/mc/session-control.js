/** Pure, inactive v2 policy. Only the trusted runner supplies clocks, measured
 * checkpoints and a profile. Model callbacks cannot reset or choose a budget. */
import { isDeepStrictEqual } from 'node:util';
import { STABLE_ID_RE } from './programme-contract.js';

const modes = ['model', 'lane', 'tool', 'gate'];
const bindingKeys = ['programme_id', 'programme_revision', 'project_id', 'goal_revision', 'run_id'];
const profileKeys = ['soft_active_ms', 'upper_active_ms', 'emergency_active_ms', 'reserve_active_ms',
  'soft_context', 'upper_context', 'emergency_context', 'reserve_context', 'context_stale_ms',
  'closing_ms', 'tool_wait_ms', 'lane_wait_ms', 'total_awake_ms', 'no_progress_ms', 'max_stagnant_sessions', 'max_failures'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 2048;
const id = value => typeof value === 'string' && STABLE_ID_RE.test(value);
function exact(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`invalid ${label} fields`);
  }
}
function checkBinding(binding) {
  exact(binding, bindingKeys, 'control binding');
  if (!['programme_id', 'project_id', 'run_id'].every(key => id(binding[key]))
    || !['programme_revision', 'goal_revision'].every(key => integer(binding[key]) && binding[key] > 0)) throw new Error('invalid control binding');
}
export function validateControlProfile(profile) {
  exact(profile, profileKeys, 'control profile');
  for (const key of profileKeys) {
    if (key.endsWith('context')) {
      if (!Number.isFinite(profile[key]) || profile[key] <= 0 || profile[key] > 1) throw new Error(`invalid profile ${key}`);
    } else if (!integer(profile[key]) || profile[key] === 0) throw new Error(`invalid profile ${key}`);
  }
  for (const unit of ['active_ms', 'context']) {
    if (profile[`soft_${unit}`] >= profile[`upper_${unit}`]
      || profile[`upper_${unit}`] > profile[`emergency_${unit}`] - profile[`reserve_${unit}`]) throw new Error(`profile must reserve closing ${unit}`);
  }
  if (profile.total_awake_ms < profile.emergency_active_ms || profile.total_awake_ms < profile.upper_active_ms + profile.closing_ms
    || profile.closing_ms < profile.reserve_active_ms) throw new Error('profile must reserve closing time');
  return structuredClone(profile);
}
function checkObservation(o) {
  exact(o, ['sequence', 'at_ms', 'awake_ms', 'activity', 'context', 'progress', 'failure'], 'control observation');
  if (!integer(o.sequence) || !integer(o.at_ms) || !integer(o.awake_ms)) throw new Error('invalid observation clock/sequence');
  exact(o.activity, ['kind', 'id'], 'activity');
  if (!modes.includes(o.activity.kind) || (o.activity.kind === 'model' ? o.activity.id !== null : !id(o.activity.id))) throw new Error('invalid activity');
  if (o.context !== null) {
    exact(o.context, ['fraction', 'at_ms', 'source', 'quality'], 'context');
    if (!Number.isFinite(o.context.fraction) || o.context.fraction < 0 || o.context.fraction > 1
      || !integer(o.context.at_ms) || o.context.at_ms > o.at_ms || !text(o.context.source)
      || !['measured', 'estimated'].includes(o.context.quality)) throw new Error('invalid current context observation');
  }
  if (o.progress !== null) {
    exact(o.progress, ['id', 'reference', 'criterion_id'], 'measured progress');
    if (!id(o.progress.id) || !text(o.progress.reference) || (o.progress.criterion_id !== null && !id(o.progress.criterion_id))) throw new Error('invalid measured progress');
  }
  if (o.failure !== null) {
    exact(o.failure, ['id', 'reference'], 'failure');
    if (!id(o.failure.id) || !text(o.failure.reference)) throw new Error('invalid failure');
  }
}
function stop(state, phase, reason) {
  if (phase === 'incomplete') state.history.failures++;
  state.phase = phase; state.reason = reason;
  state.result = { outcome: phase === 'plan_pending' ? 'needs-plan' : 'incomplete', reason, run_id: state.binding.run_id,
    goal_revision: state.binding.goal_revision, normal_exit: false, pending_plan: true };
}
function close(state, reason) {
  if (state.phase !== 'running') return;
  state.phase = 'closing'; state.reason = reason; state.closing_awake_ms = state.totals.awake_ms;
}
export function validateControlState(state) {
  if (!state || state.schema !== 'mc-session-control' || state.version !== 1
    || !['running', 'closing', 'incomplete', 'plan_pending'].includes(state.phase)) throw new Error('invalid control state');
  checkBinding(state.binding); validateControlProfile(state.profile); checkObservation(state.observation);
  const h = state.history;
  if (!h || ![h.no_progress_ms, h.stagnant_sessions, h.failures, state.wait_ms, ...Object.values(state.totals || {})].every(integer)
    || !['active_ms', 'awake_ms', 'sleep_ms', 'lane_ms', 'tool_ms', 'gate_ms'].every(key => integer(state.totals?.[key]))
    || typeof state.run_progress !== 'boolean' || (state.closing_awake_ms !== null && !integer(state.closing_awake_ms))
    || !['checkpoints', 'criteria', 'failure_ids'].every(key => Array.isArray(h[key]) && h[key].length <= 256 && h[key].every(id) && new Set(h[key]).size === h[key].length)
    || (state.phase === 'closing' && state.closing_awake_ms === null)
    || (['running', 'closing'].includes(state.phase) && state.result !== null)
    || (['incomplete', 'plan_pending'].includes(state.phase) && (!state.result || state.result.normal_exit !== false || state.result.pending_plan !== true
      || state.result.outcome !== (state.phase === 'incomplete' ? 'incomplete' : 'needs-plan')
      || state.result.run_id !== state.binding.run_id || state.result.goal_revision !== state.binding.goal_revision))) throw new Error('invalid control history/state');
  return state;
}
export function controlResponse(state) {
  validateControlState(state);
  return { ...state.binding, phase: state.phase, reason: state.reason,
    next_action: { running: 'continue', closing: 'finish-session', incomplete: 'stop-session', plan_pending: 'needs-plan' }[state.phase],
    allows_new_work: state.phase === 'running', observed_at_ms: state.observation.at_ms, observation_sequence: state.observation.sequence,
    context: structuredClone(state.context), result: structuredClone(state.result) };
}

/** New clocks and context for every fresh run; stagnation and failures belong to
 * the goal, not the conversation. Previous workers must already be reconciled. */
export function createSessionControl({ binding, profile, observation, previous = null }) {
  checkBinding(binding); validateControlProfile(profile); checkObservation(observation);
  if (previous) {
    validateControlState(previous);
    if (previous.phase === 'plan_pending') throw new Error('pending plan result must be resolved before another build session');
  }
  if (previous && (binding.run_id === previous.binding.run_id
    || bindingKeys.filter(key => key !== 'run_id').some(key => binding[key] !== previous.binding[key]))) throw new Error('fresh control requires a new run on the same assignment revision');
  const history = previous ? structuredClone(previous.history) : { no_progress_ms: 0, stagnant_sessions: 0,
    failures: 0, checkpoints: [], criteria: [], failure_ids: [], last_progress: null, last_failure: null };
  if (previous && !previous.run_progress) history.stagnant_sessions++;
  const state = { schema: 'mc-session-control', version: 1, binding: structuredClone(binding), profile: structuredClone(profile),
    phase: 'running', reason: null, result: null, closing_awake_ms: null, run_progress: false, history,
    totals: { active_ms: 0, awake_ms: 0, sleep_ms: 0, lane_ms: 0, tool_ms: 0, gate_ms: 0 },
    wait_ms: 0, observation: structuredClone(observation), context: null, request: null };
  // The initial sample may itself carry a current emergency context reading.
  return decide(state, observation, true);
}

/** Timestamped runner observations only. The old activity accounts for the
 * interval before this sample. awake_ms excludes suspend; wall minus awake is
 * recorded sleep, never inferred active model work. */
export function decideSessionControl(previous, observation) {
  return decide(previous, observation, false);
}
function decide(previous, observation, initial) {
  checkObservation(observation); validateControlState(previous);
  if (!initial && observation.sequence === previous.observation.sequence) {
    if (!isDeepStrictEqual(observation, previous.observation)) throw new Error('conflicting observation replay');
    return structuredClone(previous);
  }
  const old = previous.observation;
  const wall = observation.at_ms - old.at_ms; const awake = observation.awake_ms - old.awake_ms;
  if ((!initial && observation.sequence !== old.sequence + 1) || wall < 0 || awake < 0 || awake > wall) throw new Error('out-of-order observation clock/sequence');
  const state = structuredClone(previous); const p = state.profile; const h = state.history;
  if (['incomplete', 'plan_pending'].includes(state.phase)) return state;
  state.observation = structuredClone(observation);
  state.totals.awake_ms += awake; state.totals.sleep_ms += wall - awake;
  const mode = old.activity.kind;
  state.totals[mode === 'model' ? 'active_ms' : `${mode}_ms`] += awake;
  if (mode === 'model') h.no_progress_ms += awake;
  const sameActivity = isDeepStrictEqual(old.activity, observation.activity);
  const elapsedWait = state.wait_ms + awake;
  state.wait_ms = sameActivity ? elapsedWait : 0;
  state.context = observation.context && observation.at_ms - observation.context.at_ms <= p.context_stale_ms
    ? structuredClone(observation.context) : { fraction: null, at_ms: observation.context?.at_ms ?? null,
      source: observation.context?.source ?? null, quality: 'unknown' };
  const fraction = state.context.fraction;
  // Emergency takes precedence over progress/failures and never reports green.
  const expiredWait = mode !== 'model' && elapsedWait >= (mode === 'lane' ? p.lane_wait_ms : p.tool_wait_ms);
  if (state.totals.active_ms >= p.emergency_active_ms || state.totals.awake_ms >= p.total_awake_ms
    || (fraction !== null && fraction >= p.emergency_context)
    || (state.phase === 'closing' && state.totals.awake_ms - state.closing_awake_ms >= p.closing_ms) || expiredWait) {
    stop(state, 'incomplete', expiredWait ? `${mode}-wait-exhausted` : 'emergency-boundary'); return state;
  }
  let criterionCompleted = false;
  if (observation.progress && !h.checkpoints.includes(observation.progress.id)) {
    if (h.checkpoints.length >= 256) { stop(state, 'plan_pending', 'checkpoint-history-full'); return state; }
    h.checkpoints.push(observation.progress.id); h.no_progress_ms = 0; h.stagnant_sessions = 0; state.run_progress = true;
    h.last_progress = { ...observation.progress, run_id: state.binding.run_id, at_ms: observation.at_ms };
    if (observation.progress.criterion_id && !h.criteria.includes(observation.progress.criterion_id)) {
      h.criteria.push(observation.progress.criterion_id); criterionCompleted = true;
    }
  }
  if (observation.failure && !h.failure_ids.includes(observation.failure.id)) {
    if (h.failure_ids.length >= 256) { stop(state, 'plan_pending', 'failure-history-full'); return state; }
    h.failure_ids.push(observation.failure.id); h.failures++;
    h.last_failure = { ...observation.failure, run_id: state.binding.run_id, at_ms: observation.at_ms };
  }
  if (h.failures >= p.max_failures || h.stagnant_sessions >= p.max_stagnant_sessions || h.no_progress_ms >= p.no_progress_ms) {
    stop(state, 'plan_pending', h.failures >= p.max_failures ? 'repeated-failures' : 'no-measured-progress'); return state;
  }
  if (state.totals.active_ms >= p.upper_active_ms || state.totals.awake_ms >= p.total_awake_ms - p.closing_ms
    || (fraction !== null && fraction >= p.upper_context)) close(state, 'upper-boundary');
  else if (criterionCompleted && (state.totals.active_ms >= p.soft_active_ms || (fraction !== null && fraction >= p.soft_context))) close(state, 'criterion-soft-boundary');
  return state;
}
