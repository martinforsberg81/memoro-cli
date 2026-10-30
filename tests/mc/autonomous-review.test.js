import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { reviewCompletion, reviewSpawn } from './autonomous-review-process-fixture.js';
import { beginReviewProcess, readReviewProcess, recordReviewSpawn, recordReviewTerminal, reviewProcessPaths, reviewProcessStatus, streamReviewSession } from '../../src/mc/autonomous-review-process.js';
import { takeClaim, releaseClaim, readClaim } from '../../src/mc/resource-claim.js';
import { fixture, git, completion } from './autonomous-publication-fixture.js';
import { reviewer, planner } from './autonomous-state-fixture.js';
import { settlePublishedBuild } from '../../src/mc/autonomous-recovery.js';
import { prepareAutonomousReview, completeAutonomousReview, reviewCheckoutFingerprint } from '../../src/mc/autonomous-review.js';
import { reviewInputProblems } from '../../src/mc/autonomous-review-report.js';
import { mutateAutonomousProject, recordAutonomousReview, reserveProjectRun } from '../../src/mc/autonomous-state.js';
import { run as projectCommand } from '../../src/mc/commands/autonomous-project.js';
import { run as legacyProjectCommand } from '../../src/mc/commands/project.js';
import { run as publishCommand } from '../../src/mc/commands/publish.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';
import { run as stepCommand } from '../../src/mc/commands/step.js';
import { reviewCommandRefusal } from '../../src/mc/autonomous-review-guard.js';
import { readCanonRole, instructionsFor } from '../../src/mc/roles.js';
import { runAutonomousReview, autonomousChoice } from '../../src/mc/autonomous-run.js';
import { chooseAutonomousModel } from '../../src/mc/autonomous-models.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { normaliseCapacity } from '../../src/mc/model-capacity.js';

async function ready(t) {
  const f = fixture(t); f.edit(); await f.finish();
  await settlePublishedBuild(f.options(), completion, f.deps);
  assert.equal(f.stateNow().phase, 'review_ready');
  const options = { root: f.root, programme: f.programme, project: f.project, actor: reviewer, cwd: f.cwd, model: DEFAULT_CATALOG.review };
  const start = () => { const state = prepareAutonomousReview(options); reviewSpawn(options); return state; };
  const submit = input => mutateAutonomousProject(f.root, f.programme, f.project, 'report', input,
    { actor: reviewer, revision: f.stateNow().revision });
  return { ...f, options, start, submit };
}
const clean = () => ({ criteria: [
  { criterion_id: 'schema', status: 'verified', evidence: ['gate/schema-proof.json'], uncertainty: [] },
  { criterion_id: 'integration', status: 'deferred', evidence: ['Requires landing before checking the installed CLI.'], uncertainty: [] },
], defects: [], uncertainty: [] });
const finish = f => completeAutonomousReview(f.options, reviewCompletion);

test('review freezes published head, comparison base, full assignment and historical models in its own detached checkout', async t => {
  const f = await ready(t); const builderHead = git(f.cwd, 'rev-parse', 'HEAD'); const state = f.start(); const session = state.review_session;
  assert.notEqual(session.checkout, f.cwd); assert.equal(git(session.checkout, 'rev-parse', 'HEAD'), builderHead);
  assert.equal(git(session.checkout, 'branch', '--show-current'), ''); assert.equal(git(f.cwd, 'branch', '--show-current'), f.project);
  assert.equal(session.base, git(f.cwd, 'rev-parse', 'origin/main')); assert.deepEqual(session.assignment, state.contract);
  assert.equal(session.builders[0].model, 'haiku'); assert.equal(session.model.model, 'opus'); assert.ok(session.gate_run);
  assert.equal(reviewCheckoutFingerprint(session.checkout), session.fingerprint);
  assert.throws(f.start, /not review ready/u);
  f.submit(clean()); const final = finish(f); const report = final.review_reports[0];
  assert.equal(report.clean, true); assert.equal(report.session_digest.length, 64);
  assert.equal(final.phase, 'plan_pending'); assert.equal(final.active_run, null); assert.equal(final.confirmed, false);
  assert.equal(final.runs.filter(r => r.role === 'step').length, 1); assert.equal(final.evidence.reviews.length, 1);
  assert.equal(final.evidence.builder.length, 1, 'review never writes criterion progress');
  assert.deepEqual(finish(f), final, 'duplicate completion is idempotent');
  const { reference, ...same } = report;
  assert.deepEqual(recordAutonomousReview(f.root, f.programme, f.project, { actor: reviewer, revision: final.revision, report: same }), final);
  assert.throws(() => recordAutonomousReview(f.root, f.programme, f.project,
    { actor: reviewer, revision: final.revision, report: { ...same, clean: false } }), /immutable/u);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.project)).review_reports[0], report, 'report is durable in authoritative state');
});

