import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  claimProgrammeJob, completeProgrammeOperation, createProgrammeJobProject, finishProgrammeJob,
  MAX_PLANNER_LEASE_MS, prepareProgrammeOperation, reconcileProgrammeJobs, reconcileProgrammeQueue,
  recordProgrammeTrigger, renewProgrammeJob, setProgrammeJobMode,
} from '../../src/mc/programme-jobs.js';
import { autonomousPaths, createAutonomousDraft, mutateProgramme, readProgrammeState, releaseProgrammeRun, mutateAutonomousProject, readAutonomousState, reserveProgrammeRun, reserveProjectRun } from '../../src/mc/autonomous-state.js';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { createRunner } from '../../src/mc/run.js';
import { runnerFixture } from './autonomous-run-fixture.js';
import { builder, planner } from './autonomous-state-fixture.js';

function fixture(t) { const f = programmeJobsFixture(); t.after(f.cleanup); return f; }
const scan = (f, extra = {}, dependencies = []) => reconcileProgrammeJobs(f.options(extra), { dependencies });

describe('durable programme trigger coalescing and planner ownership (inactive)', () => {
  it('persists activation before claim and coalesces all trigger kinds into one owner', t => {
    const f = fixture(t);
    f.activate();
    const pendingId = f.read().planner_jobs.pending.id;
    for (const type of ['review', 'landed', 'failure', 'dependency', 'idle']) recordProgrammeTrigger(f.options(), f.event(`event-${type}`, type));
    assert.equal(f.read().planner_jobs.pending.id, pendingId);
    assert.equal(f.read().active_run, null);
    const options = f.claim();
    const lease = f.read().planner_jobs.lease;
    assert.equal(lease.event_ids.length, 6);
    const revision = f.read().revision;
    claimProgrammeJob(f.options({ actor: { run_id: 'competing-plan', role: 'plan' }, pid: process.pid }));
    assert.equal(f.read().revision, revision);
    assert.equal(f.read().active_run.run_id, 'job-plan-1');
    assert.throws(() => reserveProgrammeRun(f.root, f.programme, planner, revision), /active run/u);
    finishProgrammeJob(options());
    assert.equal(f.read().planner_jobs.pending, null);
    assert.equal(f.read().active_run, null);
    assert.equal(f.read().execution_enabled, false);
    const finished = f.read().revision;
    recordProgrammeTrigger(f.options(), f.event());
    assert.equal(f.read().revision, finished, 'redelivered consumed event is not a second job');
  });

  it('permits only one claim across competing real processes', async t => {
    const f = fixture(t); f.activate();
    const contend = runId => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./programme-jobs-fixture.js', import.meta.url)), 'contend', f.root, f.programme, runId]);
      let output = ''; let error = '';
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
    });
    const outcomes = await Promise.all([contend('contender-1'), contend('contender-2')]);
    assert.deepEqual(outcomes.sort(), ['claimed', 'not-claimed']);
    assert.equal(f.read().runs.filter(run => run.run_id.startsWith('contender-')).length, 1);
    scan(f); assert.equal(f.read().planner_jobs.recoveries.length, 1);
  });

  it('does not reserve an owner when the atomic persistence fails', t => {
    const f = fixture(t); f.activate(); const before = f.read();
    assert.throws(() => f.claim({ deps: { write: () => { throw new Error('disk unavailable'); } } }), /disk unavailable/u);
    assert.deepEqual(f.read(), before);
  });

  it('keeps events arriving during a lease for the next delivery', t => {
    const f = fixture(t); f.activate(); const owner = f.claim();
    recordProgrammeTrigger(f.options(), f.event('late-review', 'review'));
    const before = f.read().revision;
    recordProgrammeTrigger(f.options(), f.event('late-review', 'review'));
    assert.equal(f.read().revision, before);
    assert.throws(() => recordProgrammeTrigger(f.options(), { ...f.event('late-review', 'review'), reference: 'different' }), /different content/u);
    finishProgrammeJob(owner());
    assert.deepEqual(f.read().planner_jobs.pending.event_ids, ['late-review']);
    f.claim({ actor: { run_id: 'job-plan-2', role: 'plan' } });
    assert.deepEqual(f.read().planner_jobs.lease.event_ids, ['late-review']);
  });

  it('refuses stale revisions, malformed events and unbounded or non-plan reservations', t => {
    const f = fixture(t); const stale = f.options(); f.activate();
    assert.throws(() => recordProgrammeTrigger(stale, f.event('review-1', 'review')), /stale/u);
    for (const event of [f.event('../escape'), f.event('unknown', 'repair'), { ...f.event(), programme_revision: 1 }]) {
      assert.throws(() => recordProgrammeTrigger(f.options(), event), /invalid/u);
    }
    assert.throws(() => f.claim({ actor: builder }), /planner/u);
    assert.throws(() => f.claim({ leaseMs: MAX_PLANNER_LEASE_MS + 1 }), /bounded/u);
    const owner = f.claim();
    assert.throws(() => finishProgrammeJob(owner({ token: 'wrong-token' })), /ownership/u);
    assert.throws(() => renewProgrammeJob(owner({ actor: planner })), /ownership/u);
    const old = owner(); renewProgrammeJob(owner({ now: Date.now() + 1000 }));
    assert.throws(() => finishProgrammeJob(old), /stale/u);
  });

  it('does not serialize independent builders behind the planner lease', t => {
    const f = fixture(t); f.activate(); const owner = f.claim();
    let state = readAutonomousState(f.root, f.programme, f.project);
    // The pre-existing fixture project is owned by the former planner. Its
    // release must not be forged by that expired owner; use a fresh project.
    assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, 'release', null,
      { actor: planner, token: 'fixture-lease', revision: state.revision }), /ownership/u);
    createProgrammeJobProject(owner(), f.intent());
    state = readAutonomousState(f.root, f.programme, 'next-project');
    state = reserveProjectRun(f.root, f.programme, 'next-project', owner().actor, state.revision);
    state = mutateAutonomousProject(f.root, f.programme, 'next-project', 'release', null,
      { actor: owner().actor, revision: state.revision });
    const build = reserveProjectRun(f.root, f.programme, 'next-project', builder, state.revision);
    assert.deepEqual(build.active_run, builder);
    assert.deepEqual(f.read().active_run, owner().actor);
  });
});

