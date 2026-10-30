import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateFixture, planner, builder, reviewer, foreground } from './autonomous-state-fixture.js';
import { autonomousProject, autonomousEvidence } from './autonomy-fixtures.js';
import { runnerFixture } from './autonomous-run-fixture.js';
import { ready } from './autonomous-merge-fixture.js';
import { decideProgrammePlan, programmePlanContext } from '../../src/mc/programme-plan.js';
import { ensureProgrammePlanWorkspace, runProgrammePlan } from '../../src/mc/programme-plan-run.js';
import { autonomousPlanRole, instructionsFor, readCanonRole } from '../../src/mc/roles.js';
import { reviewCommandRefusal } from '../../src/mc/autonomous-review-guard.js';
import { readAutonomousState, readProgrammeState, sendAutonomousProject, releaseProgrammeRun, reserveProjectRun,
  mutateAutonomousProject, recordAutonomousMergeEvent, startAutonomousBuild, reserveProgrammeRun, mutateProgramme } from '../../src/mc/autonomous-state.js';
import { claimProgrammeJob, setProgrammeJobMode, cancelProgrammeOperation, completeProgrammePlan, finishProgrammeJob,
  prepareProgrammeOperation, reconcileProgrammeJobs, renewProgrammeJob, yieldProgrammeJob } from '../../src/mc/programme-jobs.js';
import { reportBinding } from '../../src/mc/autonomous-outcomes.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { streamSession } from '../../src/mc/run.js';
import { run as programmeCommand } from '../../src/mc/commands/programme.js';
import { run as foregroundPlan } from '../../src/mc/commands/plan.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';

function claim(f) {
  const read = () => readProgrammeState(f.root, f.programme);
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: read().revision }, { mode: 'active',
    event: { id: 'activate', type: 'activation', reference: 'approval/activation' } });
  const actor = { role: 'plan', run_id: 'headless-plan-1' };
  const claimed = claimProgrammeJob({ root: f.root, programme: f.programme, revision: read().revision, actor, pid: process.pid });
  const options = extra => ({ root: f.root, programme: f.programme, actor, token: claimed.planner_jobs.lease.token, revision: read().revision, ...extra });
  return { read, options };
}
function fixture(t, { send = true } = {}) {
  const f = stateFixture(); t.after(f.cleanup); let state = f.setupProject();
  if (send) sendAutonomousProject(f.root, f.programme, f.project, { actor: planner, token: 'fixture-lease', revision: state.revision });
  return decorate(f, claim(f));
}
function decorate(f, ownership) {
  const state = project => readAutonomousState(f.root, f.programme, project || f.project);
  const patch = change => { const value = state(); change(value); writeFileSync(f.paths.project, JSON.stringify(value)); };
  const intent = (kind, input = {}, extra = {}) => ({ id: `${kind}-1`, kind, project: f.project, expected_revision: state().revision,
    input, ...extra });
  return { ...f, ...ownership, state, patch, intent, apply: value => decideProgrammePlan(ownership.options(), value) };
}

test('headless plan sees the programme metadata and concise results for all goals, not transcripts', t => {
  const f = fixture(t);
  f.apply({ id: 'create-independent', kind: 'create-project', project: 'independent', expected_revision: 0,
    input: autonomousProject({ project_id: 'independent', repo: 'memoro' }) });
  const independent = f.state('independent');
  reserveProjectRun(f.root, f.programme, 'independent', builder, independent.revision);
  f.patch(value => { value.transcript = 'BUILDER TRANSCRIPT MUST NOT BE CONCATENATED'; });
  const dir = join(f.paths.dir, 'legacy'); mkdirSync(dir);
  writeFileSync(join(dir, 'PLAN.json'), JSON.stringify({ version: 1, repo: 'memoro-cli', goal: ['Legacy work'], steps: [{ status: 'ready' }] }));
  const prompt = programmePlanContext(f.options()); const context = JSON.parse(prompt);
  assert.deepEqual(context.programme, f.read().metadata);
  assert.deepEqual(context.goals.map(goal => goal.project), ['independent', 'legacy', f.project]);
  assert.equal(context.goals[0].active_run.run_id, builder.run_id);
  assert.equal(context.goals[1].authority, 'read-only legacy goal');
  assert.ok(context.goals.every(goal => goal.reference));
  assert.ok(!prompt.includes('BUILDER TRANSCRIPT'));
  assert.ok(Buffer.byteLength(prompt) <= 65536);
  assert.equal(f.read().execution_enabled, false);
});

