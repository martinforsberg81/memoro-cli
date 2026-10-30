/** The acceptance scenarios of the autonomous programme, end to end, on real
 * temporary repositories (`autonomy-lifecycle-fixture.js`). What is asserted is
 * what an operator could observe — git trees on the origin, PR numbers, queue
 * rows, merges, planner deliveries and programme state — not the reducers. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, test } from 'node:test';
import { goalCompletion } from '../../src/mc/goal-followup.js';
import { mutateAutonomousProject } from '../../src/mc/autonomous-state.js';
import { programmeStatus } from '../../src/mc/programme-status.js';
import { setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { archiveDue } from '../../src/mc/project-archive.js';
import { builderModels, independentModel } from '../../src/mc/autonomous-models.js';
import { CONTROL_CAPABILITIES } from '../../src/mc/programme-control.js';
import { observeProjectSessionControl } from '../../src/mc/autonomous-state.js';
import { mainIncidentHold, projectRecovery, readProgrammeIncidents } from '../../src/mc/programme-recovery.js';
import { groupAlive, sessionGitDir } from '../../src/mc/session-recovery.js';
import { releaseGateLock, takeGateLock } from '../../src/mc/gate-lock.js';
import { mergesPath } from '../../src/mc/merge-queue.js';
import { streamSession } from '../../src/mc/run.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { autonomousMergeDoor } from '../../src/mc/autonomous-pr.js';
import { recordAutonomousMergeEvent } from '../../src/mc/autonomous-state.js';
import { reportBinding } from '../../src/mc/autonomous-outcomes.js';
import { completeAutonomousReview } from '../../src/mc/autonomous-review.js';
import { recordReviewTerminal } from '../../src/mc/autonomous-review-process.js';
import { reviewCompletion } from './autonomous-review-process-fixture.js';
import { programmeWorld, cleanReview, findings, goal, git, closedSession, deferred, never,
  PROGRAMME, PROJECT, CRITERIA, COMPLETION } from './autonomy-lifecycle-fixture.js';

const supported = { capabilities: { supported: [...CONTROL_CAPABILITIES] } };
// One premerge and one after-integration criterion: one session reaches review.
const SHORT = [CRITERIA[0], CRITERIA[2]];
const FIRST = { 'first.js': 'export const first = 1;\n' };

/** Started programme, one ready goal with SHORT criteria. */
async function opened(t, options) {
  const w = programmeWorld(t, options);
  assert.equal((await w.start()).code, 0);
  await w.open(PROJECT, { success_criteria: SHORT });
  return w;
}
/** A measured follow-up on landed main, without a confirmation transition. */
function measure(w, plan, id = 'integration-measured', deps = {}) {
  const state = w.state();
  return mutateAutonomousProject(w.root, PROGRAMME, PROJECT, 'follow-up', { id, criterion_id: 'installed',
    goal_revision: state.goal_revision, integrated_sha: state.landing.merge_commit, reference: 'measurements/main#installed', outcome: 'passed' },
    { actor: plan.actor, token: plan.lease.token, revision: state.revision, ...deps });
}
function followUp(w, runId = 'plan-follow-up') {
  w.scan();
  const plan = w.plan(runId);
  assert.match(w.show('main', 'first.js'), /first = 1/u);
  if (goalCompletion(w.state()).pending_follow_ups.length) measure(w, plan);
  plan.finish();
}
/** What a recovered delivery must look like, whatever crashed on the way. */
function deliveredOnce(w) {
  const state = w.state();
  assert.equal(w.hub.created(), 1, 'one PR');
  assert.deepEqual(w.hub.merges.map(item => [item.pr, item.head]), [[1, state.publication.head]], 'one merge, of the published head');
  assert.equal(w.tree('main'), w.tree(state.publication.head));
  assert.equal(state.phase, 'landed'); assert.equal(state.follow_up_observations.length, 1);
  assert.deepEqual(goalCompletion(state).pending_follow_ups, []);
  assert.equal(state.runs.filter(run => run.role === 'step').length, 1, 'no second builder');
  assert.equal(state.runs.filter(run => run.role === 'review').length, 1, 'no second review');
  assert.equal(state.plan_events.filter(item => item.type === 'merge-landed').length, 1);
}

