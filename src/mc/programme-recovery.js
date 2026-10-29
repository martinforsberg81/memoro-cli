/** Inactive recovery policy and shared main incidents. All *Locked writers run
 * inside autonomous-state's programme + strict root register transaction. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-write.js';
import { validateAutonomousProject, validateAutonomousEvidence } from './autonomous-project.js';
import { STABLE_ID_RE } from './programme-contract.js';

export const RECOVERY_ATTEMPT_LIMIT = 3;
export const MAX_RECOVERY_WAIT_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = value => typeof value === 'string' && STABLE_ID_RE.test(value);
const text = value => typeof value === 'string' && !!value.trim();
export const recoveryProgress = state => [...new Set(state.evidence.builder.filter(item => item.status === 'verified').map(item => item.criterion_id))].sort();

/** Goal/session changes never erase unsuccessful approaches or retry counts.
 * Only a newly verified criterion is progress, not output or another commit. */
export function projectRecovery(state) {
  const attempts = state.attempts;
  const progress = recoveryProgress(state);
  let no_progress = 0;
  for (const attempt of [...attempts].reverse()) {
    if (!isDeepStrictEqual(attempt.progress || [], progress)) break;
    no_progress++;
  }
  return { attempt_ids: attempts.map(item => item.id), no_progress,
    exception: no_progress >= RECOVERY_ATTEMPT_LIMIT ? { code: 'no-progress', reason: `${no_progress} incomplete attempts without a new verified criterion`, reference: 'attempts' } : null,
    latest_diagnosis: state.recovery_diagnoses?.at(-1) || null };
}
export function assertProjectRecovery(state) {
  const report = state.review_reports?.at(-1);
  if (report && !report.clean && report.session.assignment.goal_revision === state.goal_revision
    && report.session.assignment.programme.revision === state.programme_revision) throw new Error('review findings require a planner revision or a new goal, never direct build');
  const recovery = projectRecovery(state);
  if (recovery.exception) throw new Error(`recovery exception: ${recovery.exception.reason}; retain diagnosis for plan`);
  if (recovery.latest_diagnosis?.action === 'exception' && recovery.latest_diagnosis.goal_revision === state.goal_revision) throw new Error(`recovery exception: ${recovery.latest_diagnosis.diagnosis}`);
  if (!state.attempts.length) return;
  const diagnosis = recovery.latest_diagnosis;
  if (!diagnosis || diagnosis.action !== 'retry' || diagnosis.goal_revision !== state.goal_revision
    || diagnosis.programme_revision !== state.programme_revision || !isDeepStrictEqual(diagnosis.attempt_ids, recovery.attempt_ids)) {
    throw new Error('incomplete attempts require a current planner diagnosis and a different approach');
  }
}
export function recoveryDiagnosisProblems(input) {
  if (!input || Object.keys(input).some(key => !['action', 'attempt_ids', 'diagnosis', 'approach'].includes(key))
    || !['retry', 'exception'].includes(input.action) || !Array.isArray(input.attempt_ids)
    || input.attempt_ids.some(id => !stable(id)) || !text(input.diagnosis)
    || input.action === 'retry' && !text(input.approach)
    || input.action === 'exception' && input.approach !== undefined) return ['diagnosis needs exact attempt IDs, diagnosis and a new retry approach or explicit exception'];
  return [];
}
export function boundedRecoveryWait(wait, now) {
  return wait && ['quota', 'network', 'resource', 'external'].includes(wait.kind) && text(wait.reason)
    && Object.keys(wait).every(key => ['kind', 'reason', 'until'].includes(key))
    && (wait.kind === 'external' && wait.until === null
      || Number.isSafeInteger(wait.until) && wait.until > now && wait.until <= now + MAX_RECOVERY_WAIT_MS);
}