test('context refuses overflow and damaged goals instead of omitting programme context', t => {
  const f = fixture(t);
  f.patch(value => { value.landing = { reference: 'x'.repeat(65536) }; });
  assert.throws(() => programmePlanContext(f.options()), /bounded start/u);
  writeFileSync(f.paths.project, '{');
  assert.throws(() => programmePlanContext(f.options()), SyntaxError);
});

test('revision of a sent open goal preserves its PR, commits, evidence and history while invalidating current authority', t => {
  const f = fixture(t); const programme = f.read().metadata;
  f.patch(value => {
    value.ownership = { branch: 'owned-branch', pr: 42 }; value.commits = ['a'.repeat(40)];
    value.evidence = autonomousEvidence(); value.current_handoff = 'handoffs/old';
    value.publication = { head: 'a'.repeat(40), phase: 'handoff_committed' };
    value.review_reports = [{ id: 'previous-review', clean: true }]; value.merge_handoff = { status: 'answered' };
  });
  const before = f.state();
  const intent = f.intent('revise-project', { ...before.contract, goal_revision: 2, instruction: ['Address the independent review finding within the same CLI scope.'] });
  const result = f.apply(intent); const after = f.state();
  assert.equal(result.revision, after.revision);
  assert.deepEqual(after.ownership, before.ownership); assert.deepEqual(after.commits, before.commits);
  assert.deepEqual(after.evidence.builder, before.evidence.builder); assert.deepEqual(after.review_reports, before.review_reports);
  assert.equal(after.contracts.length, 2); assert.equal(after.goal_revision, 2); assert.equal(after.phase, 'plan_pending');
  assert.equal(after.active_run, null); assert.equal(after.current_handoff, null); assert.equal(after.publication, undefined);
  assert.equal(after.merge_handoff, undefined); assert.equal(after.plan_decisions[0].previous.publication.head, 'a'.repeat(40));
  assert.deepEqual(f.json(join(f.paths.projectDir, 'PLAN.json')), after.contract);
  assert.deepEqual(f.read().metadata, programme);
  assert.deepEqual(f.apply(intent), result, 'repeated delivery applies the same revision once');
});

test('only plan with the active lease can decide; stale state and altered goal revision and unsupported authority fields fail closed', async t => {
  const f = fixture(t); const intent = f.intent('revise-project', { ...f.state().contract, goal_revision: 2 });
  for (const actor of [builder, reviewer, { run_id: 'stranger', role: 'plan' }]) {
    assert.throws(() => decideProgrammePlan(f.options({ actor }), intent), /ownership/u);
  }
  assert.throws(() => decideProgrammePlan(f.options({ revision: 1 }), intent), /stale/u);
  assert.throws(() => decideProgrammePlan(f.options({ token: 'wrong' }), intent), /ownership/u);
  assert.throws(() => f.apply({ ...intent, input: { ...intent.input, goal_revision: 3 } }), /advance by exactly one/u);
  assert.throws(() => f.apply({ ...intent, id: 'unsupported-authority-field', basis: { criteria: ['invented'], reference: 'anything' } }), /unknown planner intent field/u);
  assert.throws(() => f.apply({ ...intent, kind: 'approve-programme' }), /operation/u);
  const out = []; const err = [];
  const code = await programmeCommand(['approve', f.programme, '--expected-revision', String(f.read().revision), '--input-file', f.file({ by: 'headless' })],
    { root: f.root, actor: f.options().actor, stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) } });
  assert.notEqual(code, 0); assert.match(err.join(''), /operation and target are required/u);
  assert.equal(f.read().metadata.id, f.programme); assert.equal(f.state().goal_revision, 1);
});

