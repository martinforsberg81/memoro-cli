import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { planner, builder, foreground } from './autonomous-state-fixture.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { ready, clean } from './autonomous-merge-fixture.js';
import { decideProgrammePlan, programmePlanContext } from '../../src/mc/programme-plan.js';
import { claimProgrammeJob, reconcileProgrammeJobs, finishProgrammeJob, yieldProgrammeJob, cancelProgrammeOperation,
  completeProgrammePlan, setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { readAutonomousState, readProgrammeState, mutateAutonomousProject, reserveProjectRun, reserveProgrammeRun,
  releaseProgrammeRun, mutateProgramme, recordAutonomousMergeEvent, startAutonomousBuild } from '../../src/mc/autonomous-state.js';
import { readProgrammeIncidents, mainIncidentHold, projectRecovery, mainRepairPreflight } from '../../src/mc/programme-recovery.js';
import { recordMergeOutcome, reportBinding, routeAutonomousReview } from '../../src/mc/autonomous-outcomes.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { recoverAutonomousBuild } from '../../src/mc/autonomous-recovery.js';

const basis = { criteria: ['contracts'], reference: 'decisions/approved-cli-repair-scope' };
function fixture(t) {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const old = readAutonomousState(f.root, f.programme, f.project);
  mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor: planner, revision: old.revision });
  f.activate();
  return decorate(f, f.claim());
}
function decorate(f, owner) {
  let number = 0;
  const state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  const intent = (kind, input = {}, extra = {}) => ({ id: `${owner().actor.run_id}-${++number}`, kind, project: f.project,
    expected_revision: state().revision, programme_revision: f.read().approved.at(-1).revision, basis, input, ...extra });
  const apply = value => decideProgrammePlan(owner(), value);
  const scan = extra => reconcileProgrammeJobs(f.options(extra));
  const create = (project, extra = {}) => apply({ id: `create-${project}`, kind: 'create-project', project, expected_revision: 0,
    programme_revision: 1, input: autonomousProject({ project_id: project, ...extra }) });
  const patch = (change, project = f.project) => {
    const value = state(project); change(value); writeFileSync(join(f.paths.dir, project, 'AUTONOMOUS_STATE.json'), JSON.stringify(value));
  };
  const send = project => apply(intent('send-project', {}, { project, expected_revision: state(project).revision }));
  return { ...f, owner, state, intent, apply, scan, create, patch, send };
}
function acknowledge(f) {
  completeProgrammePlan(f.owner(), { event_ids: f.read().planner_jobs.lease.event_ids, reference: 'decisions/accounted' });
  finishProgrammeJob(f.owner());
}
function fail(f, n) {
  const actor = { ...builder, run_id: `failed-build-${n}` };
  reserveProjectRun(f.root, f.programme, f.project, actor, f.state().revision);
  mutateAutonomousProject(f.root, f.programme, f.project, 'attempt', { id: actor.run_id, reason: 'Same failing test; no criterion progress.', commits: [] }, { actor, revision: f.state().revision });
  mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor, revision: f.state().revision });
  f.scan();
}
function diagnose(f, approach, action = 'retry') {
  return f.apply(f.intent('diagnose-project', { action, attempt_ids: f.state().attempts.map(item => item.id),
    diagnosis: 'The failure is technical, within the approved CLI scope.', ...(action === 'retry' ? { approach } : {}) }));
}
function confirmed(f, project) {
  f.patch(state => { state.phase = 'confirmed'; state.confirmed = true;
    state.evidence.confirmation = { id: `confirmed-${project}`, role: 'plan', run_id: 'plan-confirmation', project_id: project,
      programme_id: f.programme, programme_revision: state.programme_revision, goal_revision: state.goal_revision, reference: 'integration/repair-verified' };
  }, project);
}

