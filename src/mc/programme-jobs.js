/** Durable, inactive planner outbox. Delivery can repeat; effects have receipts.
 * Lease reservation stays runner-owned; guarded plan decisions use this journal. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { autonomousPaths, autonomousOperationDigest, createAutonomousDraft, emptyPlannerJobs, planningContention, readProgrammeState, updateProgrammeRegister, AUTONOMOUS_PHASES, AUTONOMOUS_STATE_FILE, PROGRAMME_STATE_FILE } from './autonomous-state.js';
import { reviewedLanding } from './goal-followup.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { validateAutonomousProject } from './autonomous-project.js';
import { PROGRAMS_HOME } from './paths.js';
import { PLAN_FILE } from './plan-source.js';
import { processAlive, readClaim } from './resource-claim.js';
import { writeJsonAtomic } from './atomic-write.js';
import { observeMainIncidentLocked, reconcileMainRepairsLocked, cancelMainRepairLocked, mainIncidentHold, assertProjectRecovery, boundedRecoveryWait, recordRecoveryWait, RECOVERY_ATTEMPT_LIMIT } from './programme-recovery.js';
import { planOperationProblems } from './autonomous-state.js';

export const PROGRAMME_JOB_TRIGGERS = Object.freeze(['activation', 'review', 'landed', 'failure', 'dependency', 'red-main', 'follow-up', 'phase', 'idle']);
const CREATE_OPERATIONS = Object.freeze(['create-project', 'main-repair', 'new-goal']);
export const MAX_PLANNER_LEASE_MS = 5 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = value => typeof value === 'string' && STABLE_ID_RE.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = options => {
  const now = options.now ?? Date.now();
  if (!positive(now)) throw new Error('planner clock must be epoch milliseconds');
  return now;
};
const validWait = wait => wait && ['quota', 'network', 'resource', 'external'].includes(wait.kind)
  && typeof wait.reason === 'string' && wait.reason.trim()
  && (positive(wait.until) || wait.kind === 'external' && wait.until === null);
const expected = (state, revision) => {
  if (state.revision !== revision) throw planningContention('stale programme state revision');
};
function jobs(state) {
  const value = state.planner_jobs === undefined ? emptyPlannerJobs() : state.planner_jobs;
  if (!value || value.version !== 1 || !['inactive', 'active', 'waiting', 'stopped', 'exception'].includes(value.mode)
    || !['events', 'operations', 'recoveries'].every(key => Array.isArray(value[key]))
    || (value.pending !== null && (!stable(value.pending.id) || !Array.isArray(value.pending.event_ids) || (!value.pending.event_ids.length && !value.lease)))
    || (value.lease !== null && (!stable(value.lease.token) || !positive(value.lease.pid) || !positive(value.lease.expires_at)
      || !stable(value.lease.actor?.run_id) || value.lease.actor.role !== 'plan'
      || !Array.isArray(value.lease.event_ids) || value.lease.job_id !== value.pending?.id
      || !isDeepStrictEqual(value.lease.actor, state.active_run)))
    || (value.mode === 'exception' && (!value.exception || typeof value.exception.reason !== 'string' || !value.exception.reason.trim()))
    || (value.mode === 'waiting' && !validWait(value.wait))
    || (value.mode === 'stopped' && !stable(value.stop))) {
    throw new Error('invalid programme planner jobs; preserve state for recovery');
  }
  const ids = value.events.map(event => event.id);
  if (new Set(ids).size !== ids.length || value.events.some(event => !stable(event.id) || !PROGRAMME_JOB_TRIGGERS.includes(event.type)
      || typeof event.reference !== 'string' || !event.reference.trim() || (event.at !== undefined && !positive(event.at)))
    || value.pending?.event_ids.some(id => !ids.includes(id))
    || new Set(value.pending?.event_ids).size !== (value.pending?.event_ids.length || 0)
    || value.lease?.event_ids.some(id => !ids.includes(id))
    || new Set(value.operations.map(item => item.intent.id)).size !== value.operations.length
    || value.operations.some(item => !stable(item.intent.id) || !['pending', 'applied', 'cancelled', 'refused'].includes(item.status))) {
    throw new Error('invalid programme planner journal');
  }
  return value;
}
// `anyRevision` is only for idempotent holds (autonomy off): no read-modify-write of
// an operator's view, so a renewed lease must not turn it into a stale refusal.
function transact(options, change) {
  return updateProgrammeRegister(options.root, options.programme, (state, paths) => {
    if (!options.anyRevision) expected(state, options.revision);
    const journal = jobs(state);
    const next = change(state, journal, paths);
    // When each trigger was first observed. Identity never depends on it.
    for (const event of journal.events) event.at ??= instant(options);
    return next || { ...state, planner_jobs: journal };
  }, options.deps);
}
function enqueue(state, journal, event) {
  if (!stable(event.id) || !PROGRAMME_JOB_TRIGGERS.includes(event.type)
    || typeof event.reference !== 'string' || !event.reference.trim()
    || Object.keys(event).some(key => !['id', 'type', 'reference'].includes(key))) throw new Error('invalid programme trigger');
  const previous = journal.events.find(item => item.id === event.id);
  if (previous) {
    const observed = { ...previous }; delete observed.at;
    if (!isDeepStrictEqual(observed, event)) throw new Error('programme event ID already used with different content');
    return;
  }
  journal.events.push(structuredClone(event));
  journal.pending ??= { id: `job-${randomUUID()}`, event_ids: [] };
  journal.pending.event_ids.push(event.id);
}

/** Operator control (programme-control.js) shares this journal transaction. */
export { transact as updateProgrammeJobs, enqueue as enqueueProgrammeEvent };