test('one goal runs from a deliberate start to its planned stop: fresh sessions, findings to plan, one PR, exact-head landing, measured follow-up, archive', async t => {
  const w = programmeWorld(t);
  assert.equal(w.programme().planner_jobs, undefined, 'nothing is started by installing or approving');
  assert.equal((await w.start()).code, 0);
  assert.equal(w.programme().planner_jobs.mode, 'active');

  // Plan alone creates the goal: criteria, no prescribed steps.
  await w.open();
  assert.equal(w.state().phase, 'ready'); assert.equal(w.state().contract.steps, undefined);

  // Session 1 completes a criterion past the soft bound: it closes, gates green,
  // pushes and opens the goal's one PR, and starts no further criterion.
  w.build({ criteria: ['first', 'second'], files: { 'first.js': 'export const first = 1;\n', 'shared.txt': 'project intent\n' } });
  assert.equal(await w.run(), 'ran');
  const [one] = w.builds;
  assert.deepEqual(one.actions, ['finish-session']); assert.deepEqual(one.measured, ['first']);
  assert.equal(one.control.reason, 'criterion-soft-boundary');
  assert.equal(w.state().phase, 'ready'); assert.equal(w.state().active_run, null);
  assert.deepEqual(w.state().ownership, { branch: PROJECT, pr: 1 });
  assert.equal(w.hub.head(PROJECT), git(w.cwd(), 'rev-parse', 'HEAD'));
  assert.equal(w.show(PROJECT, 'first.js'), 'export const first = 1;');

  // Main moves with a conflicting change. The next fresh session integrates it,
  // keeping both intents, before its starting gate and its build.
  w.advanceMain({ 'shared.txt': 'main intent\n' });
  const order = [];
  w.capability.integrateConflicts = async ({ conflicts, worktree }) => {
    order.push('integrate'); assert.deepEqual(conflicts, ['shared.txt']);
    writeFileSync(join(worktree, 'shared.txt'), 'project intent\nmain intent\n');
    git(worktree, 'add', 'shared.txt'); git(worktree, 'commit', '-qm', 'Keep both intents');
  };
  w.capability.gate = async () => { order.push('gate'); return 0; };
  w.build({ criteria: ['second'], files: { 'second.js': 'export const second = () => 1;\n' }, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  const two = w.builds[1];
  assert.deepEqual(order, ['integrate', 'gate']);
  assert.notEqual(two.run_id, one.run_id); assert.equal(two.prompt.previous.handoff.run_id, one.run_id);
  assert.equal(w.state().phase, 'review_ready'); assert.equal(w.hub.created(), 1, 'the same PR');
  assert.equal(w.show(PROJECT, 'shared.txt'), 'project intent\nmain intent');
  git(w.remote, 'merge-base', '--is-ancestor', 'main', PROJECT);

  // Independent review, on another model in its own checkout, finds a defect:
  // a report to plan, never a merge, a repair or another build.
  const reviewed = w.hub.head(PROJECT);
  w.review(findings('second() ignores the first behaviour.'));
  assert.equal(await w.run(), 'ran');
  assert.equal(w.state().phase, 'plan_pending'); assert.equal(w.jobs().length, 0); assert.equal(w.hub.merges.length, 0);
  assert.equal(w.reviews[0].head, reviewed); assert.equal(w.hub.head(PROJECT), reviewed, 'review changed nothing');
  assert.ok(independentModel(w.reviews[0].model, builderModels(w.state())));
  assert.equal(w.next(w.record()), null, 'nothing runs until plan decides');

  w.scan();
  let status = programmeStatus(w.root, PROGRAMME, supported);
  assert.equal(status.goals[0].evidence.quality, 'review findings for plan');
  assert.deepEqual(status.goals[0].review.findings, ['second() ignores the first behaviour.']);
  assert.equal(status.goals[0].next_action, 'planner unavailable — no headless queue consumer is wired here');
  assert.ok(status.plan.pending_events >= 1);
  let plan = w.plan('plan-review');
  assert.ok(plan.events().includes('review'));
  const resume = plan.intent('resume-project');
  assert.throws(() => plan.apply(resume), /review findings require/u);
  plan.cancel(resume.id, 'Revise the goal with the review finding.');
  plan.decide('revise-project', PROJECT, { ...w.state().contract, goal_revision: w.state().goal_revision + 1,
    instruction: ['Repair second() so it keeps the first behaviour, and remeasure every criterion.'] });
  plan.decide('resume-project'); plan.finish();
  assert.equal(w.state().phase, 'ready'); assert.deepEqual(w.state().ownership, { branch: PROJECT, pr: 1 });

  // Revision 2 is rebuilt on the same branch and PR: both criteria inside the
  // soft bound, then closed by the upper bound, with a new gate.
  w.build({ criteria: ['first', 'second'], pace: 40, upper: 200, outcome: 'review-ready',
    files: { 'second.js': 'import { first } from \'./first.js\';\nexport const second = () => first;\n' } });
  assert.equal(await w.run(), 'ran');
  const three = w.builds[2];
  assert.deepEqual(three.actions, ['continue', 'continue', 'finish-session']); assert.equal(three.control.reason, 'upper-boundary');
  assert.equal(w.state().phase, 'review_ready'); assert.equal(w.hub.created(), 1); assert.equal(w.gates.length, 3);
  assert.equal(three.prompt.previous, null, 'a revised goal starts from its assignment, not the old handoff');
  const head = w.hub.head(PROJECT);

  // A clean review of that head enters the existing merge queue once.
  w.review(cleanReview());
  assert.equal(await w.run(), 'ran');
  assert.equal(w.state().phase, 'landing'); assert.equal(w.jobs().length, 1);
  assert.equal(w.jobs()[0].autonomous.head, head); assert.equal(w.jobs()[0].pr, 1);
  let archived = await w.archive();
  assert.equal(archived.code, 1); assert.match(archived.err, /without verified landing \(landing\)/u);

  // The merger lands exactly the reviewed head; execution is done at landing.
  const outcome = await w.land();
  assert.equal(outcome.landed, true, JSON.stringify(outcome.report));
  assert.deepEqual(w.hub.merges.map(item => [item.pr, item.head]), [[1, head]]);
  assert.equal(w.tree('main'), w.tree(head), 'main holds the reviewed tree');
  assert.equal(w.state().phase, 'landed'); assert.equal(w.state().confirmed, false);
  archived = await w.archive();
  assert.equal(archived.code, 1); assert.match(archived.err, /pending follow-ups \(installed\)/u);
  assert.equal(archiveDue({ record: w.record(), entry: { steps: [{ status: 'done' }] }, nowMs: Date.now() }).due, false);

  // Integration is measured separately, without reopening execution or confirming.
  w.scan();
  plan = w.plan('plan-follow-up');
  assert.ok(plan.events().includes('landed'));
  assert.match(w.show('main', 'second.js'), /=> first/u);
  measure(w, plan);
  assert.equal(w.state().phase, 'landed');
  assert.deepEqual(goalCompletion(w.state()).pending_follow_ups, []);

  // The planned stop: nothing starts beyond it, without the operator's explicit on.
  plan.stop(); plan.finish();
  status = programmeStatus(w.root, PROGRAMME, supported);
  assert.equal(status.mode, 'stopped'); assert.equal(status.autonomy.reached.stop, 'design-review');
  assert.equal(status.autonomy.enabled, true, 'a reached stop keeps the preference');
  assert.match(status.next_action, /planned stop design-review reached/u);
  assert.equal(w.next(w.record()), null);
  assert.throws(() => setProgrammeJobMode({ root: w.root, programme: PROGRAMME, revision: w.programme().revision }, { mode: 'active' }), /foreground planning restart/u);
  assert.equal(w.builds.length, 3); assert.equal(w.reviews.length, 2);

  // Programme records stay until the explicit programme archive, which takes them whole.
  const programmeDir = join(w.root, 'programs', PROGRAMME);
  assert.ok(existsSync(join(programmeDir, 'PROGRAMME_STATE.json')));
  archived = await w.archive();
  assert.equal(archived.code, 0, archived.err);
  assert.equal(existsSync(programmeDir), false);
  const kept = join(w.root, 'archive', 'programs', PROGRAMME);
  assert.equal(JSON.parse(readFileSync(join(kept, 'PROGRAMME_STATE.json'), 'utf8')).planner_jobs.stop, 'design-review');
  assert.deepEqual(goalCompletion(JSON.parse(readFileSync(join(kept, PROJECT, 'AUTONOMOUS_STATE.json'), 'utf8'))).pending_follow_ups, []);
});

for (const exit of ['red-gate', 'forced-exit']) test(`closing mid-criterion with a ${exit} keeps the work for plan and claims no green`, async t => {
  const w = await opened(t);
  if (exit === 'red-gate') w.gateHook = async () => 1;
  w.build({ criteria: [], upper: 200, files: { 'first.js': 'half of the first behaviour\n' },
    ...(exit === 'red-gate' ? { crash: () => COMPLETION }
      : { publish: false, exit: { ...COMPLETION, normal_exit: false, interrupted: true, reason: 'emergency-boundary' } }) });
  assert.equal(await w.run(), 'ran');
  const [session] = w.builds;
  // The upper bound closes the session with no criterion done and grants no new work.
  assert.equal(session.control.reason, 'upper-boundary'); assert.deepEqual(session.actions, ['finish-session']);
  if (exit === 'red-gate') assert.match(session.error, /did not complete green/u);
  const state = w.state();
  assert.equal(state.phase, 'plan_pending');
  assert.deepEqual(state.attempts.map(item => item.outcome), ['incomplete']);
  assert.equal(state.publication?.gate_run, undefined, 'no green receipt is claimed');
  assert.equal(state.current_handoff, null);
  assert.equal(w.hub.created(), 0); assert.equal(w.hub.head(PROJECT), null, 'nothing pushed');
  assert.equal(git(w.cwd(), 'status', '--porcelain'), '?? first.js', 'the unsent work is preserved');
  assert.equal(readFileSync(join(w.cwd(), 'first.js'), 'utf8'), 'half of the first behaviour\n');
  // It goes to plan, and nothing else starts it again.
  assert.equal(w.next(w.record()), null);
  w.scan();
  assert.ok(w.plan('plan-diagnose').events().includes('failure'));
});

// The synthetic transport of session-observation.test.js: it reads the durable
// finish-session action and ignores it, and ignores SIGTERM too.
const IGNORING = fileURLToPath(new URL('./fixtures/session-process.js', import.meta.url));
const LIVE = { soft_active_ms: 500, upper_active_ms: 1000, emergency_active_ms: 2000, reserve_active_ms: 500,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 800, tool_wait_ms: 2500, lane_wait_ms: 2500, total_awake_ms: 4000,
  no_progress_ms: 10000, max_stagnant_sessions: 3, max_failures: 3 };
for (const mode of ['ignores-closure', 'telemetry-lost']) test(`a real process that ${mode === 'ignores-closure' ? 'ignores closure is stopped at the emergency bound' : 'loses its clock is stopped'}, and is never green`, { timeout: 60000 }, async t => {
  const w = await opened(t, { profile: LIVE });
  const ready = join(w.root, 'ready'); const closing = join(w.root, 'closing.json');
  // Wall time is real; awake time starts once the process is listening, so a
  // cold start under load is not mistaken for work. The budgets are not relaxed.
  const began = Date.now(); let activeStart = null;
  w.capability.clock = () => {
    const now = Date.now();
    if (activeStart === null && existsSync(ready)) activeStart = now;
    if (activeStart === null && now - began > 20000) throw new Error('fixture did not become ready');
    if (mode === 'telemetry-lost' && activeStart !== null && now - activeStart > 200) throw new Error('clock unavailable');
    return { at_ms: now - began, awake_ms: activeStart === null ? 0 : now - activeStart };
  };
  w.capability.pollMs = 20;
  let pid = null;
  t.after(() => { if (pid && groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } });
  w.scripts.step.push(call => streamSession({ ...call, bin: process.execPath, args: [IGNORING, 'codex'], prompt: null,
    env: { ...w.env, ...call.env, MC_TEST_STATE: join(w.root, 'programs', PROGRAMME, PROJECT, 'AUTONOMOUS_STATE.json'),
      MC_TEST_ROOT: w.root, MC_TEST_CLOSING: closing, MC_TEST_READY: ready },
    onSpawn: value => { pid = value; }, autonomous: { ...call.autonomous, tool: 'codex', termMs: 100 } }));
  assert.equal(await w.run(), 'ran');
  assert.ok(pid); assert.equal(groupAlive(pid), false, 'the whole process group is gone');
  if (mode === 'ignores-closure') assert.equal(JSON.parse(readFileSync(closing, 'utf8')).next_action, 'finish-session');
  const state = w.state();
  assert.equal(state.phase, 'plan_pending');
  assert.deepEqual(state.attempts.map(item => item.outcome), ['incomplete']);
  assert.equal(state.publication, undefined); assert.equal(state.current_handoff, null);
  assert.equal(state.session_control.result.normal_exit, false);
  assert.equal(state.session_control.context.quality, 'unknown', 'no context reading is unknown, never zero');
  assert.equal(w.hub.created(), 0); assert.equal(w.hub.head(PROJECT), null);
});

test('a long valid gate keeps its lane and its builder: no second builder, no recovery, no early stop', async t => {
  const w = await opened(t);
  const lane = { root: w.env.MC_HOME, lane: 'light', repo: 'memoro-cli', pid: process.pid };
  const seen = {};
  w.gateHook = async call => {
    // The gate worker holds its lane reservation and its checkout's gate lock.
    assert.equal(takeGateLock(lane).ok, true);
    const lock = join(sessionGitDir(call.cwd), 'mc-gate.json');
    writeJsonAtomic(lock, { pid: process.pid });
    try {
      // Long, but inside the gate bound: gate time, not active work.
      let state = w.state(); const actor = state.active_run;
      for (const awake of [160, 220, 265]) {
        state = observeProjectSessionControl(w.root, PROGRAMME, PROJECT, { actor, revision: state.revision,
          observation: { sequence: state.session_control.observation.sequence + 1, at_ms: 1000 + awake, awake_ms: awake,
            activity: { kind: 'gate', id: 'publication-gate' }, context: null, progress: null, failure: null } });
      }
      seen.control = state.session_control;
      seen.lane = takeGateLock({ ...lane, pid: 1 }).ok;
      seen.other = await w.another().runStep(PROJECT, w.world(w.record()));
      seen.next = w.next(w.record());
    } finally {
      rmSync(lock, { force: true });
      releaseGateLock(lane);
    }
    return undefined;
  };
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  assert.equal(seen.control.phase, 'closing'); assert.equal(seen.control.totals.gate_ms, 105);
  assert.equal(seen.lane, false, 'nobody else takes the lane while the gate runs');
  assert.equal(seen.other, 'skipped:autonomous-owned'); assert.equal(seen.next, null);
  assert.equal(w.builds.length, 1);
  assert.equal(w.state().phase, 'review_ready'); assert.equal(w.hub.created(), 1);
  assert.equal(w.state().publication.gate_run, 'gate-1');
  assert.equal(takeGateLock(lane).ok, true, 'the lane is free once the gate has ended'); releaseGateLock(lane);
});

/** `stateDeps` that die at a publication phase write, before it is durable. */
const dieAt = phase => ({ write(file, state) {
  if (state.publication?.phase === phase) throw new Error(`process died at ${phase}`);
  writeJsonAtomic(file, state);
} });
async function reviewCrash(w, boundary) {
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  const died = deferred();
  w.review(cleanReview(SHORT), { after: call => {
    const options = call.reviewProcess.options;
    recordReviewTerminal(options, reviewCompletion);
    if (boundary === 'report') assert.throws(() => completeAutonomousReview(options, null,
      { record: () => { throw new Error('review state write lost'); } }), /review state write lost/u);
    died.resolve(); return never();
  } });
  w.run(); await died.promise;
  assert.equal(w.state().phase, 'reviewing'); assert.ok(w.state().active_run);
  w.restart(); assert.equal(await w.run(), 'ran');
  const state = w.state();
  assert.equal(state.review_reports.length, 1); assert.equal(state.evidence.reviews.length, 1);
  assert.equal(state.plan_events.filter(e => e.type === 'review-reported').length, 1);
  assert.equal(state.plan_events.filter(e => e.type === 'merge-queued').length, 1); assert.equal(w.jobs().length, 1);
  w.restart(); assert.equal(w.next(w.record()), null);
  assert.match(await w.run(), /^skipped:/u); assert.deepEqual(w.state(), state); assert.equal(w.jobs().length, 1);
}
const CRASHES = {
  'after review terminal persistence': w => reviewCrash(w, 'terminal'),
  'after report persistence before review owner release': w => reviewCrash(w, 'report'),
  // The model's finish dies after the push, before it is recorded; then the runner dies.
  'after push': async w => {
    const died = deferred();
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready', publicationDeps: { stateDeps: dieAt('pushed') },
      crash: (error, session) => { closedSession(w, PROJECT, session.cwd); died.resolve(); return never(); } });
    w.run(); await died.promise;
    assert.equal(w.hub.head(PROJECT), git(w.cwd(), 'rev-parse', 'HEAD'), 'the commit reached the origin');
    w.restart();
    assert.equal(await w.run(), 'ran');
  },
  // GitHub opened the PR, its answer was lost; then the runner died.
  'after PR creation': async w => {
    const died = deferred();
    const lost = args => (args[1] === 'create' ? (w.hub.gh(args), { ok: false, status: 1, stdout: '', stderr: 'response lost' }) : w.hub.gh(args));
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready', publicationDeps: { publishDeps: { ...w.publication.publishDeps, gh: lost } },
      crash: (error, session) => { closedSession(w, PROJECT, session.cwd); died.resolve(); return never(); } });
    w.run(); await died.promise;
    assert.equal(w.hub.prs.length, 1);
    w.restart();
    assert.equal(await w.run(), 'ran');
  },
  // The review report is durable; the runner dies before routing it.
  'after the review report': async w => {
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
    assert.equal(await w.run(), 'ran');
    const died = deferred();
    w.hub.hang(args => args[1] === 'view' && args.at(-1) === 'number,state,headRefName,headRefOid,baseRefName,body', () => died.resolve());
    w.review(cleanReview(SHORT));
    w.run(); await died.promise;
    assert.equal(w.state().review_reports.length, 1); assert.equal(w.jobs().length, 0);
    w.restart();
    assert.equal(await w.run(), 'ran');
  },
  // The runner dies after recording the merge intent, before the queue row:
  // the intent is written here by the writer queueMerge uses first.
  'after the queue intent': async w => {
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
    assert.equal(await w.run(), 'ran');
    const died = deferred();
    w.hub.hang(args => args[1] === 'view' && args.at(-1) === 'number,state,headRefName,headRefOid,baseRefName,body', () => died.resolve());
    w.review(cleanReview(SHORT));
    w.run(); await died.promise;
    const door = await autonomousMergeDoor({ root: w.root, repoPath: w.primary, pr: 1, env: w.env, gh: w.hub.gh });
    assert.equal(door.ok, true, door.problems.join('; '));
    recordAutonomousMergeEvent(w.root, PROGRAMME, PROJECT, { binding: reportBinding(w.state().review_reports.at(-1)),
      type: 'merge-queued', ticket: door.autonomous });
    assert.equal(w.state().phase, 'landing'); assert.equal(w.jobs().length, 0);
    w.restart();
    assert.equal(await w.run(), 'ran');
    assert.equal(w.jobs().length, 1);
    assert.equal(w.state().plan_events.filter(item => item.type === 'merge-queued').length, 1);
  },
  // GitHub merged; the merger dies before recording the landing.
  'after the merge': async w => {
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
    assert.equal(await w.run(), 'ran');
    w.review(cleanReview(SHORT));
    assert.equal(await w.run(), 'ran');
    const died = deferred();
    w.hub.hang(args => args[1] === 'merge', args => { w.hub.gh(args); died.resolve(); });
    w.land(); await died.promise;
    assert.equal(w.hub.merges.length, 1); assert.equal(w.state().phase, 'landing');
  },
  // The follow-up is durable; plan dies before acknowledging its delivery.
  'after the follow-up measurement': async w => {
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
    assert.equal(await w.run(), 'ran');
    w.review(cleanReview(SHORT));
    assert.equal(await w.run(), 'ran');
    assert.equal((await w.land()).landed, true);
    w.scan();
    const plan = w.plan('plan-dies');
    assert.throws(() => measure(w, plan, 'measured-once', { write: (file, value) => {
      writeJsonAtomic(file, value); throw new Error('plan died');
    } }), /plan died/u);
    assert.deepEqual(goalCompletion(w.state()).pending_follow_ups, []);
    w.scan({ alive: () => false });
    const next = w.plan('plan-replays');
    assert.deepEqual(goalCompletion(w.state()).pending_follow_ups, []); next.finish();
    assert.equal(w.state().follow_up_observations.length, 1);
  },
};
// Each world is its own temporary root and origin: the cases run side by side.
describe('a crash at each external and persistence boundary', { concurrency: 3 }, () => {
  for (const [boundary, crash] of Object.entries(CRASHES)) it(`${boundary} recovers to one PR, one merge and one measured follow-up`, async t => {
    const w = await opened(t);
    await crash(w);
    if (w.state().phase === 'review_ready') { w.review(cleanReview(SHORT)); assert.equal(await w.run(), 'ran'); }
    if (w.state().phase === 'landing') assert.equal((await w.land()).landed, true);
    if (w.state().phase === 'landed') followUp(w);
    deliveredOnce(w);
  });
});

