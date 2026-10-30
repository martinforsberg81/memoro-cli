/** Read-only programme status: what runs, what evidence it rests on, who acts
 * next and where it stops. Nothing here writes, launches or repairs. A missing
 * observation is `unknown`, never zero, green or done. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProgrammeState, readAutonomousState, currentAutonomousEvidence, PUBLICATION_PHASES, AUTONOMOUS_STATE_FILE, PROGRAMME_STATE_FILE } from './autonomous-state.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { installationCapabilities, missingCapabilities } from './programme-control.js';
import { mainIncidentHold } from './programme-recovery.js';
import { reviewRoutePending } from './autonomous-outcomes.js';
import { readClaim, processAlive } from './resource-claim.js';
import { PROGRAMS_HOME } from './paths.js';
import { PLAN_FILE } from './plan-source.js';

export const UNKNOWN = 'unknown';
const BUSY = ['running', 'handoff_requested', 'closing', 'publishing', 'reviewing', 'landing'];
const model = value => (value?.tool && value?.model ? `${value.tool}:${value.model}` : UNKNOWN);
const iso = ms => (Number.isSafeInteger(ms) ? new Date(ms).toISOString() : UNKNOWN);

/** The programmes under the work root that keep autonomous state. */
export function listAutonomousProgrammes(root) {
  const dir = join(root, PROGRAMS_HOME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name) && existsSync(join(dir, item.name, PROGRAMME_STATE_FILE)))
    .map(item => item.name).sort();
}

function claimHolder(root, programme, project) {
  const path = join(root, 'runner', 'autonomous-builds', programme, `${project}.claim`);
  if (!existsSync(path)) return null;
  const claim = readClaim(path);
  if (!claim) return { pid: null, alive: UNKNOWN };
  return { pid: claim.pid, alive: processAlive(claim.pid) };
}

function evidenceQuality(state, criteria, report) {
  if (state.confirmed) return 'confirmed by plan';
  const premerge = criteria.filter(item => item.verification === 'premerge');
  if (report?.current && report.clean) return 'clean independent review of the published head';
  if (report?.current) return 'review findings for plan';
  const verified = premerge.filter(item => item.builder === 'verified').length;
  if (!criteria.some(item => item.builder !== UNKNOWN)) return 'none for this goal revision';
  return verified === premerge.length ? 'builder reports every premerge criterion; not yet reviewed' : 'partial builder reports';
}

function gateState(state) {
  const p = state.publication;
  if (!p || p.goal_revision !== state.goal_revision || p.programme_revision !== state.programme_revision) {
    return state.session_control?.phase === 'running' || state.session_control?.phase === 'closing' ? 'not yet measured' : 'none recorded';
  }
  return PUBLICATION_PHASES.indexOf(p.phase) >= PUBLICATION_PHASES.indexOf('gate_verified') ? `green receipt ${p.gate_run || UNKNOWN}` : 'not yet verified';
}

function goalAction(root, state, holds) {
  if (state.confirmed) return 'none — confirmed by plan';
  const run = state.active_run;
  if (run?.role === 'step') return `build session ${run.run_id} ${state.session_control?.phase || state.phase}`;
  if (run?.role === 'review') return `independent review ${run.run_id} running`;
  if (run?.role === 'plan') return `plan run ${run.run_id} holds the goal`;
  if (holds.incident) return `wait for shared main repair ${holds.incident}`;
  if (holds.claim) return 'wait for the builder claim to be reconciled';
  if (BUSY.includes(state.phase) && state.phase !== 'landing') return `recover the interrupted ${state.phase} session`;
  if (state.phase === 'ready') return 'start a build session';
  if (state.phase === 'review_ready') return 'start an independent review';
  if (state.phase === 'landing') return `merger lands #${state.ownership.pr ?? UNKNOWN}`;
  if (state.phase === 'landed') return 'plan confirms the landed delivery';
  let route = false;
  try { route = reviewRoutePending(root, state); } catch { return 'unknown — merge queue unreadable'; }
  if (route) return 'submit the clean review for merge';
  if (state.dependency_release?.status === 'waiting') return `wait for ${state.plan_dependencies.map(item => item.project).join(', ')} to be confirmed`;
  return 'plan decides the next step for this goal';
}

