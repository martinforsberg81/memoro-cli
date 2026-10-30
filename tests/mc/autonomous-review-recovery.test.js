import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ready, clean, moveMain } from './autonomous-merge-fixture.js';
import { git } from './autonomous-publication-fixture.js';
import { prepareAutonomousReview, reviewCheckoutFingerprint } from '../../src/mc/autonomous-review.js';
import { beginReviewProcess, readReviewProcess, reviewProcessPaths, streamReviewSession } from '../../src/mc/autonomous-review-process.js';
import { recoverAutonomousReview } from '../../src/mc/autonomous-review-recovery.js';
import { mutateAutonomousProject } from '../../src/mc/autonomous-state.js';
import { autonomousBuildClaim } from '../../src/mc/autonomous-recovery.js';
import { autonomousChoice, runAutonomousBuild } from '../../src/mc/autonomous-run.js';
import { readClaim, releaseClaim, takeClaim } from '../../src/mc/resource-claim.js';
import { sessionGitDir } from '../../src/mc/session-recovery.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';

const PROCESS = fileURLToPath(new URL('./fixtures/autonomous-review-recovery-process.js', import.meta.url));
async function started(t, { submit = true } = {}) {
  const f = await ready(t, { review: false });
  const session = prepareAutonomousReview(f.options).review_session;
  if (submit) mutateAutonomousProject(f.root, f.programme, f.project, 'report', clean(),
    { actor: f.options.actor, revision: f.stateNow().revision });
  return { ...f, session };
}
function crash(f, boundary, mode) {
  const result = spawnSync(process.execPath, [PROCESS, JSON.stringify({ ...f.options, checkout: f.session.checkout }), boundary, ...(mode ? [mode] : [])],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}
const recover = f => recoverAutonomousReview(f.options, { gh: f.gh });
const jobs = f => existsSync(mergesPath(f.root)) ? parseQueue(readFileSync(mergesPath(f.root), 'utf8')) : [];
function dispatch(f, extra = {}) {
  let slots = 0;
  return runAutonomousBuild({ root: f.root,
    record: { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.stateNow().contract },
    repo: { name: 'memoro-cli', path: f.cwd }, worktree: f.cwd, lane: 0, pid: process.pid,
    paths: { currentFor: () => join(f.root, 'current-recovery.json') }, capability: { review: true },
    deps: { exists: existsSync, env: f.env, gh: f.gh, startMerger: () => ({ pid: null, started: false }) },
    waitForSlot: async () => { slots++; return 'ok'; }, dropSlot: () => { assert.equal(--slots, 0); },
    writeJson: (path, current) => {
      assert.equal(slots, 1); assert.equal(current.kind, 'review'); assert.equal(current.flavor, 'autonomous-review-recovery');
      assert.equal(readClaim(autonomousBuildClaim(f.options)).pid, process.pid);
      assert.equal(current.worktree, f.session.checkout);
    }, remove() {}, stamp: () => 'now', say() {}, routeClass: () => assert.fail('recovery must not buy a model session'), ...extra });
}

for (const boundary of ['terminal', 'report', 'state']) test(`${boundary} crash: repeated runner restart records one report and hands off one merge`, async t => {
  const f = await started(t); crash(f, boundary);
  const builder = reviewCheckoutFingerprint(f.cwd); const checkout = reviewCheckoutFingerprint(f.session.checkout);
  const paths = reviewProcessPaths(f.options); const manifest = readFileSync(paths.manifest, 'utf8');
  const savedReport = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : null;
  if (boundary === 'report') assert.ok(readClaim(paths.claim), 'crash leaves its generation-bound process claim behind');
  assert.equal(await dispatch(f), 'ran');
  const state = f.stateNow();
  assert.equal(state.review_reports.length, 1); assert.equal(state.review_reports[0].clean, true);
  assert.equal(state.evidence.reviews.length, 1); assert.equal(state.active_run, null);
  assert.equal(state.plan_events.filter(e => e.type === 'review-reported').length, 1);
  assert.equal(state.plan_events.filter(e => e.type === 'merge-queued').length, 1); assert.equal(jobs(f).length, 1);
  assert.deepEqual(await recover(f), state);
  assert.match(await dispatch(f), /^skipped:/u);
  assert.deepEqual(f.stateNow(), state); assert.equal(jobs(f).length, 1);
  assert.equal(readFileSync(paths.manifest, 'utf8'), manifest);
  assert.equal(readClaim(paths.claim), null);
  if (savedReport) assert.equal(readFileSync(paths.report, 'utf8'), savedReport);
  assert.equal(reviewCheckoutFingerprint(f.cwd), builder); assert.equal(reviewCheckoutFingerprint(f.session.checkout), checkout);
});

for (const failure of ['before-spawn', 'spawn-intent', 'missing-spawn-intent', 'missing-terminal', 'no-result', 'tools', 'no-submission', 'missing-manifest', 'corrupt-fact', 'foreign-generation', 'unknown-claim', 'malformed-claim']) test(`${failure} stays incomplete or unknown for plan, never merge`, async t => {
  const f = await started(t, { submit: failure !== 'no-submission' }); const paths = reviewProcessPaths(f.options);
  if (!['before-spawn', 'missing-manifest', 'unknown-claim'].includes(failure)) crash(f, failure === 'spawn-intent' ? failure : 'terminal',
    ['no-result', 'tools'].includes(failure) ? failure : undefined);
  if (failure === 'missing-terminal') rmSync(paths.terminal);
  if (failure === 'missing-spawn-intent') rmSync(paths.spawn_intent);
  if (failure === 'missing-manifest') rmSync(paths.manifest);
  if (failure === 'corrupt-fact') writeFileSync(paths.terminal, '{');
  if (failure === 'foreign-generation') {
    const fact = JSON.parse(readFileSync(paths.terminal)); writeFileSync(paths.terminal, JSON.stringify({ ...fact, generation: 'foreign' }));
  }
  if (failure === 'unknown-claim') mkdirSync(paths.claim);
  const malformed = failure === 'malformed-claim' ? takeClaim(paths.claim,
    { pid: 0, generation: readReviewProcess(f.options).manifest.generation, run_id: f.options.actor.run_id }) : null;
  assert.equal(await dispatch(f), 'ran'); const state = f.stateNow();
  assert.equal(state.phase, 'plan_pending'); assert.equal(jobs(f).length, 0);
  assert.ok(!state.review_reports?.some(report => report.clean));
  if (['before-spawn', 'no-result', 'no-submission'].includes(failure)) {
    assert.equal(state.active_run, null); assert.equal(state.review_reports.length, 1);
  } else {
    assert.deepEqual(state.active_run, f.options.actor); assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].outcome, 'incomplete'); assert.equal(state.attempts[0].role, 'review');
    assert.deepEqual(await recover(f), state, 'unknown retries do not multiply attempts');
    if (malformed) assert.equal(readClaim(paths.claim).marker, malformed.marker, 'an invalid PID cannot prove the old claim dead');
  }
});

