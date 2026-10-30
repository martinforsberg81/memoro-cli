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
import { runnerFixture, git } from './autonomous-run-fixture.js';
import { ready } from './autonomous-merge-fixture.js';
import { decideProgrammePlan, programmePlanContext } from '../../src/mc/programme-plan.js';
import { ensureProgrammePlanWorkspace, PLAN_SESSION_MAX_MS } from '../../src/mc/programme-plan-run.js';
import { autonomousPlanRole, instructionsFor, readCanonRole } from '../../src/mc/roles.js';
import { reviewCommandRefusal } from '../../src/mc/autonomous-review-guard.js';
import { readAutonomousState, readProgrammeState, sendAutonomousProject, releaseProgrammeRun, reserveProjectRun,
  mutateAutonomousProject, recordAutonomousMergeEvent, startAutonomousBuild, reserveProgrammeRun, mutateProgramme } from '../../src/mc/autonomous-state.js';
import { claimProgrammeJob, setProgrammeJobMode, cancelProgrammeOperation, completeProgrammePlan, finishProgrammeJob,
  prepareProgrammeOperation, reconcileProgrammeJobs, yieldProgrammeJob } from '../../src/mc/programme-jobs.js';
import { reportBinding } from '../../src/mc/autonomous-outcomes.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { createRunner, streamSession } from '../../src/mc/run.js';
import { run as programmeCommand } from '../../src/mc/commands/programme.js';
import { run as foregroundPlan } from '../../src/mc/commands/plan.js';

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
  assert.equal(code, 1); assert.match(err.join(''), /ownership|draft\/approve/u);
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
  assert.throws(() => f.apply(op('resume-project')), /awaits planner confirmation/u);
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

test('only the current independently reviewed delivery can be confirmed, with after-integration evidence', async t => {
  const base = await ready(t);
  const report = base.stateNow().review_reports.at(-1);
  recordAutonomousMergeEvent(base.root, base.programme, base.project, { binding: reportBinding(report), type: 'merge-landed',
    details: { merge_commit: report.session.head, merged_into: 'main' } });
  const f = decorate(base, claim(base));
  const before = f.read().metadata;
  const input = { id: 'confirmed-delivery', reference: 'decisions/delivery', criteria: [
    { criterion_id: 'schema', reference: 'reports/schema' }, { criterion_id: 'integration', reference: 'integration/observed' } ] };
  assert.throws(() => f.apply(f.intent('confirm-project', { ...input, criteria: input.criteria.slice(0, 1) }, { id: 'incomplete-confirmation' })), /every criterion/u);
  cancelProgrammeOperation(f.options(), { id: 'incomplete-confirmation', reason: 'Include after-integration proof.' });
  f.apply(f.intent('confirm-project', input));
  assert.equal(f.state().phase, 'confirmed'); assert.equal(f.state().evidence.confirmation.role, 'plan');
  assert.equal(f.state().ownership.pr, 42); assert.deepEqual(f.read().metadata, before);
  assert.equal(f.state().plan_decisions.at(-1).intent.input.criteria[1].reference, 'integration/observed');
});

test('a planner stop does not hold sent goals, clean-review merge admission or routing', async t => {
  const base = await ready(t); const f = decorate(base, claim(base));
  f.apply({ id: 'stop-before-next-dispatch', kind: 'reach-stop', stop: 'design-review', reference: 'decisions/agreed-stop' });
  const door = await base.door();
  assert.equal(door.ok, true, door.problems.join('; '));
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.state().contract };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'review');
});

test('undelivered goals cannot be confirmed and only explicit valid stops can halt future dispatch', t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.intent('confirm-project', { id: 'fake-confirmation', reference: 'none', criteria: [] })), /reviewed delivery/u);
  cancelProgrammeOperation(f.options(), { id: 'confirm-project-1', reason: 'Not delivered.' });
  assert.throws(() => f.apply({ id: 'unplanned-stop', kind: 'reach-stop', stop: '../invalid-stop', reference: 'none' }), /stable ID/u);
  f.apply(f.intent('resume-project'));
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
  assert.match(instructions, /headless autonomous flavor/u); assert.doesNotMatch(instructions, /with Martin at the terminal/u);
  for (const argv of [['programme', 'approve'], ['project', 'amend'], ['step', 'ready'], ['publish'], ['merge'], ['plan'], ['autonomous-project', 'revise']]) {
    assert.match(reviewCommandRefusal(argv, { actor: { role: 'plan' }, env: { MC_PROGRAMME_LEASE: 'test-lease' } }), /denied/u);
  }
  for (const argv of [['programme', 'decide'], ['programme', 'complete'], ['autonomous-project', 'show']]) assert.equal(reviewCommandRefusal(argv, { actor: { role: 'plan' } }), null);
});

test('the real headless CLI exposes guarded decisions/completion and denies agreement edits', t => {
  const f = fixture(t); const options = f.options();
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_HOME: join(f.root, 'mc-home'), MC_PROGRAMME: f.programme,
    MC_AUTONOMOUS_RUN: options.actor.run_id, MC_AUTONOMOUS_ROLE: 'plan', MC_PROGRAMME_LEASE: options.token };
  delete env.MC_STEP;
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url)), ...args], { env, encoding: 'utf8' });
  const decide = f.intent('revise-project', { ...f.state().contract, goal_revision: 2 });
  let reply = cli('programme', 'decide', f.programme, '--expected-revision', String(f.read().revision), '--input-file', f.file(decide));
  assert.equal(reply.status, 0, reply.stderr); assert.equal(f.state().goal_revision, 2);
  reply = cli('programme', 'approve', f.programme, '--expected-revision', String(f.read().revision), '--input-file', f.file({ by: 'headless' }));
  assert.equal(reply.status, 1); assert.match(reply.stderr, /agreement edits.*denied/u); assert.equal(f.read().metadata.id, f.programme);
  reply = cli('programme', 'complete', f.programme, '--expected-revision', String(f.read().revision), '--input-file', f.file({ event_ids: ['activate'], reference: 'decisions/cli-complete' }));
  assert.equal(reply.status, 0, reply.stderr); assert.equal(f.read().planner_jobs.lease.completion.reference, 'decisions/cli-complete');
});