export const programmeIncidentsPath = root => join(root, 'runner', 'programme-incidents.json');
export function readProgrammeIncidents(root) {
  const file = programmeIncidentsPath(root);
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.incidents) || value.incidents.some(item => !stable(item.id)
    || !stable(item.repo) || !text(item.failure) || !stable(item.owner) || !['open', 'resolved'].includes(item.status)
    || !Array.isArray(item.observations) || !item.observations.length || item.observations.some(observation => !text(observation.source) || !text(observation.reference))
    || new Set(item.observations.map(observation => observation.source)).size !== item.observations.length || !Array.isArray(item.dependents)
    || item.dependents.some(dependent => !stable(dependent.programme) || !stable(dependent.project))
    || item.repair && (!stable(item.repair.project) || !stable(item.repair.operation))
    || item.repair_history && (!Array.isArray(item.repair_history) || item.repair_history.some(repair => !stable(repair.project) || !stable(repair.operation) || repair.status !== 'cancelled' || !text(repair.reason)))
    || item.status === 'resolved' && (!item.repair || !stable(item.confirmation?.project) || !Number.isSafeInteger(item.confirmation.goal_revision) || item.confirmation.goal_revision < 1 || !text(item.confirmation.reference)))) throw new Error('shared main incidents are unreadable; preserve the wait');
  if (new Set(value.incidents.map(item => item.id)).size !== value.incidents.length) throw new Error('duplicate shared main incident');
  const sources = value.incidents.flatMap(item => item.observations.map(observation => observation.source));
  if (new Set(sources).size !== sources.length) throw new Error('duplicate shared main observation');
  return value.incidents;
}
const saveIncidents = (root, incidents) => writeJsonAtomic(programmeIncidentsPath(root), { version: 1, incidents });

/** Observation commits first. Replaying a source repairs the programme outbox;
 * it never reopens an old resolved incident or chooses a second repair owner. */
export function observeMainIncidentLocked(root, { programme, project, repo, failure, source, reference }) {
  if (![programme, project, repo].every(stable) || !text(failure) || !text(source) || !text(reference)) throw new Error('main failure needs repository, identity and immutable diagnosis reference');
  const incidents = readProgrammeIncidents(root);
  let incident = incidents.find(item => item.observations.some(item => item.source === source));
  if (incident && (incident.repo !== repo || incident.failure !== failure)) throw new Error('main failure source identity changed');
  incident ||= incidents.find(item => item.repo === repo && item.failure === failure && item.status === 'open');
  if (!incident) {
    incident = { id: `main-${digest([repo, failure, source]).slice(0, 59)}`, repo, failure, owner: programme,
      status: 'open', observations: [], dependents: [], repair: null };
    incidents.push(incident);
  }
  const before = JSON.stringify(incidents);
  const observation = { source, reference };
  const previous = incident.observations.find(item => item.source === source);
  if (previous && !isDeepStrictEqual(previous, observation)) throw new Error('main failure observation changed');
  if (!previous) incident.observations.push(observation);
  if (!incident.dependents.some(item => item.programme === programme && item.project === project)) incident.dependents.push({ programme, project });
  if (!existsSync(programmeIncidentsPath(root)) || JSON.stringify(incidents) !== before) saveIncidents(root, incidents);
  return structuredClone(incident);
}

/** Persist a single repair target before creation. The create receipt repairs
 * crashes on either side. Scope rationale remains plan's responsibility. */
export function reserveMainRepairLocked(root, { incident: id, programme, project, operation, repo }) {
  const incidents = readProgrammeIncidents(root); const incident = incidents.find(item => item.id === id);
  if (!incident || incident.owner !== programme || incident.status !== 'open' || incident.repo !== repo) throw new Error('main repair belongs to its owning programme plan and repository');
  if (incident.repair_history?.some(item => item.operation === operation)) throw new Error('main repair reservation was cancelled; use a new operation ID');
  const repair = { project, operation };
  if (incident.repair && !isDeepStrictEqual(incident.repair, repair)) throw new Error('shared main incident already has one repair project');
  if (!incident.repair) { incident.repair = repair; saveIncidents(root, incidents); }
}
/** Cancellation fences the reservation before journal acknowledgement. A crash
 * can leave the journal pending, but can never resurrect its cancelled target. */