test('affected active runs wait, then a fresh explicit decision revises the same PR; independent runs remain owned', t => {
  const f = fixture(t);
  reserveProjectRun(f.root, f.programme, f.project, builder, f.state().revision);
  f.patch(value => { value.ownership = { branch: f.project, pr: 42 }; });
  const intent = f.intent('revise-project', { ...f.state().contract, goal_revision: 2 });
  assert.throws(() => f.apply(intent), /affected runs must close/u);
  assert.equal(f.state().active_run.run_id, builder.run_id);
  mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor: builder, revision: f.state().revision });
  assert.throws(() => f.apply(intent), /stale state revision/u);
  cancelProgrammeOperation(f.options(), { id: intent.id, reason: 'Affected run closed; refresh observed state.' });
  f.apply({ ...intent, id: 'revision-after-close', expected_revision: f.state().revision });
  assert.equal(f.state().ownership.pr, 42);
  f.apply({ id: 'other-goal', kind: 'create-project', project: 'independent', expected_revision: 0, input: autonomousProject({ project_id: 'independent' }) });
  reserveProjectRun(f.root, f.programme, 'independent', builder, f.state('independent').revision);
  f.apply(f.intent('revise-project', { ...f.state().contract, goal_revision: 3 }, { id: 'independent-safe-revision' }));
  assert.deepEqual(f.state('independent').active_run, builder);
});

test('a revision receipt repairs interrupted PLAN publication without replaying or losing the PR', t => {
  const f = fixture(t);
  const intent = f.intent('revise-project', { ...f.state().contract, goal_revision: 2 });
  assert.throws(() => decideProgrammePlan(f.options({ deps: { writePlan: () => { throw new Error('projection crash'); } } }), intent), /projection crash/u);
  assert.equal(f.state().goal_revision, 2); assert.equal(f.json(join(f.paths.projectDir, 'PLAN.json')).goal_revision, 1);
  assert.throws(() => cancelProgrammeOperation(f.options(), { id: intent.id, reason: 'Cannot discard a committed effect.' }), /committed effect/u);
  const result = f.apply(intent);
  assert.equal(f.state().goal_revision, 2); assert.equal(f.state().contracts.length, 2);
  assert.equal(f.json(join(f.paths.projectDir, 'PLAN.json')).goal_revision, 2);
  assert.deepEqual(f.apply(intent), result);
  assert.throws(() => f.apply({ ...intent, input: { ...intent.input, instruction: ['Different decision.'] } }), /already used/u);
});

test('a new lease reconciles committed revisions; unrelated programme context does not stale goal decisions', t => {
  const f = fixture(t);
  const intent = f.intent('revise-project', { ...f.state().contract, goal_revision: 2 });
  assert.throws(() => decideProgrammePlan(f.options({ deps: { writePlan: () => { throw new Error('crash'); } } }), intent), /crash/u);
  const now = Date.now() + 300001;
  reconcileProgrammeJobs(f.options({ now }));
  const actor = { role: 'plan', run_id: 'restart-plan' };
  const claimed = claimProgrammeJob({ root: f.root, programme: f.programme, revision: f.read().revision, actor, pid: process.pid, now });
  const options = () => ({ root: f.root, programme: f.programme, actor, token: claimed.planner_jobs.lease.token, revision: f.read().revision, now });
  decideProgrammePlan(options(), intent);
  assert.equal(f.state().contracts.length, 2); assert.equal(f.json(join(f.paths.projectDir, 'PLAN.json')).goal_revision, 2);
  const stale = f.intent('revise-project', { ...f.state().contract, goal_revision: 3 }, { id: 'old-agreement-decision' });
  prepareProgrammeOperation(options(), stale);
  yieldProgrammeJob(options(), 'Foreground agreement changed at its own boundary.');
  mutateProgramme(f.root, f.programme, 'metadata', { ...f.read().metadata, brief: 'docs/project/updated/' }, { env: {}, revision: f.read().revision });
  const nextActor = { role: 'plan', run_id: 'new-context-plan' };
  const next = claimProgrammeJob({ root: f.root, programme: f.programme, revision: f.read().revision, actor: nextActor, pid: process.pid, now });
  const current = () => ({ ...options(), actor: nextActor, token: next.planner_jobs.lease.token, revision: f.read().revision });
  decideProgrammePlan(current(), stale);
  assert.equal(f.state().goal_revision, 3);
  assert.equal(f.read().metadata.brief, 'docs/project/updated/');
});