describe('planner leases, restart reconciliation and explicit waits', () => {
  it('renews a live lease without losing its event snapshot or expiring at the old deadline', t => {
    const f = fixture(t); f.activate();
    const now = Date.now(); const owner = f.claim({ now, leaseMs: 1000 });
    const original = f.read().planner_jobs.lease;
    renewProgrammeJob(owner({ now: now + 500, leaseMs: 1000 }));
    scan(f, { now: original.expires_at, alive: () => true });
    const renewed = f.read().planner_jobs.lease;
    assert.equal(renewed.token, original.token);
    assert.deepEqual(renewed.event_ids, original.event_ids);
    assert.equal(renewed.expires_at, now + 1500);
    assert.deepEqual(f.read().planner_jobs.recoveries, []);
    finishProgrammeJob(owner({ now: now + 1100 }));
  });

  it('recovers a dead owner before expiry, retains events and fences its old writer', t => {
    const f = fixture(t); f.activate(); const owner = f.claim();
    const lease = f.read().planner_jobs.lease;
    scan(f, { alive: () => false });
    assert.equal(f.read().planner_jobs.lease, null);
    assert.deepEqual(f.read().planner_jobs.pending.event_ids, lease.event_ids);
    assert.equal(f.read().planner_jobs.recoveries[0].reason, 'owner-gone');
    const replacement = f.claim({ actor: { run_id: 'replacement-plan', role: 'plan' } });
    assert.throws(() => finishProgrammeJob(owner()), /ownership/u);
    assert.throws(() => createAutonomousDraft(f.root, f.programme, 'stale-project', autonomousProject({ project_id: 'stale-project' }),
      { actor: owner().actor, revision: f.read().revision }), /ownership/u);
    finishProgrammeJob(replacement());
  });

  it('expires a live but orphaned lease, and never lets the old generation renew or write', t => {
    const f = fixture(t); f.activate(); const owner = f.claim({ leaseMs: 1000 });
    const expiry = f.read().planner_jobs.lease.expires_at;
    assert.throws(() => renewProgrammeJob(owner({ now: expiry })), /expired/u);
    assert.throws(() => createAutonomousDraft(f.root, f.programme, 'stale-project', autonomousProject({ project_id: 'stale-project' }),
      { actor: owner().actor, revision: f.read().revision, now: () => expiry }), /expired/u);
    scan(f, { now: expiry, alive: () => true });
    assert.equal(f.read().planner_jobs.recoveries[0].reason, 'lease-expired');
    assert.throws(() => f.claim({ actor: owner().actor }), /fresh planner/u);
    f.claim({ actor: { run_id: 'replacement-plan', role: 'plan' }, now: expiry });
    assert.throws(() => renewProgrammeJob(owner({ now: expiry })), /ownership/u);
  });

  it('keeps paused, quota and external waits explicit without losing late events', t => {
    const f = fixture(t); f.activate();
    setProgrammeJobMode(f.options(), { mode: 'paused' });
    f.claim(); assert.equal(f.read().active_run, null);
    recordProgrammeTrigger(f.options(), f.event('while-paused', 'failure'));
    assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'waiting', wait: { kind: 'quota', reason: 'reset unknown', until: null } }), /bounded/u);
    const until = Date.now() + 10000;
    setProgrammeJobMode(f.options(), { mode: 'waiting', wait: { kind: 'quota', reason: 'subscription reset', until } });
    scan(f, { now: until - 1 });
    assert.equal(f.read().planner_jobs.mode, 'waiting');
    scan(f, { now: until });
    assert.equal(f.read().planner_jobs.mode, 'active');
    assert.deepEqual(f.read().planner_jobs.pending.event_ids, ['activation-1', 'while-paused']);
    setProgrammeJobMode(f.options(), { mode: 'waiting', wait: { kind: 'external', reason: 'deployment result not observed', until: null } });
    scan(f, { now: until + 10000 });
    assert.equal(f.read().planner_jobs.wait.kind, 'external');
    f.claim(); assert.equal(f.read().active_run, null);
  });

  it('stops at an explicit stop and refuses further dispatch or implicit resume', t => {
    const f = fixture(t); f.activate();
    assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'stopped', stop: '../invalid-stop' }), /stable ID/u);
    setProgrammeJobMode(f.options(), { mode: 'stopped', stop: 'design-review' });
    const stopped = f.read().revision;
    setProgrammeJobMode(f.options(), { mode: 'stopped', stop: 'design-review' });
    assert.equal(f.read().revision, stopped);
    recordProgrammeTrigger(f.options(), f.event('landed-at-stop', 'landed'));
    scan(f); f.claim();
    assert.equal(f.read().planner_jobs.pending.event_ids.length, 2);
    assert.equal(f.read().active_run, null);
    assert.throws(() => setProgrammeJobMode(f.options(), { mode: 'active' }), /foreground planning restart/u);
  });

  it('scans durable review, landing, failure and dependency sources once, even when delivery repeats', t => {
    const f = fixture(t); f.activate();
    const source = f.json(f.paths.project);
    source.active_run = null; source.phase = 'plan_pending';
    source.plan_events = [
      { id: 'review-source', type: 'review-reported' },
      { id: 'landed-source', type: 'merge-landed', binding: { } },
      { id: 'failed-source', type: 'merge-failed', binding: { } },
    ];
    source.attempts = [{ id: 'build-attempt' }];
    writeFileSync(f.paths.project, JSON.stringify(source));
    const dependency = f.event('dependency-1', 'dependency');
    scan(f, {}, [dependency]);
    assert.deepEqual(f.read().planner_jobs.events.map(item => item.type), ['activation', 'review', 'landed', 'failure', 'failure', 'dependency']);
    const revision = f.read().revision;
    scan(f, {}, [dependency]);
    assert.equal(f.read().revision, revision);
    const owner = f.claim(); finishProgrammeJob(owner());
    scan(f, {}, [dependency]);
    assert.equal(f.read().planner_jobs.pending.event_ids.length, 1);
    assert.equal(f.read().planner_jobs.events.at(-1).type, 'idle');
    const idle = f.claim({ actor: { run_id: 'idle-plan', role: 'plan' } }); finishProgrammeJob(idle());
    const before = f.read().revision; scan(f);
    assert.equal(f.read().revision, before, 'unchanged idle scans must not spin up planners');
  });

  it('keeps v1 queue behavior unchanged and reconciles only through the injected runner capability', t => {
    const f = runnerFixture(t);
    f.releasePlanner();
    const options = () => ({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision });
    setProgrammeJobMode(options(), { mode: 'active', event: { id: 'activation-1', type: 'activation', reference: 'fixture activation' } });
    const before = readProgrammeState(f.root, f.programme);
    const legacy = createRunner({ deps: f.deps }).queue();
    assert.equal(Object.hasOwn(legacy, 'programmeJobs'), false);
    assert.deepEqual(readProgrammeState(f.root, f.programme), before);
    const capable = createRunner({ deps: f.deps, autonomous: { ...f.capability, programmeJobs: true } }).queue();
    assert.deepEqual(capable.programmeJobs, [f.programme]);
    assert.deepEqual(capable.names, legacy.names);
    assert.equal(f.calls.length, 0, 'reconciliation is not headless launch or activation');
    assert.equal(readProgrammeState(f.root, f.programme).execution_enabled, false);
  });

  it('refuses damaged trigger sources atomically instead of losing failures behind a deduplicated ID', t => {
    const f = fixture(t); f.activate(); f.claim();
    const original = f.json(f.paths.project); const before = f.read();
    const event = { id: `review-${'a'.repeat(64)}`, type: 'review-reported' };
    const attempt = { id: 'attempt-1' };
    const damagedSources = [
      { ...original, plan_events: [{ ...event, id: undefined }] },
      { ...original, plan_events: [event, event] },
      { ...original, plan_events: null },
      { ...original, attempts: [{ }] },
      { ...original, attempts: [attempt, attempt] },
      { ...original, attempts: null },
      { ...original, phase: 'unknown' },
      { ...original, contract: { ...original.contract, execution: { kind: 'unknown' } } },
    ];
    for (const source of damagedSources) {
      writeFileSync(f.paths.project, JSON.stringify(source));
      assert.throws(() => scan(f, { alive: () => false }), /invalid autonomous trigger source/u);
      assert.deepEqual(f.read(), before, 'even orphan recovery waits until source records can be read');
      assert.deepEqual(f.json(f.paths.project), JSON.parse(JSON.stringify(source)));
    }
    writeFileSync(f.paths.project, JSON.stringify({ ...original, plan_events: [event] }));
    scan(f, { alive: () => false });
    assert.equal(f.read().planner_jobs.recoveries.length, 1);
    assert.equal(f.read().planner_jobs.events.at(-1).type, 'review');
  });

  it('exposes only explicit active pending programmes, and reports corruption without discarding it', t => {
    const f = fixture(t);
    assert.deepEqual(reconcileProgrammeQueue(f.root), []);
    f.activate();
    assert.deepEqual(reconcileProgrammeQueue(f.root), [f.programme]);
    const damaged = f.json(f.paths.programme); damaged.planner_jobs.pending.event_ids = ['missing'];
    writeFileSync(f.paths.programme, JSON.stringify(damaged));
    const said = [];
    assert.deepEqual(reconcileProgrammeQueue(f.root, { say: text => said.push(text) }), []);
    assert.match(said[0], /reconciliation refused/u);
    assert.deepEqual(f.json(f.paths.programme), damaged);
  });
});