test('missing, duplicate, extra and unevidenced criterion findings are rejected without changing state', async t => {
  const f = await ready(t); f.start();
  for (const change of [r => r.criteria.pop(), r => r.criteria.push(r.criteria[0]), r => r.criteria[0].criterion_id = 'other',
    r => r.criteria[0].evidence = [], r => delete r.uncertainty, r => r.criteria[0].status = 'deferred', r => r.confirmed = true]) {
    const input = clean(); change(input); const before = readFileSync(f.paths.project, 'utf8');
    assert.throws(() => f.submit(input)); assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  }
  const final = finish(f); assert.equal(final.review_reports[0].clean, false);
  assert.deepEqual(final.review_reports[0].result.criteria.map(item => item.status), ['unknown', 'unknown']);
  assert.ok(final.review_reports[0].invalid_reasons.length);
});

for (const finding of ['defect', 'uncertainty', 'criterion-finding', 'unknown']) test(`${finding} is a report for plan, never clean or a new build`, async t => {
  const f = await ready(t); f.start(); const report = clean();
  if (finding === 'defect') report.defects.push('A reproducible bug.');
  if (finding === 'uncertainty') report.criteria[0].uncertainty.push('Verification environment unavailable.');
  if (finding === 'criterion-finding') report.criteria[0].status = 'finding';
  if (finding === 'unknown') report.criteria[0].status = 'unknown';
  f.submit(report); const final = finish(f);
  assert.equal(final.review_reports[0].clean, false); assert.equal(final.phase, 'plan_pending');
  assert.equal(final.active_run, null); assert.equal(final.runs.length, 2); // builder, review; assignment authoring is an operation
});

for (const mutation of ['tracked', 'untracked', 'ignored', 'index', 'commit', 'branch']) test(`${mutation} review checkout mutation invalidates an otherwise clean report`, async t => {
  const f = await ready(t); const session = f.start().review_session; f.submit(clean()); const cwd = session.checkout;
  if (mutation === 'tracked') writeFileSync(join(cwd, 'implementation.js'), 'changed\n');
  if (mutation === 'untracked') writeFileSync(join(cwd, 'extra'), 'changed\n');
  if (mutation === 'ignored') { git(cwd, 'config', 'core.excludesFile', join(f.root, 'excludes')); writeFileSync(join(f.root, 'excludes'), 'ignored\n'); writeFileSync(join(cwd, 'ignored'), 'changed\n'); }
  if (mutation === 'index') { git(cwd, 'rm', '--cached', 'implementation.js'); }
  if (mutation === 'commit') git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Review mutation');
  if (mutation === 'branch') git(cwd, 'switch', '-qc', 'unauthorized-review-branch');
  const final = finish(f); assert.equal(final.review_reports[0].clean, false);
  assert.ok(final.review_reports[0].invalid_reasons.includes('review checkout changed'));
});

test('historical builder reuse, missing provenance and moved remote head refuse review admission', async t => {
  const f = await ready(t);
  assert.throws(() => prepareAutonomousReview({ ...f.options, model: DEFAULT_CATALOG.fast[0] }), /builder-model reuse/u);
  const state = f.stateNow(); state.model_history = []; writeFileSync(f.paths.project, JSON.stringify(state));
  assert.throws(f.start, /historical builder model is unknown/u);
  state.model_history = [{ run_id: 'build-1', goal_revision: 1, model: DEFAULT_CATALOG.fast[0] }]; writeFileSync(f.paths.project, JSON.stringify(state));
  git(f.remote, 'update-ref', `refs/heads/${f.project}`, git(f.cwd, 'rev-parse', 'origin/main'));
  assert.throws(f.start, /head moved/u); assert.equal(f.stateNow().phase, 'review_ready');
});