test('create, send and resume are separate guarded effects; dependencies reject stale versions and cycles', t => {
  const f = fixture(t);
  const cancelled = { id: 'cancelled-creation', kind: 'create-project', project: 'never-created', expected_revision: 0,
    input: autonomousProject({ project_id: 'never-created' }) };
  prepareProgrammeOperation(f.options(), cancelled);
  cancelProgrammeOperation(f.options(), { id: cancelled.id, reason: 'No longer needed within the programme.' });
  assert.throws(() => f.apply(cancelled), /cancelled/u);
  assert.equal(existsSync(join(f.paths.dir, 'never-created', 'AUTONOMOUS_STATE.json')), false);
  const project = 'dependent';
  f.apply({ id: 'new-dependent', kind: 'create-project', project, expected_revision: 0, input: autonomousProject({ project_id: project }) });
  const op = (kind, input = {}, id = kind) => f.intent(kind, input, { id, project, expected_revision: f.state(project).revision });
  assert.equal(existsSync(join(f.paths.dir, project, 'PLAN.json')), false);
  f.apply(op('send-project'));
  f.apply(op('dependencies', { projects: [{ project: f.project, goal_revision: 1 }] }));
  assert.throws(() => f.apply(op('resume-project')), /awaits verified landing/u);
  cancelProgrammeOperation(f.options(), { id: 'resume-project', reason: 'Dependency is not delivered.' });
  assert.throws(() => f.apply(f.intent('dependencies', { projects: [{ project, goal_revision: 1 }] })), /cycle/u);
  cancelProgrammeOperation(f.options(), { id: 'dependencies-1', reason: 'Reject a cycle.' });
  assert.throws(() => f.apply(op('dependencies', { projects: [{ project: f.project, goal_revision: 99 }] }, 'stale-dependency')), /stale dependency/u);
  cancelProgrammeOperation(f.options(), { id: 'stale-dependency', reason: 'Refresh dependency.' });
  f.apply(op('dependencies', { projects: [] }, 'clear-dependency'));
  f.apply(op('resume-project', {}, 'resume-independent'));
  assert.equal(f.state(project).phase, 'ready');
  assert.equal(f.read().execution_enabled, false, 'test seam never enables production execution');
});

test('a current reviewed landing is complete without confirmation and its assignment stays immutable', async t => {
  const base = await ready(t);
  const report = base.stateNow().review_reports.at(-1);
  recordAutonomousMergeEvent(base.root, base.programme, base.project, { binding: reportBinding(report), type: 'merge-landed',
    details: { merge_commit: report.session.head, merged_into: 'main' } });
  const f = decorate(base, claim(base));
  const before = f.state();
  assert.throws(() => f.apply(f.intent('confirm-project', { id: 'obsolete-confirm', reference: 'none', criteria: [] })), /obsolete/u);
  cancelProgrammeOperation(f.options(), { id: 'confirm-project-1', reason: 'Landing completes execution without confirmation.' });
  assert.throws(() => f.apply(f.intent('revise-project', { ...before.contract, goal_revision: 2 })), /immutable/u);
  cancelProgrammeOperation(f.options(), { id: 'revise-project-1', reason: 'Additional work belongs to a new goal.' });
  const owner = f.options();
  mutateAutonomousProject(f.root, f.programme, f.project, 'follow-up', { id: 'integration-measured', criterion_id: 'integration',
    goal_revision: 1, integrated_sha: report.session.head, outcome: 'passed', reference: 'measurements/integration' },
    { actor: owner.actor, token: owner.token, revision: f.state().revision });
  assert.equal(f.state().phase, 'landed'); assert.equal(f.state().evidence.confirmation, null);
  assert.deepEqual(f.state().contract, before.contract); assert.equal(f.state().ownership.pr, 42);
});

test('a planner stop does not hold sent goals, clean-review merge admission or routing', async t => {
  const base = await ready(t); const f = decorate(base, claim(base));
  f.apply({ id: 'stop-before-next-dispatch', kind: 'reach-stop', stop: 'design-review', reference: 'decisions/agreed-stop' });
  const door = await base.door();
  assert.equal(door.ok, true, door.problems.join('; '));
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.state().contract };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'review');
});

