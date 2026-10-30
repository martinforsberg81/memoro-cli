/** A v1 project with fixed steps beside an autonomous programme, in one runner
 * on one real repository (`autonomy-lifecycle-fixture.js`). V1 keeps its
 * selection, prompt, plan and merge door; the programme runs only after a
 * deliberate start, and pause or a planned stop never touches v1 work. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunner } from '../../src/mc/run.js';
import { AUTONOMOUS_EXECUTION_ENABLED } from '../../src/mc/autonomous-project.js';
import { createAutonomousDraft, mutateAutonomousProject, mutateProgramme, readAutonomousState, releaseProgrammeRun,
  reserveProgrammeRun, sendAutonomousProject } from '../../src/mc/autonomous-state.js';
import { autonomousMergeDoor } from '../../src/mc/autonomous-pr.js';
import { reconcileProgrammeQueue } from '../../src/mc/programme-jobs.js';
import { programmeStatus } from '../../src/mc/programme-status.js';
import { programmeContract } from './autonomy-fixtures.js';
import { programmeWorld, cleanReview, deferred, goal, git, PROGRAMME, PROJECT, CRITERIA } from './autonomy-lifecycle-fixture.js';

const SHORT = [CRITERIA[0], CRITERIA[2]];
const FIRST = { 'first.js': 'export const first = 1;\n' };

/** A v1 project in the same programme directory: fixed steps, no autonomous state. */
function legacy(w) {
  const plan = { schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['Legacy goal.'], contract: ['Preserve fixed steps.'],
    out_of_scope: ['Autonomous execution.'], success_criteria: [{ met: false, criterion: 'Legacy step runs.', check: 'Inspect fixture.' }],
    documents: [], steps: [{ title: 'Legacy work', status: 'ready', instruction: ['Do legacy work.'], done_when: 'Legacy work is done.' }] };
  const dir = join(w.root, 'programs', PROGRAMME, 'legacy'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'PLAN.json'); const bytes = JSON.stringify(plan);
  writeFileSync(path, bytes);
  return { project: 'legacy', programme: PROGRAMME, repo: 'memoro-cli', path, plan, bytes };
}
async function started(t) {
  const w = programmeWorld(t);
  assert.equal((await w.start()).code, 0);
  w.open(PROJECT, { success_criteria: SHORT });
  return w;
}
const pause = w => w.cli(['pause', PROGRAMME, '--by', 'Martin']);
const resume = w => w.cli(['resume', PROGRAMME, '--expected-revision', String(w.programme().revision), '--by', 'Martin']);

