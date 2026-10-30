import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './autonomous-publication-fixture.js';
import { reviewCompletion, reviewSpawn } from './autonomous-review-process-fixture.js';
import { reviewer } from './autonomous-state-fixture.js';
import { completeAutonomousReview } from '../../src/mc/autonomous-review.js';
import { createAutonomousDraft, currentAutonomousEvidence, mutateAutonomousProject, mutateProgramme, readProgrammeState, recordAutonomousMergeEvent } from '../../src/mc/autonomous-state.js';
import { autonomousMergeDoor, autonomousPrOwner } from '../../src/mc/autonomous-pr.js';
import { autonomousProof, reviewRelevance } from '../../src/mc/autonomous-merge.js';
import { criteriaDoor } from '../../src/mc/merge-boundary.js';
import { queueMerge, landJob } from '../../src/mc/merger.js';
import { parseQueue, mergesPath, markLanding } from '../../src/mc/merge-queue.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';

import { routeAutonomousReview, reportBinding, recordMergeOutcome, reviewRoutePending } from '../../src/mc/autonomous-outcomes.js';
import { autonomousChoice, runAutonomousBuild, runAutonomousReview } from '../../src/mc/autonomous-run.js';
import { archiveDue } from '../../src/mc/project-archive.js';
import { clean, ready, queue, receiptPath, moveMain, round } from './autonomous-merge-fixture.js';

test('current clean review, premerge evidence and full gate enter the existing queue and pin the leased landing', async t => {
  const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
  assert.equal(admitted.checked, true); assert.deepEqual(admitted.autonomous.builder_evidence, ['schema-proof']);
  assert.equal(admitted.autonomous.review_id, reviewer.run_id); assert.equal(admitted.autonomous.gate_run, 'admission-gate');
  assert.equal((await criteriaDoor({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh: f.gh })).ok, true);
  assert.throws(() => queue(f), /admission/u, 'even the low-level queue requires freshly checked evidence');
  const owner = autonomousPrOwner({ root: f.root, repoPath: f.cwd, pr: 42 }).owner;
  assert.throws(() => queue(f, autonomousProof({ root: f.root, owner, pr: 42 }).ticket), /fresh complete/u, 'constructing IDs is not a gate check');
  queue(f, admitted.autonomous);
  assert.throws(() => queue(f, admitted.autonomous), /fresh complete/u, 'queue admission is single-use');
  assert.equal(await mergeCommand(['memoro-cli', '42'], { root: f.root, env: f.env, cwd: f.cwd, gh: f.gh,
    resolveRepoPath: () => f.cwd, prFiles: () => ['implementation.js'], stdout: f.deps.stdout, stderr: f.deps.stderr,
    startMerger: () => ({ pid: null, started: false }) }), 0, f.output.join(''));
  const jobs = parseQueue(readFileSync(mergesPath(f.root), 'utf8'));
  assert.deepEqual(jobs[0].autonomous, admitted.autonomous);
  const restarted = parseQueue(JSON.stringify(markLanding(jobs, jobs[0], { pid: 123, now: 'now' })))[0];
  assert.deepEqual(restarted.autonomous, admitted.autonomous);
  const outcome = await round(f, { ticket: restarted.autonomous });
  assert.equal(outcome.report.ok, true, outcome.report.reason); assert.equal(outcome.merged, true);
  assert.equal(f.stateNow().confirmed, false, 'admission never confirms a goal');
});

test('editing an issued ticket to match newer state does not manufacture a fresh admission', async t => {
  const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true);
  f.patch(s => { s.review_reports[0].result.criteria[0].evidence.push('Replacement observation.'); });
  const owner = autonomousPrOwner({ root: f.root, repoPath: f.cwd, pr: 42 }).owner;
  Object.assign(admitted.autonomous, autonomousProof({ root: f.root, owner, pr: 42 }).ticket);
  assert.throws(() => queue(f, admitted.autonomous), /fresh complete/u);
  const renewed = await f.door(); assert.equal(renewed.ok, true); queue(f, renewed.autonomous);
});

