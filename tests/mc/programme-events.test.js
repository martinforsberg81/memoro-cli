/** The planning journal both planners share: ordinary verbs replay from their
 * receipt, and events are consumed only by an ack that names them. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run as programmeCommand } from '../../src/mc/commands/programme.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';
import { CONTROL_CAPABILITIES, programmeAutonomyOff } from '../../src/mc/programme-control.js';
import { acknowledgeProgrammeEvents, claimProgrammeJob, completeProgrammePlan, finishProgrammeJob, listProgrammeEvents, reconcileProgrammeJobs,
  recordProgrammeTrigger, renewProgrammeJob, setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { acknowledgePlanningEvents, decideProgrammePlan, runPlanningOperation } from '../../src/mc/programme-plan.js';
import { autonomousPaths, mutateAutonomousProject, mutateProgramme, readAutonomousState, readProgrammeState, reserveProjectRun } from '../../src/mc/autonomous-state.js';
import { readProgrammeIncidents } from '../../src/mc/programme-recovery.js';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { measuredLanding } from './goal-followup-fixture.js';

const fixtureFile = fileURLToPath(new URL('./programme-jobs-fixture.js', import.meta.url));
const sha = 'b'.repeat(40);
const failure = (id, file = 'tests/shared.test.js') => ({ id, type: 'merge-failed', binding: { }, details: { main_failures: [file] } });

function fixture(t) {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const out = []; const err = [];
  const io = { stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } };
  f.programmeCli = (argv, env = {}) => { out.length = 0; err.length = 0; return programmeCommand(argv, { root: f.root, env, ...io, capabilities: { supported: [...CONTROL_CAPABILITIES] } }); };
  f.goal = (argv, env = {}) => { out.length = 0; err.length = 0; return goalCommand(argv, { root: f.root, env, ...io }); };
  f.out = () => JSON.parse(out.join('')); f.err = () => err.join('');
  f.state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  f.journal = () => f.read().planner_jobs;
  f.operations = () => f.journal().operations.map(item => [item.intent.kind, item.status]);
  f.list = () => listProgrammeEvents({ root: f.root, programme: f.programme, now: Date.now(), deps: { env: {} } });
  f.foreground = (extra = {}) => ({ root: f.root, programme: f.programme, now: Date.now(), deps: { env: {} }, ...extra });
  f.patch = (change, project = f.project) => {
    const file = autonomousPaths(f.root, f.programme, project).project;
    const state = JSON.parse(readFileSync(file, 'utf8')); change(state); state.revision++; writeFileSync(file, JSON.stringify(state));
  };
  f.leased = lease => ({ MC_AUTONOMOUS_ROLE: 'plan', MC_AUTONOMOUS_RUN: lease.actor.run_id, MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: lease.token });
  f.child = (...args) => spawnSync(process.execPath, [fixtureFile, ...args], { encoding: 'utf8', timeout: 30000 });
  return f;
}
const newGoal = (f, name, phase = '1') => ['new', `${f.programme}/${name}`, '--phase', phase, '--repo', 'memoro-cli', '--class', 'fast',
  '--goal', 'Goal text.', '--contract', 'Contract text.', '--out-of-scope', 'Nothing else.'];
const addCriterion = (f, name) => ['criterion', 'add', `${f.programme}/${name}`, '--id', 'schema', '--criterion', 'It holds.', '--instruction', 'Build it.',
  '--check', 'node --test', '--verify', 'premerge'];
const revised = (f, text) => ({ ...f.state().contract, goal_revision: 2, goal: [text] });
const author = (f, kind, input, project = f.project) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fixtureFile, 'author', f.root, f.programme, project, String(f.state(project).revision), JSON.stringify({ kind, input })]);
  let output = ''; let error = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
});

function failBuild(f) {
  const actor = { run_id: 'failed-build', role: 'step' };
  reserveProjectRun(f.root, f.programme, f.project, actor, f.state().revision);
  mutateAutonomousProject(f.root, f.programme, f.project, 'attempt', { id: actor.run_id, reason: 'Red.', commits: [] }, { actor, revision: f.state().revision });
  mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor, revision: f.state().revision });
  return actor;
}

test('a repeated ordinary command replays its receipt instead of changing the goal again', async t => {
  const f = fixture(t);
  assert.equal(await f.goal(newGoal(f, 'next')), 0, f.err());
  assert.equal(await f.goal(newGoal(f, 'next')), 0, f.err());
  assert.equal(f.state('next').revision, 1);
  assert.equal(await f.goal(addCriterion(f, 'next')), 0, f.err());
  const added = f.state('next');
  assert.equal(await f.goal([...addCriterion(f, 'next'), '--expected-revision', '1']), 0, f.err());
  assert.deepEqual(f.state('next'), added);
  assert.equal(await f.goal(['send', `${f.programme}/next`, '--expected-revision', String(added.revision)]), 0, f.err());
  const sent = f.state('next');
  assert.equal(await f.goal(['send', `${f.programme}/next`, '--expected-revision', String(added.revision)]), 0, f.err());
  assert.deepEqual(f.state('next'), sent);
  assert.equal(sent.phase, 'ready');
  assert.deepEqual(f.operations(), [['new-goal', 'applied'], ['revise-goal', 'applied'], ['send-goal', 'applied']]);
  assert.deepEqual(sent.operation_receipts.map(item => item.kind), ['new-goal', 'revise-goal', 'send-goal']);

  const revision = String(f.read().revision);
  assert.equal(await f.programmeCli(['phase', 'add', f.programme, '1', 'grunden', '--purpose', 'Foundations.', '--expected-revision', revision]), 0, f.err());
  const added1 = f.read();
  assert.equal(await f.programmeCli(['phase', 'add', f.programme, '1', 'grunden', '--purpose', 'Foundations.', '--expected-revision', revision]), 0, f.err());
  assert.deepEqual(f.read(), added1);
  assert.equal(f.operations().at(-1)[0], 'programme-phase-add');
  assert.equal(await f.programmeCli(['phase', 'add', f.programme, '1', 'grunden', '--purpose', 'Foundations.']), 1, 'a new read is a new command');
  assert.match(f.err(), /already exists/u);
});

test('a refused command leaves no pending intent and can simply run again', async t => {
  const f = fixture(t);
  const stale = f.state().revision + 5;
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`, '--expected-revision', String(stale)]), 1);
  assert.match(f.err(), /^mc: contention: stale state revision/u);
  assert.deepEqual(f.operations(), [['send-goal', 'refused']]);
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`]), 0, f.err());
  assert.deepEqual(f.operations(), [['send-goal', 'refused'], ['send-goal', 'applied']]);
});

test('a real crash between the state write and the receipt is replayed once, by the same command or by the ack', async t => {
  const f = fixture(t);
  const before = f.state().revision;
  const plan = join(f.paths.projectDir, 'PLAN.json');
  assert.equal(f.child('crash-goal', f.root, f.programme, f.project, String(before), 'committed').status, 86);
  assert.equal(f.state().phase, 'ready', 'the effect committed');
  assert.deepEqual(f.operations(), [['send-goal', 'pending']]);
  assert.equal(f.state().operation_receipts.length, 1);
  assert.equal(existsSync(plan), false, 'the crash came before its projection');
  recordProgrammeTrigger(f.options(), f.event('during-crash', 'failure'));

  // Any later ordinary work first finishes what committed.
  const replayed = f.state();
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`, '--expected-revision', String(before)]), 0, f.err());
  assert.deepEqual(f.state(), replayed, 'replay writes no second effect');
  assert.deepEqual(f.operations(), [['send-goal', 'applied']]);
  assert.deepEqual(JSON.parse(readFileSync(plan, 'utf8')), f.state().contract);

  // The ack itself settles a receipt rather than inferring anything from a process.
  f.patch(state => { state.phase = 'plan_pending'; });
  const next = f.state().revision;
  assert.equal(f.child('crash-goal', f.root, f.programme, f.project, String(next), 'committed').status, 86);
  acknowledgePlanningEvents(f.foreground(), { event_ids: ['during-crash'], reference: 'decisions/after-crash' });
  assert.deepEqual(f.operations().at(-1), ['send-goal', 'applied']);
  assert.equal(f.journal().pending, null);
});

test('a crash before the effect holds the ack and that goal until the intent is replayed or cancelled', async t => {
  const f = fixture(t);
  const revision = f.state().revision;
  recordProgrammeTrigger(f.options(), f.event('waiting', 'review'));
  assert.equal(f.child('crash-goal', f.root, f.programme, f.project, String(revision), 'prepared').status, 86);
  assert.deepEqual(f.operations(), [['send-goal', 'pending']]);
  assert.equal(f.state().revision, revision);
  assert.throws(() => acknowledgePlanningEvents(f.foreground(), { event_ids: ['waiting'], reference: 'decisions/x' }), /pending planner effects/u);
  assert.deepEqual(f.journal().pending.event_ids, ['waiting']);
  assert.deepEqual(f.list().pending_operations.map(item => item.project), [f.project]);

  assert.equal(await f.goal(['revise', `${f.programme}/${f.project}`, '--expected-revision', String(revision), '--input-file', f.file(revised(f, 'Another author.'))]), 1);
  assert.match(f.err(), /^mc: contention: operation op-[a-f0-9]+ on test-project is unresolved/u);
  assert.equal(f.state().goal_revision, 1);

  const id = f.journal().operations[0].intent.id;
  assert.equal(await f.programmeCli(['operation', 'cancel', f.programme, id, '--reason', 'Superseded by a revision.']), 0, f.err());
  assert.equal(await f.programmeCli(['events', 'ack', f.programme, '--event', 'waiting', '--reference', 'decisions/x']), 0, f.err());
  assert.equal(f.journal().pending, null);

  // Cancelling is for what never happened.
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`]), 0, f.err());
  const applied = f.journal().operations.at(-1).intent.id;
  assert.equal(await f.programmeCli(['operation', 'cancel', f.programme, applied, '--reason', 'Too late.']), 1);
  assert.match(f.err(), /only pending/u);
});

test('concurrent foreground authors in real processes land one effect and an explicit refusal', async t => {
  const f = fixture(t);
  const outcomes = await Promise.all([author(f, 'revise-goal', revised(f, 'First author.')), author(f, 'revise-goal', revised(f, 'Second author.'))]);
  assert.equal(outcomes.filter(item => item === 'applied').length, 1, outcomes.join(' / '));
  assert.match(outcomes.find(item => item !== 'applied'), /contention|persisted planner intent/u);
  const state = f.state();
  assert.equal(state.goal_revision, 2); assert.equal(state.contracts.length, 2);
  assert.equal(state.operation_receipts.length, 1);
  assert.equal(f.operations().filter(([, status]) => status === 'pending').length, 0);
});

test('a live lease refuses foreground authors explicitly and its owner uses the same verbs', async t => {
  const f = fixture(t); f.activate();
  const owner = f.claim(); const lease = f.journal().lease;
  const before = f.state();
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`]), 1);
  assert.match(f.err(), /^mc: contention: the programme already has an active run/u);
  assert.equal(await f.programmeCli(['events', 'ack', f.programme, '--event', lease.event_ids[0], '--reference', 'decisions/foreground']), 1);
  assert.match(f.err(), /contention/u);
  assert.equal(await f.programmeCli(['phase', 'add', f.programme, '1', 'grunden', '--purpose', 'Foundations.']), 1);
  assert.match(f.err(), /contention/u);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.journal().operations, []);

  // The lease's owner uses the same verbs, with the same journal.
  assert.equal(await f.goal(['send', `${f.programme}/${f.project}`], f.leased(lease)), 0, f.err());
  assert.equal(f.state().phase, 'ready');
  assert.equal(f.state().operation_receipts[0].run_id, lease.actor.run_id);
  assert.equal(await f.programmeCli(['events', 'ack', f.programme, '--event', lease.event_ids[0], '--reference', 'decisions/leased'], f.leased(lease)), 0, f.err());
  assert.equal(f.journal().acknowledgements[0].run_id, lease.actor.run_id);
  assert.notEqual(f.journal().lease, null, 'an ack does not end the session');
  finishProgrammeJob(owner());
  assert.equal(f.journal().pending, null);
});

test('an expired lease writes nothing: no goal effect, no ack, no renewal', async t => {
  const f = fixture(t); f.activate();
  const now = Date.now();
  const owner = f.claim({ now, leaseMs: 1000 }); const lease = f.journal().lease;
  const late = now + 2000;
  const before = f.read(); const goal = f.state();
  const leased = { root: f.root, programme: f.programme, actor: lease.actor, token: lease.token, now: late, deps: { env: {} } };
  assert.throws(() => runPlanningOperation(leased, { kind: 'send-goal', project: f.project, input: { after: [] }, revision: goal.revision }), /expired/u);
  assert.throws(() => acknowledgePlanningEvents(leased, { event_ids: lease.event_ids, reference: 'decisions/late' }), /expired/u);
  assert.throws(() => renewProgrammeJob(owner({ now: late })), /expired/u);
  assert.deepEqual(f.read(), before); assert.deepEqual(f.state(), goal);

  // Foreground waits for reconciliation rather than taking the dead lease's place.
  assert.throws(() => acknowledgePlanningEvents(f.foreground({ now: late }), { event_ids: lease.event_ids, reference: 'decisions/late' }), /contention/u);
  reconcileProgrammeJobs(f.options({ now: late, alive: () => true }));
  assert.equal(f.journal().recoveries[0].reason, 'lease-expired');
  assert.deepEqual(f.journal().pending.event_ids, lease.event_ids, 'expiry never acknowledges');
});

test('neither a process exit nor finishing a lease acknowledges a delivery', t => {
  const f = fixture(t); f.activate();
  const owner = f.claim(); const ids = f.journal().lease.event_ids;
  finishProgrammeJob(owner());
  assert.equal(f.read().active_run, null);
  assert.deepEqual(f.journal().pending.event_ids, ids);
  const second = f.claim({ actor: { run_id: 'job-plan-2', role: 'plan' } });
  assert.deepEqual(f.journal().lease.event_ids, ids);
  completeProgrammePlan(second(), { event_ids: ids, reference: 'decisions/done' });
  finishProgrammeJob(second());
  assert.equal(f.journal().pending, null);
  assert.deepEqual(f.journal().acknowledgements.map(item => item.reference), ['decisions/done']);
});

test('events are persisted with autonomy off, keep source identity, and off/on neither loses nor redelivers them', async t => {
  const f = fixture(t);
  assert.equal(await f.programmeCli(['autonomy', f.programme, 'on', '--expected-revision', String(f.read().revision)]), 0, f.err());
  const activation = f.journal().pending.event_ids[0];
  programmeAutonomyOff({ root: f.root, programme: f.programme, by: 'Martin' });

  // Attempt, review, landing, red main and follow-up, all from their durable sources.
  failBuild(f);
  f.patch(state => {
    measuredLanding(state);
    state.plan_events = [{ id: 'review-source', type: 'review-reported', goal_revision: 1 }, { id: 'landed-source', type: 'merge-landed', binding: { goal_revision: 1 } }, failure('red-source')];
  });
  const target = `${f.programme}/${f.project}`;
  assert.equal(await f.goal(['criterion', 'evidence', target, '--id', 'integration', '--reference', 'measurements/one.json', '--expected-revision', String(f.state().revision),
    '--integrated-sha', sha, '--outcome', 'passed']), 0, f.err());
  assert.equal(await f.programmeCli(['phase', 'add', f.programme, '1', 'grunden', '--purpose', 'Foundations.']), 0, f.err());
  assert.equal(await f.programmeCli(['phase', 'close', f.programme, '1', '--reference', 'decisions/phase-1']), 0, f.err());

  assert.equal(await f.programmeCli(['events', 'list', f.programme]), 0, f.err());
  const listed = f.out();
  assert.equal(listed.autonomy, false);
  assert.deepEqual(listed.events.map(item => item.type).sort(), ['activation', 'failure', 'failure', 'follow-up', 'landed', 'phase', 'red-main', 'review']);
  assert.ok(listed.events.every(item => item.id && item.reference));
  assert.deepEqual(listed.pending_operations, []);
  assert.equal(f.read().active_run, null, 'off never starts a consumer');
  claimProgrammeJob(f.options({ actor: { run_id: 'refused-plan', role: 'plan' }, pid: process.pid }));
  assert.equal(f.read().active_run, null);

  // The foreground planner consumes them; polling later finds nothing new.
  const ids = listed.events.filter(item => item.id !== activation).flatMap(item => ['--event', item.id]);
  assert.equal(await f.programmeCli(['events', 'ack', f.programme, ...ids, '--reference', 'decisions/foreground']), 0, f.err());
  assert.deepEqual(f.journal().pending.event_ids, [activation]);
  const revision = f.read().revision;
  reconcileProgrammeJobs(f.options({ now: Date.now() + 86_400_000 }));
  assert.equal(f.read().revision, revision, 'identity does not depend on when the scan ran');

  // Back on: only what nobody consumed is delivered.
  assert.equal(await f.programmeCli(['autonomy', f.programme, 'on', '--expected-revision', String(f.read().revision)]), 0, f.err());
  f.claim();
  assert.deepEqual(f.journal().lease.event_ids, [activation]);
});

test('event identity follows the source and its goal revision', t => {
  const f = fixture(t);
  const attempt = { id: 'same-attempt', goal_revision: 1 };
  f.patch(state => { state.attempts = [attempt]; });
  const scan = () => reconcileProgrammeJobs(f.options());
  const first = scan().planner_jobs.events.map(item => item.id);
  assert.deepEqual(scan().planner_jobs.events.map(item => item.id), first);
  f.patch(state => { state.attempts = [{ ...attempt, goal_revision: 2 }]; });
  const after = scan().planner_jobs.events.map(item => item.id);
  assert.equal(after.length, 2, 'the same source ID under another goal revision is another event');
});

test('an ack names only what its planner observed, and events arriving meanwhile survive it', async t => {
  const f = fixture(t); f.activate();
  const owner = f.claim(); const snapshot = f.journal().lease.event_ids;
  recordProgrammeTrigger(f.options(), f.event('late-review', 'review'));
  const ack = (event_ids, reference = 'decisions/ack') => acknowledgeProgrammeEvents(owner(), { event_ids, reference });
  assert.throws(() => ack(['late-review']), /unobserved events: late-review/u);
  assert.throws(() => ack([...snapshot, 'late-review']), /unobserved/u);
  assert.throws(() => ack(['never-existed']), /unobserved/u);
  assert.throws(() => ack([]), /event IDs/u);
  assert.throws(() => ack(snapshot, ' '), /reference/u);
  assert.deepEqual(f.journal().pending.event_ids, [...snapshot, 'late-review']);
  ack(snapshot);
  assert.deepEqual(f.journal().pending.event_ids, ['late-review']);
  const acked = f.read();
  ack(snapshot, 'decisions/replayed');
  assert.deepEqual(f.read(), acked, 'a replayed ack is a read');
  finishProgrammeJob(owner());
  assert.deepEqual(f.journal().pending.event_ids, ['late-review']);

  // Foreground: an event between list and ack stays pending without any retry.
  const listed = f.list().events.map(item => item.id);
  recordProgrammeTrigger(f.options(), f.event('during-ack', 'landed'));
  assert.throws(() => acknowledgePlanningEvents(f.foreground(), { event_ids: ['never-seen'], reference: 'decisions/x' }), /unobserved/u);
  acknowledgePlanningEvents(f.foreground(), { event_ids: listed, reference: 'decisions/foreground' });
  assert.deepEqual(f.journal().pending.event_ids, ['during-ack']);

  // A caller that asks for the CAS gets it.
  assert.throws(() => acknowledgePlanningEvents(f.foreground({ revision: 1 }), { event_ids: ['during-ack'], reference: 'decisions/cas' }), /contention: stale/u);
  assert.deepEqual(f.journal().pending.event_ids, ['during-ack']);
});

test('replay never creates a second repair, and the incident keeps one owner and one repair across programmes', t => {
  const f = fixture(t); f.activate();
  const other = 'other-programme'; const foreign = 'foreign-dependent';
  mutateProgramme(f.root, other, 'metadata', { ...f.draft, id: other }, { env: {}, revision: 0 });
  const otherOptions = extra => ({ root: f.root, programme: other, revision: readProgrammeState(f.root, other).revision, ...extra });
  setProgrammeJobMode(otherOptions(), { mode: 'active', event: { id: 'activation', type: 'activation', reference: 'approval' } });
  const actor = { role: 'plan', run_id: 'foreign-plan' };
  const foreignLease = claimProgrammeJob(otherOptions({ actor, pid: process.pid })).planner_jobs.lease;
  const foreignOwner = () => otherOptions({ actor, token: foreignLease.token });
  decideProgrammePlan(foreignOwner(), { id: 'foreign-project', kind: 'create-project', project: foreign, expected_revision: 0,
    input: autonomousProject({ project_id: foreign, programme: { id: other } }) });

  const owner = f.claim();
  f.patch(state => { state.plan_events = [failure('failure-owner')]; });
  reconcileProgrammeJobs(f.options());
  const path = join(f.root, 'programs', other, foreign, 'AUTONOMOUS_STATE.json');
  const dependent = JSON.parse(readFileSync(path)); dependent.plan_events = [failure('failure-foreign')]; writeFileSync(path, JSON.stringify(dependent));
  reconcileProgrammeJobs(otherOptions());
  const [incident] = readProgrammeIncidents(f.root);
  assert.equal(readProgrammeIncidents(f.root).length, 1);
  assert.equal(incident.owner, f.programme); assert.equal(incident.dependents.length, 2);
  assert.ok(f.journal().events.some(item => item.type === 'red-main'), 'the owner gets the incident event');

  const repair = { id: 'repair-main', kind: 'main-repair', project: 'main-repair-goal', expected_revision: 0, incident: incident.id,
    basis: { criteria: ['schema'], reference: 'decisions/scope' }, input: autonomousProject({ project_id: 'main-repair-goal' }) };
  assert.throws(() => decideProgrammePlan(owner({ deps: { writeDraft: () => { throw new Error('projection crash'); } } }), repair), /projection crash/u);
  const created = f.state('main-repair-goal');
  const replayedEvents = f.journal().events.length;
  decideProgrammePlan(owner(), repair); decideProgrammePlan(owner(), repair);
  assert.deepEqual(f.state('main-repair-goal'), created);
  reconcileProgrammeJobs(f.options()); reconcileProgrammeJobs(f.options());
  assert.equal(f.journal().events.length, replayedEvents);
  assert.throws(() => decideProgrammePlan(owner(), { ...repair, id: 'repair-again', project: 'second-repair', input: autonomousProject({ project_id: 'second-repair' }) }), /already has one repair/u);
  assert.throws(() => decideProgrammePlan(foreignOwner(), { ...repair, id: 'foreign-repair', project: 'foreign-repair', input: autonomousProject({ project_id: 'foreign-repair', programme: { id: other } }) }), /owning programme/u);
  assert.equal(readProgrammeIncidents(f.root)[0].repair.project, 'main-repair-goal');
});

test('retry, diagnose and wait are ordinary verbs with bounded history for both planners', async t => {
  const f = fixture(t); f.activate();
  const target = `${f.programme}/${f.project}`;
  assert.equal(await f.goal(['send', target]), 0, f.err());
  const actor = failBuild(f);

  assert.equal(await f.goal(['retry', target]), 1);
  assert.match(f.err(), /current planner diagnosis/u);
  assert.equal(f.state().phase, 'plan_pending');
  assert.equal(await f.goal(['diagnose', target, '--attempt', actor.run_id, '--diagnosis', 'The fixture was stale.']), 1, 'neither an approach nor an exception');
  assert.equal(await f.goal(['diagnose', target, '--attempt', actor.run_id, '--diagnosis', 'The fixture was stale.', '--approach', 'Rebuild the fixture.']), 0, f.err());
  assert.equal(await f.goal(['diagnose', target, '--attempt', actor.run_id, '--diagnosis', 'The fixture was stale.', '--approach', 'Rebuild the fixture.', '--expected-revision', String(f.state().revision - 1)]), 0, f.err());
  assert.equal(f.state().recovery_diagnoses.length, 1, 'the repeat is a replay');
  assert.equal(await f.goal(['retry', target]), 0, f.err());
  assert.equal(f.state().phase, 'ready');

  const wait = (condition = 'quota-reset', until = String(Date.now() + 60_000), env = {}) => f.programmeCli(['wait', f.programme, '--condition', condition, '--kind', 'quota', '--reason', 'Quota spent.',
    '--reference', `diagnosis/${until}`, '--until', until], env);
  assert.equal(await f.programmeCli(['wait', f.programme, '--condition', 'c', '--kind', 'quota', '--reason', 'r', '--reference', 'x']), 1, 'a quota wait is bounded');
  assert.equal(await wait(), 0, f.err());
  assert.equal(f.journal().mode, 'waiting');
  assert.equal(f.journal().wait_history[0].run_id, null, 'foreground holds no lease');
  setProgrammeJobMode(f.options(), { mode: 'active' });
  const owner = f.claim(); const lease = f.journal().lease;
  assert.equal(await wait('quota-reset', String(Date.now() + 90_000), f.leased(lease)), 0, f.err());
  assert.equal(f.journal().wait_history[1].run_id, lease.actor.run_id);
  setProgrammeJobMode(f.options(), { mode: 'active' });
  assert.equal(await wait('quota-reset', String(Date.now() + 120_000), f.leased(lease)), 0, f.err());
  assert.equal(f.journal().mode, 'exception', 'the third wait on one condition is not another wait');
  assert.equal(f.journal().exception.code, 'wait-exhausted');
  finishProgrammeJob(owner());
});

test('a headless review or build session cannot reach the planning verbs', async t => {
  const f = fixture(t); const before = f.read();
  const review = { MC_AUTONOMOUS_ROLE: 'review', MC_AUTONOMOUS_RUN: 'review-1' };
  assert.equal(await f.programmeCli(['events', 'list', f.programme], review), 1);
  assert.equal(await f.programmeCli(['events', 'ack', f.programme, '--event', 'x', '--reference', 'y'], { MC_AUTONOMOUS_ROLE: 'step', MC_AUTONOMOUS_RUN: 'step-1' }), 1);
  assert.deepEqual(f.read(), before);
});