test('review findings enter the plan job; only a revision can resume the same branch/PR', async t => {
  const result = clean(); result.defects.push('A repeatable CLI defect.');
  const base = await ready(t, { result });
  releaseProgrammeRun(base.root, base.programme, planner, readProgrammeState(base.root, base.programme).revision);
  const read = () => readProgrammeState(base.root, base.programme);
  const options = extra => ({ root: base.root, programme: base.programme, revision: read().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activate', type: 'activation', programme_revision: 1, reference: 'approval' } });
  const lease = claimProgrammeJob(options({ actor: { run_id: 'findings-plan', role: 'plan' }, pid: process.pid })).planner_jobs.lease;
  const f = decorate({ ...base, read, options }, () => options({ actor: lease.actor, token: lease.token }));
  f.scan(); assert.ok(f.read().planner_jobs.events.some(item => item.type === 'review'));
  assert.equal((await routeAutonomousReview({ root: f.root, programme: f.programme, project: f.project, repoPath: f.cwd, env: f.env, gh: f.gh })).queued, false);
  const rejected = f.intent('resume-project'); assert.throws(() => f.apply(rejected), /review findings require/u);
  cancelProgrammeOperation(f.owner(), { id: rejected.id, reason: 'Revise the goal with the review diagnosis.' });
  const old = f.state();
  f.apply(f.intent('revise-project', { ...old.contract, goal_revision: 2, instruction: ['Repair the reported CLI defect and remeasure.'] }));
  f.apply(f.intent('resume-project'));
  assert.equal(f.state().phase, 'ready'); assert.deepEqual(f.state().ownership, old.ownership);
  assert.deepEqual(f.state().review_reports, old.review_reports); assert.equal(f.state().review_reports[0].clean, false);
});

test('diagnosis and failed approaches survive planner restarts and goal revisions; three stagnant attempts retain an exception', t => {
  const f = fixture(t); f.send(f.project);
  for (let n = 1; n <= 3; n++) {
    fail(f, n);
    if (n < 3) { diagnose(f, `approach-${n}`); f.apply(f.intent('resume-project')); f.patch(state => { state.phase = 'plan_pending'; }); }
  }
  const oldAttempts = f.state().attempts;
  yieldProgrammeJob(f.owner(), 'Restart after receiving the failure.');
  const owner = f.claim({ actor: { run_id: 'restarted-diagnosis', role: 'plan' } });
  const next = decorate(f, owner);
  next.apply(next.intent('revise-project', { ...next.state().contract, goal_revision: 2 }));
  assert.deepEqual(next.state().attempts, oldAttempts); assert.equal(projectRecovery(next.state()).no_progress, 3);
  const rejected = next.intent('resume-project'); assert.throws(() => next.apply(rejected), /recovery exception/u);
  cancelProgrammeOperation(owner(), { id: rejected.id, reason: 'No verified progress: stop retrying, retain the exception.' });
  diagnose(next, null, 'exception');
  const context = JSON.parse(programmePlanContext(owner()));
  assert.equal(context.goals[0].recovery.exception.code, 'no-progress'); assert.equal(next.state().recovery_diagnoses.length, 3);
  assert.equal(next.read().approved[0].planned_stops.length, 1, 'failure never invents a design stop');
});

test('a second incomplete attempt cannot repeat an already unsuccessful approach', t => {
  const f = fixture(t); f.send(f.project); fail(f, 1); diagnose(f, 'same-approach');
  f.apply(f.intent('resume-project')); f.patch(state => { state.phase = 'plan_pending'; }); fail(f, 2);
  assert.throws(() => diagnose(f, 'same-approach'), /repeated unsuccessful approach/u);
  assert.equal(f.state().attempts.length, 2);
});

test('plan-selected dependency release occurs after confirmation, not landing, and survives a programme-ack crash exactly once', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] }));
  f.apply(f.intent('await-dependencies'));
  f.patch(state => { state.phase = 'landed'; }, 'dependency'); f.scan(); assert.equal(f.state().phase, 'plan_pending');
  confirmed(f, 'dependency');
  assert.throws(() => reconcileProgrammeJobs(f.options({ deps: { write: () => { throw new Error('programme ack crash'); } } })), /ack crash/u);
  assert.equal(f.state().phase, 'ready'); const revision = f.state().revision;
  f.scan(); f.scan(); assert.equal(f.state().revision, revision);
  assert.equal(f.state().plan_events.filter(item => item.type === 'dependency-released').length, 1);
  assert.ok(f.read().planner_jobs.events.some(item => item.type === 'dependency'));
});

