import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
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
import { takeClaim, releaseClaim } from '../../src/mc/resource-claim.js';

const basis = { criteria: ['schema'], reference: 'decisions/approved-cli-repair-scope' };
function fixture(t) {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  f.activate();
  return decorate(f, f.claim());
}
function decorate(f, owner) {
  let number = 0;
  const state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  const intent = (kind, input = {}, extra = {}) => ({ id: `${owner().actor.run_id}-${++number}`, kind, project: f.project,
    expected_revision: state().revision, input, ...extra });
  const apply = value => decideProgrammePlan(owner(), value);
  const scan = extra => reconcileProgrammeJobs(f.options(extra));
  const create = (project, extra = {}) => apply({ id: `create-${project}`, kind: 'create-project', project, expected_revision: 0,
    input: autonomousProject({ project_id: project, ...extra }) });
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
      programme_id: f.programme, goal_revision: state.goal_revision, reference: 'integration/repair-verified' };
  }, project);
}

test('review findings enter the plan job; only a revision can resume the same branch/PR', async t => {
  const result = clean(); result.defects.push('A repeatable CLI defect.');
  const base = await ready(t, { result });
  base.releasePlanner();
  const read = () => readProgrammeState(base.root, base.programme);
  const options = extra => ({ root: base.root, programme: base.programme, revision: read().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activate', type: 'activation', reference: 'approval' } });
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
  assert.equal(next.read().planner_jobs.stop, null, 'failure never invents a design stop');
});

test('a second incomplete attempt cannot repeat an already unsuccessful approach', t => {
  const f = fixture(t); f.send(f.project); fail(f, 1); diagnose(f, 'same-approach');
  f.apply(f.intent('resume-project')); f.patch(state => { state.phase = 'plan_pending'; }); fail(f, 2);
  assert.throws(() => diagnose(f, 'same-approach'), /repeated unsuccessful approach/u);
  assert.equal(f.state().attempts.length, 2);
});

test('another goal revision leaves recovery evidence current, but this goal needs a new revision-bound diagnosis', t => {
  const f = fixture(t); f.send(f.project); fail(f, 1); diagnose(f, 'first-diagnosis');
  const before = f.state();
  f.create('independent-goal');
  f.apply(f.intent('revise-project', { ...f.state('independent-goal').contract, goal_revision: 2 },
    { project: 'independent-goal', expected_revision: f.state('independent-goal').revision }));
  assert.deepEqual(f.state(), before);
  f.apply(f.intent('resume-project')); assert.equal(f.state().phase, 'ready');
  f.apply(f.intent('revise-project', { ...f.state().contract, goal_revision: 2 }));
  const revised = f.state();
  assert.deepEqual(revised.recovery_diagnoses, before.recovery_diagnoses);
  const stale = f.intent('resume-project');
  assert.throws(() => f.apply(stale), /current planner diagnosis/u);
  assert.deepEqual(f.state(), revised);
  cancelProgrammeOperation(f.owner(), { id: stale.id, reason: 'The retained diagnosis belongs to the old goal revision.' });
  diagnose(f, 'revised-diagnosis'); f.apply(f.intent('resume-project'));
  assert.equal(f.state().phase, 'ready');
  assert.equal(f.state().recovery_diagnoses.at(-1).goal_revision, 2);
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

test('a revised dependency cannot release a goal waiting on its earlier revision', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] }));
  f.apply(f.intent('await-dependencies'));
  const before = f.state();
  f.apply(f.intent('revise-project', { ...f.state('dependency').contract, goal_revision: 2 },
    { project: 'dependency', expected_revision: f.state('dependency').revision }));
  confirmed(f, 'dependency'); f.scan(); f.scan();
  assert.deepEqual(f.state(), before);
  assert.equal(f.state().dependency_release.status, 'waiting');
  assert.equal(f.state('dependency').goal_revision, 2);
});