/** Persist before any launch. Duplicate immutable events do not advance state. */
export function recordProgrammeTrigger(options, event) {
  return transact(options, (state, journal) => { enqueue(state, journal, event); });
}

/** Future activation/operations seam, not production enablement. Waits retain
 * pending events. A planned stop cannot silently turn back into active. */
export function setProgrammeJobMode(options, { mode, wait = null, stop = null, event = null }) {
  return transact(options, (state, journal) => {
    if (!['active', 'waiting', 'stopped'].includes(mode)) throw new Error('explicit programme job mode required');
    if (journal.mode === 'stopped') {
      if (mode === 'stopped' && stop === journal.stop && !event) return state;
      throw new Error('planned stop requires an explicit foreground planning restart before new claims');
    }
    if (mode === 'active' && journal.mode === 'inactive') {
      if (event?.type !== 'activation') throw new Error('activation must persist its trigger');
      state.autonomy = { enabled: true, stop: null };
    }
    if (mode === 'waiting' && !validWait(wait)) throw new Error('wait names its condition and bounded retry or external dependency');
    if (mode === 'stopped' && !stable(stop)) throw new Error('stop must be an explicit stable ID');
    if (mode !== 'waiting' && wait !== null || mode !== 'stopped' && stop !== null) throw new Error('wait/stop must match mode');
    if (event) enqueue(state, journal, event);
    journal.mode = mode; journal.wait = wait; journal.stop = stop;
    if (mode === 'active') journal.exception = null;
  });
}
function acknowledge(journal, eventIds, reference, actor, at) {
  journal.acknowledgements = [...(journal.acknowledgements || []), { event_ids: eventIds, reference, run_id: actor?.run_id ?? null, role: actor?.role ?? 'foreground-plan', at }];
  journal.pending.event_ids = journal.pending.event_ids.filter(id => !eventIds.includes(id));
  if (!journal.pending.event_ids.length && !journal.lease) journal.pending = null;
}
function releaseLease(journal) {
  journal.lease = null;
  if (!journal.pending?.event_ids.length) journal.pending = null;
}
function owned(state, journal, options) {
  const lease = journal.lease;
  if (!lease || lease.token !== options.token || !isDeepStrictEqual(lease.actor, options.actor)
    || !isDeepStrictEqual(state.active_run, options.actor)) throw new Error('active planner lease ownership required');
  if (lease.expires_at <= instant(options)) throw new Error('planner lease expired');
  return lease;
}
/** Headless proves its lease. Foreground owns only its locked transaction: it
 * never impersonates a lease, and it does not run beside one. */
function authority(state, journal, options) {
  const role = (options.deps?.env || process.env).MC_AUTONOMOUS_ROLE;
  if (role && !['plan', 'foreground-plan'].includes(role)) throw new Error('only planning roles may change goal assignments');
  if (options.actor || role === 'plan') return owned(state, journal, options);
  if (state.active_run || journal.lease) throw planningContention('the programme already has an active run');
  return null;
}
function duration(ms) {
  if (!positive(ms) || ms > MAX_PLANNER_LEASE_MS) throw new Error('planner lease must be bounded');
  return ms;
}