test('changed approved revision fences an armed release until plan aligns the goal', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] })); f.apply(f.intent('await-dependencies'));
  acknowledge(f);
  const actor = { ...foreground, run_id: 'approve-successor' };
  reserveProgrammeRun(f.root, f.programme, actor, f.read().revision);
  mutateProgramme(f.root, f.programme, 'draft', { ...f.draft, revision: 2, based_on: 1 }, { actor, revision: f.read().revision });
  mutateProgramme(f.root, f.programme, 'approve', { by: 'Martin', at: '2026-10-29T12:00:00Z' }, { actor, revision: f.read().revision });
  releaseProgrammeRun(f.root, f.programme, actor, f.read().revision);
  confirmed(f, 'dependency'); f.scan(); assert.equal(f.state().phase, 'plan_pending');
  assert.equal(f.state().dependency_release.status, 'waiting');
});

test('main failures coalesce into one owner and ordinary repair, and every dependent waits for its planner-confirmed result', t => {
  const f = fixture(t); f.create('another-project');
  for (const project of [f.project, 'another-project']) f.patch(state => {
    state.plan_events = [{ id: `merge-failure-${project}`, type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: ['tests/shared.test.js'] } }];
  }, project);
  f.scan(); f.scan(); let [incident] = readProgrammeIncidents(f.root);
  assert.equal(readProgrammeIncidents(f.root).length, 1); assert.equal(incident.owner, f.programme); assert.equal(incident.dependents.length, 2);
  const repair = { id: 'repair-shared-main', kind: 'main-repair', project: 'shared-main-repair', expected_revision: 0,
    programme_revision: 1, incident: incident.id, basis, input: autonomousProject({ project_id: 'shared-main-repair' }) };
  assert.throws(() => decideProgrammePlan(f.owner({ deps: { writeDraft: () => { throw new Error('creation projection crash'); } } }), repair), /projection crash/u);
  assert.equal(f.state('shared-main-repair').contracts.length, 1);
  yieldProgrammeJob(f.owner(), 'Restart around the committed main-repair effect.');
  const owner = f.claim({ actor: { run_id: 'repair-restart-plan', role: 'plan' } });
  decideProgrammePlan(owner(), repair); decideProgrammePlan(owner(), repair);
  assert.equal(f.state('shared-main-repair').contracts.length, 1); assert.deepEqual(f.state('shared-main-repair').attempts, []);
  assert.throws(() => decideProgrammePlan(owner(), { ...repair, id: 'duplicate-repair', project: 'another-repair', input: autonomousProject({ project_id: 'another-repair' }) }), /already has one repair/u);
  cancelProgrammeOperation(owner(), { id: 'duplicate-repair', reason: 'All dependents use the existing repair.' });
  for (const project of [f.project, 'another-project']) assert.equal(mainIncidentHold(f.root, f.programme, project).id, incident.id);
  f.patch(state => { state.phase = 'landed'; }, repair.project); f.scan(); assert.ok(mainIncidentHold(f.root, f.programme, f.project));
  confirmed(f, repair.project); f.scan(); f.scan();
  assert.equal(mainIncidentHold(f.root, f.programme, f.project), null); assert.equal(readProgrammeIncidents(f.root)[0].status, 'resolved');
  assert.ok(f.read().planner_jobs.events.some(item => item.type === 'dependency'));
});