test('a v1 project and a v2 goal share one runner and its lane cap; v1 keeps its prompt, plan and merge door', async t => {
  const w = await started(t); const v1 = legacy(w);
  w.deps.laneCount = () => ({ per_repo: 2, total: 1 });
  const building = deferred(); const release = deferred();
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready', during: async () => { building.resolve(); await release.promise; } });
  const v2 = w.runner.runStep(PROJECT, w.world(w.record(), v1));
  await building.promise;
  const current = JSON.parse(readFileSync(w.runner.paths.currentFor('memoro-cli'), 'utf8'));
  assert.equal(current.flavor, 'autonomous'); assert.equal(current.run_id, w.state().active_run.run_id);
  // The v1 step waits for the one slot the v2 build holds.
  const old = w.runner.runStep('legacy', w.world(w.record(), v1), { lane: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.legacy.length, 0); assert.equal(w.sleeps.length, 1);
  release.resolve(); assert.equal(await v2, 'ran');
  w.sleeps[0](); assert.equal(await old, 'ran');
  assert.equal(w.legacy.length, 1);
  // V1 is launched as it always was: its fixed step, no autonomous role or assignment.
  const [call] = w.legacy;
  assert.ok(call.prompt.includes('Legacy work'));
  assert.equal(call.env?.MC_AUTONOMOUS_ROLE, undefined); assert.equal(call.autonomous, undefined);
  assert.equal(w.builds[0].prompt.assignment.version, 2);
  assert.equal(readFileSync(v1.path, 'utf8'), v1.bytes, 'the v1 plan is not rewritten');
  assert.equal(w.state().phase, 'review_ready'); assert.equal(w.hub.created(), 1);
  // The programme's status names the v1 project and leaves it alone.
  assert.deepEqual(programmeStatus(w.root, PROGRAMME).legacy, ['legacy']);
  // A v1 PR keeps the legacy merge door: not checked by the autonomous one.
  w.hub.gh(['pr', 'create', '--head', 'legacy', '--base', 'main', '--title', 'Legacy work', '--body', 'Fixed step.']);
  assert.deepEqual(await autonomousMergeDoor({ root: w.root, repoPath: w.primary, pr: 2, env: w.env, gh: w.hub.gh }), { checked: false, ok: true, problems: [] });
  const goalDoor = await autonomousMergeDoor({ root: w.root, repoPath: w.primary, pr: 1, env: w.env, gh: w.hub.gh });
  assert.equal(goalDoor.checked, true); assert.equal(goalDoor.ok, false, 'the goal is not reviewed yet');
});

test('nothing activates an existing programme: status, reconciliation, a capability-less runner and an unsupported start leave it inactive while v1 runs', async t => {
  const w = programmeWorld(t); const v1 = legacy(w);
  // A goal sent before any start, the way the inactive contract verbs allow.
  const planner = { run_id: 'plan-before-start', role: 'plan' };
  reserveProgrammeRun(w.root, PROGRAMME, planner, w.programme().revision);
  let state = createAutonomousDraft(w.root, PROGRAMME, PROJECT, goal(PROJECT, { success_criteria: SHORT }), { actor: planner, revision: w.programme().revision });
  state = sendAutonomousProject(w.root, PROGRAMME, PROJECT, { actor: planner, revision: state.revision });
  mutateAutonomousProject(w.root, PROGRAMME, PROJECT, 'release', null, { actor: planner, revision: readAutonomousState(w.root, PROGRAMME, PROJECT).revision });
  releaseProgrammeRun(w.root, PROGRAMME, planner, w.programme().revision);
  const agreement = join(w.root, 'programs', PROGRAMME, 'PROGRAMME_STATE.json');

  const status = await w.cli(['status', PROGRAMME, '--json'], { capabilities: undefined });
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).mode, 'inactive'); assert.equal(JSON.parse(status.out).execution.supported, false);
  // The runner's opt-in scan reads the programme and starts nothing.
  assert.deepEqual(reconcileProgrammeQueue(w.root), []);
  assert.equal(w.programme().planner_jobs?.mode ?? 'inactive', 'inactive');
  assert.equal(w.programme().planner_jobs?.lease ?? null, null);
  const before = readFileSync(agreement, 'utf8');
  const refused = await w.start({ capabilities: undefined });
  assert.equal(refused.code, 1); assert.match(refused.err, /not activated in this installation/u);
  assert.equal(readFileSync(agreement, 'utf8'), before, 'a refused start writes nothing');
  assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false); assert.equal(w.programme().execution_enabled, false);

  // The runner as installed passes no autonomous capability: v2 is skipped, v1 runs.
  const installed = createRunner({ deps: w.deps });
  const world = w.world({ ...w.record(), plan: w.state().contract }, v1);
  assert.equal(installed.nextStep({ world }).name, 'legacy');
  assert.equal(await installed.runStep(PROJECT, world), 'skipped:autonomous-disabled');
  assert.equal(await installed.runStep('legacy', world, { lane: 1 }), 'ran');
  assert.equal(w.legacy.length, 1); assert.equal(w.builds.length, 0);
  assert.equal(existsSync(w.cwd()), false); assert.equal(w.hub.created(), 0);
  assert.equal(w.programme().planner_jobs?.mode ?? 'inactive', 'inactive'); assert.equal(w.state().phase, 'plan_pending');
});