test('another goal revision and programme metadata do not invalidate an exact reviewed goal or its issued admission', async t => {
  const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true);
  f.releasePlanner();
  const before = f.stateNow(); const bytes = readFileSync(f.paths.project, 'utf8');
  const other = { ...before.contract, project_id: 'independent-goal' };
  const created = createAutonomousDraft(f.root, f.programme, other.project_id, other,
    { env: {}, revision: readProgrammeState(f.root, f.programme).revision });
  mutateAutonomousProject(f.root, f.programme, other.project_id, 'revise', { ...other, goal_revision: 2 },
    { env: {}, revision: created.revision });
  const programme = readProgrammeState(f.root, f.programme);
  mutateProgramme(f.root, f.programme, 'metadata', { ...programme.metadata, brief: 'docs/project/updated-context/' },
    { env: {}, revision: programme.revision });
  assert.equal(readFileSync(f.paths.project, 'utf8'), bytes);
  const renewed = await f.door({ expected: admitted.autonomous });
  assert.equal(renewed.ok, true, renewed.problems.join('; '));
  assert.deepEqual(renewed.autonomous, admitted.autonomous);
  queue(f, admitted.autonomous);
});

test('revising the reviewed goal rejects old admission and routing, retaining a late landing only as historical evidence', async t => {
  const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true);
  const old = f.stateNow(); f.releasePlanner();
  const revised = mutateAutonomousProject(f.root, f.programme, f.project, 'revise', { ...old.contract, goal_revision: 2 },
    { env: {}, revision: old.revision });
  assert.deepEqual(revised.review_reports, old.review_reports);
  assert.deepEqual(revised.evidence, old.evidence);
  assert.deepEqual(currentAutonomousEvidence(revised), { builder: [], reviews: [], confirmation: null });
  assert.equal(reviewRoutePending(f.root, revised), false);
  assert.equal((await f.door({ expected: admitted.autonomous })).ok, false);
  assert.throws(() => queue(f, admitted.autonomous), /admission|publication/u);
  const job = { repo_path: f.cwd, pr: 42, branch: f.project, autonomous: admitted.autonomous };
  const report = { ok: true, merged: true, merged_into: 'main', merge_commit: 'b'.repeat(40) };
  recordMergeOutcome({ root: f.root, job, report });
  const final = f.stateNow();
  assert.equal(final.goal_revision, 2); assert.deepEqual(final.contract, revised.contract);
  assert.equal(final.phase, revised.phase); assert.equal(final.landing, undefined);
  assert.equal(final.merge_handoff, undefined); assert.equal(final.current_handoff, null);
  assert.equal(final.plan_events.at(-1).binding.goal_revision, 1);
  assert.deepEqual(final.review_reports, old.review_reports);
  recordMergeOutcome({ root: f.root, job, report }); assert.deepEqual(f.stateNow(), final);
});

for (const measuredHead of [null, '', 'a'.repeat(40)]) test(`incomplete or wrong measured head (${measuredHead}) never permits an unpinned autonomous squash`, async t => {
  const f = await ready(t); const admitted = await f.door();
  const outcome = await round(f, { ticket: admitted.autonomous, measuredHead });
  assert.equal(outcome.merged, false); assert.equal(outcome.report.stopped_at, 'autonomous-review-required');
  assert.equal(outcome.calls.some(args => args[1] === 'merge'), false);
});

// Simulate a PR acquiring durable ownership during a legacy measurement.
// The final read must discover it even when the initial metadata was v1.
function temporarilyLegacy(f) {
  const dir = join(f.root, 'runner', 'autonomous-prs');
  const repository = join(dir, readdirSync(dir)[0]);
  const path = join(repository, readdirSync(repository)[0]);
  const marker = readFileSync(path); rmSync(path);
  const pr = f.pr(); const original = { body: pr.body, headRefName: pr.headRefName };
  pr.body = ''; pr.headRefName = 'legacy';
  return () => { writeFileSync(path, marker); Object.assign(pr, original); };
}