for (const mutation of ['tracked', 'ignored', 'source', 'remote-head', 'pr-base', 'pr-unknown', 'assignment', 'sent-assignment', 'base', 'evidence']) test(`${mutation} after report persistence cannot adopt the old clean report`, async t => {
  const f = await started(t); crash(f, 'report'); const paths = reviewProcessPaths(f.options);
  const report = readFileSync(paths.report, 'utf8');
  if (mutation === 'tracked') writeFileSync(join(f.session.checkout, 'implementation.js'), 'review mutation\n');
  if (mutation === 'ignored') {
    writeFileSync(join(f.root, 'excludes'), 'ignored\n'); git(f.session.checkout, 'config', 'core.excludesFile', join(f.root, 'excludes'));
    writeFileSync(join(f.session.checkout, 'ignored'), 'ignored review mutation\n');
  }
  if (mutation === 'source') writeFileSync(join(f.cwd, 'implementation.js'), 'unsent builder bytes\n');
  if (mutation === 'remote-head') git(f.remote, 'update-ref', `refs/heads/${f.project}`, f.session.base);
  if (mutation === 'pr-base') { const gh = f.gh; f.gh = args => { const result = gh(args); return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), baseRefName: 'other' }) }; }; }
  if (mutation === 'pr-unknown') f.gh = () => ({ status: 1 });
  if (mutation === 'assignment') f.patch(state => { state.contract.goal_revision++; state.goal_revision++; });
  if (mutation === 'sent-assignment') {
    const path = join(f.paths.projectDir, 'PLAN.json'); const sent = JSON.parse(readFileSync(path)); sent.goal_revision++;
    writeFileSync(path, JSON.stringify(sent));
  }
  if (mutation === 'base') f.patch(state => { state.review_session.base = state.review_session.head; });
  if (mutation === 'evidence') f.patch(state => { state.evidence.builder[0].reference = 'changed evidence'; });
  const source = reviewCheckoutFingerprint(f.cwd); const checkout = reviewCheckoutFingerprint(f.session.checkout);
  assert.equal(await dispatch(f), 'ran'); const state = f.stateNow();
  assert.deepEqual(state.active_run, f.options.actor); assert.equal(state.phase, 'plan_pending');
  assert.equal(state.review_reports?.length || 0, 0); assert.equal(state.attempts.length, 1); assert.equal(jobs(f).length, 0);
  assert.deepEqual(await recover(f), state); assert.equal(readFileSync(paths.report, 'utf8'), report);
  assert.equal(reviewCheckoutFingerprint(f.cwd), source); assert.equal(reviewCheckoutFingerprint(f.session.checkout), checkout);
});

