import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  const start = () => prepareAutonomousReview(options);
  const submit = input => mutateAutonomousProject(f.root, f.programme, f.project, 'report', input,
    { actor: reviewer, revision: f.stateNow().revision });
  return { ...f, options, start, submit };
}
const clean = () => ({ criteria: [
  { criterion_id: 'schema', status: 'verified', evidence: ['gate/schema-proof.json'], uncertainty: [] },
  { criterion_id: 'integration', status: 'deferred', evidence: ['Requires landing before checking the installed CLI.'], uncertainty: [] },
], defects: [], uncertainty: [] });
const finish = f => completeAutonomousReview(f.options, { status: 0 });

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
  assert.equal(final.active_run, null); assert.equal(final.runs.length, 3); // planner, builder, review
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
    const result = completeAutonomousReview(f.options, { status: failure === 'exit' ? 1 : 0, interrupted: failure === 'interrupted' });
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
        return { status: 0, stdout: '', stderr: '' };
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
  const state = f.stateNow(); state.contract.goal_revision = 2; state.goal_revision = 2;
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