test('ownership acquired during a legacy gate requires a new admitted leased round', async t => {
  const f = await ready(t); const restore = temporarilyLegacy(f);
  const outcome = await round(f, { unadmitted: true, duringGate: restore });
  assert.equal(outcome.merged, false); assert.equal(outcome.report.stopped_at, 'autonomous-review-required');
  assert.match(outcome.report.reason, /appeared after measurement/u);
});

test('ownership acquired during document measurement cannot use the lease-free squash', async t => {
  const f = await ready(t); const restore = temporarilyLegacy(f);
  Object.assign(f.pr(), { files: [{ path: 'docs/note.md' }], mergeable: 'MERGEABLE' });
  const report = await runDocsMerge({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env,
    gh: args => { assert.notEqual(args[1], 'merge'); return f.gh(args); },
    measure: async () => { restore(); return { ok: true }; } });
  assert.equal(report.merged, false); assert.equal(report.stopped_at, 'autonomous-review-required');
});

for (const mutation of ['plan-missing', 'plan-corrupt', 'state-missing', 'state-corrupt', 'report-missing', 'report-corrupt',
  'criterion-missing', 'criterion-unknown', 'revision', 'criteria-change', 'evidence-change', 'publication-incomplete', 'handoff-missing', 'model-reuse']) {
  test(`${mutation} refuses queue and resumed/direct landing instead of the legacy notChecked path`, async t => {
    const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
    if (mutation === 'plan-missing') rmSync(join(f.paths.projectDir, 'PLAN.json'));
    else if (mutation === 'plan-corrupt') writeFileSync(join(f.paths.projectDir, 'PLAN.json'), '{');
    else if (mutation === 'state-missing') rmSync(f.paths.project);
    else if (mutation === 'state-corrupt') writeFileSync(f.paths.project, '{');
    else if (mutation === 'handoff-missing') rmSync(f.stateNow().current_handoff);
    else f.patch(s => {
      if (mutation === 'report-missing') delete s.review_reports;
      if (mutation === 'report-corrupt') s.review_reports[0].session_digest = 'broken';
      if (mutation === 'criterion-missing') s.evidence.builder = [];
      if (mutation === 'criterion-unknown') s.evidence.builder[0].status = 'unknown';
      if (mutation === 'revision') { s.goal_revision++; s.contract = { ...s.contract, goal_revision: s.goal_revision }; s.contracts.push(s.contract); }
      if (mutation === 'criteria-change') s.contract.success_criteria[0].instruction += ' Changed.';
      if (mutation === 'evidence-change') s.evidence.builder[0].id = 'replacement-proof';
      if (mutation === 'publication-incomplete') s.publication.phase = 'pushed';
      if (mutation === 'model-reuse') s.model_history.push({ run_id: 'reused-model', model: s.reviewer_model, goal_revision: 1 });
    });
    const door = await f.door(); assert.equal(door.checked, true); assert.equal(door.ok, false);
    assert.equal(door.stop, 'autonomous-review-required');
    assert.throws(() => queue(f, admitted.autonomous));
    const report = await runMergeRound({ repoPath: f.cwd, pr: 42, root: f.env.MC_HOME, env: f.env, gh: f.gh,
      autonomous: admitted.autonomous, gate: () => assert.fail('invalid evidence must not reach gate') });
    assert.equal(report.stopped_at, 'autonomous-review-required');
    const legacyDoor = await criteriaDoor({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh: () => ({ status: 1 }) });
    assert.equal(legacyDoor.ok, false, 'durable PR identity survives GitHub/plan failure');
  });
}