test('job reconciliation refuses goal revision drift before acknowledging events or applying dependency effects', t => {
  const f = fixture(t); f.send(f.project);
  for (const goal_revision of [undefined, 2]) {
    f.patch(state => { state.goal_revision = goal_revision; });
    const programme = readFileSync(f.paths.programme, 'utf8');
    const project = readFileSync(f.paths.project, 'utf8');
    assert.throws(() => f.scan(), /invalid autonomous trigger source/u);
    assert.equal(readFileSync(f.paths.programme, 'utf8'), programme);
    assert.equal(readFileSync(f.paths.project, 'utf8'), project);
    // Restore only the isolated malformed fixture for the next negative case.
    const state = JSON.parse(project); state.goal_revision = state.contract.goal_revision;
    writeFileSync(f.paths.project, JSON.stringify(state));
  }
});

test('changed programme metadata does not fence an armed dependency release', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] })); f.apply(f.intent('await-dependencies'));
  acknowledge(f);
  mutateProgramme(f.root, f.programme, 'metadata', { ...f.draft, brief: 'docs/project/updated/' }, { env: {}, revision: f.read().revision });
  confirmed(f, 'dependency'); f.scan(); assert.equal(f.state().phase, 'ready');
  assert.equal(f.state().dependency_release.status, 'released');
});

test('main failures coalesce into one owner and ordinary repair, and every dependent waits for its planner-confirmed result', t => {
  const f = fixture(t); f.create('another-project');
  for (const project of [f.project, 'another-project']) f.patch(state => {
    state.plan_events = [{ id: `merge-failure-${project}`, type: 'merge-failed', binding: { }, details: { main_failures: ['tests/shared.test.js'] } }];
  }, project);
  f.scan(); f.scan(); let [incident] = readProgrammeIncidents(f.root);
  assert.equal(readProgrammeIncidents(f.root).length, 1); assert.equal(incident.owner, f.programme); assert.equal(incident.dependents.length, 2);
  const repair = { id: 'repair-shared-main', kind: 'main-repair', project: 'shared-main-repair', expected_revision: 0,
    incident: incident.id, basis, input: autonomousProject({ project_id: 'shared-main-repair' }) };
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
    const input = { id: `wait-${n}`, kind: 'wait-programme', condition: 'external-condition', reference: 'diagnosis/external-condition',
      wait: { kind, reason: 'The external condition is unchanged.', until: now + 1000 } };
    decideProgrammePlan(owner({ now }), input); decideProgrammePlan(owner({ now }), input);
    completeProgrammePlan(owner({ now }), { event_ids: f.read().planner_jobs.lease.event_ids, reference: 'decisions/wait' }); finishProgrammeJob(owner({ now }));
    now += 1001; f.scan({ now });
    if (n < 3) owner = f.claim({ actor: { run_id: `wait-restart-${n}`, role: 'plan' }, now });
  }
  assert.equal(f.read().planner_jobs.mode, 'exception'); assert.equal(f.read().planner_jobs.exception.code, 'wait-exhausted');
  assert.equal(f.read().planner_jobs.wait_history.length, 3); assert.equal(f.read().metadata.id, f.programme);
});

test('a planner stop is committed once across restart without holding sent dependency release or dispatch', t => {
  const f = fixture(t); f.create('dependency'); f.send(f.project);
  f.apply(f.intent('dependencies', { projects: [{ project: 'dependency', goal_revision: 1 }] })); f.apply(f.intent('await-dependencies'));
  const stop = { id: 'stop-exactly-once', kind: 'reach-stop', stop: 'design-review', reference: 'decisions/stop' };
  f.apply(stop); f.apply(stop); acknowledge(f);
  confirmed(f, 'dependency'); f.scan(); f.scan();
  assert.equal(f.state().phase, 'ready'); assert.equal(f.read().planner_jobs.operations.filter(item => item.intent.id === stop.id).length, 1);
  assert.equal(f.read().planner_jobs.mode, 'stopped'); assert.equal(f.read().execution_enabled, false);
  const record = { plan: f.state().contract, project: f.project, programme: f.programme, repo: 'memoro-cli' };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'step');
  assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'active' }), /foreground planning restart/u);
});

