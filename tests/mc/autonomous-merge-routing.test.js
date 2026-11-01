import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './autonomous-publication-fixture.js';
import { reviewCompletion, reviewSpawn } from './autonomous-review-process-fixture.js';
import { completeAutonomousReview } from '../../src/mc/autonomous-review.js';
import { mutateAutonomousProject, recordAutonomousMergeEvent } from '../../src/mc/autonomous-state.js';
import { landJob } from '../../src/mc/merger.js';
import { parseQueue, mergesPath } from '../../src/mc/merge-queue.js';
import { routeAutonomousReview, reportBinding, recordMergeOutcome } from '../../src/mc/autonomous-outcomes.js';
import { autonomousChoice, runAutonomousBuild, runAutonomousReview } from '../../src/mc/autonomous-run.js';
import { archiveDue } from '../../src/mc/project-archive.js';
import { clean, ready, queue, moveMain, round } from './autonomous-merge-fixture.js';

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