test('a clean reviewer cannot replace missing or unknown builder criterion verification', async t => {
  for (const status of ['missing', 'unknown']) {
    const f = await ready(t, { beforeReview: f => {
      const state = f.stateNow();
      if (status === 'missing') state.evidence.builder = [];
      else state.evidence.builder[0].status = 'unknown';
      writeFileSync(f.paths.project, JSON.stringify(state));
    } });
    const door = await f.door(); assert.equal(door.ok, false);
    assert.match(door.problems.join('; '), /premerge criterion/u);
  }
});

for (const finding of ['defect', 'unknown', 'uncertainty']) test(`${finding} review findings do not admit merge`, async t => {
  const result = clean();
  if (finding === 'defect') result.defects.push('Broken behavior.');
  if (finding === 'unknown') result.criteria[0].status = 'unknown';
  if (finding === 'uncertainty') result.uncertainty.push('Cannot establish correctness.');
  const f = await ready(t, { result }); assert.equal((await f.door()).ok, false);
});

for (const kind of ['missing', 'corrupt', 'focused', 'incomplete', 'wrong-tree', 'wrong-revision', 'limited-coverage', 'configuration']) {
  test(`${kind} gate evidence refuses autonomous admission`, async t => {
    const f = await ready(t); const path = receiptPath(f);
    if (kind === 'missing') rmSync(path);
    else if (kind === 'corrupt') writeFileSync(path, '{');
    else {
      const receipt = JSON.parse(readFileSync(path));
      if (kind === 'focused') receipt.coverage.kind = 'named';
      if (kind === 'incomplete') receipt.execution.tests.finished = false;
      if (kind === 'wrong-tree') receipt.tree = 'a'.repeat(40);
      if (kind === 'wrong-revision') receipt.goal_revision++;
      if (kind === 'limited-coverage') receipt.coverage.files = ['other.test.js'];
      if (kind === 'configuration') receipt.configuration = 'stale';
      writeFileSync(path, JSON.stringify(receipt));
    }
    const door = await f.door(); assert.equal(door.ok, false, kind);
  });
}

test('new commits, even equal-tree commits, invalidate the published head', async t => {
  const f = await ready(t); const admitted = await f.door();
  git(f.cwd, 'commit', '--allow-empty', '-qm', 'New head'); git(f.cwd, 'push', '-q', 'origin', f.project);
  assert.equal((await f.door({ expected: admitted.autonomous })).ok, false);
});

test('related/unknown main movement needs new review; proven identical integration content reuses it independently of gate delta', async t => {
  for (const path of ['implementation.js', 'shared.js', 'docs/technical/shared.md', 'docs/project/another-goal/note.md', 'empty']) {
    const f = await ready(t); const admitted = await f.door(); assert.equal(admitted.ok, true, admitted.problems.join('; '));
    moveMain(f, path); const door = await f.door({ expected: admitted.autonomous });
    assert.equal(door.ok, path === 'empty', door.problems.join('; '));
    if (door.ok) assert.deepEqual(door.autonomous, admitted.autonomous);
  }
  const f = await ready(t); const assignment = f.stateNow().contract;
  assert.equal(reviewRelevance({ paths: ['docs/project/other/note.md'], assignment, reviewedFiles: ['implementation.js'] }), 'unknown', 'namespace separation is not proof of semantic independence');
  assert.equal(reviewRelevance({ paths: ['docs/project/other/note.md'], assignment: { ...assignment, documents: [{ path: 'docs/project/other/note.md' }] }, reviewedFiles: ['implementation.js'] }), 'review-required');
  assert.equal(reviewRelevance({ paths: [], assignment, reviewedFiles: [] }), 'unknown');
  assert.equal(reviewRelevance({ fromTree: 'a'.repeat(40), toTree: 'a'.repeat(40) }), 'unrelated');
});