/** Reservation and event snapshot commit together. Builders use their existing
 * independent project reservations and shared resource lane, not this lease.
 * Autonomy off refuses here and nowhere else: a held lease finishes its snapshot. */
export function claimProgrammeJob(options) {
  return transact(options, (state, journal) => {
    if (!state.autonomy?.enabled || journal.mode !== 'active' || !journal.pending || journal.lease || state.active_run) return state;
    if (options.actor?.role !== 'plan' || !stable(options.actor.run_id) || Object.keys(options.actor).length !== 2
      || state.runs.some(item => item.run_id === options.actor.run_id) || !positive(options.pid)) throw new Error('a fresh planner run and owning pid are required');
    const now = instant(options);
    journal.lease = { token: `lease-${randomUUID()}`, actor: structuredClone(options.actor), pid: options.pid,
      job_id: journal.pending.id, event_ids: [...journal.pending.event_ids],
      expires_at: now + duration(options.leaseMs ?? MAX_PLANNER_LEASE_MS) };
    return { ...state, active_run: options.actor, runs: [...state.runs, options.actor], planner_jobs: journal };
  });
}
export function renewProgrammeJob(options) {
  return transact(options, (state, journal) => {
    const lease = owned(state, journal, options);
    lease.expires_at = instant(options) + duration(options.leaseMs ?? MAX_PLANNER_LEASE_MS);
  });
}
/** Releases the lease. Only a recorded completion or ack consumes events: a
 * session that ended without one leaves them for the next delivery. */
export function finishProgrammeJob(options) {
  return transact(options, (state, journal) => {
    const lease = owned(state, journal, options);
    if (journal.operations.some(item => item.status === 'pending')) throw new Error('reconcile pending planner effects before completion');
    if (lease.completion) {
      journal.results = [...(journal.results || []), { run_id: lease.actor.run_id, job_id: lease.job_id, ...lease.completion }];
      acknowledge(journal, lease.completion.event_ids, lease.completion.reference, lease.actor, instant(options));
    }
    releaseLease(journal);
    return { ...state, active_run: null, planner_jobs: journal };
  });
}

/** Read immutable project outboxes under the same programme lock that every
 * project mutation takes. A damaged record is not an empty/successful result. */