test('an unknown abandoned review is delivered to plan once across runner restarts and retains its checkout owner', async t => {
  const w = await opened(t);
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' }); assert.equal(await w.run(), 'ran');
  const died = deferred();
  w.review(cleanReview(SHORT), { after: () => { died.resolve(); return never(); } });
  w.run(); await died.promise;
  const owner = w.state().active_run; const checkout = w.state().review_session.checkout;
  w.restart(); assert.equal(await w.run(), 'ran');
  const state = w.state();
  assert.equal(state.phase, 'plan_pending'); assert.deepEqual(state.active_run, owner);
  assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].role, 'review');
  assert.equal(state.review_reports?.length || 0, 0); assert.equal(w.jobs().length, 0);
  w.restart(); assert.equal(await w.run(), 'ran'); assert.deepEqual(w.state(), state);
  assert.equal(w.state().review_session.checkout, checkout); assert.equal(w.reviews.length, 1);
  w.scan(); assert.ok(w.plan('plan-review-recovery').events().includes('failure'));
});

const MOVES = {
  // An empty main commit leaves the integration tree as reviewed: the review stands.
  unrelated: w => w.advanceMain({}),
  related: w => w.advanceMain({ 'first.js': 'main rewrote the reviewed file\n' }),
  unknown: w => { mkdirSync(join(w.primary, 'docs'), { recursive: true }); w.advanceMain({ 'docs/other.md': 'another goal\n' }); },
  'new head': w => { git(w.cwd(), 'commit', '--allow-empty', '-qm', 'After review'); git(w.cwd(), 'push', '-q', 'origin', PROJECT); },
  'damaged ownership': w => {
    const dir = join(w.root, 'runner', 'autonomous-prs');
    const repo = join(dir, readdirSync(dir)[0]);
    writeFileSync(join(repo, readdirSync(repo)[0]), '{');
  },
};
describe('main or head movement and damaged ownership after a clean review', { concurrency: 3 }, () => {
  for (const [move, apply] of Object.entries(MOVES)) it(`${move} change after review ${move === 'unrelated' ? 'keeps the review and lands the reviewed head' : 'refuses merge and goes to plan'}`, async t => {
    const w = await opened(t);
    w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
    assert.equal(await w.run(), 'ran');
    const reviewed = w.hub.head(PROJECT);
    w.review(cleanReview(SHORT), { after: () => apply(w) });
    assert.equal(await w.run(), 'ran');
    if (move === 'unrelated') {
      assert.equal(w.jobs().length, 1);
      assert.equal((await w.land()).landed, true);
      assert.deepEqual(w.hub.merges.map(item => item.head), [reviewed]);
      return;
    }
    assert.equal(w.jobs().length, 0); assert.equal(w.hub.merges.length, 0);
    assert.equal(w.state().phase, 'plan_pending'); assert.equal(w.state().confirmed, false);
    // A head that moved under the review voids the report itself; the others are refused at the door.
    if (move === 'new head') assert.equal(w.state().review_reports.at(-1).clean, false);
    assert.equal(w.state().plan_events.at(-1).type, move === 'new head' ? 'review-reported' : 'merge-refused');
    // The refusal is plan's; a second pass neither queues nor builds.
    assert.equal(await w.run(), 'skipped:autonomous-not-ready');
    assert.equal(w.jobs().length, 0); assert.equal(w.builds.length, 1);
    w.scan();
    assert.ok(w.plan('plan-refusal').events().includes(move === 'new head' ? 'review' : 'failure'));
  });
});