test('pause holds new v2 work and merge submission, lets started work finish, never holds v1; resume continues the same PR', async t => {
  const w = await started(t); const v1 = legacy(w);
  // Paused during a build: the build finishes and publishes; nothing new starts.
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready', during: async () => assert.equal((await pause(w)).code, 0) });
  assert.equal(await w.run(), 'ran');
  assert.equal(w.programme().planner_jobs.mode, 'paused');
  assert.equal(w.state().phase, 'review_ready'); assert.equal(w.state().publication.phase, 'handoff_committed');
  const head = git(w.cwd(), 'rev-parse', 'HEAD'); const status = git(w.cwd(), 'status', '--porcelain');
  assert.equal(await w.run(), 'skipped:programme-held');
  assert.equal(w.next(w.record(), v1).name, 'legacy', 'v1 is selected while v2 is held');
  assert.equal(await w.runner.runStep('legacy', w.world(w.record(), v1), { lane: 1 }), 'ran');
  assert.equal(git(w.cwd(), 'rev-parse', 'HEAD'), head); assert.equal(git(w.cwd(), 'status', '--porcelain'), status, 'pause touched no goal checkout');
  assert.equal(w.builds.length, 1); assert.equal(w.reviews.length, 0);

  // Paused during the review: its report is recorded, its clean route is held, not refused.
  assert.equal((await resume(w)).code, 0);
  w.review(cleanReview(SHORT), { after: async () => assert.equal((await pause(w)).code, 0) });
  assert.equal(await w.run(), 'ran');
  assert.equal(w.state().review_reports.at(-1).clean, true);
  assert.equal(w.jobs().length, 0); assert.equal(w.state().plan_events.some(item => item.type === 'merge-refused'), false);
  assert.equal(await w.run(), 'skipped:programme-held');

  // Resumed: the held route is submitted and the same PR lands.
  assert.equal((await resume(w)).code, 0);
  assert.equal(await w.run(), 'ran');
  assert.equal(w.jobs().length, 1);
  assert.equal((await w.land()).landed, true);
  assert.deepEqual(w.hub.merges.map(item => [item.pr, item.head]), [[1, head]]);
  assert.equal(w.hub.created(), 1); assert.equal(w.reviews.length, 1); assert.equal(w.builds.length, 1);
  assert.deepEqual(w.programme().planner_jobs.control.map(item => item.operation), ['start', 'pause', 'resume', 'pause', 'resume']);
});

test('at the planned stop v2 starts nothing while v1 runs on, and a foreground draft changes no active work', async t => {
  const w = await started(t); const v1 = legacy(w);
  w.build({ criteria: ['first'], files: FIRST, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  const defects = ['The design question needs the agreed review.'];
  w.review({ ...cleanReview(SHORT), defects });
  assert.equal(await w.run(), 'ran');
  const report = w.state().review_reports?.at(-1);
  assert.equal(report?.clean, false, w.log.join('\n'));
  assert.deepEqual(report.result.defects, defects);
  assert.deepEqual(report.invalid_reasons, [], 'the planned stop follows valid review findings, not a broken submission');
  const head = w.hub.head(PROJECT); const phase = w.state().phase;
  // Plan answers the review at the agreed design point: the planned stop.
  w.scan();
  const plan = w.plan('plan-stop'); plan.stop(); plan.finish();
  assert.equal(w.programme().planner_jobs.mode, 'stopped');
  assert.equal(await w.run(), 'skipped:programme-held');
  assert.equal(w.next(w.record(), v1).name, 'legacy');
  assert.equal(await w.runner.runStep('legacy', w.world(w.record(), v1), { lane: 1 }), 'ran');
  assert.equal((await pause(w)).code, 1, 'a reached stop is not paused away');
  // The next agreement is drafted in the foreground; the approved one and every goal stay as they are.
  const foreground = { run_id: 'foreground-next', role: 'foreground-plan' };
  reserveProgrammeRun(w.root, PROGRAMME, foreground, w.programme().revision);
  const draft = programmeContract({ status: 'draft', revision: 2, based_on: 1, goal: ['Deliver the next capability.'] }); delete draft.approval;
  mutateProgramme(w.root, PROGRAMME, 'draft', draft, { actor: foreground, revision: w.programme().revision });
  releaseProgrammeRun(w.root, PROGRAMME, foreground, w.programme().revision);
  assert.equal(w.programme().approved.length, 1); assert.equal(w.programme().draft.revision, 2);
  assert.equal(w.programme().planner_jobs.mode, 'stopped');
  assert.equal(w.state().phase, phase); assert.equal(w.hub.head(PROJECT), head);
  assert.equal(await w.run(), 'skipped:programme-held');
  assert.equal(w.builds.length, 1); assert.equal(w.reviews.length, 1); assert.equal(w.legacy.length, 1);
});