for (const kind of ['quota', 'network', 'resource']) test(`${kind} waits retry durably across restarts and exhaust into a precise exception, not a design question`, t => {
  const f = fixture(t); let owner = f.owner; let now = Date.now();
  for (let n = 1; n <= 3; n++) {
    const input = { id: `wait-${n}`, kind: 'wait-programme', programme_revision: 1, condition: 'external-condition', reference: 'diagnosis/external-condition',
      wait: { kind, reason: 'The external condition is unchanged.', until: now + 1000 } };
    decideProgrammePlan(owner({ now }), input); decideProgrammePlan(owner({ now }), input);
    completeProgrammePlan(owner({ now }), { event_ids: f.read().planner_jobs.lease.event_ids, reference: 'decisions/wait' }); finishProgrammeJob(owner({ now }));
    now += 1001; f.scan({ now });
    if (n < 3) owner = f.claim({ actor: { run_id: `wait-restart-${n}`, role: 'plan' }, now });
  }
  assert.equal(f.read().planner_jobs.mode, 'exception'); assert.equal(f.read().planner_jobs.exception.code, 'wait-exhausted');
  assert.equal(f.read().planner_jobs.wait_history.length, 3); assert.equal(f.read().approved.length, 1);
});

test('a planned stop is committed once across restart and prevents armed dependency release, builder and review routing', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] })); f.apply(f.intent('await-dependencies'));
  const stop = { id: 'stop-exactly-once', kind: 'reach-stop', programme_revision: 1, stop: 'design-review', reference: 'decisions/stop' };
  f.apply(stop); f.apply(stop); acknowledge(f);
  confirmed(f, 'dependency'); f.scan(); f.scan();
  assert.equal(f.state().phase, 'plan_pending'); assert.equal(f.read().planner_jobs.operations.filter(item => item.intent.id === stop.id).length, 1);
  assert.equal(f.read().planner_jobs.mode, 'stopped'); assert.equal(f.read().execution_enabled, false);
  assert.throws(() => startAutonomousBuild(f.root, f.programme, f.project, { actor: builder, revision: f.state().revision }), /not ready|paused, waiting or stopped/u);
  const record = { plan: f.state().contract, project: f.project, programme: f.programme, repo: 'memoro-cli' };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).reason, 'programme-held');
  assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'active' }), /new foreground agreement/u);
});

test('merge outcome main-red identities survive recording and reconciliation; a clean landing still requires after-integration confirmation', async t => {
  const base = await ready(t);
  const read = () => readProgrammeState(base.root, base.programme);
  releaseProgrammeRun(base.root, base.programme, planner, read().revision);
  const options = extra => ({ root: base.root, programme: base.programme, revision: read().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation', type: 'activation', programme_revision: 1, reference: 'approval' } });
  const report = base.stateNow().review_reports[0];
  const job = { repo_path: base.cwd, pr: 42, branch: base.project };
  recordMergeOutcome({ root: base.root, job, report: { ok: false, stopped_at: 'red', reason: 'Shared main failure.', main_red: { red_on_main: ['tests/shared.test.js'] } } });
  reconcileProgrammeJobs(options()); assert.equal(readProgrammeIncidents(base.root).length, 1);
  recordAutonomousMergeEvent(base.root, base.programme, base.project, { binding: reportBinding(report), type: 'merge-landed', details: { merge_commit: report.session.head, merged_into: 'main' } });
  reconcileProgrammeJobs(options()); assert.equal(base.stateNow().confirmed, false);
  assert.ok(read().planner_jobs.events.some(item => item.type === 'landed'));
});

test('safe incomplete owners reconcile without another model; unknown supervisor state remains owned', async t => {
  const f = await ready(t, { review: false }); const read = () => readProgrammeState(f.root, f.programme);
  releaseProgrammeRun(f.root, f.programme, planner, read().revision);
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: read().revision }, { mode: 'active', event: { id: 'activation', type: 'activation', programme_revision: 1, reference: 'approval' } });
  for (const unknown of [false, true]) {
    const actor = { ...builder, run_id: unknown ? 'unknown-failure' : 'closed-failure' };
    reserveProjectRun(f.root, f.programme, f.project, actor, f.stateNow().revision);
    mutateAutonomousProject(f.root, f.programme, f.project, 'attempt', { id: actor.run_id, reason: 'Incomplete transport.', commits: [] }, { actor, revision: f.stateNow().revision });
    if (unknown) writeFileSync(join(f.cwd, '.git', 'mc-autonomous-session.json'), '{');
    const record = { programme: f.programme, project: f.project, repo: 'memoro-cli', plan: f.stateNow().contract };
    assert.equal(autonomousChoice({ root: f.root, record, worktree: f.cwd, capability: { review: true } }).recovery, true);
    const recovered = await recoverAutonomousBuild({ root: f.root, programme: f.programme, project: f.project, actor, cwd: f.cwd });
    assert.equal(recovered.phase, 'plan_pending'); assert.equal(recovered.confirmed, false);
    assert.deepEqual(recovered.active_run, unknown ? actor : null);
  }
});