describe('durable planner operations and exactly-once project effects', () => {
  it('checks the expected programme revision even before repairing a committed effect projection', t => {
    const f = fixture(t); f.activate(); const owner = f.claim(); const intent = f.intent();
    createProgrammeJobProject(owner(), intent);
    const stale = f.read().revision;
    recordProgrammeTrigger(f.options(), f.event('new-review', 'review'));
    const paths = autonomousPaths(f.root, f.programme, intent.project);
    rmSync(paths.draft);
    const retry = revision => createAutonomousDraft(f.root, f.programme, intent.project, intent.input,
      { actor: owner().actor, token: owner().token, revision, operationId: intent.id });
    assert.throws(() => retry(stale), /stale state revision/u);
    assert.equal(existsSync(paths.draft), false, 'stale readback must not write a projection');
    const before = f.read();
    const project = retry(before.revision);
    assert.equal(project.revision, 1);
    assert.equal(project.operation_receipts.length, 1);
    assert.deepEqual(f.json(paths.draft), intent.input);
    assert.deepEqual(f.read(), before);
  });

  it('never adopts an unrelated existing project as a completed creation', t => {
    const f = fixture(t); f.activate(); const owner = f.claim();
    const before = readFileSync(f.paths.project, 'utf8');
    const intent = { ...f.intent(), project: f.project, input: autonomousProject() };
    assert.throws(() => createProgrammeJobProject(owner(), intent), /project effect does not match/u);
    assert.equal(readFileSync(f.paths.project, 'utf8'), before);
    assert.equal(f.read().planner_jobs.operations[0].status, 'pending');
    assert.throws(() => finishProgrammeJob(owner()), /pending planner effects/u);
  });

  it('reconciles repeated delivery from the atomic project receipt, not from process success', t => {
    const f = fixture(t); f.activate(); const owner = f.claim(); const intent = f.intent();
    assert.throws(() => prepareProgrammeOperation(owner(), { ...intent, input: { ...intent.input, success_criteria: [] } }), /invalid planner goal/u);
    assert.equal(f.read().planner_jobs.operations.length, 0);
    prepareProgrammeOperation(owner(), intent);
    assert.throws(() => finishProgrammeJob(owner()), /pending planner effects/u);
    assert.throws(() => completeProgrammeOperation(owner(), intent, { project: intent.project, revision: 1 }), /ENOENT/u);
    const result = createProgrammeJobProject(owner(), intent);
    const before = f.read().revision;
    assert.deepEqual(createProgrammeJobProject(owner(), { ...intent, input: Object.fromEntries(Object.entries(intent.input).reverse()) }), result);
    assert.equal(f.read().revision, before);
    assert.equal(readAutonomousState(f.root, f.programme, intent.project).revision, 1);
    assert.throws(() => createProgrammeJobProject(owner(), { ...intent, input: { ...intent.input, goal: ['Different goal.'] } }), /different content/u);
    assert.throws(() => createProgrammeJobProject(owner(), f.intent('create-goal-2')), /project effect/u);
  });

  it('does not acknowledge a different effect, apply stale programme decisions or apply while paused', t => {
    const f = fixture(t); f.activate(); const owner = f.claim(); const intent = f.intent();
    assert.throws(() => prepareProgrammeOperation(owner(), { ...intent, input: { ...intent.input, programme: { id: f.programme, revision: 2 } } }), /unsupported pre-ruling-60/u);
    prepareProgrammeOperation(owner(), intent);
    setProgrammeJobMode(f.options(), { mode: 'paused' });
    assert.throws(() => createProgrammeJobProject(owner(), intent), /waits/u);
    assert.equal(existsSync(autonomousPaths(f.root, f.programme, intent.project).project), false);
    setProgrammeJobMode(f.options(), { mode: 'active' });
    createProgrammeJobProject(owner(), intent);
    assert.throws(() => completeProgrammeOperation(owner(), intent, { project: 'different-project', revision: 1 }), /immutable/u);
  });

  for (const committed of [false, true]) {
    it(`reconciles changed programme context with effect ${committed ? 'committed' : 'absent'}`, t => {
      const f = fixture(t); f.activate(); const original = f.claim(); const intent = f.intent();
      prepareProgrammeOperation(original(), intent);
      if (committed) createAutonomousDraft(f.root, f.programme, intent.project, intent.input,
        { actor: original().actor, token: original().token, revision: f.read().revision, operationId: intent.id });
      scan(f, { alive: () => false });
      mutateProgramme(f.root, f.programme, 'metadata', { ...f.draft, brief: 'docs/project/updated/' },
        { env: {}, revision: f.read().revision });
      const replacement = f.claim({ actor: { role: 'plan', run_id: 'replacement-plan' } });
      assert.deepEqual(createProgrammeJobProject(replacement(), intent), { project: intent.project, revision: 1 });
      assert.equal(f.read().planner_jobs.operations[0].status, 'applied');
      assert.equal(readAutonomousState(f.root, f.programme, intent.project).contracts.length, 1);
    });
  }

  for (const phase of ['claim', 'intent', 'effect', 'projection', 'ack']) {
    it(`recovers real process exit after ${phase} without losing the job or duplicating its effect`, t => {
      const f = fixture(t); f.activate();
      const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('./programme-jobs-fixture.js', import.meta.url)), 'crash', f.root, f.programme, phase], { encoding: 'utf8', timeout: 30000 });
      assert.equal(crashed.status, 86, crashed.stderr);
      assert.notEqual(f.read().active_run, null);
      scan(f);
      assert.equal(f.read().planner_jobs.recoveries.at(-1).reason, 'owner-gone');
      const owner = f.claim({ actor: { run_id: 'recovering-plan', role: 'plan' } });
      const intent = { ...f.intent('crash-create-1'), project: 'crash-project', input: autonomousProject({ project_id: 'crash-project' }) };
      const result = createProgrammeJobProject(owner(), intent);
      assert.deepEqual(result, { project: 'crash-project', revision: 1 });
      assert.deepEqual(createProgrammeJobProject(owner(), intent), result);
      const paths = autonomousPaths(f.root, f.programme, intent.project);
      assert.deepEqual(JSON.parse(readFileSync(paths.draft, 'utf8')), intent.input);
      const project = readAutonomousState(f.root, f.programme, intent.project);
      assert.equal(project.revision, 1);
      assert.equal(project.operation_receipts.length, 1);
      assert.equal(project.active_run, null, 'receipt-created drafts do not strand an old planner reservation');
      const reserved = reserveProjectRun(f.root, f.programme, intent.project, owner().actor, project.revision);
      mutateAutonomousProject(f.root, f.programme, intent.project, 'release', null, { actor: owner().actor, revision: reserved.revision });
      assert.equal(readdirSync(f.paths.dir).filter(name => name === intent.project).length, 1);
      assert.equal(f.read().planner_jobs.operations.length, 1);
      finishProgrammeJob(owner());
      const done = f.read().revision;
      recordProgrammeTrigger(f.options(), f.event());
      assert.equal(f.read().revision, done);
      assert.equal(f.read().planner_jobs.pending, null);
    });
  }
});