test('confirmation cannot fabricate delivery and only explicit valid stops can halt future dispatch', t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.intent('confirm-project', { id: 'fake-confirmation', reference: 'none', criteria: [] })), /obsolete/u);
  cancelProgrammeOperation(f.options(), { id: 'confirm-project-1', reason: 'Not delivered.' });
  assert.throws(() => f.apply({ id: 'unplanned-stop', kind: 'reach-stop', stop: '../invalid-stop', reference: 'none' }), /stable ID/u);
  assert.equal(f.state().phase, 'ready', 'ordinary send already made the goal ready');
  const stop = { id: 'agreed-stop', kind: 'reach-stop', stop: 'design-review', reference: 'decisions/stop-reached' };
  f.apply(stop); f.apply(stop);
  assert.equal(f.read().planner_jobs.operations.filter(item => item.intent.id === stop.id).length, 1);
  assert.equal(f.read().planner_jobs.mode, 'stopped');
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.state().contract };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'step');
  assert.throws(() => f.apply(f.intent('revise-project', { ...f.state().contract, goal_revision: 2 })), /active programme/u);
});

test('completion explicitly covers the claimed snapshot; pending decisions and process exit cannot acknowledge work', t => {
  const f = fixture(t);
  assert.throws(() => completeProgrammePlan(f.options(), { event_ids: [], reference: 'none' }), /claimed event snapshot/u);
  prepareProgrammeOperation(f.options(), f.intent('send-project'));
  assert.throws(() => completeProgrammePlan(f.options(), { event_ids: ['activate'], reference: 'decisions' }), /pending planner effects/u);
  f.apply(f.intent('send-project'));
  completeProgrammePlan(f.options(), { event_ids: ['activate'], reference: 'decisions/complete' });
  finishProgrammeJob(f.options());
  assert.equal(f.read().planner_jobs.pending, null);
  assert.equal(f.read().planner_jobs.results[0].reference, 'decisions/complete');
});

test('headless flavor replaces foreground authority and command guards deny legacy, build and programme edits', () => {
  const role = autonomousPlanRole(readCanonRole('plan'));
  assert.equal(role.name, 'plan');
  const instructions = instructionsFor('codex', role.overlay);
  assert.match(instructions, /headless plan role/u); assert.doesNotMatch(instructions, /with Martin at the terminal/u);
  for (const argv of [['programme', 'approve'], ['project', 'amend'], ['step', 'ready'], ['publish'], ['merge'], ['plan']]) {
    assert.match(reviewCommandRefusal(argv, { actor: { role: 'plan' }, env: { MC_PROGRAMME_LEASE: 'test-lease' } }), /denied/u);
  }
  for (const argv of [['goal', 'new'], ['goal', 'criterion'], ['goal', 'send'], ['goal', 'revise'], ['goal', 'show'], ['goal', 'done']]) {
    assert.equal(reviewCommandRefusal(argv, { actor: { role: 'plan' }, env: { MC_PROGRAMME_LEASE: 'test-lease' } }), null);
  }
  for (const argv of [['programme', 'decide'], ['programme', 'complete'], ['goal', 'show']]) assert.equal(reviewCommandRefusal(argv, { actor: { role: 'plan' } }), null);
});

test('the real CLI rejects planner envelopes and exposes ordinary guarded goal revisions', t => {
  const f = fixture(t); const options = f.options();
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_HOME: join(f.root, 'mc-home'), MC_PROGRAMME: f.programme,
    MC_AUTONOMOUS_RUN: options.actor.run_id, MC_AUTONOMOUS_ROLE: 'plan', MC_PROGRAMME_LEASE: options.token };
  delete env.MC_STEP;
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url)), ...args], { env, encoding: 'utf8' });
  for (const operation of ['draft', 'approve', 'decide', 'complete', 'cancel']) {
    const reply = cli('programme', operation, f.programme, '--expected-revision', String(f.read().revision), '--input-file', f.file({}));
    assert.notEqual(reply.status, 0); assert.match(reply.stderr, /denied|operation and target are required/u);
  }
  const revision = { ...f.state().contract, goal_revision: 2 };
  const reply = cli('goal', 'revise', `${f.programme}/${f.project}`, '--expected-revision', String(f.state().revision), '--input-file', f.file(revision));
  assert.equal(reply.status, 0, reply.stderr); assert.equal(f.state().goal_revision, 2);
  assert.equal(f.read().metadata.id, f.programme); assert.equal(f.read().planner_jobs.lease.token, options.token);
});