for (const change of ['head', 'criteria', 'report', 'receipt', 'related-main', 'unrelated-main']) test(`${change} during a green gate is checked again before the pinned squash`, async t => {
  const f = await ready(t); const admitted = await f.door();
  const outcome = await round(f, { ticket: admitted.autonomous, duringGate: () => {
    if (change === 'head') { git(f.cwd, 'commit', '--allow-empty', '-qm', 'Another head'); git(f.cwd, 'push', '-q', 'origin', f.project); }
    if (change === 'criteria') f.patch(s => { s.contract.success_criteria[0].instruction += ' Changed.'; });
    if (change === 'report') f.patch(s => { s.review_reports[0].clean = false; });
    if (change === 'receipt') rmSync(receiptPath(f));
    if (change.endsWith('-main')) moveMain(f, change === 'unrelated-main' ? 'empty' : 'shared.js');
  } });
  assert.equal(outcome.merged, change === 'unrelated-main', outcome.report.reason || change);
  if (change !== 'unrelated-main') assert.equal(outcome.report.ok, false);
});

test('docs, admin and imported docs doors cannot bypass even a clean autonomous review', async t => {
  const f = await ready(t); const gh = args => { assert.notEqual(args[1], 'merge'); return f.gh(args); };
  for (const flag of ['--docs', '--admin']) {
    const code = await mergeCommand(['memoro-cli', '42', flag], { root: f.root, env: f.env, gh,
      resolveRepoPath: () => f.cwd, stdout: f.deps.stdout, stderr: f.deps.stderr, measure: () => assert.fail('no docs shortcut') });
    assert.equal(code, 1);
  }
  assert.equal((await runDocsMerge({ repoPath: f.cwd, pr: 42, root: f.root, env: f.env, gh,
    measure: () => assert.fail('no direct docs shortcut') })).stopped_at, 'autonomous-review-required');
  let queued = false;
  assert.equal(await mergeCommand(['memoro-cli', '42'], { root: f.root, env: f.env, gh,
    resolveRepoPath: () => f.cwd, prFiles: () => ['docs/note.md'], stdout: f.deps.stdout, stderr: f.deps.stderr,
    gate: () => { queued = true; return 0; }, runDocsMerge: () => assert.fail('automatic docs route must use leased merger') }), 0);
  assert.equal(queued, true);
});

test('missing or damaged restarted queue IDs refuse while legacy PRs retain notChecked behavior', async t => {
  const f = await ready(t); const admitted = await f.door();
  for (const ticket of [null, {}, { ...admitted.autonomous, gate_run: 'old-gate' }]) {
    const outcome = await round(f, { ticket }); assert.equal(outcome.merged, false); assert.equal(outcome.report.stopped_at, 'autonomous-review-required');
  }
  const door = await autonomousMergeDoor({ root: f.root, repoPath: f.cwd, pr: 99,
    gh: () => ({ status: 0, stdout: JSON.stringify({ headRefName: 'legacy', body: '' }) }) });
  assert.deepEqual(door, { checked: false, ok: true, problems: [] });
  const markerRoot = join(f.root, 'runner', 'autonomous-prs');
  const directory = join(markerRoot, readdirSync(markerRoot)[0]);
  writeFileSync(join(directory, readdirSync(directory)[0]), '{');
  assert.equal((await f.door()).ok, false, 'corrupt registry is not a legacy escape');
});

test('merger passes persisted IDs into restarted rounds rather than silently rebuilding admission', async t => {
  const f = await ready(t); const admitted = await f.door(); queue(f, admitted.autonomous);
  const job = parseQueue(readFileSync(mergesPath(f.root), 'utf8'))[0]; let seen;
  await landJob(job, { root: f.root, say() {}, sleep: async () => {}, gh: f.gh,
    readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }),
    mergeRound: async options => { seen = options.autonomous; return { ok: false, stopped_at: 'autonomous-review-required', reason: 'fixture stop' }; },
    recordStart() {}, record() {} });
  assert.deepEqual(seen, admitted.autonomous);
});

// Outcomes are input to plan, never builder ownership or implicit confirmation.

const route = (f, extra = {}) => routeAutonomousReview({ root: f.root, programme: f.programme, project: f.project,
  repoPath: f.cwd, env: f.env, gh: f.gh, start: () => ({ pid: null, started: false }), ...extra });