test('planner transport failures back off and orphaned restarts cannot reset their bounded job', t => {
  const f = fixture(t); let owner = f.owner; let now = Date.now();
  const ids = f.read().planner_jobs.pending.event_ids;
  for (let n = 1; n <= 3; n++) {
    yieldProgrammeJob(owner({ now }), 'Planner transport did not complete.', { retry: true });
    assert.deepEqual(f.read().planner_jobs.pending.event_ids, ids);
    if (n < 3) {
      assert.equal(f.read().planner_jobs.mode, 'waiting'); now = f.read().planner_jobs.wait.until;
      f.scan({ now }); owner = f.claim({ now, actor: { role: 'plan', run_id: `failed-plan-${n}` } });
    }
  }
  assert.equal(f.read().planner_jobs.mode, 'exception'); assert.equal(f.read().planner_jobs.exception.code, 'planner-no-progress');
  assert.equal(f.read().planner_jobs.recoveries.length, 3); assert.equal(f.read().active_run, null);
});

test('uncreated repair reservations can be explicitly superseded after an agreement revision without resurrecting their old intent', t => {
  const f = fixture(t);
  f.patch(state => { state.plan_events = [{ id: 'shared-failure', type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan(); const [incident] = readProgrammeIncidents(f.root);
  const repair = { id: 'uncreated-repair', kind: 'main-repair', project: 'shared-repair', expected_revision: 0,
    programme_revision: 1, incident: incident.id, basis, input: autonomousProject({ project_id: 'shared-repair' }) };
  assert.throws(() => decideProgrammePlan(f.owner({ deps: { write: (file, value) => {
    if (file.endsWith('shared-repair/AUTONOMOUS_STATE.json')) throw new Error('crash before effect');
    writeJsonAtomic(file, value);
  } } }), repair), /crash before effect/u);
  assert.equal(readProgrammeIncidents(f.root)[0].repair.project, 'shared-repair');
  yieldProgrammeJob(f.owner(), 'Foreground approves a successor revision.');
  const actor = { ...foreground, run_id: 'repair-successor-agreement' };
  reserveProgrammeRun(f.root, f.programme, actor, f.read().revision);
  mutateProgramme(f.root, f.programme, 'draft', { ...f.draft, revision: 2, based_on: 1 }, { actor, revision: f.read().revision });
  mutateProgramme(f.root, f.programme, 'approve', { by: 'Martin', at: '2026-10-29T12:00:00Z' }, { actor, revision: f.read().revision });
  releaseProgrammeRun(f.root, f.programme, actor, f.read().revision);
  const owner = f.claim({ actor: { role: 'plan', run_id: 'repair-successor-plan' } });
  assert.throws(() => decideProgrammePlan(owner(), repair), /programme revision changed/u);
  cancelProgrammeOperation(owner(), { id: repair.id, reason: 'Align repair with the successor agreement.' });
  assert.throws(() => decideProgrammePlan(owner(), repair), /cancelled/u);
  decideProgrammePlan(owner(), { ...repair, id: 'current-repair', programme_revision: 2, input: { ...repair.input, programme: { id: f.programme, revision: 2 } } });
  assert.equal(f.state('shared-repair').programme_revision, 2); assert.equal(f.state('shared-repair').contracts.length, 1);
  assert.equal(readProgrammeIncidents(f.root)[0].repair_history[0].operation, repair.id);
});

test('cross-programme dependents share an owner; foreign plan cannot create the repair or invent its authority', t => {
  const f = fixture(t); const other = 'other-programme'; const project = 'foreign-dependent';
  const foregroundActor = { role: 'foreground-plan', run_id: 'other-foreground' };
  reserveProgrammeRun(f.root, other, foregroundActor, 0);
  const otherRead = () => readProgrammeState(f.root, other);
  const draft = { ...f.draft, id: other };
  mutateProgramme(f.root, other, 'draft', draft, { actor: foregroundActor, revision: otherRead().revision });
  mutateProgramme(f.root, other, 'approve', { by: 'Martin', at: '2026-10-29T12:00:00Z' }, { actor: foregroundActor, revision: otherRead().revision });
  releaseProgrammeRun(f.root, other, foregroundActor, otherRead().revision);
  const options = extra => ({ root: f.root, programme: other, revision: otherRead().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation', type: 'activation', programme_revision: 1, reference: 'approval' } });
  const actor = { role: 'plan', run_id: 'foreign-plan' };
  const lease = claimProgrammeJob(options({ actor, pid: process.pid })).planner_jobs.lease;
  const owner = extra => options({ actor, token: lease.token, ...extra });
  decideProgrammePlan(owner(), { id: 'foreign-project', kind: 'create-project', project, expected_revision: 0, programme_revision: 1,
    input: autonomousProject({ project_id: project, programme: { id: other, revision: 1 } }) });
  f.patch(state => { state.plan_events = [{ id: 'failure-owner', type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan();
  const path = join(f.root, 'programs', other, project, 'AUTONOMOUS_STATE.json');
  const foreign = JSON.parse(readFileSync(path)); foreign.plan_events = [{ id: 'failure-foreign', type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: ['tests/shared.test.js'] } }]; writeFileSync(path, JSON.stringify(foreign));
  reconcileProgrammeJobs(options()); const [incident] = readProgrammeIncidents(f.root);
  assert.equal(incident.owner, f.programme); assert.equal(incident.dependents.length, 2);
  const repair = { id: 'foreign-repair', kind: 'main-repair', project: 'foreign-repair', expected_revision: 0,
    programme_revision: 1, incident: incident.id, basis, input: autonomousProject({ project_id: 'foreign-repair', programme: { id: other, revision: 1 } }) };
  assert.throws(() => decideProgrammePlan(owner(), { ...repair, basis: { criteria: ['unapproved'], reference: 'unapproved-scope' } }), /scope authority/u);
  assert.throws(() => decideProgrammePlan(owner(), repair), /owning programme/u);
  cancelProgrammeOperation(owner(), { id: repair.id, reason: 'Only the incident owner may allocate the shared repair.' });
  decideProgrammePlan(owner(), { id: 'authority-exception', kind: 'exception-programme', programme_revision: 1, reference: 'diagnosis/owner-scope',
    exception: { code: 'repair-owned-elsewhere', reason: `Wait for ${f.programme}'s approved repair.` } });
  assert.equal(otherRead().planner_jobs.mode, 'exception');
  assert.equal(mainIncidentHold(f.root, other, project).id, incident.id);
});

test('a shared-main repair can build from only its completed diagnosed red preflight; publication still needs green', t => {
  const f = fixture(t);
  f.patch(state => { state.plan_events = [{ id: 'preflight-failure', type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan(); const [incident] = readProgrammeIncidents(f.root);
  f.apply({ id: 'preflight-repair', kind: 'main-repair', project: 'repair', expected_revision: 0, programme_revision: 1,
    incident: incident.id, basis, input: autonomousProject({ project_id: 'repair' }) });
  const content = { repository: 'fixture-repo', tree: 'tree', fingerprint: 'bytes' };
  const path = join(f.root, 'preflight-receipt.json');
  const receipt = { schema: 'mc-session-gate-evidence', version: 1, outcome: 'red', exit: 1, repo: 'memoro-cli', base: 'base', ...content,
    coverage: { kind: 'affected', pattern: null }, execution: { tests: { finished: true, exit: 1, totals: { fail: 1, cancelled: 0 } }, commands: [] } };
  const summary = { exit: 1, ok: false, red_tests: [{ file: 'tests/shared.test.js' }], evidence: { path } };
  const options = { root: f.root, programme: f.programme, project: 'repair', summary, content, base: 'base' };
  writeJsonAtomic(path, receipt); assert.equal(mainRepairPreflight(options), true);
  for (const mutation of [s => s.outcome = 'incomplete', s => s.fingerprint = 'changed', s => s.execution.tests.finished = false,
    s => s.execution.tests.totals.cancelled = 1, s => s.execution.commands.push({ ok: false, exit: 1 })]) {
    const value = structuredClone(receipt); mutation(value); writeJsonAtomic(path, value); assert.equal(mainRepairPreflight(options), false);
  }
  writeJsonAtomic(path, receipt);
  assert.equal(mainRepairPreflight({ ...options, project: f.project }), false);
  assert.equal(mainRepairPreflight({ ...options, summary: { ...summary, red_tests: [{ file: 'tests/unrelated.test.js' }] } }), false);
  assert.equal(receipt.outcome, 'red', 'a preflight exception never manufactures green evidence');
});


test('new verified criteria, not sessions or fresh proof IDs for the same criterion, delimit no-progress attempts', t => {
  const f = fixture(t); fail(f, 1); fail(f, 2);
  assert.equal(projectRecovery(f.state()).no_progress, 2);
  f.patch(state => { state.evidence.builder.push({ id: 'criterion-progress', run_id: 'observed-build', project_id: f.project,
    programme_id: f.programme, programme_revision: 1, goal_revision: 1, criterion_id: 'schema', status: 'verified', reference: 'proof/schema' }); });
  assert.equal(projectRecovery(f.state()).no_progress, 0);
  fail(f, 3); assert.equal(projectRecovery(f.state()).no_progress, 1);
  f.patch(state => { state.evidence.builder.push({ ...state.evidence.builder[0], id: 'repeated-proof', run_id: 'another-session' }); });
  assert.equal(projectRecovery(f.state()).no_progress, 1);
});

test('corrupt shared incident history refuses dispatch instead of silently dropping the wait', t => {
  const f = fixture(t); f.send(f.project);
  writeJsonAtomic(join(f.root, 'runner', 'programme-incidents.json'), { version: 1, incidents: [{ id: 'bad-incident' }] });
  assert.throws(() => f.scan(), /incidents are unreadable/u);
  assert.throws(() => f.apply(f.intent('resume-project')), /incidents are unreadable/u);
});


test('malformed main-red source data refuses reconciliation before creating incidents or losing the programme job', t => {
  const f = fixture(t); const before = f.read();
  f.patch(state => { state.plan_events = [{ id: 'malformed-main', type: 'merge-failed', binding: { programme_revision: 1 }, details: { main_failures: 'tests/not-an-array.test.js' } }]; });
  assert.throws(() => f.scan(), /invalid main failure source/u);
  assert.deepEqual(f.read(), before); assert.deepEqual(readProgrammeIncidents(f.root), []);
});
