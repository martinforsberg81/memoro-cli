/** Real git/remote state at each crash boundary; GitHub and execution receipts
 * are controlled fixtures, never paid model calls or nested gate processes. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fixture, git, completion, profile } from './autonomous-publication-fixture.js';
import { runnerFixture } from './autonomous-run-fixture.js';
import { builder } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import { autonomousBuildClaim, recoverAutonomousBuild, settlePublishedBuild } from '../../src/mc/autonomous-recovery.js';
import { autonomousChoice, runAutonomousBuild } from '../../src/mc/autonomous-run.js';
import { createRunner } from '../../src/mc/run.js';
import { startAutonomousBuild, mutateAutonomousProject, observeProjectSessionControl } from '../../src/mc/autonomous-state.js';
import { finishAutonomousPublication } from '../../src/mc/autonomous-publish.js';
import { preserveSession, sessionGitDir } from '../../src/mc/session-recovery.js';
import { controlResponse } from '../../src/mc/session-control.js';
import { takeClaim, releaseClaim } from '../../src/mc/resource-claim.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { archiveDue, archivePrograms } from '../../src/mc/project-archive.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { gateConfiguration } from '../../src/mc/gate-greens.js';
import { AUTONOMOUS_PR_MARK } from '../../src/mc/autonomous-pr.js';

const assignment = { success_criteria: [...autonomousProject().success_criteria,
  { id: 'continuation', criterion: 'Another session builds.', instruction: ['Build the next part.'], check: 'mc gate next.test.js', verification: 'premerge' }] };
const continuing = t => fixture(t, { assignment });
function closedSession(f, overrides = {}) {
  const state = f.stateNow();
  const directory = join(f.root, `supervisor-${state.active_run.run_id}`); mkdirSync(directory, { recursive: true });
  const result = { ...completion, signal: null, group_dead: true, ...overrides };
  const snapshot = preserveSession({ cwd: f.cwd, directory, control: state.session_control, telemetry: {}, process: result });
  writeJsonAtomic(join(directory, 'result.json'), { ...result, recovery: { ok: true }, control: controlResponse(state.session_control) });
  writeJsonAtomic(join(sessionGitDir(f.cwd), 'mc-autonomous-session.json'), {
    run_id: state.active_run.run_id, binding: state.session_control.binding, cwd: f.cwd,
    // An impossible positive process group, not a process we signal or reap.
    pid: 2147483647, process_closed: true, snapshot, control_persisted: true,
    unreconciled_tools: false, recovery: { ok: true },
  });
  return { directory, snapshot, result };
}
async function recover(f) {
  const path = autonomousBuildClaim(f.options());
  const held = takeClaim(path, { pid: process.pid, run_id: builder.run_id }); assert.ok(held.ok);
  try { return await recoverAutonomousBuild(f.options(), f.deps); }
  finally { releaseClaim(path, held.marker); }
}
function crashWrite(f, phase, after = false) {
  f.deps.stateDeps = { write(file, state) {
    if (state.publication?.phase === phase) {
      if (after) writeJsonAtomic(file, state);
      throw new Error(`crash at ${phase}`);
    }
    writeJsonAtomic(file, state);
  } };
}
function assertOnePublication(f, state) {
  assert.equal(state.ownership.branch, f.project); assert.equal(state.ownership.pr, 42);
  assert.equal(f.calls.filter(call => call[1] === 'create').length, 1);
  assert.equal(git(f.cwd, 'ls-remote', '--heads', 'origin', f.project).split(/\s+/u)[0], state.publication.head);
  assert.equal(state.publication.phase, 'handoff_committed'); assert.equal(state.confirmed, false);
}

test('crashes before/after commit, push and PR response resume publication, not implementation', async t => {
  for (const [phase, after] of [['started', true], ['gate_verified', false], ['gate_verified', true], ['committed', false], ['committed', true],
    ['pushed', false], ['pushed', true], ['pr_resolved', false], ['pr_resolved', true]]) {
    await t.test(`${phase} ${after ? 'after' : 'before'} state write`, async t => {
      const f = continuing(t); f.edit(); crashWrite(f, phase, after);
      await assert.rejects(f.finish(), /crash at/);
      delete f.deps.stateDeps;
      const saved = closedSession(f); const head = git(f.cwd, 'rev-parse', 'HEAD');
      const recovered = await recover(f);
      assert.equal(recovered.phase, 'ready'); assert.equal(recovered.active_run, null); assertOnePublication(f, recovered);
      assert.equal(f.calls.filter(call => call[0] === 'gate').length, phase === 'gate_verified' && !after ? 2 : 1,
        'only a crash before the gate phase is durable needs a new measurement');
      if (!['started', 'gate_verified'].includes(phase)) assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head, 'no second or empty commit');
      assert.ok(existsSync(join(saved.snapshot, 'checkpoint.json')), 'original immutable snapshot retained');
      assert.deepEqual(await recoverAutonomousBuild(f.options(), f.deps), recovered, 'settlement is idempotent');
    });
  }
});

test('crash after GitHub creates the PR but before its response finds that same PR', async t => {
  const f = continuing(t); f.edit(); const gh = f.gh;
  f.deps.publishDeps.gh = args => {
    const response = gh(args);
    return args[1] === 'create' ? { ok: false, text: 'response lost' } : response;
  };
  await assert.rejects(f.finish(), /publication failed/);
  assert.equal(f.stateNow().publication.pr, null); assert.equal(f.pr().number, 42);
  f.deps.publishDeps.gh = gh; closedSession(f);
  const state = await recover(f); assert.equal(state.phase, 'ready'); assertOnePublication(f, state);
});

test('handoff crashes before pointer, after pointer and after phase write recover exactly once', async t => {
  for (const boundary of ['pointer', 'phase-before', 'phase-after', 'continuation']) {
    await t.test(boundary, async t => {
      const f = continuing(t); f.edit(); await f.finish(); closedSession(f);
      if (boundary === 'pointer') f.deps.handoffDeps = { writeCurrent() { throw new Error('handoff crash'); } };
      else if (boundary !== 'continuation') crashWrite(f, 'handoff_committed', boundary === 'phase-after');
      if (boundary === 'continuation') await f.complete();
      else await assert.rejects(f.complete(), /crash/);
      delete f.deps.handoffDeps; delete f.deps.stateDeps;
      const state = await recover(f); assert.equal(state.phase, 'ready'); assert.equal(state.active_run, null);
      assertOnePublication(f, state);
      const artifact = readFileSync(state.current_handoff, 'utf8');
      await recoverAutonomousBuild(f.options(), f.deps);
      assert.equal(readFileSync(state.current_handoff, 'utf8'), artifact);
    });
  }
});

test('a recovered commit crash before snapshot refresh reconciles the measured descendant and preserves the old snapshot', async t => {
  const f = continuing(t); f.edit(); crashWrite(f, 'gate_verified', true);
  await assert.rejects(f.finish(), /crash/); delete f.deps.stateDeps;
  const saved = closedSession(f); const bytes = readFileSync(join(saved.snapshot, 'checkpoint.json'), 'utf8');
  git(f.cwd, 'add', '-A'); git(f.cwd, 'commit', '-qm', f.input.message);
  const state = await recover(f);
  assert.equal(state.phase, 'ready'); assertOnePublication(f, state);
  assert.equal(readFileSync(join(saved.snapshot, 'checkpoint.json'), 'utf8'), bytes);
  const manifest = JSON.parse(readFileSync(join(sessionGitDir(f.cwd), 'mc-autonomous-session.json'), 'utf8'));
  assert.notEqual(manifest.snapshot, saved.snapshot); assert.ok(manifest.snapshot.startsWith(dirname(saved.snapshot)));
});

test('only published current premerge reports route review-ready; postintegration work does not block it', async t => {
  const f = fixture(t); f.edit(); await f.finish(); closedSession(f);
  const state = await recover(f);
  assert.equal(state.phase, 'review_ready'); assert.equal(state.active_run, null); assertOnePublication(f, state);
  assert.equal(state.evidence.reviews.length, 0); assert.equal(state.evidence.confirmation, null);
  assert.equal(autonomousChoice({ root: f.root, record: { project: f.project, programme: f.programme,
    repo: 'memoro-cli', plan: state.contract }, capability: {}, worktree: f.cwd }).reason, 'autonomous-not-ready');
});

test('remaining criteria launch a fresh bounded session on the same branch/PR; all-done stops at review-ready', async t => {
  const f = continuing(t); f.edit(); await f.finish(); closedSession(f);
  let state = await recover(f); assert.equal(state.phase, 'ready');
  const next = { run_id: 'build-2', role: 'step' };
  state = startAutonomousBuild(f.root, f.programme, f.project, { actor: next, revision: state.revision,
    model: { tool: 'claude', model: 'haiku', effort: 'high' }, reviewer: { tool: 'claude', model: 'opus', effort: 'high' },
    assignment: state.contract, branch: f.project, profile,
    observation: { sequence: 0, at_ms: 2000, awake_ms: 0, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  state = mutateAutonomousProject(f.root, f.programme, f.project, 'progress', { id: 'continuation-proof', criterion_id: 'continuation',
    status: 'verified', reference: 'evidence/continuation.json' }, { actor: next, revision: state.revision });
  state = observeProjectSessionControl(f.root, f.programme, f.project, { actor: next, revision: state.revision,
    observation: { sequence: 1, at_ms: 2200, awake_ms: 200, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  const input = structuredClone(f.input); input.result.run_id = next.run_id; input.result.handoff.run_id = next.run_id;
  input.result.outcome = 'review-ready'; input.result.handoff.interpretation.remaining = [];
  input.result.handoff.evidence.forEach(item => { item.run_id = next.run_id; });
  input.result.handoff.evidence.push({ ...input.result.handoff.evidence[0], criterion_id: 'continuation', reference: 'evidence/continuation.json' });
  const options = { ...f.options(), actor: next, revision: state.revision };
  const head = git(f.cwd, 'rev-parse', 'HEAD');
  await finishAutonomousPublication(options, input, f.deps); closedSession(f);
  state = await settlePublishedBuild(options, completion, f.deps);
  assert.equal(state.phase, 'review_ready'); assert.equal(state.runs.filter(run => run.role === 'step').length, 2);
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head); assertOnePublication(f, state);
});

test('incomplete exits, clean exits without publication and unknown completion become durable plan-pending without losing unsent work', async t => {
  for (const boundary of ['no-intent', 'failed-exit', 'failed-gate', 'missing-manifest', 'changed-content', 'unknown-gate', 'wrong-binding']) {
    await t.test(boundary, async t => {
      const f = continuing(t); f.edit();
      if (boundary !== 'no-intent') await f.finish();
      if (boundary !== 'missing-manifest') closedSession(f, boundary === 'failed-exit' ? { normal_exit: false, interrupted: true } : {});
      if (boundary === 'changed-content') {
        writeFileSync(join(f.cwd, 'implementation.js'), 'staged unsent\n'); git(f.cwd, 'add', 'implementation.js');
        writeFileSync(join(f.cwd, 'unsent.txt'), 'untracked unsent\n');
      }
      if (boundary === 'unknown-gate') writeJsonAtomic(join(sessionGitDir(f.cwd), 'mc-gate.json'), { pid: 2147483647 });
      if (boundary === 'failed-gate') {
        const path = join(sessionGitDir(f.cwd), 'mc-autonomous-session.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.recovery.gate = { code: 1 }; writeJsonAtomic(path, manifest);
        await assert.rejects(f.complete(), /supervisor observed a failed gate/);
      }
      if (boundary === 'wrong-binding') {
        const path = join(sessionGitDir(f.cwd), 'mc-autonomous-session.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.run_id = 'other-run'; writeJsonAtomic(path, manifest);
      }
      const status = git(f.cwd, 'status', '--porcelain'); const staged = git(f.cwd, 'diff', '--cached', '--binary');
      const head = git(f.cwd, 'rev-parse', 'HEAD'); const state = await recover(f);
      assert.equal(state.phase, 'plan_pending'); assert.deepEqual(state.active_run, builder);
      assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].outcome, 'incomplete');
      assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head); assert.equal(git(f.cwd, 'status', '--porcelain'), status);
      assert.equal(git(f.cwd, 'diff', '--cached', '--binary'), staged);
      assert.equal((await recover(f)).attempts.length, 1);
    });
  }
});

test('surviving session, finish and gate owners forbid recovery and cannot release another builder', async t => {
  for (const owner of ['mc-autonomous-session.claim', 'mc-autonomous-finish.claim', 'mc-gate.json']) {
    const f = continuing(t); f.edit(); await f.finish(); closedSession(f);
    const path = join(sessionGitDir(f.cwd), owner);
    const held = owner.endsWith('.claim') ? takeClaim(path, { pid: process.pid }) : null;
    if (!held) writeJsonAtomic(path, { pid: process.pid });
    try {
      const before = f.stateNow(); assert.deepEqual(await recover(f), before);
      assert.deepEqual(f.stateNow().active_run, builder); assert.equal(f.stateNow().current_handoff, null);
    } finally { if (held) releaseClaim(path, held.marker); }
  }
});

test('dispatcher recovers the previous published run without routing or launching implementation, under the shared slot', async t => {
  const f = continuing(t); f.edit(); await f.finish(); closedSession(f);
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: f.stateNow().contract };
  const choice = () => autonomousChoice({ root: f.root, record, capability: {}, worktree: f.cwd });
  assert.equal(choice().recovery, true);
  const path = autonomousBuildClaim(f.options()); const held = takeClaim(path, { pid: process.pid });
  assert.equal(choice().reason, 'autonomous-owned'); releaseClaim(path, held.marker);
  let slots = 0; const currentPath = join(f.root, 'current-recovery.json'); const currents = [];
  const ran = await runAutonomousBuild({ root: f.root, record, repo: { name: 'memoro-cli' }, lane: 0, worktree: f.cwd, pid: process.pid,
    paths: { currentFor: () => currentPath }, stamp: () => '2026-10-28T12:00:00Z',
    writeJson: (path, value) => { currents.push(value); writeJsonAtomic(path, value); }, remove: path => rmSync(path),
    capability: { publication: f.deps }, deps: { env: f.env }, waitForSlot: async () => { slots++; return 'ok'; },
    dropSlot: () => { slots--; }, say() {}, routeClass: () => assert.fail('recovery must not buy another model session') });
  assert.equal(ran, 'ran'); assert.equal(slots, 0); assert.equal(f.stateNow().phase, 'ready');
  assert.equal(currents[0].flavor, 'autonomous-recovery'); assert.equal(currents[0].run_id, builder.run_id);
  assert.equal(currents[0].pid, process.pid); assert.equal(existsSync(currentPath), false);
  assert.equal(f.stateNow().runs.filter(run => run.role === 'step').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'gate').length, 1); assertOnePublication(f, f.stateNow());
});

test('out-of-scope needs-plan attempts stay with plan, never legacy failed-to-person or archive', async t => {
  const f = continuing(t); f.edit();
  const state = mutateAutonomousProject(f.root, f.programme, f.project, 'attempt', {
    id: builder.run_id, reason: 'Needs-plan: requested deployment is outside the approved scope.', commits: [],
  }, { actor: builder, revision: f.stateNow().revision });
  assert.equal((await recover(f)).phase, 'plan_pending');
  const record = { path: join(f.paths.projectDir, 'PLAN.json'), status: 'done', plan: state.contract, project: f.project };
  const entry = { steps: [{ status: 'done', updated: '2020-01-01T00:00:00Z' }], criteria: [] };
  assert.equal(archiveDue({ record, entry, nowMs: Date.now() }).due, false);
  const archived = await archivePrograms({ repo: { name: 'memoro-cli' }, items: [{ record, entry }],
    deps: { read: path => readFileSync(path, 'utf8') } });
  assert.deepEqual(archived.archived, []); assert.equal(archived.held.length, 1);
  assert.equal(existsSync(join(f.paths.projectDir, 'CLOSEOUT.json')), false);
  assert.ok(existsSync(record.path)); assert.equal(git(f.cwd, 'status', '--porcelain'), '?? implementation.js');
});

test('the runner advances two fresh sessions with main movement and never starts review or a duplicate builder', async t => {
  const f = runnerFixture(t, { assignment });
  f.deps.env.MC_HOME = join(f.root, 'mc-home');
  let cwd; let pr = null; let gates = 0; let creates = 0;
  const gh = args => {
    let value;
    if (args[1] === 'list') value = pr ? [{ number: 42, state: 'OPEN', url: 'https://fixture/pull/42' }] : [];
    else if (args[1] === 'create') {
      assert.equal(pr, null); creates++;
      pr = { number: 42, state: 'OPEN', headRefName: f.project, baseRefName: 'main', body: args[args.indexOf('--body') + 1] };
      return { ok: true, status: 0, stdout: 'https://fixture/pull/42' };
    } else if (args[1] === 'edit') { pr.body = args[args.indexOf('--body') + 1]; value = null; }
    else if (args[1] === 'view') value = { ...pr, headRefOid: git(cwd, 'ls-remote', '--heads', 'origin', f.project).split(/\s+/u)[0] };
    else assert.fail(`unexpected GitHub call ${args.join(' ')}`);
    return { ok: true, status: 0, stdout: JSON.stringify(value) };
  };
  const requirements = async () => ({ base: git(cwd, 'rev-parse', 'origin/main'), configuration: gateConfiguration({ select: 'fixture-selector' }),
    selection: { kind: 'affected', files: ['base.test.js'], commands: [], flags: [], pattern: null } });
  f.capability.publication = { requirements, publishDeps: { gh, merge: () => assert.fail('never enqueue merge') },
    stdout: { write() {} }, stderr: { write() {} }, gate: async (args, call) => {
      const required = await requirements(); const candidate = captureWorktree(cwd); gates++;
      const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: `finish-${gates}`, ...call.measurementBinding,
        configuration: required.configuration, candidate, base: required.base }, before: candidate, after: candidate,
        result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
          totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
        started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
      call.stdout.write(JSON.stringify({ evidence: { path: persistGateReceipt({ root: f.deps.env.MC_HOME, receipt }) } })); return 0;
    } };
  f.deps.session = async call => {
    f.calls.push(call); cwd = call.cwd;
    const count = f.calls.length; const actor = f.state().active_run;
    const criterion_id = count === 1 ? 'schema' : 'continuation';
    let state = mutateAutonomousProject(f.root, f.programme, f.project, 'progress', { id: `proof-${count}`, criterion_id,
      status: 'verified', reference: `proof-${count}.json` }, { actor, revision: f.state().revision });
    state = observeProjectSessionControl(f.root, f.programme, f.project, { actor, revision: state.revision,
      observation: { sequence: state.session_control.observation.sequence + 1, at_ms: 1200, awake_ms: 200,
        activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
    const binding = state.session_control.binding;
    const input = { goal_revision: state.goal_revision, message: `Build session ${count}`, title: 'Build project', body: 'Measured project.',
      result: { schema: 'mc-session-result', version: 1, ...binding, reason: null, outcome: count === 1 ? 'continue' : 'review-ready',
        handoff: { schema: 'mc-session-handoff', version: 1, ...binding, published_sha: null,
          interpretation: { implemented: [`Session ${count}.`], remaining: count === 1 ? ['Another criterion.'] : [], decisions: [], failed_approaches: [], next_focus: 'Follow current criteria.' },
          evidence: state.evidence.builder.map(item => ({ ...binding, criterion_id: item.criterion_id, reference: item.reference, summary: 'Measured.' })), references: [] } } };
    writeFileSync(join(cwd, `session-${count}.js`), `export const built = ${count};\n`);
    await finishAutonomousPublication({ root: f.root, programme: f.programme, project: f.project, actor,
      cwd, env: f.deps.env, revision: state.revision }, input, f.capability.publication);
    closedSession({ ...f, cwd, stateNow: f.state });
    return completion;
  };
  const runner = createRunner({ deps: f.deps, autonomous: f.capability }); const world = f.world(f.record);
  assert.equal(await runner.runStep(f.project, world), 'ran');
  assert.equal(f.state().phase, 'ready'); assert.equal(f.state().active_run, null);
  const first = f.state().runs.at(-1).run_id;
  const firstManifest = JSON.parse(readFileSync(join(sessionGitDir(cwd), 'mc-autonomous-session.json'), 'utf8'));
  const newMain = f.advanceMain('main moved between green sessions\n');
  assert.equal(runner.nextStep({ world }).name, f.project);
  assert.equal(await runner.runStep(f.project, world), 'ran');
  assert.equal(f.state().phase, 'review_ready'); assert.equal(f.state().active_run, null);
  assert.equal(git(cwd, 'merge-base', '--is-ancestor', newMain, 'HEAD'), '');
  assert.equal(creates, 1); assert.equal(gates, 2); assert.equal(f.calls.length, 2);
  assert.notEqual(first, f.state().runs.at(-1).run_id);
  const prompt = JSON.parse(f.calls[1].prompt); assert.equal(prompt.previous.handoff.run_id, first);
  assert.ok(!f.calls[1].args.includes('--resume')); assert.ok(pr.body.includes(AUTONOMOUS_PR_MARK));
  assert.ok(existsSync(join(dirname(firstManifest.snapshot), 'retired-manifest.json')));
  assert.equal(runner.nextStep({ world }), null); assert.equal(f.state().evidence.reviews.length, 0);
});