test('opening mc plan remains foreground and does not reserve or start autonomous work', async t => {
  const f = fixture(t); const before = f.read(); let opened = false;
  const code = await foregroundPlan([f.programme, '--new'], { env: { MC_WORK_ROOT: f.root }, repos: [],
    role: () => readCanonRole('plan'), ensure: () => ({ ok: true, path: f.paths.dir, repos: ['memoro-cli'] }),
    open: async call => { opened = true; assert.equal(call.roleName, 'plan'); assert.match(call.overlay, /with Martin at the terminal/u); return { ok: true, code: 0 }; } });
  assert.equal(code, 0); assert.equal(opened, true); assert.deepEqual(f.read(), before);
});

/** A headless session as a runner grants it: a fresh run, its lease and the env the
 * command handlers read. Its commands are the real `mc goal` and `mc programme` ones. */
function headlessSession(f, run_id, now) {
  const read = () => readProgrammeState(f.root, f.programme);
  const actor = { role: 'plan', run_id };
  const token = claimProgrammeJob({ root: f.root, programme: f.programme, revision: read().revision, actor, pid: process.pid, now }).planner_jobs.lease.token;
  const env = { MC_AUTONOMOUS_ROLE: 'plan', MC_AUTONOMOUS_RUN: run_id, MC_PROGRAMME: f.programme, MC_PROGRAMME_LEASE: token };
  const owner = { root: f.root, programme: f.programme, actor, token, now };
  const mc = async (command, argv, extra = {}) => {
    const out = []; const err = [];
    const io = { root: f.root, env, now: () => now, stdout: { write: line => out.push(line) }, stderr: { write: line => err.push(line) }, ...extra };
    const code = await (command === 'goal' ? goalCommand : programmeCommand)(argv, io);
    return { code, out: out.join(''), err: err.join('') };
  };
  return {
    read, owner, mc,
    context: () => JSON.parse(programmePlanContext(owner)),
    ack: (ids, reference) => mc('programme', ['events', 'ack', f.programme, ...ids.flatMap(id => ['--event', id]), '--reference', reference]),
    finish: () => finishProgrammeJob({ ...owner, revision: read().revision }),
  };
}

/** A goal that has landed, a declared phase, and activation claimed by reconciliation. */
async function landedProgramme(t, now) {
  const base = await ready(t); base.releasePlanner();
  const report = base.stateNow().review_reports.at(-1);
  recordAutonomousMergeEvent(base.root, base.programme, base.project, { binding: reportBinding(report), type: 'merge-landed',
    details: { merge_commit: report.session.head, merged_into: 'main' } });
  const sink = { write() {} };
  const phase = await programmeCommand(['phase', 'add', base.programme, '1', 'build', '--purpose', 'Land the first goal and its successor.'],
    { root: base.root, env: {}, now: () => now, stdout: sink, stderr: sink });
  assert.equal(phase, 0);
  const revision = () => readProgrammeState(base.root, base.programme).revision;
  setProgrammeJobMode({ root: base.root, programme: base.programme, revision: revision() }, { mode: 'active',
    event: { id: 'activate', type: 'activation', reference: 'approval/activation' } });
  reconcileProgrammeJobs({ root: base.root, programme: base.programme, revision: revision(), now });
  return base;
}

const successor = programme => ['goal', 'new', `${programme}/successor`, '--phase', '1', '--repo', 'memoro-cli', '--class', 'fast',
  '--goal', 'Use the landed result.', '--contract', 'Continue within this programme.', '--out-of-scope', 'Fixed-step projects.'];