test('head movement and nonzero/interrupted review exits cannot produce a clean report', async t => {
  for (const failure of ['head', 'exit', 'interrupted', 'missing']) await t.test(failure, async t => {
    const f = await ready(t); f.start(); if (failure !== 'missing') f.submit(clean());
    if (failure === 'head') git(f.remote, 'update-ref', `refs/heads/${f.project}`, git(f.cwd, 'rev-parse', 'origin/main'));
    const result = completeAutonomousReview(f.options, { ...reviewCompletion, status: failure === 'exit' ? 1 : 0, interrupted: failure === 'interrupted' });
    assert.equal(result.review_reports[0].clean, false); assert.equal(result.phase, 'plan_pending');
  });
});

test('review command/state guards deny scope, criterion status, publication, merge, build and release', async t => {
  const f = await ready(t); f.start(); const before = readFileSync(f.paths.project, 'utf8');
  for (const operation of ['revise', 'confirm', 'progress', 'attempt', 'release', 'recover']) {
    assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, operation, {}, { actor: reviewer, revision: f.stateNow().revision }));
  }
  assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  let output = ''; const deps = { env: { MC_AUTONOMOUS_ROLE: 'review', MC_AUTONOMOUS_RUN: reviewer.run_id },
    stdout: { write: s => { output += s; } }, stderr: { write: s => { output += s; } } };
  for (const [command, args] of [[publishCommand, []], [mergeCommand, ['memoro-cli', '42', '--admin']],
    [legacyProjectCommand, ['criterion', 'met', '1']], [stepCommand, ['ready']]]) assert.equal(await command(args, deps), 1);
  assert.match(output, /only examine and report/u);
  for (const argv of [['programme', 'approve'], ['run'], ['work', 'add'], ['project', 'amend'], ['autonomous-project', 'finish']]) assert.ok(reviewCommandRefusal(argv, deps));
  assert.equal(reviewCommandRefusal(['publish'], { env: {} }), null, 'legacy review is unchanged');
  assert.equal(reviewCommandRefusal(['autonomous-project', 'report'], deps), null);
  const cli = fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url));
  const response = spawnSync(process.execPath, [cli, 'run'], { env: { ...process.env, ...deps.env }, encoding: 'utf8', timeout: 10000 });
  assert.equal(response.status, 1); assert.match(response.stderr, /only examine and report/u);
});

test('command submission checks active run, revision and exact protocol; cannot mutate or overwrite', async t => {
  const f = await ready(t); f.start(); const errors = [];
  const deps = { root: f.root, actor: reviewer, env: {}, readInput: () => JSON.stringify(clean()), stdout: { write() {} }, stderr: { write: text => errors.push(text) } };
  const args = () => ['report', `${f.programme}/${f.project}`, '--expected-revision', String(f.stateNow().revision), '--input-file', '/unused'];
  assert.equal(await projectCommand(args(), { ...deps, actor: planner }), 1);
  assert.equal(await projectCommand(args(), deps), 0); assert.equal(await projectCommand(args(), deps), 1);
  assert.ok(errors.some(e => e.includes('immutable')));
});

test('autonomous overlay reports only while legacy review still repairs and publishes', () => {
  const legacy = readCanonRole('review'); assert.match(legacy.overlay, /Close the gaps/u); assert.match(legacy.overlay, /mc publish/u);
  const overlay = instructionsFor('codex', '@include _review-autonomous.md');
  assert.match(overlay, /Do not edit code/u); assert.match(overlay, /Only plan decides/u);
  assert.equal(reviewInputProblems(clean(), { success_criteria: [{ id: 'schema', verification: 'premerge' }, { id: 'integration', verification: 'after-integration' }] }).length, 0);
});

