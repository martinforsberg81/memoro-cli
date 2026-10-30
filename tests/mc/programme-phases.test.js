/** Programme phases and planner autonomy are independent: phases order dispatch
 * and close only explicitly; autonomy controls only new headless planner claims. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../../src/mc/commands/programme.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';
import { CONTROL_CAPABILITIES } from '../../src/mc/programme-control.js';
import { programmeStatus, renderProgrammeStatus } from '../../src/mc/programme-status.js';
import { cancelProgrammeOperation, completeProgrammePlan, finishProgrammeJob, prepareProgrammeOperation, reachProgrammeStop, reconcileProgrammeJobs,
  reconcileProgrammeQueue, recordProgrammeTrigger, setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { autonomousPaths, createAutonomousDraft, mutateAutonomousProject, mutateProgramme, readAutonomousState, reserveProjectRun, sendAutonomousProject,
  startAutonomousBuild } from '../../src/mc/autonomous-state.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { takeClaim, releaseClaim } from '../../src/mc/resource-claim.js';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { measuredLanding } from './goal-followup-fixture.js';

const supported = { supported: [...CONTROL_CAPABILITIES] };
const sha = 'b'.repeat(40);

function fixture(t) {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const out = []; const err = [];
  const io = { stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } };
  f.cli = (argv, deps = {}) => { out.length = 0; err.length = 0; return run(argv, { root: f.root, env: {}, ...io, ...deps }); };
  f.goal = (argv, env = {}) => { out.length = 0; err.length = 0; return goalCommand(argv, { root: f.root, env, ...io }); };
  f.out = () => out.join(''); f.err = () => err.join('');
  f.raw = () => readFileSync(f.paths.programme, 'utf8');
  f.add = (n, name = `phase-${n}`) => f.cli(['phase', 'add', f.programme, String(n), name, '--purpose', `Purpose of ${name}.`]);
  f.close = (n, reference = `decisions/phase-${n}`) => f.cli(['phase', 'close', f.programme, String(n), '--reference', reference]);
  f.on = (stop = null) => f.cli(['autonomy', f.programme, 'on', '--expected-revision', String(f.read().revision), ...(stop ? ['--stop', stop] : [])], { capabilities: supported });
  f.off = () => f.cli(['autonomy', f.programme, 'off', '--by', 'Martin']);
  f.create = (project, programme_phase) => createAutonomousDraft(f.root, f.programme, project,
    autonomousProject({ project_id: project, programme_phase }), { env: {}, revision: f.read().revision });
  f.state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  f.send = (project = f.project, after = []) => sendAutonomousProject(f.root, f.programme, project, { env: {}, revision: f.state(project).revision, after });
  f.patchGoal = (project, change) => {
    const file = autonomousPaths(f.root, f.programme, project).project;
    const state = JSON.parse(readFileSync(file, 'utf8')); change(state); state.revision++;
    writeFileSync(file, JSON.stringify(state));
  };
  f.land = (project = f.project) => f.patchGoal(project, measuredLanding);
  f.measure = (project = f.project, outcome = 'passed') => mutateAutonomousProject(f.root, f.programme, project, 'follow-up', {
    id: `measurement-${f.state(project).revision}`, criterion_id: 'integration', goal_revision: 1, integrated_sha: sha, reference: 'measurements/cli.json', outcome,
  }, { env: {}, revision: f.state(project).revision });
  f.choice = (project = f.project) => autonomousChoice({ root: f.root, capability: { review: true },
    record: { project, programme: f.programme, repo: 'memoro-cli', plan: f.state(project).contract } });
  return f;
}

test('phase verbs need a purpose or a reference and write only ordered, declared phases', async t => {
  const f = fixture(t); const before = f.raw();
  assert.equal(await f.cli(['phase', 'add', f.programme, '1', 'grunden']), 2);
  assert.equal(await f.cli(['phase', 'add', f.programme, '0', 'zero', '--purpose', 'No.']), 2);
  assert.equal(await f.cli(['phase', 'close', f.programme, '1']), 2);
  assert.equal(await f.cli(['phase', 'rename', f.programme, '1']), 2);
  assert.equal(await f.close(1), 1); assert.match(f.err(), /not declared/u);
  assert.equal(f.raw(), before, 'refusals write nothing');
  assert.equal(await f.add(2), 0, f.err()); assert.equal(await f.add(1), 0, f.err());
  assert.deepEqual(f.read().phases.map(item => [item.n, item.purpose, item.closed]), [[1, 'Purpose of phase-1.', null], [2, 'Purpose of phase-2.', null]]);
  assert.equal(await f.add(1), 1); assert.match(f.err(), /already exists/u);
  assert.equal(await f.cli(['phase', 'add', f.programme, '3', 'next', '--purpose', 'Next.', '--expected-revision', '1']), 1);
  assert.match(f.err(), /stale state revision/u);
});

test('an empty phase never closes by itself and holds later phases until it is closed explicitly', async t => {
  const f = fixture(t);
  assert.equal(await f.add(2), 0, f.err()); assert.equal(await f.add(3), 0, f.err());
  // The fixture goal sits in undeclared phase 1, so it never orders phase 2.
  f.create('later', 3); f.send('later');
  assert.equal(f.state('later').phase, 'ready');
  reconcileProgrammeJobs(f.options());
  assert.deepEqual(f.read().phases.map(item => item.closed), [null, null], 'nothing closes a phase as a side effect');
  assert.equal(f.choice('later').reason, 'programme-phase');
  assert.equal(await f.close(3), 1); assert.match(f.err(), /close programme phase 2 first/u);
  assert.equal(await f.close(2), 0, f.err());
  assert.equal(f.choice('later').kind, 'step');
});

test('only the earliest unclosed phase dispatches; closing it releases the next, and open goals run in parallel', async t => {
  const f = fixture(t);
  assert.equal(await f.add(1), 0, f.err()); assert.equal(await f.add(2), 0, f.err());
  f.create('beside', 1); f.create('following', 1); f.create('later', 2);
  for (const project of [f.project, 'beside', 'later']) f.send(project);
  f.send('following', ['beside']);
  // Parallel under existing caps; --after gives the further ordering.
  assert.equal(f.choice().kind, 'step'); assert.equal(f.choice('beside').kind, 'step');
  assert.equal(f.state('following').dependency_release.status, 'waiting');
  assert.equal(f.choice('later').reason, 'programme-phase');
  assert.throws(() => startAutonomousBuild(f.root, f.programme, 'later', { actor: { run_id: 'build-later', role: 'step' }, revision: f.state('later').revision,
    assignment: f.state('later').contract }), /programme phase 1 is not closed/u);
  const status = programmeStatus(f.root, f.programme, { capabilities: supported });
  const later = status.goals.find(goal => goal.project === 'later');
  assert.deepEqual([later.phase, later.programme_phase], ['ready', 2], 'runtime phase and programme phase stay separate');
  assert.equal(later.next_action, 'wait: programme phase 1 is not closed');
  assert.deepEqual(status.phases.map(item => [item.n, item.goals, item.landed, item.closed]), [[1, 3, 0, null], [2, 1, 0, null]]);
  assert.match(renderProgrammeStatus(status), /ready · goal r1 · fast · programme phase 2/u);
  assert.match(renderProgrammeStatus(status), /PHASES\n {2}1 phase-1 — Purpose of phase-1\. · open · 0\/3 landed/u);

  for (const project of [f.project, 'beside', 'following']) { f.land(project); f.measure(project); }
  assert.equal(f.choice('later').reason, 'programme-phase', 'a finished phase still needs its explicit close');
  assert.equal(await f.close(1), 0, f.err());
  assert.equal(f.choice('later').kind, 'step');
  assert.equal(f.read().phases[0].closed.reference, 'decisions/phase-1');
});

test('close requires landed goals, measured follow-ups and no ownership; a repeated close is a read', async t => {
  const f = fixture(t);
  assert.equal(await f.add(1), 0, f.err());
  // The unsent draft counts: every phase goal must have landed.
  assert.equal(await f.close(1), 1); assert.match(f.err(), new RegExp(`${f.project} has not landed`, 'u'));
  f.land();
  assert.equal(await f.close(1), 1); assert.match(f.err(), /unmeasured follow-ups: integration/u);
  for (const outcome of ['failed', 'unknown']) {
    f.measure(f.project, outcome);
    assert.equal(await f.close(1), 1); assert.match(f.err(), /unmeasured follow-ups/u);
  }
  f.measure();
  const builder = { run_id: 'lingering-run', role: 'step' };
  f.patchGoal(f.project, state => { state.active_run = builder; state.runs.push(builder); });
  assert.equal(await f.close(1), 1); assert.match(f.err(), /still owned/u);
  f.patchGoal(f.project, state => { state.active_run = null; });
  const path = join(f.root, 'runner', 'autonomous-builds', f.programme, `${f.project}.claim`);
  const claim = takeClaim(path, { pid: process.pid });
  assert.equal(await f.close(1), 1); assert.match(f.err(), /still owned/u);
  releaseClaim(path, claim.marker);
  assert.equal(f.read().phases[0].closed, null);

  assert.equal(await f.close(1), 0, f.err());
  const closed = f.raw();
  assert.equal(await f.close(1), 0, f.err()); assert.equal(f.raw(), closed, 'a repeated close writes nothing');
  assert.equal(await f.cli(['phase', 'close', f.programme, '1', '--reference', 'decisions/phase-1', '--expected-revision', '1']), 0, 'even from a stale view');
  assert.equal(await f.close(1, 'decisions/another'), 1); assert.match(f.err(), /already closed with another reference/u);
  assert.equal(f.raw(), closed);
});

test('a closed or undeclared phase takes no new goals, by create or by revision', async t => {
  const f = fixture(t);
  f.land(); f.measure();
  assert.equal(await f.add(1), 0, f.err()); assert.equal(await f.add(2), 0, f.err());
  assert.equal(await f.close(1), 0, f.err());
  const goal = (name, phase) => f.goal(['new', `${f.programme}/${name}`, '--phase', String(phase), '--repo', 'memoro-cli', '--class', 'fast',
    '--goal', 'A goal.', '--contract', 'A contract.', '--out-of-scope', 'Nothing else.']);
  assert.equal(await goal('too-late', 1), 1); assert.match(f.err(), /programme phase 1 is closed/u);
  assert.equal(await goal('nowhere', 9), 1); assert.match(f.err(), /phase 9 is not declared/u);
  assert.equal(await goal('in-time', 2), 0, f.err());
  const state = f.state('in-time');
  const criteria = autonomousProject().success_criteria;
  assert.throws(() => mutateAutonomousProject(f.root, f.programme, 'in-time', 'revise', { ...state.contract, goal_revision: 2, programme_phase: 1, success_criteria: criteria },
    { env: {}, revision: state.revision }), /programme phase 1 is closed/u);
  assert.equal(await f.add(1), 1, 'a closed number is not reopened');
  assert.equal(await f.cli(['phase', 'add', f.programme, '0', 'none', '--purpose', 'No.']), 2);
});

test('a phase added below a closed phase is refused; both planners share the phase verbs; step and review do not', async t => {
  const f = fixture(t);
  assert.equal(await f.add(1), 0, f.err()); assert.equal(await f.add(3), 0, f.err());
  f.land(); f.measure();
  assert.equal(await f.close(1), 0, f.err());
  assert.equal(await f.close(3), 0, f.err());
  assert.equal(await f.add(2), 1); assert.match(f.err(), /cannot precede a closed phase/u);
  const before = f.raw();
  for (const role of ['step', 'review']) {
    assert.equal(await f.cli(['phase', 'add', f.programme, '4', 'next', '--purpose', 'Next.'], { env: { MC_AUTONOMOUS_ROLE: role, MC_AUTONOMOUS_RUN: `run-${role}` } }), 1);
  }
  assert.equal(f.raw(), before);
  f.activate();
  f.claim();
  const lease = f.read().planner_jobs.lease;
  const leased = { MC_AUTONOMOUS_ROLE: 'plan', MC_AUTONOMOUS_RUN: lease.actor.run_id, MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: lease.token };
  assert.equal(await f.add(4), 1, 'a foreground writer does not impersonate the lease'); assert.match(f.err(), /active run/u);
  assert.equal(await f.cli(['phase', 'add', f.programme, '4', 'next', '--purpose', 'Next.'], { env: leased }), 0, f.err());
  assert.equal(await f.cli(['phase', 'close', f.programme, '4', '--reference', 'decisions/next'], { env: leased }), 0, f.err());
  assert.equal(f.read().phases.at(-1).closed.run_id, lease.actor.run_id);
  assert.equal(await f.cli(['phase', 'add', 'other-programme', '1', 'x', '--purpose', 'X.'], { env: leased }), 1);
  assert.match(f.err(), /owning programme/u);
});

test('autonomy off stops only the next claim: a held lease finishes, sent goals and reviews continue, events accrue', async t => {
  const f = fixture(t);
  f.send();
  f.activate();
  const owner = f.claim(); const lease = f.read().planner_jobs.lease;
  assert.equal(await f.off(), 0, f.err());
  // The claimed snapshot finishes under its lease.
  const intent = f.intent();
  prepareProgrammeOperation(owner(), intent);
  assert.equal(f.read().planner_jobs.operations.at(-1).status, 'pending');
  cancelProgrammeOperation(owner(), { id: intent.id, reason: 'The snapshot needs no new goal.' });
  recordProgrammeTrigger(f.options(), f.event('while-off', 'failure'));
  completeProgrammePlan(owner(), { event_ids: lease.event_ids, reference: 'decisions/finished' });
  finishProgrammeJob(owner());
  assert.equal(f.read().active_run, null);
  assert.deepEqual(f.read().planner_jobs.pending.event_ids, ['while-off'], 'events keep their place for foreground planning or a later claim');

  // No next lease, and the runner's scan offers none.
  f.claim({ actor: { run_id: 'job-plan-2', role: 'plan' } });
  assert.equal(f.read().active_run, null);
  assert.deepEqual(reconcileProgrammeQueue(f.root), []);
  assert.equal(f.read().planner_jobs.pending.event_ids.includes('while-off'), true);
  assert.equal(programmeStatus(f.root, f.programme, { capabilities: supported }).plan.pending_events, f.read().planner_jobs.pending.event_ids.length);

  // Sent work is not autonomy's: a build and a review are still chosen.
  assert.equal(f.choice().kind, 'step');
  f.patchGoal(f.project, value => { value.phase = 'review_ready'; });
  assert.equal(f.choice().kind, 'review');

  // Foreground planning keeps every verb while off.
  assert.equal(await f.add(1), 0, f.err());
  assert.equal(await f.close(1), 1); assert.match(f.err(), /has not landed/u);

  // Turning it back on grants the next lease, without touching phases.
  const phases = f.read().phases;
  assert.equal(await f.on(), 0, f.err());
  assert.deepEqual(f.read().phases, phases);
  assert.deepEqual(reconcileProgrammeQueue(f.root), [f.programme]);
  f.claim({ actor: { run_id: 'job-plan-3', role: 'plan' } });
  assert.equal(f.read().active_run.run_id, 'job-plan-3');
});

test('autonomy does not release phases, and phases do not change the preference', async t => {
  const f = fixture(t);
  assert.equal(await f.on('When phase 2 has landed.'), 0, f.err());
  assert.equal(await f.add(1), 0, f.err()); assert.equal(await f.add(2), 0, f.err());
  f.create('later', 2); f.send('later');
  assert.equal(f.choice('later').reason, 'programme-phase');
  f.land(); f.measure();
  assert.equal(await f.close(1), 0, f.err());
  assert.equal(f.read().autonomy.enabled, true); assert.equal(f.read().autonomy.stop, 'When phase 2 has landed.');
  assert.equal(await f.off(), 0, f.err());
  assert.equal(f.choice('later').kind, 'step', 'off never holds a released phase');
});

test('a reached prose stop is recorded with its reference by either planner and keeps the preference', async t => {
  const f = fixture(t);
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/stop']), 1, 'nothing to stop before the first on');
  assert.equal(await f.cli(['stop', f.programme]), 2);
  assert.equal(await f.on('When the pilot has been measured.'), 0, f.err());
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/stop'], { env: { MC_AUTONOMOUS_ROLE: 'step', MC_AUTONOMOUS_RUN: 'run-step' } }), 1);

  // Headless: the leased planner reaches the same operation.
  const owner = f.claim(); const lease = f.read().planner_jobs.lease;
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/stop']), 1, 'foreground refuses while a lease runs'); assert.match(f.err(), /active run/u);
  const leased = { MC_AUTONOMOUS_ROLE: 'plan', MC_AUTONOMOUS_RUN: lease.actor.run_id, MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: lease.token };
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/stop'], { env: leased }), 0, f.err());
  completeProgrammePlan(owner(), { event_ids: lease.event_ids, reference: 'decisions/stop' });
  finishProgrammeJob(owner());
  let state = f.read();
  assert.equal(state.planner_jobs.mode, 'stopped');
  assert.equal(state.planner_jobs.reached_stop.reference, 'decisions/stop');
  assert.equal(state.planner_jobs.reached_stop.condition, 'When the pilot has been measured.');
  assert.deepEqual([state.autonomy.enabled, state.autonomy.stop], [true, 'When the pilot has been measured.'], 'the stop does not change the preference');
  recordProgrammeTrigger(f.options(), f.event('after-stop', 'landed'));
  f.claim({ actor: { run_id: 'job-plan-2', role: 'plan' } });
  assert.equal(f.read().active_run, null, 'no claim past a reached stop');
  let status = programmeStatus(f.root, f.programme, { capabilities: supported });
  assert.equal(status.mode, 'stopped'); assert.equal(status.autonomy.enabled, true); assert.equal(status.autonomy.reached.reference, 'decisions/stop');
  assert.match(renderProgrammeStatus(status), /stop {8}When the pilot has been measured\. · reached/u);
  assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'active' }), /foreground planning restart/u);

  // Only the operator's explicit on continues, with a new whole preference.
  assert.equal(await f.on('When the next pilot has been measured.'), 0, f.err());
  state = f.read();
  assert.equal(state.planner_jobs.mode, 'active'); assert.equal(state.planner_jobs.reached_stop, null);

  // Foreground: the same operation, an idempotent read when repeated.
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/foreground']), 0, f.err());
  const stopped = f.raw();
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/foreground']), 0, f.err());
  assert.equal(f.raw(), stopped);
  assert.equal(f.read().planner_jobs.reached_stop.run_id, null);
  assert.equal(f.read().autonomy.enabled, true);
  reachProgrammeStop(f.options(), { id: f.read().planner_jobs.stop, reference: 'decisions/foreground' });
  assert.equal(f.raw(), stopped);
});

test('reaching a stop waits for owned goals', async t => {
  const f = fixture(t);
  assert.equal(await f.on(), 0, f.err());
  reserveProjectRun(f.root, f.programme, f.project, { run_id: 'builder-1', role: 'step' }, f.state().revision);
  assert.equal(await f.cli(['stop', f.programme, '--reference', 'decisions/stop']), 1);
  assert.match(f.err(), /affected runs must close/u);
  assert.equal(f.read().planner_jobs.mode, 'active');
  mutateProgramme(f.root, f.programme, 'metadata', f.draft, { env: {}, revision: f.read().revision });
  assert.equal(f.read().autonomy.enabled, true, 'an ordinary metadata write keeps the preference');
});