/** One autonomous goal. An unreadable state is reported, not skipped. */
export function goalStatus(root, programme, project, approvedRevision = null) {
  let state;
  try { state = readAutonomousState(root, programme, project); }
  catch (error) { return { project, problem: error.message, next_action: `${UNKNOWN} — state preserved for recovery` }; }
  const current = currentAutonomousEvidence(state);
  const latestReview = current.reviews.at(-1) || null;
  const criteria = state.contract.success_criteria.map(item => {
    const build = current.builder.filter(entry => entry.criterion_id === item.id).at(-1);
    return { id: item.id, verification: item.verification, builder: build?.status || UNKNOWN, reference: build?.reference ?? null,
      review: latestReview?.criteria.find(entry => entry.criterion_id === item.id)?.status || UNKNOWN };
  });
  const last = state.review_reports?.at(-1) || null;
  const report = last ? { id: last.id, clean: last.clean, head: last.session.head,
    current: last.session.assignment.goal_revision === state.goal_revision && last.session.assignment.programme.revision === state.programme_revision
      && last.session.head === state.publication?.head,
    findings: state.evidence.reviews.find(item => item.id === last.id)?.findings || [] } : null;
  const control = state.session_control || null;
  const context = control?.context;
  const holds = { incident: mainIncidentHold(root, programme, project)?.id || null, claim: null };
  const claim = claimHolder(root, programme, project);
  if (claim && !state.active_run && claim.alive !== false) holds.claim = claim;
  const builders = (state.model_history || []).filter(item => item.goal_revision === state.goal_revision).map(item => model(item.model));
  const stale = state.evidence.builder.length + state.evidence.reviews.length - current.builder.length - current.reviews.length;
  return {
    project, phase: state.phase, state_revision: state.revision, goal_revision: state.goal_revision,
    programme_revision: state.programme_revision, aligned: approvedRevision === null ? UNKNOWN : state.programme_revision === approvedRevision,
    confirmed: state.confirmed, branch: state.ownership.branch, pr: state.ownership.pr, active_run: state.active_run,
    criteria,
    evidence: { quality: evidenceQuality(state, criteria, report), gate: gateState(state),
      premerge_verified: criteria.filter(item => item.verification === 'premerge' && item.builder === 'verified').length,
      premerge_total: criteria.filter(item => item.verification === 'premerge').length,
      stale_observations: stale, incomplete_attempts: state.attempts.filter(item => item.goal_revision === state.goal_revision).length },
    review: report,
    models: { builders: [...new Set(builders)], reviewer_reserved: state.reviewer_model ? model(state.reviewer_model) : null,
      reviewer_actual: last ? model(last.session.model) : state.review_session ? model(state.review_session.model) : null },
    session: control ? { run_id: control.binding.run_id, phase: control.phase, reason: control.reason,
      activity: control.observation.activity.kind,
      context: context && context.fraction !== null ? { fraction: context.fraction, quality: context.quality, source: context.source }
        : { fraction: UNKNOWN, quality: context?.quality || UNKNOWN, source: context?.source || null },
      active_ms: control.totals.active_ms, failures: control.history.failures, stagnant_sessions: control.history.stagnant_sessions } : null,
    publication: state.publication ? { run_id: state.publication.run_id, phase: state.publication.phase,
      head: state.publication.head || null, pr: state.publication.pr ?? null } : null,
    merge: state.merge_handoff ? { status: state.merge_handoff.status, pr: state.merge_handoff.binding?.pr ?? null } : null,
    landing: state.landing?.merge_commit ? { merge_commit: state.landing.merge_commit, merged_into: state.landing.merged_into } : null,
    waits: [
      ...(holds.incident ? [`shared main repair ${holds.incident}`] : []),
      ...(holds.claim ? [`builder claim held by pid ${holds.claim.pid ?? UNKNOWN}`] : []),
      ...(state.dependency_release?.status === 'waiting' ? [`dependencies ${state.plan_dependencies.map(item => item.project).join(', ')}`] : []),
    ],
    next_action: goalAction(root, state, holds),
  };
}

function legacyGoals(root, programme) {
  const dir = join(root, PROGRAMS_HOME, programme);
  return readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name)
    && !existsSync(join(dir, item.name, AUTONOMOUS_STATE_FILE)) && existsSync(join(dir, item.name, PLAN_FILE)))
    .filter(item => {
      try { return JSON.parse(readFileSync(join(dir, item.name, PLAN_FILE), 'utf8')).version === 1; } catch { return false; }
    }).map(item => item.name).sort();
}

