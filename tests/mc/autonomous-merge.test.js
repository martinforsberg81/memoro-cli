import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewer } from './autonomous-state-fixture.js';
import { createAutonomousDraft, currentAutonomousEvidence, mutateAutonomousProject, mutateProgramme, readProgrammeState } from '../../src/mc/autonomous-state.js';
import { autonomousPrOwner } from '../../src/mc/autonomous-pr.js';
import { autonomousProof } from '../../src/mc/autonomous-merge.js';
import { criteriaDoor } from '../../src/mc/merge-boundary.js';
import { parseQueue, mergesPath, markLanding } from '../../src/mc/merge-queue.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';
import { recordMergeOutcome, reviewRoutePending } from '../../src/mc/autonomous-outcomes.js';
import { clean, ready, queue, round } from './autonomous-merge-fixture.js';

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