test('injected review dispatch uses shared slot, distinct model/checkout, durable report and no direct repair or merge', async t => {
  const f = await ready(t); let slots = 0; const currents = []; const lines = []; let launched = 0;
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.stateNow().contract };
  assert.equal(autonomousChoice({ root: f.root, record, capability: null }).kind, null);
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'review');
  const routeClass = (cls, state, role) => chooseAutonomousModel({ cls, state, role, catalog: DEFAULT_CATALOG, capacity: normaliseCapacity(null) });
  const adapter = await import('../../src/adapters/claude-code.js');
  const result = await runAutonomousReview({ root: f.root, record, repo: { name: 'memoro-cli', path: f.cwd }, worktree: f.cwd, lane: 0, pid: process.pid,
    paths: { currentFor: () => join(f.root, 'current.json') },
    deps: { exists: () => true, role: readCanonRole, launch: () => ({ ok: true, id: 'claude-code', adapter, spec: { bin: 'fixture' } }),
      gh: f.gh, mkdir() {}, session: async call => {
        launched++; assert.equal(slots, 1); assert.notEqual(call.cwd, f.cwd);
        assert.equal(call.env.MC_AUTONOMOUS_ROLE, 'review'); assert.equal(call.env.MC_STEP, undefined);
        const prompt = JSON.parse(call.prompt); assert.equal(prompt.session.model.model, 'opus');
        const state = f.stateNow(); mutateAutonomousProject(f.root, f.programme, f.project, 'report', clean(), { actor: state.active_run, revision: state.revision });
        reviewSpawn(call.reviewProcess.options);
        return { ...reviewCompletion, stdout: '', stderr: '' };
      } },
    waitForSlot: async () => { slots++; return 'ok'; }, dropSlot: () => { slots--; }, routeClass,
    writeJson: (path, value) => currents.push(value), remove() {}, stamp: () => 'now', say: line => lines.push(line), observeResult() {} });
  assert.equal(result, 'ran'); assert.equal(slots, 0); assert.equal(launched, 1);
  assert.equal(currents[0].kind, 'review'); assert.equal(currents[0].flavor, 'autonomous-review');
  assert.equal(f.stateNow().review_reports[0].clean, true); assert.equal(f.stateNow().phase, 'plan_pending');
  assert.ok(lines.some(line => line.includes('nothing queued')));
});

test('assignment movement invalidates the old frozen report without rewriting its revision', async t => {
  const f = await ready(t); f.start(); f.submit(clean());
  const state = f.stateNow(); state.contract = { ...state.contract, goal_revision: 2 }; state.contracts.push(state.contract); state.goal_revision = 2;
  writeFileSync(f.paths.project, JSON.stringify(state));
  const final = finish(f);
  assert.equal(final.review_reports[0].clean, false);
  assert.ok(final.review_reports[0].invalid_reasons.includes('review assignment changed'));
  assert.equal(final.evidence.reviews[0].goal_revision, 1);
  assert.equal(final.review_reports[0].session.assignment.goal_revision, 1);
  assert.equal(final.goal_revision, 2);
});

test('review waits without reserving, launching, acquiring a slot or using a builder when capacity is absent', async t => {
  const f = await ready(t); const before = readFileSync(f.paths.project, 'utf8'); const log = [];
  assert.equal(await runAutonomousReview({ root: f.root, record: { project: f.project, programme: f.programme },
    routeClass: () => ({ ok: false, transient: true, reason: 'reserved reviewer unavailable' }),
    waitForSlot: () => assert.fail('no slot without independent capacity'), say: line => log.push(line) }), 'skipped:no-capacity');
  assert.equal(readFileSync(f.paths.project, 'utf8'), before); assert.match(log.join(''), /review waits/u);
});


