import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ready } from './autonomous-merge-fixture.js';
import { git } from './autonomous-publication-fixture.js';
import { stateFixture } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { measuredLanding } from './goal-followup-fixture.js';
import { goalCompletion } from '../../src/mc/goal-followup.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';
import { mutateAutonomousProject, readAutonomousState, readProgrammeState, createAutonomousDraft, sendAutonomousProject, recordAutonomousMergeEvent } from '../../src/mc/autonomous-state.js';
import { reconcileProgrammeJobs, setProgrammeJobMode, claimProgrammeJob } from '../../src/mc/programme-jobs.js';
import { recordMergeOutcome, reportBinding } from '../../src/mc/autonomous-outcomes.js';
import { autonomousArchiveFacts, archiveVerdict } from '../../src/mc/archive-programme.js';
import { goalStatus } from '../../src/mc/programme-status.js';
import { observeMainIncidentLocked, reserveMainRepairLocked, reconcileMainRepairsLocked, mainIncidentHold } from '../../src/mc/programme-recovery.js';
import { persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { takeClaim, releaseClaim } from '../../src/mc/resource-claim.js';

const sha = 'b'.repeat(40);
function unit(t, criteria = autonomousProject().success_criteria) {
  const f = stateFixture(); t.after(f.cleanup); f.setupProject({ success_criteria: criteria }); f.releasePlanner();
  const read = () => readAutonomousState(f.root, f.programme, f.project);
  const patch = change => { const state = read(); change(state); writeFileSync(f.paths.project, JSON.stringify(state)); };
  patch(state => measuredLanding(state));
  return { ...f, read, patch };
}
async function cli(f, args, env = {}) {
  const out = []; const err = [];
  const code = await goalCommand(args, { root: f.root, env, stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } });
  return { code, out: out.join(''), err: err.join('') };
}
const done = f => cli(f, ['done', `${f.programme}/${f.project}`]);
const observe = (f, extra = {}, options = {}) => mutateAutonomousProject(f.root, f.programme, f.project, 'follow-up', {
  id: 'measurement-1', criterion_id: 'integration', goal_revision: 1, integrated_sha: sha, reference: 'measurements/integrated-cli.json', outcome: 'passed', ...extra,
}, { env: {}, revision: f.read().revision, ...options });

test('verified reviewed landing completes execution once, not follow-ups or main checks', async t => {
  const f = await ready(t); f.releasePlanner();
  const report = f.stateNow().review_reports.at(-1); const binding = reportBinding(report);
  const job = { repo_path: f.cwd, pr: binding.pr, branch: binding.branch };
  const outcome = { ok: true, merged: true, merged_into: 'main', merge_commit: sha };
  recordMergeOutcome({ root: f.root, job, report: outcome });
  const state = f.stateNow();
  assert.equal(state.phase, 'landed'); assert.equal(goalCompletion(state).done, true);
  assert.deepEqual(goalCompletion(state).pending_follow_ups, ['integration']);
  assert.equal(state.evidence.confirmation, null);
  const status = goalStatus(f.root, f.programme, f.project);
  assert.equal(status.done, true); assert.match(status.next_action, /measure follow-ups: integration/u);
  assert.equal((await done(f)).code, 1);
  recordMergeOutcome({ root: f.root, job, report: outcome });
  recordAutonomousMergeEvent(f.root, f.programme, f.project, { binding, type: 'merge-landed', details: { ...outcome, already_merged: true } });
  assert.deepEqual(f.stateNow(), state, 'round, merger and crash readback share one landing event');
  recordAutonomousMergeEvent(f.root, f.programme, f.project, { binding, type: 'merge-failed', details: { reason: 'Late reply.' } });
  assert.deepEqual(f.stateNow().landing, state.landing); assert.equal(f.stateNow().phase, 'landed');
  assert.throws(() => recordAutonomousMergeEvent(f.root, f.programme, f.project, { binding, type: 'merge-landed', details: { merge_commit: 'c'.repeat(40), merged_into: 'main' } }), /commit cannot change/u);
});

test('missing, stale, failed and unknown observations cannot close follow-ups; successful done is a repeatable read', async t => {
  const f = unit(t);
  assert.equal((await done(f)).code, 1);
  for (const extra of [{ integrated_sha: 'c'.repeat(40) }, { goal_revision: 2 }, { criterion_id: 'schema' }, { reference: '' }, { outcome: 'verified' }]) {
    const before = readFileSync(f.paths.project, 'utf8');
    assert.throws(() => observe(f, extra)); assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  }
  for (const outcome of ['failed', 'unknown', 'passed', 'failed', 'passed']) {
    observe(f, { id: `measurement-${f.read().revision}`, outcome });
    assert.equal((await done(f)).code, outcome === 'passed' ? 0 : 1);
  }
  const state = f.read(); const bytes = readFileSync(f.paths.project, 'utf8');
  assert.equal(state.evidence.builder.length, 0, 'follow-ups are not builder or premerge progress');
  assert.equal(state.follow_up_observations.length, 5);
  assert.equal((await done(f)).code, 0); assert.equal((await done(f)).code, 0);
  assert.equal(readFileSync(f.paths.project, 'utf8'), bytes, 'done never fabricates a merge or a state transition');
  assert.equal(goalStatus(f.root, f.programme, f.project).next_action, 'none — done on main');
  for (const extra of [{ goal_revision: 99 }, { integrated_sha: 'd'.repeat(40) }, { project_id: 'other' }, { programme_id: 'other' }]) {
    const stale = structuredClone(state); stale.follow_up_observations = stale.follow_up_observations.map(item => ({ ...item, ...extra }));
    assert.deepEqual(goalCompletion(stale).pending_follow_ups, ['integration']);
  }
});