const jobsOf = f => { try { return parseQueue(readFileSync(mergesPath(f.root), 'utf8')); } catch { return []; } };
const jobDeps = f => ({ root: f.root, say() {}, sleep: async () => {}, gh: f.gh,
  readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }), recordStart() {}, record() {} });

test('clean report automatically queues and lands once through the existing merger, without confirming or archiving', async t => {
  const f = await ready(t); const report = f.stateNow().review_reports[0];
  assert.equal(f.stateNow().plan_events.filter(e => e.type === 'review-reported').length, 1);
  completeAutonomousReview(f.options, { status: 0 });
  assert.equal((await route(f)).queued, true);
  assert.equal((await route(f)).queued, false); assert.equal(jobsOf(f).length, 1);
  const state = f.stateNow(); assert.equal(state.phase, 'landing'); assert.equal(state.confirmed, false);
  assert.equal(state.evidence.builder.some(e => e.criterion_id === 'integration' && e.status === 'verified'), false);
  const [job] = jobsOf(f);
  const [outcome] = await landJob(job, { ...jobDeps(f), mergeRound: async () => (await round(f, { ticket: job.autonomous })).report });
  assert.equal(outcome.landed, true); assert.equal(f.stateNow().phase, 'landed');
  const final = f.stateNow(); assert.equal(final.confirmed, false); assert.equal(final.evidence.confirmation, null);
  assert.equal(final.landing.binding.report_id, report.id);
  assert.equal(final.plan_events.filter(e => e.type === 'merge-landed').length, 1, 'round + merger replay share one identity');
  recordMergeOutcome({ root: f.root, job, report: outcome.report }); assert.deepEqual(f.stateNow(), final);
  assert.equal(archiveDue({ record: { plan: final.contract }, entry: { steps: [{ status: 'done' }] }, nowMs: Date.now() }).due, false);
});

for (const kind of ['finding', 'unknown', 'uncertainty']) test(`${kind} stays with plan, no automatic merge or build`, async t => {
  const result = clean();
  if (kind === 'uncertainty') result.uncertainty.push('Unable to measure integration.'); else result.criteria[0].status = kind;
  const f = await ready(t, { result }); const before = f.stateNow();
  assert.equal((await route(f)).queued, false); assert.equal(jobsOf(f).length, 0);
  assert.equal(f.stateNow().phase, 'plan_pending'); assert.deepEqual(f.stateNow().runs, before.runs);
  assert.equal(autonomousChoice({ root: f.root, record: { plan: before.contract, programme: f.programme, project: f.project, repo: 'memoro-cli' }, capability: { review: true } }).kind, null);
});

for (const movement of ['head', 'related-main', 'unknown-main', 'identical-main']) test(`${movement} between report and routing is rechecked`, async t => {
  const f = await ready(t);
  if (movement === 'head') { git(f.cwd, 'commit', '--allow-empty', '-qm', 'Moved head'); git(f.cwd, 'push', '-q', 'origin', f.project); }
  else moveMain(f, movement === 'identical-main' ? 'empty' : movement === 'related-main' ? 'implementation.js' : 'docs/other.md');
  const routed = await route(f); assert.equal(routed.queued, movement === 'identical-main');
  if (!routed.queued) {
    assert.equal(f.stateNow().phase, 'plan_pending'); assert.equal(jobsOf(f).length, 0);
    assert.equal(f.stateNow().plan_events.at(-1).type, 'merge-refused');
    const final = f.stateNow(); await route(f); assert.deepEqual(f.stateNow(), final);
  }
});