function projectClaimHeld(root, programme, project) {
  const path = join(root, 'runner', 'autonomous-builds', programme, `${project}.claim`);
  if (!existsSync(path)) return false;
  const claim = readClaim(path);
  return !claim || processAlive(claim.pid);
}
function projectTriggers(paths, options, state, journal) {
  const events = []; const identities = []; const projects = new Map(); let hasNextAction = false;
  for (const entry of readdirSync(paths.dir, { withFileTypes: true }).filter(item => item.isDirectory() && stable(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(paths.dir, entry.name, AUTONOMOUS_STATE_FILE);
    if (!existsSync(file)) continue;
    const project = JSON.parse(readFileSync(file, 'utf8'));
    if (project.schema !== 'mc-autonomous-state' || project.version !== 2 || project.contract?.project_id !== entry.name
      || project.contract?.programme.id !== paths.id || !positive(project.revision)
      || project.goal_revision !== project.contract?.goal_revision
      || !validateAutonomousProject(project.contract).ok || !AUTONOMOUS_PHASES.includes(project.phase)
      || !Array.isArray(project.attempts) || (project.plan_events !== undefined && !Array.isArray(project.plan_events))
      || (project.follow_up_observations !== undefined && !Array.isArray(project.follow_up_observations))) throw new Error(`invalid autonomous trigger source: ${file}`);
    projects.set(entry.name, { state: project, file });
    identities.push([entry.name, project.revision]);
    hasNextAction ||= !!project.active_run || ['ready', 'running', 'review_ready', 'reviewing', 'publishing', 'landing'].includes(project.phase);
    const sourceIds = new Set();
    const sourceId = source => {
      // Review/merge IDs include a full digest and exceed the user-ID limit.
      if (typeof source?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(source.id)
        || sourceIds.has(source.id)) throw new Error(`invalid autonomous trigger source identity: ${file}`);
      sourceIds.add(source.id);
    };
    for (const source of project.plan_events || []) {
      sourceId(source);
      const failures = source.details?.main_failures;
      if (failures !== undefined && (!Array.isArray(failures) || failures.some(item => typeof item !== 'string' || !item.trim()) || new Set(failures).size !== failures.length)) throw new Error(`invalid main failure source: ${file}`);
      const type = source.type === 'review-reported' ? 'review' : source.type === 'merge-landed' ? 'landed' : source.type === 'dependency-released' ? 'dependency'
        : ['merge-refused', 'merge-failed', 'merge-unknown'].includes(source.type) ? 'failure' : null;
      if (!type) continue;
      events.push({ id: `evt-${digest([entry.name, source.goal_revision ?? source.binding?.goal_revision ?? null, source.id]).slice(0, 60)}`, type,
        reference: `${file}#plan_events/${source.id}` });
    }
    sourceIds.clear();
    for (const attempt of project.attempts) {
      sourceId(attempt);
      events.push({ id: `evt-${digest([entry.name, 'attempt', attempt.goal_revision ?? null, attempt.id]).slice(0, 60)}`,
        type: 'failure', reference: `${file}#attempts/${attempt.id}` });
    }
    sourceIds.clear();
    for (const observation of project.follow_up_observations || []) {
      sourceId(observation);
      events.push({ id: `evt-${digest([entry.name, 'follow-up', observation.goal_revision, observation.id]).slice(0, 60)}`,
        type: 'follow-up', reference: `${file}#follow_up_observations/${observation.id}` });
    }
  }
  // Sources were validated before committing any recoverable cross-file effect.
  for (const [name, { state: project, file }] of projects) {
    for (const source of project.plan_events || []) {
      for (const failure of source.details?.main_failures || []) observeMainIncidentLocked(options.root, {
        programme: paths.id, project: name, repo: project.contract.repo, failure,
        source: `${paths.id}/${name}/${source.id}/${failure}`, reference: `${file}#plan_events/${source.id}` });
    }
  }
  const incidents = reconcileMainRepairsLocked(options.root, { evidenceRoot: options.evidenceRoot });
  for (const incident of incidents) {
    if (incident.owner === paths.id) events.push({ id: `incident-${digest(incident.id).slice(0, 55)}`, type: 'red-main',
      reference: `${options.root}/runner/programme-incidents.json#${incident.id}` });
    if (incident.status === 'resolved' && incident.dependents.some(item => item.programme === paths.id)) events.push({
      id: `resolved-${digest(incident.id).slice(0, 55)}`, type: 'dependency',
      reference: `${options.root}/runner/programme-incidents.json#${incident.id}/measurement` });
  }
  for (const [name, { state: project, file }] of projects) {
    const dependencies = project.plan_dependencies || [];
    if (!dependencies.length) continue;
    const available = dependencies.every(item => {
      const dependency = projects.get(item.project)?.state;
      return dependency && reviewedLanding(dependency) && dependency.goal_revision === item.goal_revision;
    });
    if (!available) continue;
    const id = `dep-${digest([name, project.goal_revision, dependencies]).slice(0, 60)}`;
    events.push({ id, type: 'dependency', reference: `${file}#plan_dependencies` });
    const release = project.dependency_release;
    if (!release || release.status !== 'waiting' || release.goal_revision !== project.goal_revision
      || project.phase !== 'plan_pending' || project.active_run || projectClaimHeld(options.root, paths.id, name) || mainIncidentHold(options.root, paths.id, name)) continue;
    assertProjectRecovery(project);
    const sent = join(paths.dir, name, PLAN_FILE);
    if (!existsSync(sent) || !isDeepStrictEqual(JSON.parse(readFileSync(sent, 'utf8')), project.contract)) continue;
    // The release and its outcome share one authoritative write. The next scan
    // repairs a programme acknowledgement lost after this write.
    const source = { id: `released-${digest([name, release.operation]).slice(0, 60)}`, type: 'dependency-released', goal_revision: release.goal_revision };
    project.revision++; project.phase = 'ready'; project.dependency_release.status = 'released';
    project.plan_events = [...(project.plan_events || []), source];
    writeJsonAtomic(file, project); hasNextAction = true;
    events.push({ id: `evt-${digest([name, source.goal_revision, source.id]).slice(0, 60)}`, type: 'dependency', reference: `${file}#plan_events/${source.id}` });
  }
  return { events, identities, hasNextAction };
}

/** Restart scan retains the event snapshot and unacknowledged operation intents.
 * Expiry fences old writers even if their process later returns. No signalling. */
export function reconcileProgrammeJobs(options, { dependencies = [] } = {}) {
  return transact(options, (state, journal, paths) => {
    const now = instant(options);
    const lease = journal.lease;
    if (lease && (lease.expires_at <= now || !(options.alive || processAlive)(lease.pid))) {
      journal.recoveries.push({ token: lease.token, run_id: lease.actor.run_id, job_id: lease.job_id, at: now,
        reason: lease.expires_at <= now ? 'lease-expired' : 'owner-gone' });
      releaseLease(journal); state.active_run = null;
      if (journal.mode === 'active' && journal.recoveries.filter(item => item.job_id === lease.job_id).length >= RECOVERY_ATTEMPT_LIMIT) {
        journal.mode = 'exception'; journal.exception = { code: 'planner-no-progress', reason: 'Repeated expired or orphaned planner deliveries without completing this job.', job_id: lease.job_id };
      }
    }
    if (journal.mode === 'waiting' && journal.wait.until !== null && journal.wait.until <= now) {
      if (journal.wait.operation) enqueue(state, journal, { id: `wait-${digest(journal.wait.operation).slice(0, 59)}`, type: 'failure', reference: `${paths.programme}#planner_jobs/wait_history/${journal.wait.operation}` });
      journal.mode = 'active'; journal.wait = null;
    }
    const sources = projectTriggers(paths, options, state, journal);
    for (const event of [...sources.events, ...dependencies]) enqueue(state, journal, event);
    for (const phase of (state.phases || []).filter(item => item.closed)) enqueue(state, journal, { id: `phase-${digest([paths.id, phase.n, phase.closed.reference]).slice(0, 58)}`,
      type: 'phase', reference: `${paths.programme}#phases/${phase.n}` });
    if (state.autonomy?.enabled && journal.mode === 'active' && !state.active_run && !journal.pending && !sources.hasNextAction) {
      // Stable across repeated scans of unchanged work, including after ack.
      enqueue(state, journal, { id: `idle-${digest([state.metadata.id, sources.identities]).slice(0, 59)}`,
        type: 'idle', reference: `${paths.programme}#idle` });
    }
  });
}

/** What either planner reads. The scan persists whatever sources hold, with
 * autonomy on or off, so a foreground planner sees what a claim would. */
export function listProgrammeEvents(options) {
  const state = reconcileProgrammeJobs({ ...options, anyRevision: true });
  const journal = jobs(state);
  const open = journal.pending?.event_ids || [];
  return { programme: options.programme, state_revision: state.revision, mode: journal.mode, autonomy: state.autonomy?.enabled === true,
    leased: journal.lease?.event_ids || [], events: journal.events.filter(item => open.includes(item.id)),
    pending_operations: journal.operations.filter(item => item.status === 'pending').map(({ intent }) => ({ id: intent.id, kind: intent.kind, project: intent.project })) };
}

/** Explicit, and only for what was observed: a lease names its snapshot, so an
 * event that arrived during it stays pending. A repeated ack is a read. */
export function acknowledgeProgrammeEvents(options, input) {
  return transact({ ...options, anyRevision: options.revision === undefined || options.revision === null }, (state, journal) => {
    const lease = authority(state, journal, options);
    const ids = input?.event_ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || typeof input.reference !== 'string' || !input.reference.trim()) throw new Error('ack names its event IDs and a decision reference');
    const unobserved = ids.filter(id => !journal.events.some(item => item.id === id) || (lease && !lease.event_ids.includes(id)));
    if (unobserved.length) throw new Error(`ack names unobserved events: ${unobserved.join(', ')}`);
    const open = ids.filter(id => journal.pending?.event_ids.includes(id));
    if (!open.length) return state;
    if (journal.operations.some(item => item.status === 'pending')) throw new Error('reconcile pending planner effects before acknowledging events');
    acknowledge(journal, open, input.reference, lease?.actor, instant(options));
  });
}

/** Opt-in event reconciliation only. No headless planner queue consumer is
 * installed; V1 and normal (capability-less) runners never enter this path. */
export function reconcileProgrammeQueue(root, { now = Date.now(), alive, say = () => {} } = {}) {
  const directory = join(root, PROGRAMS_HOME);
  if (!existsSync(directory)) return [];
  const pending = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && stable(item.name))) {
    if (!existsSync(join(directory, entry.name, PROGRAMME_STATE_FILE))) continue;
    try {
      const previous = readProgrammeState(root, entry.name);
      const state = reconcileProgrammeJobs({ root, programme: entry.name, revision: previous.revision, now, alive });
      if (state.autonomy?.enabled && state.planner_jobs?.mode === 'active' && state.planner_jobs.pending && !state.active_run) pending.push(entry.name);
    } catch (error) { say(`${entry.name}: programme job reconciliation refused — ${error.message}`); }
  }
  return pending;
}