test('no-follow-up done is idempotent and never turns an unlanded or damaged assignment into a delivery', async t => {
  const f = unit(t, autonomousProject().success_criteria.slice(0, 1));
  const before = readFileSync(f.paths.project, 'utf8');
  assert.equal(JSON.parse((await done(f)).out).done, true);
  assert.equal(JSON.parse((await done(f)).out).done, true); assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  for (const change of [state => { delete state.landing; }, state => { state.landing.merged_into = 'release'; },
    state => { state.landing.merge_commit = 'short'; }, state => { state.review_reports[0].clean = false; },
    state => { state.landing.binding.goal_revision++; }, state => { state.landing.binding.head = sha; }]) {
    writeFileSync(f.paths.project, before); f.patch(change);
    assert.equal(JSON.parse((await done(f)).out).done, false);
  }
});

test('ordinary evidence records explicit outcomes and integrated identity under foreground or leased planning authority', async t => {
  const f = unit(t);
  const command = () => ['criterion', 'evidence', `${f.programme}/${f.project}`, '--id', 'integration', '--reference', 'measurements/cli.json',
    '--integrated-sha', sha, '--outcome', 'passed', '--expected-revision', String(f.read().revision)];
  for (const role of ['step', 'review']) assert.equal((await cli(f, command(), { MC_AUTONOMOUS_ROLE: role, MC_AUTONOMOUS_RUN: `test-${role}` })).code, 1);
  assert.equal((await cli(f, command().slice(0, -6))).code, 1);
  const result = await cli(f, command()); assert.equal(result.code, 0, result.err);
  assert.equal((await done(f)).code, 0); assert.equal(f.read().follow_up_observations[0].reference, 'measurements/cli.json');
  const options = () => ({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'test-activation', type: 'activation', reference: 'fixtures/activation' } });
  const actor = { run_id: 'leased-planner', role: 'plan' };
  const lease = claimProgrammeJob({ ...options(), actor, pid: process.pid }).planner_jobs.lease;
  const leased = await cli(f, command(), { MC_AUTONOMOUS_ROLE: 'plan', MC_AUTONOMOUS_RUN: actor.run_id,
    MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: lease.token });
  assert.equal(leased.code, 0, leased.err); assert.equal(f.read().follow_up_observations.at(-1).run_id, actor.run_id);
  const state = f.read();
  assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, 'revise', { ...state.contract, goal_revision: 2 },
    { actor, token: lease.token, env: {}, revision: state.revision }), /immutable/u);
  assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, 'confirm', {}, { revision: state.revision }), /obsolete/u);
});

test('archive discovers unlisted goals and waits for follow-ups, owners, claims and pending work, not confirmation', t => {
  const f = unit(t);
  const facts = () => autonomousArchiveFacts({ root: f.root, programme: f.programme });
  const verdict = () => archiveVerdict({ programme: f.programme, homes: [{}], autonomy: facts() });
  assert.equal(facts().goals.length, 1, 'a goal absent from main is not silently dropped');
  assert.match(verdict().lines.join('\n'), /pending follow-ups/u);
  observe(f); assert.equal(verdict().ok, true);
  f.patch(state => { state.active_run = { run_id: 'lingering-builder', role: 'step' }; state.runs.push(state.active_run); });
  assert.match(verdict().lines.join('\n'), /still owned/u);
  f.patch(state => { state.active_run = null; });
  const path = join(f.root, 'runner', 'autonomous-builds', f.programme, `${f.project}.claim`);
  const claim = takeClaim(path, { pid: process.pid });
  try { assert.match(verdict().lines.join('\n'), /builder claim/u); } finally { releaseClaim(path, claim.marker); }
  f.patch(state => { state.merge_handoff = { status: 'pending' }; });
  assert.match(verdict().lines.join('\n'), /pending work/u);
  f.patch(state => { delete state.merge_handoff; });
  assert.equal(verdict().ok, true);
  const queue = join(f.root, 'runner', 'merges.json');
  writeFileSync(queue, JSON.stringify([{ repo: 'memoro-cli', pr: 42, state: 'landing' }]));
  assert.match(verdict().lines.join('\n'), /pending work/u);
  writeFileSync(queue, '{'); assert.match(verdict().lines.join('\n'), /unreadable/u); rmSync(queue);
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision },
    { mode: 'active', event: { id: 'pending-work', type: 'activation', reference: 'fixtures/activation' } });
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision },
    { mode: 'stopped', stop: 'archive-check' });
  assert.match(verdict().lines.join('\n'), /pending autonomous work/u);
});