test('a crash after report or queue intent resumes routing without another review or build session', async t => {
  for (const gap of ['report', 'queue-intent']) await t.test(gap, async t => {
    const f = await ready(t); const before = f.stateNow();
    if (gap === 'queue-intent') {
      const ticket = (await f.door()).autonomous;
      recordAutonomousMergeEvent(f.root, f.programme, f.project,
        { binding: reportBinding(before.review_reports[0]), type: 'merge-queued', ticket });
    }
    const record = { plan: before.contract, project: f.project, programme: f.programme, repo: 'memoro-cli' };
    assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).routing, true);
    assert.equal(await runAutonomousBuild({ root: f.root, record, repo: { name: 'memoro-cli', path: f.cwd }, worktree: f.cwd,
      capability: { review: true }, deps: { env: f.env, gh: f.gh, startMerger: () => ({ pid: null, started: false }) },
      say() {}, routeClass: () => assert.fail('routing never buys another model session') }), 'ran');
    assert.equal(jobsOf(f).length, 1); assert.deepEqual(f.stateNow().runs, before.runs);
    assert.equal(f.stateNow().plan_events.filter(e => e.type === 'merge-queued').length, 1);
  });
});

test('a crash after landing but before its event uses GitHub readback, never another merge', async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  const gh = () => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', baseRefName: 'main',
    mergeCommit: { oid: 'b'.repeat(40) }, headRefOid: job.autonomous.head }) });
  const before = f.stateNow();
  const [outcome] = await landJob(job, { ...jobDeps(f), gh, mergeRound: () => assert.fail('already landed') });
  assert.equal(outcome.landed, true); assert.equal(f.stateNow().phase, 'landed'); assert.equal(f.stateNow().confirmed, false);
  const final = f.stateNow(); await landJob(job, { ...jobDeps(f), gh }); assert.deepEqual(f.stateNow(), final);
  // The same recovery covers a direct round's durable intent without a queue row.
  f.patch(state => { state.phase = before.phase; state.merge_handoff = before.merge_handoff; state.plan_events = before.plan_events; delete state.landing; });
  rmSync(mergesPath(f.root));
  assert.match((await route(f, { gh })).reason, /read back/u); assert.equal(f.stateNow().phase, 'landed');
  assert.equal(jobsOf(f).length, 0);
});

test('a late old-revision outcome is retained without overwriting the current assignment or completion', async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  f.patch(state => { state.goal_revision++; state.contract = { ...state.contract, goal_revision: state.goal_revision }; state.contracts.push(state.contract); state.phase = 'plan_pending'; delete state.landing; });
  recordMergeOutcome({ root: f.root, job, report: { ok: true, merged: true, merged_into: 'main', merge_commit: 'b'.repeat(40) } });
  assert.equal(f.stateNow().phase, 'plan_pending'); assert.equal(f.stateNow().landing, undefined);
  assert.equal(f.stateNow().plan_events.at(-1).binding.goal_revision, 1);
});


test('trusted runner routes a completed clean independent session without another approval/model session', async t => {
  const f = await ready(t, { review: false }); let sessions = 0; let slots = 0;
  const adapter = await import('../../src/adapters/claude-code.js');
  const state = f.stateNow(); const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: state.contract };
  assert.equal(await runAutonomousReview({ root: f.root, record, repo: { name: 'memoro-cli', path: f.cwd }, worktree: f.cwd,
    lane: 0, pid: process.pid, paths: { currentFor: () => join(f.root, 'current.json') },
    deps: { env: f.env, gh: f.gh, exists: () => true, mkdir() {}, startMerger: () => ({ pid: null }),
      role: () => ({ overlay: 'review' }), launch: () => ({ ok: true, id: 'claude-code', adapter, spec: { bin: 'fixture' } }),
      session: async call => {
        sessions++; assert.equal(slots, 1); assert.notEqual(call.cwd, f.cwd); assert.equal(call.env.MC_AUTONOMOUS_ROLE, 'review');
        const current = f.stateNow(); mutateAutonomousProject(f.root, f.programme, f.project, 'report', clean(),
          { actor: current.active_run, revision: current.revision });
        reviewSpawn(call.reviewProcess.options);
        return { ...reviewCompletion, stdout: '', stderr: '' };
      } },
    routeClass: () => ({ ok: true, candidate: state.reviewer_model }),
    waitForSlot: async () => { slots++; return 'ok'; }, dropSlot: () => { slots--; },
    writeJson() {}, remove() {}, stamp: () => 'now', say() {}, observeResult() {} }), 'ran');
  assert.equal(sessions, 1); assert.equal(slots, 0); assert.equal(jobsOf(f).length, 1);
  assert.equal(f.stateNow().phase, 'landing'); assert.equal(f.stateNow().confirmed, false);
});