test('opening mc plan remains foreground and does not reserve or start autonomous work', async t => {
  const f = fixture(t); const before = f.read(); let opened = false;
  const code = await foregroundPlan([f.programme, '--new'], { env: { MC_WORK_ROOT: f.root }, repos: [],
    role: () => readCanonRole('plan'), ensure: () => ({ ok: true, path: f.paths.dir, repos: ['memoro-cli'] }),
    open: async call => { opened = true; assert.equal(call.roleName, 'plan'); assert.match(call.overlay, /with Martin at the terminal/u); return { ok: true, code: 0 }; } });
  assert.equal(code, 0); assert.equal(opened, true); assert.deepEqual(f.read(), before);
});

for (const changeCheckout of [false, true]) test(`runner launches an isolated headless plan and validates explicit completion (changed checkout: ${changeCheckout})`, async t => {
  const f = runnerFixture(t); f.deps.now = () => new Date();
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision }, { mode: 'active',
    event: { id: 'runner-activation', type: 'activation', reference: 'approval' } });
  let call;
  f.deps.session = async value => {
    call = value;
    if (changeCheckout) git(join(value.cwd, 'memoro-cli'), 'commit', '--allow-empty', '-qm', 'Unexpected planner implementation');
    const actor = { role: 'plan', run_id: value.env.MC_AUTONOMOUS_RUN };
    const state = readProgrammeState(f.root, f.programme);
    completeProgrammePlan({ root: f.root, programme: f.programme, actor, token: value.env.MC_PROGRAMME_LEASE, revision: state.revision },
      { event_ids: state.planner_jobs.lease.event_ids, reference: 'decisions/runner-complete' });
    return { status: 0 };
  };
  const runner = createRunner({ deps: f.deps, autonomous: { ...f.capability, programmeJobs: true, programmePlan: true } });
  const world = { ...f.world(f.record), programmeJobs: [f.programme] };
  assert.equal((await runner.pass({ world })).name, `programme:${f.programme}`, f.log.join('\n'));
  assert.equal(call.env.MC_AUTONOMOUS_ROLE, 'plan'); assert.equal(call.maxRunMs, PLAN_SESSION_MAX_MS);
  assert.equal(call.cwd, join(f.root, 'runner', 'plans', f.programme));
  assert.equal(git(join(call.cwd, 'memoro-cli'), 'branch', '--show-current'), '');
  assert.equal(existsSync(f.cwd(f.project)), false, 'builder workspace was not created or borrowed');
  const result = readProgrammeState(f.root, f.programme).planner_jobs;
  if (changeCheckout) {
    assert.ok(result.pending); assert.match(result.recoveries.at(-1).reason, /changed an inspection checkout/u);
    assert.throws(() => ensureProgrammePlanWorkspace({ root: f.root, programme: f.programme, repos: [{ name: 'memoro-cli', path: f.primary }], git: f.deps.git }), /inspection head changed/u);
  } else {
    assert.equal(result.pending, null); assert.equal(result.results.length, 1);
  }
});

test('workspace refresh preserves dirty inspection trees and refuses foreground/branch adoption', t => {
  const f = runnerFixture(t);
  const options = { root: f.root, programme: f.programme, repos: [{ name: 'memoro-cli', path: f.primary }], git: f.deps.git };
  const workspace = ensureProgrammePlanWorkspace(options);
  writeFileSync(join(workspace.repos[0].path, 'unfinished'), 'Do not discard.');
  assert.throws(() => ensureProgrammePlanWorkspace(options), /preserve it for recovery/u);
  assert.equal(readFileSync(join(workspace.repos[0].path, 'unfinished'), 'utf8'), 'Do not discard.');
});

test('zero exit without durable planner completion retains events and ownership is released for reconciliation', async t => {
  const f = runnerFixture(t); f.deps.now = () => new Date();
  f.releasePlanner();
  setProgrammeJobMode({ root: f.root, programme: f.programme, revision: readProgrammeState(f.root, f.programme).revision }, { mode: 'active',
    event: { id: 'incomplete', type: 'activation', reference: 'approval' } });
  const runner = createRunner({ deps: f.deps, autonomous: { ...f.capability, programmeJobs: true, programmePlan: true } });
  await runner.pass({ world: { ...f.world(f.record), programmeJobs: [f.programme] } });
  const state = readProgrammeState(f.root, f.programme);
  assert.equal(state.active_run, null); assert.deepEqual(state.planner_jobs.pending.event_ids, ['incomplete']);
  assert.match(state.planner_jobs.recoveries.at(-1)?.reason || f.log.join('\n'), /no durable event completion/u);
  assert.equal(state.execution_enabled, false);
});

test('bounded planner transport terminates only its own child and waits for close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = []; child.kill = signal => { signals.push(signal); child.emit('close', null, signal); };
  const result = await streamSession({ bin: 'fixture', args: [], maxRunMs: 10, spawn: () => child });
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(result.timedOut, true); assert.notEqual(result.status, 0);
});