function operationCheck(state, intent) {
  if (!CREATE_OPERATIONS.includes(intent.kind)) {
    const problems = planOperationProblems(intent);
    if (problems.length) throw new Error(problems.join('; '));
    return;
  }
  if (!stable(intent.id) || !stable(intent.project) || intent.expected_revision !== 0
    || intent.input?.project_id !== intent.project
    || intent.input?.programme.id !== state.metadata.id
    || Object.keys(intent).some(key => !['id', 'kind', 'project', 'expected_revision', 'input', ...(intent.kind === 'main-repair' ? ['incident', 'basis'] : [])].includes(key))) throw new Error('invalid planner operation intent');
  if (intent.kind === 'main-repair' && (!stable(intent.incident) || !intent.basis?.reference?.trim() || !Array.isArray(intent.basis.criteria) || !intent.basis.criteria.length || intent.basis.criteria.some(id => !intent.input?.success_criteria?.some(item => item.id === id)))) throw new Error('main repair needs assignment criteria and a scope rationale reference');
  const validation = validateAutonomousProject(intent.input, { programme: state.metadata, allowEmptyCriteria: intent.kind === 'new-goal' });
  if (!validation.ok) throw new Error(`invalid planner goal: ${validation.problems.join('; ')}`);
}
/** Persist decision first. Operation IDs are durable across planner run IDs. */
export function prepareProgrammeOperation(options, intent) {
  return transact(options, (state, journal) => {
    const lease = authority(state, journal, options);
    const previous = journal.operations.find(item => item.intent.id === intent.id);
    if (previous && previous.status !== 'refused' && !(options.reopen && previous.status === 'cancelled')) {
      if (!isDeepStrictEqual(previous.intent, intent)) throw new Error('planner operation ID already used with different content');
      return;
    }
    if (lease && journal.mode !== 'active') throw new Error('new planner effects require an active programme');
    if (lease?.completion) throw new Error('completed planner must exit before new decisions');
    const held = !lease && journal.operations.find(item => item.status === 'pending' && item.intent.project === intent.project);
    if (held) throw planningContention(`operation ${held.intent.id} on ${intent.project} is unresolved; repeat it or cancel it with mc programme operation cancel`);
    operationCheck(state, intent);
    if (previous) { previous.status = 'pending'; previous.result = null; return; }
    journal.operations.push({ intent: structuredClone(intent), status: 'pending', result: null });
  });
}
export function completeProgrammeOperation(options, intent, result) {
  return transact(options, (state, journal) => {
    authority(state, journal, options);
    const operation = journal.operations.find(item => item.intent.id === intent.id);
    if (!operation || !isDeepStrictEqual(operation.intent, intent)) throw new Error('persisted planner intent required');
    if (operation.status === 'applied') {
      if (!isDeepStrictEqual(operation.result, result)) throw new Error('planner effect result is immutable');
      return;
    }
    const file = autonomousPaths(options.root, options.programme, intent.project).project;
    const effect = JSON.parse(readFileSync(file, 'utf8'));
    const receipt = effect.operation_receipts?.find(receipt => receipt.id === intent.id && receipt.kind === intent.kind
      && receipt.digest === autonomousOperationDigest(CREATE_OPERATIONS.includes(intent.kind) ? intent.input : intent));
    if (!receipt || result.project !== intent.project || (CREATE_OPERATIONS.includes(intent.kind) ? result.revision !== 1 : !isDeepStrictEqual(result, receipt.result))) throw new Error('matching committed project effect receipt required');
    operation.status = 'applied'; operation.result = structuredClone(result);
  });
}