test('outcome persistence unavailable after landing retains the queue job until readback can be recorded', async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  const saved = readFileSync(f.paths.project, 'utf8'); writeFileSync(f.paths.project, '{');
  const gh = () => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', baseRefName: 'main',
    headRefOid: job.autonomous.head, mergeCommit: { oid: 'd'.repeat(40) } }) });
  await assert.rejects(landJob(job, { ...jobDeps(f), gh, mergeRound: () => assert.fail('already landed') }));
  assert.equal(jobsOf(f).length, 1, 'no queue cleanup before durable plan event');
  writeFileSync(f.paths.project, saved);
  const [answer] = await landJob(job, { ...jobDeps(f), gh, mergeRound: () => assert.fail('already landed') });
  assert.equal(answer.landed, true); assert.equal(f.stateNow().phase, 'landed');
  assert.equal(f.stateNow().plan_events.filter(e => e.type === 'merge-landed').length, 1);
});


for (const mergeReply of ['merged', 'unknown']) test(`a lost merge reply with ${mergeReply} readback is an explicit plan outcome`, async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  const outcome = await round(f, { ticket: job.autonomous, mergeReply });
  assert.equal(outcome.merged, true, 'the fixture accepted the pinned merge, but its reply was lost');
  assert.equal(outcome.report.ok, mergeReply === 'merged');
  assert.equal(f.stateNow().phase, mergeReply === 'merged' ? 'landed' : 'plan_pending');
  assert.equal(f.stateNow().plan_events.at(-1).type, mergeReply === 'merged' ? 'merge-landed' : 'merge-unknown');
  assert.equal(f.stateNow().confirmed, false);
});

for (const damage of ['missing-report', 'changed-report', 'damaged-ticket']) test(`${damage} still records a red outcome for plan, never authority`, async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  if (damage === 'missing-report') f.patch(state => { state.review_reports = []; });
  if (damage === 'changed-report') f.patch(state => { state.review_reports[0].reference += '-changed'; });
  if (damage === 'damaged-ticket') job.autonomous = {};
  const [answer] = await landJob(job, { ...jobDeps(f), mergeRound: async () => ({ ok: false, stopped_at: 'autonomous-review-required', reason: damage }) });
  assert.equal(answer.landed, false); assert.equal(f.stateNow().phase, 'plan_pending');
  assert.equal(f.stateNow().plan_events.at(-1).type, 'merge-failed'); assert.equal(f.stateNow().confirmed, false);
  if (damage !== 'damaged-ticket') assert.equal(f.stateNow().plan_events.at(-1).binding_verified, false);
});

test('a damaged autonomous queue cannot acquire legacy stack/step repair ownership', async t => {
  const f = await ready(t); await route(f); const [job] = jobsOf(f);
  job.parent = { pr: 1, sha: 'a'.repeat(40) }; job.step = { project: 'legacy', index: 0 };
  const [answer] = await landJob(job, { ...jobDeps(f), moveOntoMain: () => assert.fail('never rewrite the autonomous branch'),
    mergeRound: () => assert.fail('legacy ownership must be refused'), mayMend: () => assert.fail('no mend') });
  assert.equal(answer.landed, false); assert.equal(answer.mending, undefined); assert.equal(f.stateNow().phase, 'plan_pending');
  assert.equal(f.stateNow().plan_events.at(-1).details.stopped_at, 'autonomous-review-required');
});