test('selected dependencies release on verified landing despite open follow-ups, never on an unverified or stale landing', t => {
  const f = unit(t); const project = 'next-goal';
  const source = f.read(); f.patch(state => { delete state.landing; });
  createAutonomousDraft(f.root, f.programme, project, autonomousProject({ project_id: project }), {
    env: {}, revision: readProgrammeState(f.root, f.programme).revision,
  });
  sendAutonomousProject(f.root, f.programme, project, { env: {}, revision: 1, after: [f.project] });
  const path = join(f.paths.dir, project, 'AUTONOMOUS_STATE.json');
  const read = () => readAutonomousState(f.root, f.programme, project);
  const dependent = read();
  assert.equal(dependent.phase, 'plan_pending');
  assert.deepEqual(dependent.dependency_release, { goal_revision: 1, status: 'waiting', operation: 'goal-send-1' });
  dependent.plan_dependencies[0].goal_revision = 2;
  writeFileSync(path, JSON.stringify(dependent));
  const scan = () => reconcileProgrammeJobs({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision });
  scan(); assert.equal(read().phase, 'plan_pending', 'wrong selected revision stays pending');
  dependent.plan_dependencies[0].goal_revision = 1; writeFileSync(path, JSON.stringify(dependent));
  scan(); assert.equal(read().phase, 'plan_pending', 'a landed phase label alone is not proof');
  writeFileSync(f.paths.project, JSON.stringify(source));
  scan(); assert.equal(read().phase, 'ready');
  assert.deepEqual(goalCompletion(f.read()).pending_follow_ups, ['integration']);
  const released = read(); scan(); scan(); assert.deepEqual(read(), released);
  assert.equal(released.plan_events.filter(item => item.type === 'dependency-released').length, 1);
});

test('a landed repair cannot resolve red main until new successful affected main measurements exist', async t => {
  const f = await ready(t); const evidenceRoot = f.env.MC_HOME;
  const incident = observeMainIncidentLocked(f.root, { programme: f.programme, project: 'dependent', repo: 'memoro-cli',
    failure: 'schema.test.js', source: 'main-red-observed', reference: 'gate/main-red.json' });
  reserveMainRepairLocked(f.root, { incident: incident.id, programme: f.programme, project: f.project, operation: 'repair-main', repo: 'memoro-cli' });
  const scan = () => reconcileMainRepairsLocked(f.root, { evidenceRoot })[0];
  assert.equal(scan().status, 'open');
  const state = f.stateNow(); const head = state.publication.head;
  recordAutonomousMergeEvent(f.root, f.programme, f.project, { binding: reportBinding(state.review_reports.at(-1)), type: 'merge-landed',
    details: { merge_commit: head, merged_into: 'main' }, now: () => Date.now() - 1000 });
  git(f.cwd, 'update-ref', 'refs/remotes/origin/main', head); // GitHub's verified landing readback.
  assert.equal(scan().status, 'open', 'landing never means green main');
  const original = JSON.parse(readFileSync(join(evidenceRoot, 'gate-evidence', `${state.publication.gate_run}.json`), 'utf8'));
  const measurement = { ...original, run: 'main-measured', base: head, session_run: null, goal_revision: null,
    started: new Date().toISOString(), ended: new Date().toISOString() };
  const variants = [
    { outcome: 'red', exit: 1 }, { outcome: 'incomplete' }, { base: 'c'.repeat(40) }, { tree: 'c'.repeat(40) },
    { started: original.started, ended: original.ended }, { session_run: state.publication.run_id },
    { coverage: { ...original.coverage, files: ['unrelated.test.js'] } },
    { coverage: { ...original.coverage, pattern: 'one check' } },
    { coverage: { ...original.coverage, flags: ['--test-only'] } },
    { execution: { tests: { ...original.execution.tests, finished: false }, commands: [] } },
    { execution: { tests: { ...original.execution.tests, totals: { tests: 1, pass: 1, fail: 0, cancelled: 1 } }, commands: [] } },
  ];
  for (const [index, patch] of variants.entries()) {
    persistGateReceipt({ root: evidenceRoot, receipt: { ...measurement, ...patch, run: `rejected-main-${index}` } });
    assert.equal(scan().status, 'open', JSON.stringify(patch));
  }
  persistGateReceipt({ root: evidenceRoot, receipt: measurement });
  const resolved = scan(); assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.measurement.integrated_sha, head); assert.equal(resolved.measurement.outcome, 'passed');
  assert.equal(mainIncidentHold(f.root, f.programme, 'dependent'), null);
  assert.deepEqual(scan(), resolved, 'resolution is durable and does not replay a landing into another measurement');
});