/** The committed side of an intent: its receipt, which the effect wrote. */
export function programmeOperationCommitted(root, programme, intent) {
  const file = autonomousPaths(root, programme, intent.project).project;
  return existsSync(file) && !!JSON.parse(readFileSync(file, 'utf8')).operation_receipts?.some(item => item.id === intent.id);
}

/** A refused effect wrote nothing, so its intent steps aside and the same command
 * can run again. A crash never gets here: its intent stays pending for replay. */
export function withdrawProgrammeOperation(options, id, reason) {
  return transact({ ...options, anyRevision: true }, (state, journal) => {
    const operation = journal.operations.find(item => item.intent.id === id);
    if (operation?.status !== 'pending' || programmeOperationCommitted(options.root, options.programme, operation.intent)) return state;
    try { authority(state, journal, options); } catch { return state; }
    operation.status = 'refused'; operation.result = { reason };
  });
}

/** A stale uncommitted decision is explicitly superseded, never silently rebased.
 * A committed receipt must be reconciled instead of being discarded. */
export function cancelProgrammeOperation(options, { id, reason }) {
  return transact(options, (state, journal) => {
    authority(state, journal, options);
    const operation = journal.operations.find(item => item.intent.id === id);
    if (!operation || typeof reason !== 'string' || !reason.trim()) throw new Error('a known operation and cancellation reason are required');
    if (operation.status !== 'pending') throw new Error('only pending decisions can be cancelled');
    if (programmeOperationCommitted(options.root, options.programme, operation.intent)) throw new Error('committed effect must be reconciled, not cancelled');
    cancelMainRepairLocked(options.root, options.programme, id, reason);
    operation.status = 'cancelled'; operation.result = { reason };
  });
}