test('a different reserved run cannot reuse an earlier review session or submission', async t => {
  const f = await ready(t); f.start(); f.submit(clean()); const done = finish(f);
  const actor = { run_id: 'another-review', role: 'review' };
  const state = reserveProjectRun(f.root, f.programme, f.project, actor, done.revision);
  assert.throws(() => mutateAutonomousProject(f.root, f.programme, f.project, 'report', clean(),
    { actor, revision: state.revision }), /active independent review session/u);
  assert.throws(() => completeAutonomousReview({ ...f.options, actor }, { status: 0 }), /active review ownership/u);
  assert.equal(f.stateNow().review_reports.length, 1);
});

test('crash before spawn leaves an immutable bound manifest and can only settle as incomplete', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session;
  const { manifest, paths } = readReviewProcess(f.options);
  assert.deepEqual(manifest.session, session); assert.deepEqual(manifest.actor, reviewer);
  assert.equal(manifest.session.head, f.stateNow().publication.head);
  assert.equal(manifest.source_fingerprint, reviewCheckoutFingerprint(f.cwd));
  const bytes = readFileSync(paths.manifest, 'utf8');
  assert.equal(reviewProcessStatus(f.options).kind, 'unknown');
  assert.deepEqual(f.stateNow().active_run, reviewer);
  f.submit(clean()); const done = completeAutonomousReview(f.options, { status: 0 });
  assert.equal(done.review_reports[0].clean, false);
  assert.equal(readReviewProcess(f.options).terminal.result.not_spawned, true);
  assert.equal(reviewProcessStatus(f.options).kind, 'incomplete');
  assert.equal(readFileSync(paths.manifest, 'utf8'), bytes);
  assert.equal(git(session.checkout, 'rev-parse', 'HEAD'), session.head);
});

for (const boundary of ['spawn-intent', 'spawned', 'missing-terminal', 'children', 'tools']) test(`${boundary} crash retains review ownership; exit zero is not closure`, async t => {
  const f = await ready(t); prepareAutonomousReview(f.options); beginReviewProcess(f.options); f.submit(clean());
  if (boundary !== 'spawn-intent') recordReviewSpawn(f.options, 2147483647);
  if (boundary === 'children' || boundary === 'tools') recordReviewTerminal(f.options, {
    ...reviewCompletion, group_dead: boundary !== 'children', tools_closed: boundary !== 'tools',
  });
  const before = readFileSync(f.paths.project, 'utf8');
  assert.throws(() => completeAutonomousReview(f.options, { status: 0 }), /unknown; ownership retained/u);
  assert.equal(reviewProcessStatus(f.options).kind, 'unknown');
  assert.equal(readFileSync(f.paths.project, 'utf8'), before);
  assert.equal(f.stateNow().review_reports?.length || 0, 0);
});

test('a live real review process stays owned, then native terminal facts survive restart', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session;
  beginReviewProcess(f.options); f.submit(clean()); let child;
  const resultPromise = streamReviewSession({ bin: process.execPath, args: ['-e',
    'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"turn.completed"})))'], cwd: session.checkout,
    reviewProcess: { options: f.options, tool: 'codex' }, spawn: (bin, args, options) => { child = spawn(bin, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); return child; } });
  const close = once(child, 'close');
  assert.equal(reviewProcessStatus(f.options).kind, 'live');
  // Simulate the supervisor's claim disappearing at restart: the observed
  // child/group, not just a supervisor PID, still keeps the checkout owned.
  const claimPath = reviewProcessPaths(f.options).claim;
  const supervisorClaim = readClaim(claimPath);
  releaseClaim(claimPath, supervisorClaim.marker);
  assert.equal(reviewProcessStatus(f.options).kind, 'live');
  assert.throws(() => completeAutonomousReview(f.options, { status: 0 }), /live; ownership retained/u);
  child.stdin.end();
  const result = await resultPromise; await close;
  assert.equal(result.normal_exit, true); assert.equal(result.tools_closed, true);
  assert.equal(reviewProcessStatus(f.options).kind, 'completed');
  assert.equal(f.stateNow().phase, 'reviewing', 'terminal persistence precedes owner release');
  const final = completeAutonomousReview(f.options, null);
  assert.equal(final.review_reports[0].clean, true); assert.equal(final.active_run, null);
  assert.deepEqual(completeAutonomousReview(f.options, null), final);
});