test('merge outcome main-red identities survive recording and reconciliation; a clean landing still requires after-integration confirmation', async t => {
  const base = await ready(t);
  const read = () => readProgrammeState(base.root, base.programme);
  base.releasePlanner();
  const options = extra => ({ root: base.root, programme: base.programme, revision: read().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation', type: 'activation', reference: 'approval' } });
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
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: read().revision }, { mode: 'active', event: { id: 'activation', type: 'activation', reference: 'approval' } });
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
  f.patch(state => { state.plan_events = [{ id: 'shared-failure', type: 'merge-failed', binding: { }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan(); const [incident] = readProgrammeIncidents(f.root);
  const repair = { id: 'uncreated-repair', kind: 'main-repair', project: 'shared-repair', expected_revision: 0,
    incident: incident.id, basis, input: autonomousProject({ project_id: 'shared-repair' }) };
  assert.throws(() => decideProgrammePlan(f.owner({ deps: { write: (file, value) => {
    if (file.endsWith('shared-repair/AUTONOMOUS_STATE.json')) throw new Error('crash before effect');
    writeJsonAtomic(file, value);
  } } }), repair), /crash before effect/u);
  assert.equal(readProgrammeIncidents(f.root)[0].repair.project, 'shared-repair');
  yieldProgrammeJob(f.owner(), 'Foreground approves a successor revision.');
  mutateProgramme(f.root, f.programme, 'metadata', { ...f.draft, brief: 'docs/project/updated/' }, { env: {}, revision: f.read().revision });
  const owner = f.claim({ actor: { role: 'plan', run_id: 'repair-successor-plan' } });
  cancelProgrammeOperation(owner(), { id: repair.id, reason: 'Align repair with the successor agreement.' });
  assert.throws(() => decideProgrammePlan(owner(), repair), /cancelled/u);
  decideProgrammePlan(owner(), { ...repair, id: 'current-repair', input: repair.input });
  assert.equal(f.state('shared-repair').goal_revision, 1); assert.equal(f.state('shared-repair').contracts.length, 1);
  assert.equal(readProgrammeIncidents(f.root)[0].repair_history[0].operation, repair.id);
});

test('cross-programme dependents share an owner; foreign plan cannot create the repair or invent its authority', t => {
  const f = fixture(t); const other = 'other-programme'; const project = 'foreign-dependent';
  const foregroundActor = { role: 'foreground-plan', run_id: 'other-foreground' };
  const otherRead = () => readProgrammeState(f.root, other);
  const draft = { ...f.draft, id: other };
  mutateProgramme(f.root, other, 'metadata', draft, { env: {}, revision: 0 });
  const options = extra => ({ root: f.root, programme: other, revision: otherRead().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation', type: 'activation', reference: 'approval' } });
  const actor = { role: 'plan', run_id: 'foreign-plan' };
  const lease = claimProgrammeJob(options({ actor, pid: process.pid })).planner_jobs.lease;
  const owner = extra => options({ actor, token: lease.token, ...extra });
  decideProgrammePlan(owner(), { id: 'foreign-project', kind: 'create-project', project, expected_revision: 0,
    input: autonomousProject({ project_id: project, programme: { id: other } }) });
  f.patch(state => { state.plan_events = [{ id: 'failure-owner', type: 'merge-failed', binding: { }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan();
  const path = join(f.root, 'programs', other, project, 'AUTONOMOUS_STATE.json');
  const foreign = JSON.parse(readFileSync(path)); foreign.plan_events = [{ id: 'failure-foreign', type: 'merge-failed', binding: { }, details: { main_failures: ['tests/shared.test.js'] } }]; writeFileSync(path, JSON.stringify(foreign));
  reconcileProgrammeJobs(options()); const [incident] = readProgrammeIncidents(f.root);
  assert.equal(incident.owner, f.programme); assert.equal(incident.dependents.length, 2);
  const repair = { id: 'foreign-repair', kind: 'main-repair', project: 'foreign-repair', expected_revision: 0,
    incident: incident.id, basis, input: autonomousProject({ project_id: 'foreign-repair', programme: { id: other } }) };
  assert.throws(() => decideProgrammePlan(owner(), { ...repair, basis: { criteria: ['unapproved'], reference: 'unapproved-scope' } }), /scope rationale/u);
  assert.throws(() => decideProgrammePlan(owner(), repair), /owning programme/u);
  cancelProgrammeOperation(owner(), { id: repair.id, reason: 'Only the incident owner may allocate the shared repair.' });
  decideProgrammePlan(owner(), { id: 'authority-exception', kind: 'exception-programme', reference: 'diagnosis/owner-scope',
    exception: { code: 'repair-owned-elsewhere', reason: `Wait for ${f.programme}'s approved repair.` } });
  assert.equal(otherRead().planner_jobs.mode, 'exception');
  assert.equal(mainIncidentHold(f.root, other, project).id, incident.id);
});

test('a shared-main repair can build from only its completed diagnosed red preflight; publication still needs green', t => {
  const f = fixture(t);
  f.patch(state => { state.plan_events = [{ id: 'preflight-failure', type: 'merge-failed', binding: { }, details: { main_failures: ['tests/shared.test.js'] } }]; });
  f.scan(); const [incident] = readProgrammeIncidents(f.root);
  f.apply({ id: 'preflight-repair', kind: 'main-repair', project: 'repair', expected_revision: 0,
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
    programme_id: f.programme, goal_revision: 1, criterion_id: 'schema', status: 'verified', reference: 'proof/schema' }); });
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
  f.patch(state => { state.plan_events = [{ id: 'malformed-main', type: 'merge-failed', binding: { }, details: { main_failures: 'tests/not-an-array.test.js' } }]; });
  assert.throws(() => f.scan(), /invalid main failure source/u);
  assert.deepEqual(f.read(), before); assert.deepEqual(readProgrammeIncidents(f.root), []);
});

test('a repair observing its assigned main failure again never waits on itself or allocates another repair', t => {
  const f = fixture(t);
  const failure = project => f.patch(state => {
    state.plan_events = [{ id: `failure-${project}`, type: 'merge-failed', binding: { },
      details: { main_failures: ['tests/shared.test.js'] } }];
  }, project);
  failure(f.project); f.scan();
  const [incident] = readProgrammeIncidents(f.root);
  f.apply({ id: 'repair-observed-main', kind: 'main-repair', project: 'repair', expected_revision: 0,
    incident: incident.id, basis, input: autonomousProject({ project_id: 'repair' }) });
  f.send('repair'); failure('repair'); f.scan(); f.scan();
  assert.equal(readProgrammeIncidents(f.root).length, 1);
  assert.equal(readProgrammeIncidents(f.root)[0].repair.project, 'repair');
  assert.equal(readProgrammeIncidents(f.root)[0].dependents.length, 2);
  assert.equal(mainIncidentHold(f.root, f.programme, 'repair'), null);
  f.apply(f.intent('resume-project', {}, { project: 'repair', expected_revision: f.state('repair').revision }));
  assert.equal(f.state('repair').phase, 'ready');
  assert.equal(mainIncidentHold(f.root, f.programme, f.project).id, incident.id);
  f.send(f.project);
  assert.throws(() => f.apply(f.intent('resume-project')), /shared main incident/u);
});

test('reaching a planned stop waits for live or unreadable builder claims even without a recorded active run', t => {
  const f = fixture(t);
  const path = join(f.root, 'runner', 'autonomous-builds', f.programme, `${f.project}.claim`);
  const held = takeClaim(path, { pid: process.pid }); assert.equal(held.ok, true);
  t.after(() => releaseClaim(path, held.marker));
  const stop = { id: 'stop-after-claims', kind: 'reach-stop', stop: 'design-review', reference: 'decisions/safe-stop' };
  assert.throws(() => f.apply(stop), /affected runs must close/u);
  assert.equal(f.read().planner_jobs.mode, 'active');
  releaseClaim(path, held.marker);
  writeFileSync(path, '{');
  assert.throws(() => f.apply(stop), /affected runs must close/u);
  rmSync(path);
  f.apply(stop); f.apply(stop); acknowledge(f); f.scan();
  assert.equal(f.read().planner_jobs.mode, 'stopped');
  assert.equal(f.read().planner_jobs.operations.filter(item => item.intent.id === stop.id).length, 1);
});

test('unrelated programme metadata leaves ready goal dispatch and its assignment unchanged', t => {
  const f = fixture(t); f.send(f.project); f.apply(f.intent('resume-project'));
  const before = f.state(); acknowledge(f);
  mutateProgramme(f.root, f.programme, 'metadata', { ...f.draft, brief: 'docs/project/updated/' }, { env: {}, revision: f.read().revision });
  f.scan(); f.scan();
  assert.deepEqual(f.state(), before);
  assert.equal(f.read().planner_jobs.pending, null);
  const record = { plan: before.contract, project: f.project, programme: f.programme, repo: 'memoro-cli' };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'step');
});

test('unrelated programme metadata preserves exact reviewed merge evidence', async t => {
  const f = await ready(t); const read = () => readProgrammeState(f.root, f.programme);
  f.releasePlanner();
  const before = f.stateNow();
  mutateProgramme(f.root, f.programme, 'metadata', { ...read().metadata, brief: 'docs/project/updated/' }, { env: {}, revision: read().revision });
  const door = await f.door();
  assert.equal(door.ok, true, door.problems.join('; '));
  assert.deepEqual(f.stateNow(), before);
});

test('a real clean landing releases the next selected goal only after planner confirmation covers after-integration verification', async t => {
  const base = await ready(t); const read = () => readProgrammeState(base.root, base.programme);
  base.releasePlanner();
  const options = extra => ({ root: base.root, programme: base.programme, revision: read().revision, ...extra });
  setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation', type: 'activation', reference: 'approval' } });
  const actor = { role: 'plan', run_id: 'next-goal-plan' };
  const lease = claimProgrammeJob(options({ actor, pid: process.pid })).planner_jobs.lease;
  const f = decorate({ ...base, read, options }, () => options({ actor, token: lease.token }));
  f.create('next-goal'); f.send('next-goal');
  const next = (kind, input = {}) => f.intent(kind, input, { project: 'next-goal', expected_revision: f.state('next-goal').revision });
  f.apply(next('dependencies', { projects: [{ project: f.project, goal_revision: 1 }] }));
  f.apply(next('await-dependencies'));
  const report = f.state().review_reports.at(-1);
  recordAutonomousMergeEvent(f.root, f.programme, f.project, { binding: reportBinding(report), type: 'merge-landed',
    details: { merge_commit: report.session.head, merged_into: 'main' } });
  f.scan(); assert.equal(f.state().confirmed, false); assert.equal(f.state('next-goal').phase, 'plan_pending');
  const input = { id: 'confirm-delivery', reference: 'decisions/verified-integration', criteria: [
    { criterion_id: 'schema', reference: 'reports/schema' }, { criterion_id: 'integration', reference: 'integration/observed' } ] };
  const rejected = f.intent('confirm-project', { ...input, criteria: input.criteria.slice(0, 1) });
  assert.throws(() => f.apply(rejected), /including after-integration/u);
  cancelProgrammeOperation(f.owner(), { id: rejected.id, reason: 'Wait for the after-integration observation.' });
  f.apply(f.intent('confirm-project', input)); f.scan();
  const released = f.state('next-goal');
  assert.equal(f.state().confirmed, true); assert.equal(released.phase, 'ready');
  f.scan(); assert.equal(f.state('next-goal').revision, released.revision);
  assert.equal(released.plan_events.filter(item => item.type === 'dependency-released').length, 1);
  assert.equal(f.read().execution_enabled, false);
});