export function cancelMainRepairLocked(root, programme, operation, reason) {
  const incidents = readProgrammeIncidents(root);
  const incident = incidents.find(item => item.owner === programme && item.repair?.operation === operation);
  if (!incident) return;
  const file = join(root, 'programs', programme, incident.repair.project, 'AUTONOMOUS_STATE.json');
  if (existsSync(file)) throw new Error('committed main repair must be reconciled, not cancelled');
  incident.repair_history = [...(incident.repair_history || []), { ...incident.repair, status: 'cancelled', reason }];
  incident.repair = null; saveIncidents(root, incidents);
}
export function reconcileMainRepairsLocked(root) {
  const incidents = readProgrammeIncidents(root); let changed = false;
  for (const incident of incidents.filter(item => item.status === 'open' && item.repair)) {
    const file = join(root, 'programs', incident.owner, incident.repair.project, 'AUTONOMOUS_STATE.json');
    if (!existsSync(file)) continue; // reserved target; creation receipt will reconcile
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.schema !== 'mc-autonomous-state' || !validateAutonomousProject(state.contract).ok || !validateAutonomousEvidence(state.evidence).ok
      || state.goal_revision !== state.contract.goal_revision || state.programme_revision !== state.contract.programme.revision || state.contract?.project_id !== incident.repair.project
      || state.contract?.repo !== incident.repo || state.contract?.programme.id !== incident.owner) throw new Error('shared main repair identity is unreadable');
    const confirmation = state.evidence?.confirmation;
    if (state.confirmed && state.phase === 'confirmed' && confirmation?.role === 'plan'
      && confirmation.goal_revision === state.goal_revision && confirmation.programme_revision === state.programme_revision) {
      incident.status = 'resolved'; incident.confirmation = { project: incident.repair.project, goal_revision: state.goal_revision, reference: confirmation.reference }; changed = true;
    }
  }
  if (changed) saveIncidents(root, incidents);
  return incidents;
}
export function mainIncidentHold(root, programme, project) {
  return readProgrammeIncidents(root).find(item => item.status === 'open'
    // The ordinary repair may observe the same red again. Its own incident
    // must not become a dependency on its not-yet-confirmed self.
    && !(item.owner === programme && item.repair?.project === project)
    && item.dependents.some(item => item.programme === programme && item.project === project)) || null;
}

/** A diagnosed repair may inspect/build from a known red *starting* gate.
 * This never changes its verdict or the publication/merge green requirement.
 * Unknown, running, command-failed and unrelated red measurements still hold. */
export function mainRepairPreflight({ root, programme, project, summary, content, base }) {
  try {
    const incidents = readProgrammeIncidents(root).filter(item => item.status === 'open' && item.owner === programme && item.repair?.project === project);
    if (!incidents.length || summary?.exit !== 1 || summary.ok !== false || !summary.red_tests?.length) return false;
    const receipt = JSON.parse(readFileSync(summary.evidence.path, 'utf8'));
    const tests = receipt.execution?.tests;
    return receipt.schema === 'mc-session-gate-evidence' && receipt.version === 1 && receipt.outcome === 'red' && receipt.exit === 1
      && receipt.repo === incidents[0].repo && receipt.base === base && receipt.repository === content.repository
      && receipt.tree === content.tree && receipt.fingerprint === content.fingerprint
      && receipt.coverage?.kind === 'affected' && receipt.coverage.pattern === null
      && tests?.finished === true && tests.exit === 1 && tests.totals.fail > 0 && !tests.totals.cancelled
      && receipt.execution.commands.every(item => item.ok === true && item.exit === 0)
      && summary.red_tests.every(item => incidents.some(incident => incident.failure === item.file));
  } catch { return false; }
}