/** A process exit alone never acknowledges a planner delivery. */
export function completeProgrammePlan(options, input) {
  return transact(options, (state, journal) => {
    const lease = owned(state, journal, options);
    if (!input || Object.keys(input).sort().join(',') !== 'event_ids,reference' || typeof input.reference !== 'string' || !input.reference.trim()
      || !isDeepStrictEqual(input.event_ids, lease.event_ids)) throw new Error('completion must account for the claimed event snapshot and name its decision reference');
    if (journal.operations.some(item => item.status === 'pending')) throw new Error('reconcile pending planner effects before completion');
    if (lease.completion && !isDeepStrictEqual(lease.completion, input)) throw new Error('planner completion is immutable');
    lease.completion = structuredClone(input);
  });
}

/** Failed/incomplete sessions retain the same job and operation identities. */
export function yieldProgrammeJob(options, reason, { retry = false } = {}) {
  return transact(options, (state, journal) => {
    const lease = owned(state, journal, options);
    journal.recoveries.push({ token: lease.token, run_id: lease.actor.run_id, job_id: lease.job_id, at: instant(options), reason });
    if (retry && journal.mode === 'active') {
      const failures = journal.recoveries.filter(item => item.job_id === lease.job_id).length;
      if (failures >= RECOVERY_ATTEMPT_LIMIT) {
        journal.mode = 'exception'; journal.exception = { code: 'planner-no-progress', reason, attempts: failures, job_id: lease.job_id };
      } else {
        journal.mode = 'waiting'; journal.wait = { kind: 'resource', reason, until: instant(options) + failures * 30_000 };
      }
    }
    releaseLease(journal);
    return { ...state, active_run: null, planner_jobs: journal };
  });
}

/** Stop intent and effect fit in one authoritative write. No agreement edits.
 * Foreground and leased planning share it; it leaves `autonomy` as the user set it. */
export function reachProgrammeStop(options, input) {
  return transact(options, (state, journal, paths) => {
    const lease = authority(state, journal, options);
    if (!input || Object.keys(input).some(key => !['id', 'reference', 'stop'].includes(key)) || !stable(input.id)
      || typeof input.reference !== 'string' || !input.reference.trim()) throw new Error('stop decision needs identity and evidence reference');
    const previous = journal.operations.find(item => item.intent.id === input.id);
    const intent = { ...input, kind: 'reach-stop' };
    if (previous) {
      if (!isDeepStrictEqual(previous.intent, intent)) throw new Error('planner operation ID already used with different content');
      return;
    }
    if (lease?.completion) throw new Error('completed planner must exit before new decisions');
    if (journal.mode !== 'active' || (input.stop !== undefined && !stable(input.stop))) throw new Error('stop needs an active planner and an explicit stable ID');
    if (journal.operations.some(item => item.status === 'pending')) throw new Error('reconcile pending planner effects before stopping');
    for (const entry of readdirSync(paths.dir, { withFileTypes: true }).filter(item => item.isDirectory() && stable(item.name))) {
      const file = join(paths.dir, entry.name, AUTONOMOUS_STATE_FILE);
      if (!existsSync(file)) continue;
      const project = JSON.parse(readFileSync(file, 'utf8'));
      if (project.active_run || ['running', 'handoff_requested', 'closing', 'publishing', 'reviewing', 'landing'].includes(project.phase)
        || projectClaimHeld(options.root, options.programme, entry.name)) throw new Error('affected runs must close before reaching the planned stop');
    }
    const stop = input.stop ?? input.id;
    journal.operations.push({ intent, status: 'applied', result: { stop } });
    journal.mode = 'stopped'; journal.stop = stop;
    journal.reached_stop = { stop, reference: input.reference, condition: state.autonomy?.stop ?? null, run_id: lease?.actor.run_id ?? null };
  });
}