function programmeAction(status, journal) {
  const mode = status.mode;
  if (mode === 'inactive') return 'none — not started; mc programme start';
  if (mode === 'paused') return status.in_flight.length
    ? `none new — paused; ${status.in_flight.length} started operation${status.in_flight.length === 1 ? '' : 's'} finishing`
    : 'none — paused; mc programme resume';
  if (mode === 'stopped') return `none — planned stop ${journal.stop} reached; going further needs a new agreement`;
  if (mode === 'exception') return `none — exception ${journal.exception.code || ''}: ${journal.exception.reason}`.replace(' :', ':');
  if (mode === 'waiting') return journal.wait.until === null ? `wait for external ${journal.wait.reason}` : `retry after ${iso(journal.wait.until)} (${journal.wait.kind})`;
  if (!status.execution.supported) return 'none — this installation cannot run autonomous work';
  if (status.plan.lease) return `plan session ${status.plan.lease.run_id} running`;
  if (status.plan.pending_events) return `plan session for ${status.plan.pending_events} pending event${status.plan.pending_events === 1 ? '' : 's'}`;
  const goal = status.goals.find(item => !/^(none|plan decides)/u.test(item.next_action));
  return goal ? `${goal.project}: ${goal.next_action}` : 'plan reviews the programme (idle check)';
}

/** Everything `mc programme status` says. `capabilities` defaults to what this
 * installation reports. Damaged programme state is reported as a problem. */
export function programmeStatus(root, programme, deps = {}) {
  const report = installationCapabilities(deps);
  const missing = missingCapabilities(report);
  const execution = { supported: !missing.length, missing, reason: missing.length ? report.reason || null : null };
  // No state file is no autonomous programme — a mistyped name or v1 only — never damage.
  if (!STABLE_ID_RE.test(programme) || !existsSync(join(root, PROGRAMS_HOME, programme, PROGRAMME_STATE_FILE))) {
    return { programme, mode: 'none', problem: `no ${PROGRAMME_STATE_FILE} — not an autonomous programme; v1 projects are in mc status`,
      execution, goals: [], legacy: [], in_flight: [], next_action: 'none — nothing autonomous to run' };
  }
  let state;
  try { state = readProgrammeState(root, programme); }
  catch (error) { return { programme, mode: UNKNOWN, problem: error.message, execution, goals: [], legacy: [], in_flight: [], next_action: `${UNKNOWN} — programme state preserved for recovery` }; }
  const journal = state.planner_jobs || { mode: 'inactive', wait: null, stop: null, pending: null, lease: null, operations: [] };
  const agreement = state.approved.at(-1) || null;
  const dir = join(root, PROGRAMS_HOME, programme);
  const projects = readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name)
    && existsSync(join(dir, item.name, AUTONOMOUS_STATE_FILE))).map(item => item.name).sort();
  const goals = projects.map(project => goalStatus(root, programme, project, agreement?.revision ?? null));
  const activation = journal.activation || null;
  const target = activation?.stop || null;
  const stopOf = id => agreement?.planned_stops.find(item => item.id === id)?.condition || UNKNOWN;
  const lease = journal.lease ? { run_id: journal.lease.actor.run_id, expires_at: iso(journal.lease.expires_at), job_id: journal.lease.job_id } : null;
  const in_flight = [
    ...(lease ? [`plan ${lease.run_id} (lease until ${lease.expires_at})`] : []),
    ...goals.filter(goal => goal.active_run).map(goal => `${goal.active_run.role} ${goal.active_run.run_id} on ${goal.project} (${goal.phase})`),
    ...goals.filter(goal => !goal.active_run && goal.waits?.some(item => item.startsWith('builder claim'))).map(goal => `builder claim on ${goal.project}`),
    ...goals.filter(goal => goal.merge?.status === 'pending').map(goal => `merge of #${goal.merge.pr} for ${goal.project} (queued before any pause; the merge door rechecks the mode)`),
  ];
  const pendingOperations = (journal.operations || []).filter(item => item.status === 'pending').map(item => `${item.intent.kind} ${item.intent.id}`);
  const status = {
    programme, state_revision: state.revision, mode: journal.mode, execution,
    agreement: { approved_revision: agreement?.revision ?? null, draft_revision: state.draft?.revision ?? null,
      approved_by: agreement?.approval?.by || null },
    activation: activation ? { at: activation.at, by: activation.by, programme_revision: activation.programme_revision,
      build: { class: activation.profiles.build.class }, review: { model: model(activation.profiles.review.model) } } : null,
    planned_stop: { target, condition: target ? stopOf(target) : null, reached: journal.mode === 'stopped' ? journal.stop : null,
      agreed: (agreement?.planned_stops || []).map(item => item.id) },
    plan: { owner: 'plan', active_run: state.active_run, lease, pending_events: journal.pending?.event_ids.length || 0,
      pending_operations: pendingOperations },
    wait: journal.mode === 'waiting' ? { kind: journal.wait.kind, reason: journal.wait.reason, until: journal.wait.until === null ? null : iso(journal.wait.until) } : null,
    exception: journal.mode === 'exception' ? { code: journal.exception.code || null, reason: journal.exception.reason } : null,
    pause: journal.pause ? { by: journal.pause.by, at: journal.pause.at, previous: journal.pause.previous.mode } : null,
    goals, legacy: legacyGoals(root, programme), in_flight,
  };
  status.next_action = programmeAction(status, journal);
  return status;
}