test('a real process exiting zero without a transport result is incomplete, not a clean review', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session;
  beginReviewProcess(f.options); f.submit(clean());
  const result = await streamReviewSession({ bin: process.execPath, args: ['-e', 'process.exit(0)'], cwd: session.checkout,
    reviewProcess: { options: f.options, tool: 'codex' } });
  assert.equal(result.status, 0); assert.equal(result.normal_exit, false);
  assert.equal(reviewProcessStatus(f.options).kind, 'incomplete');
  assert.equal(completeAutonomousReview(f.options, null).review_reports[0].clean, false);
});

test('unknown throwing spawn keeps ownership and cannot be relaunched', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session; beginReviewProcess(f.options);
  await assert.rejects(streamReviewSession({ cwd: session.checkout, reviewProcess: { options: f.options, tool: 'codex' },
    spawn: () => { throw new Error('lost spawn response'); } }), /lost spawn response/u);
  await assert.rejects(streamReviewSession({ cwd: session.checkout, reviewProcess: { options: f.options, tool: 'codex' },
    spawn: () => assert.fail('unknown native spawn must never be retried') }), /fresh bound review spawn intent required/u);
  assert.throws(() => beginReviewProcess(f.options), /already attempted/u);
  assert.throws(() => completeAutonomousReview(f.options, { status: 1 }), /unknown; ownership retained/u);
  assert.equal(f.stateNow().active_run.run_id, reviewer.run_id);
});

test('native tools still open at provider exit keep ownership even with a result event', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session;
  beginReviewProcess(f.options); f.submit(clean());
  const result = await streamReviewSession({ bin: process.execPath, args: ['-e',
    'for(const e of [{type:"item.started",item:{type:"command_execution",id:"detached"}},{type:"turn.completed"}]) console.log(JSON.stringify(e))'],
    cwd: session.checkout, reviewProcess: { options: f.options, tool: 'codex' } });
  assert.equal(result.tools_closed, false);
  assert.throws(() => completeAutonomousReview(f.options, null), /unknown; ownership retained/u);
});

test('completed report is durable before release; restart replays exactly once', async t => {
  const f = await ready(t); f.start(); f.submit(clean());
  const crash = () => { throw new Error('crash before state release'); };
  assert.throws(() => completeAutonomousReview(f.options, reviewCompletion, { record: crash }), /crash before state release/u);
  const attempt = readReviewProcess(f.options); const bytes = readFileSync(attempt.paths.report, 'utf8');
  assert.equal(attempt.report.report.clean, true); assert.equal(f.stateNow().phase, 'reviewing');
  assert.deepEqual(f.stateNow().active_run, reviewer); assert.equal(f.stateNow().review_reports?.length || 0, 0);
  const abandoned = takeClaim(attempt.paths.claim, { pid: 2147483647, generation: attempt.manifest.generation, run_id: reviewer.run_id });
  assert.equal(abandoned.ok, true);
  const done = completeAutonomousReview(f.options, null);
  assert.equal(readClaim(attempt.paths.claim), null);
  assert.equal(done.review_reports.length, 1); assert.equal(done.evidence.reviews.length, 1);
  assert.equal(done.plan_events.filter(e => e.type === 'review-reported').length, 1);
  assert.deepEqual(completeAutonomousReview(f.options, null), done);
  assert.equal(readFileSync(attempt.paths.report, 'utf8'), bytes);
});