/** Concrete idempotent effect, not an exactly-once process claim. A crash after
 * AUTONOMOUS_STATE but before DRAFT/ack reads the same receipt on retry. Other
 * goal effects use their own atomic receipts through programme-plan. */
export function createProgrammeJobProject(options, intent) {
  let state = prepareProgrammeOperation(options, intent);
  const operation = state.planner_jobs.operations.find(item => item.intent.id === intent.id);
  if (operation.status === 'applied') return operation.result;
  if (operation.status === 'cancelled') throw new Error('planner decision was cancelled; use a new operation ID');
  // Read back committed effects even when the programme metadata/mode changed.
  // A missing effect still needs current ownership before any new write.
  const path = autonomousPaths(options.root, options.programme, intent.project).project;
  const effect = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const committed = effect?.operation_receipts?.some(receipt => receipt.id === intent.id
    && receipt.kind === intent.kind && receipt.digest === autonomousOperationDigest(intent.input));
  if (!committed) {
    operationCheck(state, intent);
    if (state.planner_jobs.lease && state.planner_jobs.mode !== 'active') throw new Error('programme waits before applying planner effect');
  }
  createAutonomousDraft(options.root, options.programme, intent.project, intent.input,
    { ...options.deps, actor: options.actor, token: options.token, revision: state.revision, operationId: intent.id, operationKind: intent.kind, ...(intent.kind === 'main-repair' ? { mainIncident: intent.incident } : {}), now: () => instant(options) });
  state = readProgrammeState(options.root, options.programme);
  const result = { project: intent.project, revision: 1 };
  completeProgrammeOperation({ ...options, revision: state.revision }, intent, result);
  return result;
}

/** Planner-owned external waits and precise exceptions, not design checkpoints.
 * Intent and hold commit together; expiry creates another durable delivery.
 * Foreground and leased planning share it. */
export function holdProgrammePlan(options, intent) {
  return transact(options, (state, journal) => {
    const lease = authority(state, journal, options);
    const previous = journal.operations.find(item => item.intent.id === intent?.id);
    if (previous) {
      if (!isDeepStrictEqual(previous.intent, intent)) throw new Error('planner operation ID already used with different content');
      return;
    }
    if (!stable(intent?.id) || !['wait-programme', 'exception-programme'].includes(intent.kind)
      || Object.keys(intent).some(key => !['id', 'kind', 'reference', 'condition', 'wait', 'exception'].includes(key))
      || !intent.reference?.trim() || journal.mode !== 'active' || lease?.completion) throw new Error('hold needs current planner authority and a diagnosis reference');
    if (journal.operations.some(item => item.status === 'pending')) throw new Error('reconcile pending planner effects before waiting');
    if (intent.kind === 'wait-programme') {
      if (!stable(intent.condition) || !boundedRecoveryWait(intent.wait, instant(options)) || intent.exception !== undefined) throw new Error('external wait needs a condition and a bounded retry within 24 hours, or explicit external dependency');
      recordRecoveryWait(journal, intent, lease?.actor.run_id ?? null);
    } else {
      if (!stable(intent.exception?.code) || !intent.exception.reason?.trim() || Object.keys(intent.exception).some(key => !['code', 'reason'].includes(key)) || intent.wait !== undefined || intent.condition !== undefined) throw new Error('exception needs its precise code and reason');
      journal.mode = 'exception'; journal.exception = { ...intent.exception, reference: intent.reference };
    }
    journal.operations.push({ intent: structuredClone(intent), status: 'applied', result: { mode: journal.mode } });
  });
}