/** The page's AUTONOMY lines, or null when no programme keeps autonomous
 * state. One programme's damage is its own line, never the page's failure. */
export function autonomySection({ root, deps = {} } = {}) {
  let names = [];
  try { names = listAutonomousProgrammes(root); } catch { return null; }
  if (!names.length) return null;
  return { programmes: names.map(name => {
    const status = programmeStatus(root, name, deps);
    return { programme: name, mode: status.mode, goals: status.goals.length, in_flight: status.in_flight.length,
      stop: status.planned_stop?.target || null, next_action: status.next_action, problem: status.problem || null };
  }) };
}

/** `mc programme capabilities`: whether start can succeed here and, per
 * control capability and tool transport, what is built, proven and missing. */
export function capabilityReport(deps = {}) {
  const report = installationCapabilities(deps);
  const missing = missingCapabilities(report);
  return { supported: !missing.length, missing, reason: missing.length ? report.reason || null : null,
    capabilities: report.capabilities || [], transport: report.transport || [] };
}

/* ------------------------------------------------------------------ render */

const clip = (value, max) => {
  const one = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function renderCapabilities(report) {
  const out = [report.supported ? 'autonomous execution — supported by this installation'
    : `autonomous execution — not supported here: ${report.reason || 'unsupported'}`];
  if (!report.supported) out.push(`  start refuses — missing ${report.missing.join(', ')}`);
  const sub = (key, value) => out.push(`    ${key.padEnd(9)} ${value}`);
  if (report.capabilities.length) { out.push(''); out.push('CAPABILITIES'); }
  for (const item of report.capabilities) {
    out.push(`  ${item.name}`);
    sub('built', item.built); sub('proven', item.proven); if (item.missing) sub('missing', item.missing);
  }
  if (report.transport.length) { out.push(''); out.push('TRANSPORT (version and help probes, 2026-10-28)'); }
  for (const item of report.transport) {
    out.push(`  ${item.tool}`);
    sub('prompt', item.prompt); sub('control', item.live_control); sub('context', item.context); sub('measured', item.measured);
  }
  return `${out.join('\n')}\n`;
}

export function renderProgrammeStatus(status) {
  const out = [`programme ${status.programme} — autonomous · ${status.mode}`];
  const row = (key, value) => out.push(`  ${key.padEnd(11)} ${value}`);
  if (status.problem) { row('problem', status.problem); row('next', status.next_action); return `${out.join('\n')}\n`; }
  row('execution', status.execution.supported ? 'supported by this installation'
    : `not supported here — ${status.execution.reason || 'unsupported'} (missing ${status.execution.missing.join(', ')})`);
  row('agreement', `approved revision ${status.agreement.approved_revision ?? 'none'}${status.agreement.draft_revision ? ` · draft revision ${status.agreement.draft_revision} (not in force)` : ''} · state revision ${status.state_revision}`);
  if (status.activation) row('started', `${status.activation.at} by ${status.activation.by} at revision ${status.activation.programme_revision} · build ${status.activation.build.class} · review ${status.activation.review.model}`);
  else row('started', 'no — nothing runs until mc programme start');
  row('stop', status.planned_stop.target ? `runs to ${status.planned_stop.target} — ${clip(status.planned_stop.condition, 70)}${status.planned_stop.reached ? ' · reached' : ''}`
    : `none chosen · agreed stops: ${status.planned_stop.agreed.join(', ') || 'none'}`);
  const plan = status.plan;
  row('plan', `owns goals and confirmation · ${plan.lease ? `session ${plan.lease.run_id} until ${plan.lease.expires_at}` : 'no session'} · ${plan.pending_events} pending event${plan.pending_events === 1 ? '' : 's'}${plan.pending_operations.length ? ` · unreconciled: ${plan.pending_operations.join(', ')}` : ''}`);
  if (status.pause) row('paused', `${status.pause.at} by ${status.pause.by} (was ${status.pause.previous})`);
  if (status.wait) row('wait', `${status.wait.kind}: ${status.wait.reason}${status.wait.until ? ` · until ${status.wait.until}` : ' · external'}`);
  if (status.exception) row('exception', `${status.exception.code || UNKNOWN}: ${status.exception.reason}`);
  row('in flight', status.in_flight.length ? status.in_flight.join('; ') : 'nothing');
  row('next', status.next_action);
  out.push('');
  out.push('GOALS');
  if (!status.goals.length) out.push('  none yet — plan creates them once the programme runs');
  for (const goal of status.goals) {
    if (goal.problem) { out.push(`  ${goal.project}  problem: ${goal.problem}`); out.push(`    next       ${goal.next_action}`); continue; }
    out.push(`  ${goal.project}  ${goal.phase} · goal r${goal.goal_revision} · programme r${goal.programme_revision}${goal.aligned === false ? ' (behind the agreement)' : ''} · branch ${goal.branch || 'none'} · PR ${goal.pr ? `#${goal.pr}` : 'none'}`);
    const sub = (key, value) => out.push(`    ${key.padEnd(10)} ${value}`);
    sub('criteria', goal.criteria.map(item => `${item.id} ${item.builder}${item.verification === 'after-integration' ? ' (after integration)' : ''}${item.review !== UNKNOWN ? `, review ${item.review}` : ''}`).join(' · '));
    sub('evidence', `${goal.evidence.quality} · ${goal.evidence.premerge_verified} of ${goal.evidence.premerge_total} premerge reported · gate ${goal.evidence.gate}${goal.evidence.stale_observations ? ` · ${goal.evidence.stale_observations} older-revision observations ignored` : ''}${goal.evidence.incomplete_attempts ? ` · ${goal.evidence.incomplete_attempts} incomplete attempts` : ''}`);
    sub('review', goal.review ? `${goal.review.clean ? 'clean' : `${goal.review.findings.length} finding${goal.review.findings.length === 1 ? '' : 's'}`}${goal.review.current ? '' : ' (stale)'}${goal.review.findings.length ? ` — ${clip(goal.review.findings[0], 70)}` : ''}` : 'none yet');
    sub('models', `builders ${goal.models.builders.join(', ') || 'none yet'} · reviewer ${goal.models.reviewer_actual || 'none yet'}${goal.models.reviewer_reserved ? ` (reserved ${goal.models.reviewer_reserved})` : ''}`);
    sub('session', goal.session ? `${goal.session.run_id} ${goal.session.phase}${goal.session.reason ? ` (${goal.session.reason})` : ''} · ${goal.session.activity} · context ${goal.session.context.fraction === UNKNOWN ? UNKNOWN : `${Math.round(goal.session.context.fraction * 100)}% ${goal.session.context.quality}`}` : 'none');
    if (goal.publication) sub('publish', `${goal.publication.phase}${goal.publication.head ? ` · head ${goal.publication.head.slice(0, 7)}` : ''}${goal.publication.pr ? ` · #${goal.publication.pr}` : ''}`);
    if (goal.merge || goal.landing) sub('merge', `${goal.merge ? `handoff ${goal.merge.status}` : ''}${goal.landing ? `${goal.merge ? ' · ' : ''}landed ${goal.landing.merge_commit.slice(0, 7)} on ${goal.landing.merged_into}` : ''}`);
    if (goal.waits.length) sub('waits', goal.waits.join('; '));
    sub('next', status.mode === 'active' ? goal.next_action : `${goal.next_action} (held while ${status.mode})`);
  }
  if (status.legacy.length) {
    out.push('');
    out.push('V1 PROJECTS (fixed steps, unchanged)');
    out.push(`  ${status.legacy.join(', ')}`);
  }
  return `${out.join('\n')}\n`;
}