test('recovered clean evidence still uses the existing conservative current-main admission', async t => {
  const f = await started(t); crash(f, 'report'); moveMain(f, 'implementation.js');
  assert.equal(await dispatch(f), 'ran');
  assert.equal(f.stateNow().review_reports.length, 1); assert.equal(jobs(f).length, 0);
  assert.equal(f.stateNow().plan_events.filter(event => event.type === 'merge-refused').length, 1);
});

test('a live fixture group, a live supervisor claim and a successor generation cannot be taken over', async t => {
  const f = await started(t); beginReviewProcess(f.options); let child;
  const result = streamReviewSession({ bin: process.execPath, args: ['-e',
    'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"turn.completed"})))'], cwd: f.session.checkout,
    reviewProcess: { options: f.options, tool: 'codex' },
    spawn: (bin, args, options) => { child = spawn(bin, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); return child; } });
  const closed = once(child, 'close');
  try {
    const before = f.stateNow(); assert.deepEqual(await recover(f), before);
    const path = reviewProcessPaths(f.options).claim; const claim = readClaim(path); releaseClaim(path, claim.marker);
    assert.deepEqual(await recover(f), before, 'group observation keeps ownership even without supervisor claim');
  } finally { child.stdin.end(); await result; await closed; }
  const path = reviewProcessPaths(f.options).claim;
  const successor = takeClaim(path, { pid: 2147483647, generation: 'successor', run_id: 'successor' });
  assert.equal(successor.ok, true);
  await recover(f); assert.equal(readClaim(path).marker, successor.marker); assert.deepEqual(f.stateNow().active_run, f.options.actor);
  releaseClaim(path, successor.marker);
  assert.equal((await recover(f)).review_reports[0].clean, true, 'late proven closure can settle the still-owned run');
});

for (const gate of ['live', 'unknown']) test(`${gate} review gate keeps the old review owned despite a persisted terminal and report`, async t => {
  const f = await started(t); crash(f, 'report');
  writeFileSync(join(sessionGitDir(f.session.checkout), 'mc-gate.json'), JSON.stringify({ pid: gate === 'live' ? process.pid : 2147483647 }));
  const state = await recover(f); assert.equal(state.phase, 'plan_pending'); assert.deepEqual(state.active_run, f.options.actor);
  assert.equal(state.review_reports?.length || 0, 0); assert.equal(state.attempts.length, 1); assert.equal(jobs(f).length, 0);
});

test('owned review selection stays inactive without the injected capability and respects the shared project claim', async t => {
  const f = await started(t); const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.stateNow().contract };
  const choose = capability => autonomousChoice({ root: f.root, record, capability, worktree: f.cwd });
  assert.equal(choose(null).kind, null); assert.equal(choose({}).kind, null); assert.equal(choose({ review: true }).recovery, true);
  record.plan = structuredClone(record.plan); record.plan.goal_revision++;
  assert.equal(choose({ review: true }).recovery, true, 'owned review recovery diagnoses a changed sent assignment instead of hiding the owner');
  const held = takeClaim(autonomousBuildClaim(f.options), { pid: process.pid });
  try { assert.equal(choose({ review: true }).reason, 'autonomous-owned'); }
  finally { releaseClaim(autonomousBuildClaim(f.options), held.marker); }
});