test('a scripted planner creates the next goal on landing with ordinary verbs and acknowledges exactly the events it was given', async t => {
  const now = Date.now();
  const base = await landedProgramme(t, now);
  const s = headlessSession(base, 'plan-land-1', now);
  const landed = s.read().planner_jobs.events.find(item => item.type === 'landed').id;
  const ctx = s.context();
  const claimed = [...ctx.job.event_ids];
  assert.ok(claimed.includes('activate') && claimed.includes(landed), 'the claim names the activation and the landing');
  assert.equal(ctx.autonomy.enabled, true);
  assert.deepEqual(ctx.phases.map(item => [item.n, item.name]), [[1, 'build']]);
  assert.ok(ctx.goals.some(goal => goal.project === base.project && goal.landing), 'the landed goal arrives with its landing');

  const target = `${base.programme}/successor`;
  assert.equal((await s.mc('goal', successor(base.programme).slice(1))).code, 0);
  const added = await s.mc('goal', ['criterion', 'add', target, '--id', 'successor-check', '--criterion', 'The successor lands.',
    '--instruction', 'Make the successor land.', '--check', 'node --test tests/mc/programme-plan.test.js', '--verify', 'premerge']);
  assert.equal(added.code, 0, added.err);
  const sent = await s.mc('goal', ['send', target]);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(readAutonomousState(base.root, base.programme, 'successor').phase, 'ready');

  const acked = await s.ack(claimed, 'decisions/successor-created');
  assert.equal(acked.code, 0, acked.err);
  s.finish();
  assert.equal(s.read().planner_jobs.pending, null); assert.equal(s.read().active_run, null);
});

test('a planner that crashes mid-send keeps its landed event; the next session replays the send once, then acknowledges', async t => {
  const now = Date.now();
  const base = await landedProgramme(t, now);
  const target = `${base.programme}/successor`;
  const first = headlessSession(base, 'plan-crash-1', now);
  const landed = first.read().planner_jobs.events.find(item => item.type === 'landed').id;
  const claimed = [...first.context().job.event_ids];
  renewProgrammeJob({ ...first.owner, revision: first.read().revision, now: now + 60_000 });
  assert.ok(first.read().planner_jobs.lease.expires_at > now + 300_000, 'renewal extends the lease');
  assert.equal((await first.mc('goal', successor(base.programme).slice(1))).code, 0);
  assert.equal((await first.mc('goal', ['criterion', 'add', target, '--id', 'successor-check', '--criterion', 'The successor lands.',
    '--instruction', 'Make the successor land.', '--check', 'node --test tests/mc/programme-plan.test.js', '--verify', 'premerge'])).code, 0);
  const goalRevision = readAutonomousState(base.root, base.programme, 'successor').revision;
  const send = ['send', target, '--expected-revision', String(goalRevision)];

  // The send commits, then the projection write fails and the process dies with its lease.
  const crashed = await first.mc('goal', send, { writePlan: () => { throw new Error('projection crash'); } });
  assert.equal(crashed.code, 1); assert.match(crashed.err, /projection crash/u);
  assert.equal(first.read().planner_jobs.operations.find(item => item.intent.kind === 'send-goal').status, 'pending');
  assert.equal(readAutonomousState(base.root, base.programme, 'successor').phase, 'ready', 'the send committed before the crash');

  // Its lease expires; reconciliation keeps the events it claimed and frees the programme.
  const later = now + 600_000;
  reconcileProgrammeJobs({ root: base.root, programme: base.programme, revision: first.read().revision, now: later });
  assert.equal(first.read().planner_jobs.lease, null);
  assert.deepEqual([...first.read().planner_jobs.pending.event_ids].sort(), [...claimed].sort(), 'the crashed session did not acknowledge');

  const second = headlessSession(base, 'plan-crash-2', later);
  const ctx = second.context();
  assert.deepEqual(ctx.pending_operations.map(item => item.intent.kind), ['send-goal']);
  assert.deepEqual([...ctx.job.event_ids].sort(), [...claimed].sort());
  const replay = await second.mc('goal', send, { now: () => later });
  assert.equal(replay.code, 0, replay.err);
  assert.ok(existsSync(join(base.paths.dir, 'successor', 'PLAN.json')), 'the replay repairs the projection');
  assert.equal(second.read().planner_jobs.operations.filter(item => item.intent.kind === 'new-goal').length, 1, 'the goal is created once');
  assert.equal(second.read().planner_jobs.operations.find(item => item.intent.kind === 'send-goal').status, 'applied');
  assert.equal((await second.ack(claimed, 'decisions/successor-sent')).code, 0);
  second.finish();
  assert.equal(second.read().planner_jobs.pending, null);
});