test('one red main becomes one incident and one repair for every affected goal; waits and stagnation outlive sessions', async t => {
  const w = programmeWorld(t);
  assert.equal((await w.start()).code, 0);
  const goals = ['alpha-goal', 'beta-goal'];
  const plan = w.plan('plan-goals');
  for (const project of goals) {
    plan.apply({ id: `create-${project}`, kind: 'create-project', project, expected_revision: 0,
      input: goal(project, { success_criteria: SHORT }) });
    plan.decide('send-project', project); plan.decide('resume-project', project);
  }
  plan.finish();
  const red = { ok: false, merged: false, stopped_at: 'red', reason: 'tests/shared.test.js fails on main',
    main_red: { red_on_main: ['tests/shared.test.js'] } };
  for (const project of goals) {
    w.build({ project, criteria: ['first'], files: { [`${project}.js`]: 'export {};\n' }, outcome: 'review-ready' });
    assert.equal(await w.run(project), 'ran');
    w.review(cleanReview(SHORT), { project });
    assert.equal(await w.run(project), 'ran');
    assert.equal((await w.land(project, { round: red })).landed, false);
    assert.equal(w.state(project).phase, 'plan_pending');
  }
  assert.deepEqual(w.hub.prs.map(item => [item.number, item.branch]), [[1, 'alpha-goal'], [2, 'beta-goal']], 'one branch and PR per goal');
  w.scan(); w.scan();
  const [incident] = readProgrammeIncidents(w.root);
  assert.equal(readProgrammeIncidents(w.root).length, 1); assert.equal(incident.owner, PROGRAMME);
  assert.deepEqual(incident.dependents.map(item => item.project).sort(), goals);
  for (const project of goals) {
    assert.equal(mainIncidentHold(w.root, PROGRAMME, project).id, incident.id);
    assert.equal(w.next(w.record(project)), null);
  }
  const repairPlan = w.plan('plan-repair');
  const repair = { id: 'repair-shared', kind: 'main-repair', project: 'shared-repair', expected_revision: 0,
    incident: incident.id, basis: { criteria: ['first'], reference: 'decisions/repair-scope' },
    input: goal('shared-repair', { success_criteria: SHORT }) };
  repairPlan.apply(repair); repairPlan.apply(repair);
  assert.throws(() => repairPlan.apply({ ...repair, id: 'repair-again', project: 'another-repair',
    input: { ...repair.input, project_id: 'another-repair' } }), /already has one repair/u);
  repairPlan.cancel('repair-again', 'Both goals wait on the one repair.');
  repairPlan.decide('send-project', 'shared-repair'); repairPlan.decide('resume-project', 'shared-repair');
  // A planner quota wait holds new planner claims, not already sent goals.
  const until = Date.now() + 1000;
  repairPlan.apply({ id: 'wait-quota', kind: 'wait-programme', condition: 'provider-quota',
    reference: 'diagnosis/quota', wait: { kind: 'quota', reason: 'Provider quota exhausted.', until } });
  repairPlan.finish();
  assert.equal(w.programme().planner_jobs.mode, 'waiting');
  assert.equal(w.next(w.record('shared-repair')).name, 'shared-repair');
  w.scan({ now: until + 1 });
  assert.equal(w.programme().planner_jobs.mode, 'active');
  // Two fresh repair sessions end without progress: the count survives the new
  // conversation, and plan cannot send the same failed approach again.
  const retry = (plan, approach) => plan.intent('diagnose-project', 'shared-repair', { action: 'retry',
    attempt_ids: projectRecovery(w.state('shared-repair')).attempt_ids,
    diagnosis: 'The repair session ended without a measured criterion.', approach });
  for (let n = 1; n <= 2; n++) {
    w.build({ project: 'shared-repair', criteria: [], publish: false });
    assert.equal(await w.run('shared-repair'), 'ran');
    assert.equal(w.state('shared-repair').phase, 'plan_pending');
    assert.equal(projectRecovery(w.state('shared-repair')).no_progress, n);
    w.scan({ now: until + 1 });
    const diagnose = w.plan(`plan-diagnose-${n}`);
    if (n === 2) { assert.throws(() => diagnose.apply(retry(diagnose, 'rerun-the-repair')), /repeated unsuccessful approach/u); break; }
    diagnose.apply(retry(diagnose, 'rerun-the-repair')); diagnose.decide('resume-project', 'shared-repair'); diagnose.finish();
  }
  const sessions = w.builds.filter(item => item.project === 'shared-repair').map(item => item.run_id);
  assert.equal(new Set(sessions).size, 2, 'two fresh sessions');
  assert.equal(w.hub.merges.length, 0);
});