for (const mutation of ['checkout', 'ignored', 'head', 'source']) test(`${mutation} changed after report persistence cannot release the checkout`, async t => {
  const f = await ready(t); const session = f.start().review_session; f.submit(clean());
  assert.throws(() => completeAutonomousReview(f.options, reviewCompletion,
    { record: () => { throw new Error('crash before release'); } }), /crash before release/u);
  if (mutation === 'checkout') writeFileSync(join(session.checkout, 'implementation.js'), 'altered');
  if (mutation === 'source') writeFileSync(join(f.cwd, 'implementation.js'), 'altered');
  if (mutation === 'ignored') {
    writeFileSync(join(f.root, 'excludes'), 'ignored\n'); git(session.checkout, 'config', 'core.excludesFile', join(f.root, 'excludes'));
    writeFileSync(join(session.checkout, 'ignored'), 'altered');
  }
  if (mutation === 'head') git(f.remote, 'update-ref', `refs/heads/${f.project}`, session.base);
  const paths = reviewProcessPaths(f.options); const report = readFileSync(paths.report, 'utf8');
  assert.throws(() => completeAutonomousReview(f.options, null));
  assert.deepEqual(f.stateNow().active_run, reviewer); assert.equal(f.stateNow().review_reports?.length || 0, 0);
  assert.equal(readFileSync(paths.report, 'utf8'), report);
});

test('foreign terminal generations and successor claims cannot be adopted or released by an old owner', async t => {
  const f = await ready(t); f.start(); f.submit(clean());
  recordReviewTerminal(f.options, reviewCompletion);
  const paths = reviewProcessPaths(f.options); const terminal = JSON.parse(readFileSync(paths.terminal));
  writeFileSync(paths.terminal, JSON.stringify({ ...terminal, generation: 'foreign' }));
  assert.throws(() => completeAutonomousReview(f.options, null), /generation changed/u);
  writeFileSync(paths.terminal, JSON.stringify(terminal));
  const old = takeClaim(paths.claim, { pid: 2147483647, generation: 'old' });
  const successor = takeClaim(paths.claim, { pid: process.pid, generation: 'successor' });
  assert.equal(old.ok, true); assert.equal(successor.ok, true);
  assert.equal(releaseClaim(paths.claim, old.marker), false);
  assert.equal(readClaim(paths.claim).marker, successor.marker);
  assert.throws(() => completeAutonomousReview(f.options, null), /unknown; ownership retained/u);
  assert.equal(readClaim(paths.claim).marker, successor.marker);
  releaseClaim(paths.claim, successor.marker);
  assert.equal(completeAutonomousReview(f.options, null).review_reports[0].clean, true);
});

test('a native failed spawn is a known incomplete attempt, not successful or unknown', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session; beginReviewProcess(f.options);
  const result = await streamReviewSession({ bin: join(f.root, 'no-such-reviewer'), args: [], cwd: session.checkout,
    reviewProcess: { options: f.options, tool: 'codex' } });
  assert.equal(result.process_closed, true); assert.equal(result.group_dead, true); assert.equal(result.tools_closed, true);
  assert.equal(reviewProcessStatus(f.options).kind, 'incomplete');
  const done = completeAutonomousReview(f.options, null);
  assert.equal(done.review_reports[0].clean, false); assert.equal(done.active_run, null);
});

test('a real surviving child keeps the detached checkout owned after the provider exits', async t => {
  const f = await ready(t); const session = prepareAutonomousReview(f.options).review_session; beginReviewProcess(f.options); f.submit(clean());
  const result = await streamReviewSession({ bin: process.execPath, args: ['-e',
    'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1800)"],{stdio:"inherit"}).unref();console.log(JSON.stringify({type:"turn.completed"}))'],
    cwd: session.checkout, reviewProcess: { options: f.options, tool: 'codex' } });
  assert.equal(result.group_dead, false); assert.equal(result.process_closed, false);
  assert.throws(() => completeAutonomousReview(f.options, null), /live; ownership retained/u);
  assert.deepEqual(f.stateNow().active_run, reviewer);
  // The fixture child exits itself; recovery never signals a discovered PID.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(reviewProcessStatus(f.options).kind, 'unknown', 'a later dead group cannot invent missing closure facts');
});

test('contradictory or missing terminal success facts cannot become a clean report', async t => {
  const f = await ready(t); f.start(); f.submit(clean());
  const result = { ...reviewCompletion, transport_completed: false }; delete result.interrupted;
  const done = completeAutonomousReview(f.options, result);
  assert.equal(reviewProcessStatus(f.options).kind, 'incomplete');
  assert.equal(done.review_reports[0].clean, false);
  assert.ok(done.review_reports[0].invalid_reasons.includes('review process did not complete successfully'));
});