test('a no-op planner session records a bounded wait, so reconciliation does not wake the programme before it ends', async t => {
  const f = stateFixture(); t.after(f.cleanup); f.setupProject(); f.releasePlanner();
  const now = Date.now();
  const revision = () => readProgrammeState(f.root, f.programme).revision;
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: revision() }, { mode: 'active',
    event: { id: 'activate', type: 'activation', reference: 'approval/activation' } });
  const s = headlessSession(f, 'plan-noop-1', now);
  assert.deepEqual(s.context().job.event_ids, ['activate']);
  const acked = await s.ack(['activate'], 'decisions/activation-seen');
  assert.equal(acked.code, 0, acked.err);
  const waited = await s.mc('programme', ['wait', f.programme, '--condition', 'nothing-to-plan', '--kind', 'resource',
    '--reason', 'No goal awaits planning.', '--reference', 'decisions/no-op-wait', '--until', String(now + 3_600_000)]);
  assert.equal(waited.code, 0, waited.err);
  s.finish();
  assert.equal(s.read().planner_jobs.mode, 'waiting'); assert.equal(s.read().planner_jobs.wait.until, now + 3_600_000);
  reconcileProgrammeJobs({ root: f.root, programme: f.programme, revision: revision(), now: now + 1_000 });
  assert.equal(s.read().planner_jobs.pending, null, 'a bounded wait wakes nothing before its time');
});

test('runner reports planner unavailable and retains pending events without launching a session', async t => {
  const f = runnerFixture(t);
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision }, { mode: 'active',
    event: { id: 'runner-activation', type: 'activation', reference: 'operator-start' } });
  const before = readProgrammeState(f.root, f.programme);
  assert.equal(await runProgrammePlan(), 'skipped:planner-unavailable');
  const after = readProgrammeState(f.root, f.programme);
  assert.deepEqual(after, before, 'no lease, acknowledgement, or recovery write is fabricated');
  assert.deepEqual(after.planner_jobs.pending.event_ids, ['runner-activation']);
  assert.equal(after.active_run, null);
  assert.equal(existsSync(f.cwd(f.project)), false, 'no planner workspace or builder checkout is created');
});

test('workspace refresh preserves dirty inspection trees and refuses foreground/branch adoption', t => {
  const f = runnerFixture(t);
  const options = { root: f.root, programme: f.programme, repos: [{ name: 'memoro-cli', path: f.primary }], git: f.deps.git };
  const workspace = ensureProgrammePlanWorkspace(options);
  writeFileSync(join(workspace.repos[0].path, 'unfinished'), 'Do not discard.');
  assert.throws(() => ensureProgrammePlanWorkspace(options), /preserve it for recovery/u);
  assert.equal(readFileSync(join(workspace.repos[0].path, 'unfinished'), 'utf8'), 'Do not discard.');
});

test('planner unavailability leaves queue events durable for a future consumer', async t => {
  const f = runnerFixture(t); f.deps.now = () => new Date();
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision }, { mode: 'active',
    event: { id: 'incomplete', type: 'activation', reference: 'approval' } });
  assert.equal(await runProgrammePlan(), 'skipped:planner-unavailable');
  const state = readProgrammeState(f.root, f.programme);
  assert.equal(state.active_run, null); assert.deepEqual(state.planner_jobs.pending.event_ids, ['incomplete']);
  assert.equal(state.planner_jobs.recoveries.length, 0);
  assert.equal(state.execution_enabled, false);
});

test('bounded planner transport terminates only its own child and waits for close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = []; child.kill = signal => { signals.push(signal); child.emit('close', null, signal); };
  const result = await streamSession({ bin: 'fixture', args: [], maxRunMs: 10, spawn: () => child });
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(result.timedOut, true); assert.notEqual(result.status, 0);
});
