/** Real temporary Git repositories and bare remotes. GitHub is stubbed;
 * completed check receipts below use synthetic execution observations, not
 * nested tests competing for the outer mc gate's resource lane. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateFixture, planner, builder } from './autonomous-state-fixture.js';
import { attribution } from './autonomy-fixtures.js';
import { readAutonomousState, sendAutonomousProject, mutateAutonomousProject, startAutonomousBuild,
  observeProjectSessionControl, readProgrammeState } from '../../src/mc/autonomous-state.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';
import { gateConfiguration } from '../../src/mc/gate-greens.js';
import { finishAutonomousPublication, completeAutonomousPublication } from '../../src/mc/autonomous-publish.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { readCurrentHandoff } from '../../src/mc/session-handoff.js';
import { AUTONOMOUS_PR_MARK, autonomousMergeDoor } from '../../src/mc/autonomous-pr.js';
import { criteriaDoor } from '../../src/mc/merge-boundary.js';
import { run as projectCommand } from '../../src/mc/commands/autonomous-project.js';
import { run as publishCommand } from '../../src/mc/commands/publish.js';
import { run as mergeCommand } from '../../src/mc/commands/merge.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { publicationGateSelection } from '../../src/mc/commands/gate.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';

const profile = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
const completion = { status: 0, normal_exit: true, recovery_ready: true, control_persisted: true, interrupted: false };
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t, { close = true, existing = null } = {}) {
  const f = stateFixture(); t.after(f.cleanup); f.setupProject();
  const cwd = join(f.root, 'memoro-cli'); mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Publication Test'); git(cwd, 'config', 'user.email', 'publication@example.invalid');
  writeFileSync(join(cwd, 'schema.test.js'), 'export {};\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'baseline');
  const remote = join(f.root, 'origin.git'); git(cwd, 'clone', '--bare', '-q', cwd, remote);
  git(cwd, 'remote', 'add', 'origin', remote); git(cwd, 'fetch', '-q', 'origin');
  git(cwd, 'switch', '-qc', f.project);
  let state = readAutonomousState(f.root, f.programme, f.project);
  sendAutonomousProject(f.root, f.programme, f.project, { actor: planner, revision: state.revision });
  state = mutateAutonomousProject(f.root, f.programme, f.project, 'release', null, { actor: planner, revision: state.revision });
  // Activation remains unavailable; only this isolated runner fixture admits it.
  state.phase = 'ready';
  if (existing !== null) state.ownership.pr = existing;
  writeFileSync(f.paths.project, JSON.stringify(state));
  state = startAutonomousBuild(f.root, f.programme, f.project, { actor: builder, revision: state.revision,
    assignment: state.contract, branch: f.project, profile,
    observation: { sequence: 0, at_ms: 1000, awake_ms: 0, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  state = mutateAutonomousProject(f.root, f.programme, f.project, 'progress', { id: 'schema-proof', criterion_id: 'schema',
    status: 'verified', reference: 'evidence/schema.json' }, { actor: builder, revision: state.revision });
  if (close) state = observeProjectSessionControl(f.root, f.programme, f.project, { actor: builder, revision: state.revision,
    observation: { sequence: 1, at_ms: 1200, awake_ms: 200, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_HOME: join(f.root, 'mc-home'), MC_AUTONOMOUS_RUN: builder.run_id, MC_AUTONOMOUS_ROLE: 'step' };
  delete env.MC_STEP;
  const binding = { ...attribution(), run_id: builder.run_id };
  const input = { goal_revision: 1, message: 'Implement schema', title: 'Schema implementation', body: 'Built and measured the schema.',
    result: { schema: 'mc-session-result', version: 1, ...binding, outcome: 'continue', reason: null,
      handoff: { schema: 'mc-session-handoff', version: 1, ...binding, published_sha: null,
        interpretation: { implemented: ['Schema implemented.'], remaining: ['Next criterion.'], decisions: [], failed_approaches: [], next_focus: 'Check the next criterion.' },
        evidence: [{ ...binding, criterion_id: 'schema', reference: 'evidence/schema.json', summary: 'Schema verified.' }], references: [] } } };
  const calls = []; const output = []; let count = 0;
  let pr = existing === null ? null : { number: existing, headRefName: f.project, baseRefName: 'main', state: 'OPEN', body: '' };
  const stateNow = () => readAutonomousState(f.root, f.programme, f.project);
  const options = () => ({ root: f.root, programme: f.programme, project: f.project, actor: builder, cwd, env, revision: stateNow().revision });
  const requirements = async () => ({ base: git(cwd, 'rev-parse', 'origin/main'), configuration: gateConfiguration({ select: 'fixture-selector' }),
    selection: { kind: 'affected', files: ['schema.test.js'], commands: [], flags: [], pattern: null } });
  const gh = args => {
    calls.push(args);
    if (args[1] === 'list') return { ok: true, status: 0, stdout: JSON.stringify(pr ? [{ number: pr.number, url: `https://fixture/pull/${pr.number}`, state: pr.state }] : []) };
    if (args[1] === 'create') {
      assert.equal(pr, null, 'never create a second PR');
      assert.ok(args.includes('--draft')); assert.ok(args[args.indexOf('--body') + 1].includes(AUTONOMOUS_PR_MARK));
      pr = { number: 42, headRefName: f.project, baseRefName: 'main', state: 'OPEN', body: args[args.indexOf('--body') + 1] };
      return { ok: true, status: 0, stdout: 'https://fixture/pull/42' };
    }
    if (args[1] === 'edit') {
      assert.equal(Number(args[2]), pr.number);
      if (args.includes('--body')) pr.body = args[args.indexOf('--body') + 1];
      return { ok: true, status: 0, stdout: '' };
    }
    if (args[1] === 'view') {
      const remoteHead = git(cwd, 'ls-remote', '--heads', 'origin', f.project).split(/\s+/u)[0];
      return { ok: true, status: 0, stdout: JSON.stringify({ ...pr, headRefOid: remoteHead }) };
    }
    throw new Error(`unexpected GitHub operation ${args.join(' ')}`);
  };
  const deps = { stdout: { write: text => output.push(text) }, stderr: { write: text => output.push(text) }, requirements,
    publishDeps: { gh, merge: () => assert.fail('autonomous publication never queues merge') },
    gate: async (args, call) => {
      assert.deepEqual(args, ['--json']); calls.push(['gate']); count++;
      const required = await requirements(); const candidate = captureWorktree(cwd);
      const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: `gate-${count}`, ...call.measurementBinding,
        configuration: required.configuration, candidate, base: required.base }, before: candidate, after: candidate,
        result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
          totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
        started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
      const path = persistGateReceipt({ root: env.MC_HOME, receipt });
      call.stdout.write(JSON.stringify({ evidence: { path } })); return 0;
    } };
  const edit = () => writeFileSync(join(cwd, 'implementation.js'), 'export const implemented = true;\n');
  return { ...f, cwd, remote, env, input, options, stateNow, deps, calls, output, gh, edit,
    finish: () => finishAutonomousPublication(options(), input, deps),
    complete: (result = completion) => completeAutonomousPublication(options(), result, deps),
    pr: () => pr };
}

function held(f) {
  const state = f.stateNow();
  assert.deepEqual(state.active_run, builder);
  assert.notEqual(state.phase, 'ready'); assert.notEqual(state.phase, 'review_ready');
  assert.equal(autonomousChoice({ root: f.root, record: { project: f.project, programme: f.programme,
    repo: 'memoro-cli', plan: state.contract }, capability: {} }).reason, 'autonomous-owned');
}

test('finish commits measured dirty content, confirms the pushed marked PR, and only settled completion commits a normal handoff', async t => {
  const f = fixture(t); f.edit();
  const before = git(f.cwd, 'rev-parse', 'HEAD'); const prepared = await f.finish();
  assert.equal(prepared.phase, 'pr_resolved'); assert.equal(prepared.pr, 42);
  assert.notEqual(prepared.head, before); assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  assert.equal(git(f.cwd, 'ls-remote', '--heads', 'origin', f.project).split(/\s+/u)[0], prepared.head);
  assert.equal(f.stateNow().current_handoff, null); held(f);
  const done = await f.complete(); assert.equal(done.phase, 'handoff_committed'); held(f);
  const handoff = readCurrentHandoff({ root: f.root, assignment: f.stateNow().contract,
    programme: readProgrammeState(f.root, f.programme).approved[0], runId: builder.run_id });
  assert.equal(handoff.observed.normal_exit, true); assert.equal(handoff.observed.head, prepared.head);
  assert.equal(handoff.observed.pushed, prepared.head); assert.ok(handoff.observed.gate.startsWith(f.env.MC_HOME));
  assert.equal(await criteriaDoor({ repoPath: f.cwd, pr: 42, root: f.root, gh: f.gh, programs: () => [] }).then(x => x.ok), false);
});

test('retry updates one existing PR, resumes the same phases and needs neither another gate nor an empty commit', async t => {
  const f = fixture(t, { existing: 77 }); f.edit(); await f.finish();
  const count = git(f.cwd, 'rev-list', '--count', 'HEAD');
  await f.finish(); await f.complete(); const first = f.stateNow().current_handoff;
  await f.complete();
  assert.equal(git(f.cwd, 'rev-list', '--count', 'HEAD'), count);
  assert.equal(f.calls.filter(args => args[0] === 'gate').length, 1);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
  assert.equal(f.pr().number, 77); assert.equal(f.stateNow().current_handoff, first); held(f);
});

test('equal-tree publication does not create an empty commit', async t => {
  const f = fixture(t); const head = git(f.cwd, 'rev-parse', 'HEAD');
  assert.equal((await f.finish()).head, head); await f.complete(); assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head);
});

test('ownership, closing state, assignment revision and criterion bindings are validated before any gate or push', async t => {
  for (const kind of ['owner', 'role', 'closing', 'revision', 'goal', 'criterion', 'reference', 'result', 'sent']) {
    const f = fixture(t, { close: kind !== 'closing' }); let options = f.options();
    if (kind === 'owner') options.actor = { ...builder, run_id: 'someone-else' };
    if (kind === 'role') options.actor = { ...builder, role: 'review' };
    if (kind === 'revision') options.revision--;
    if (kind === 'goal') f.input.goal_revision++;
    if (kind === 'criterion') f.input.result.handoff.evidence[0].criterion_id = 'unknown';
    if (kind === 'reference') f.input.result.handoff.evidence[0].reference = 'unrecorded';
    if (kind === 'result') f.input.result.goal_revision++;
    if (kind === 'sent') writeFileSync(join(f.paths.projectDir, 'PLAN.json'), '{}');
    await assert.rejects(finishAutonomousPublication(options, f.input, f.deps));
    assert.equal(f.calls.length, 0, kind); held(f);
  }
});

test('red, running, unknown, no-checks and interrupted gates cannot publish or release even a time/context close', async t => {
  for (const code of [1, 2, 3, undefined, 0]) {
    const f = fixture(t); f.edit(); f.deps.gate = async () => code;
    await assert.rejects(f.finish(), /gate|evidence/);
    assert.equal(f.pr(), null); assert.equal(f.stateNow().publication.phase, 'started'); held(f);
    await assert.rejects(f.complete(), /confirmed publication/);
  }
});

test('focused, filtered, stale-base, wrong-run, wrong-goal and changed-content receipts are not normal green evidence', async t => {
  for (const kind of ['focused', 'filtered', 'stale-base', 'wrong-run', 'wrong-goal', 'changed-content', 'wrong-config', 'version', 'selection']) {
    const f = fixture(t); f.edit(); const gate = f.deps.gate;
    f.deps.gate = async (args, call) => {
      const code = await gate(args, call);
      const path = join(f.env.MC_HOME, 'gate-evidence', 'gate-1.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (kind === 'focused') receipt.coverage.kind = 'named';
      if (kind === 'filtered') receipt.coverage.pattern = 'one test';
      if (kind === 'stale-base') receipt.base = 'a'.repeat(40);
      if (kind === 'wrong-run') receipt.session_run = 'another-run';
      if (kind === 'wrong-goal') receipt.goal_revision++;
      if (kind === 'wrong-config') receipt.configuration = 'stale';
      if (kind === 'version') receipt.gate_version--;
      if (kind === 'selection') receipt.coverage.commands.push({ packageScript: 'unexecuted-check' });
      if (kind === 'changed-content') writeFileSync(join(f.cwd, 'after.js'), 'after\n');
      // Corrupt an isolated fixture receipt to exercise the defensive reader.
      writeFileSync(path, JSON.stringify(receipt)); return code;
    };
    await assert.rejects(f.finish(), /complete relevant green gate/);
    assert.equal(f.pr(), null); held(f);
  }
});

test('push failure retains the commit and gate phase; retry confirms the actual remote and resumes without rebuilding', async t => {
  const f = fixture(t); f.edit(); f.deps.publishDeps.push = () => ({ ok: false, text: 'network unavailable' });
  await assert.rejects(f.finish(), /publication failed/);
  const local = git(f.cwd, 'rev-parse', 'HEAD'); assert.equal(f.stateNow().publication.phase, 'committed'); held(f);
  delete f.deps.publishDeps.push; assert.equal((await f.finish()).head, local);
  assert.equal(f.calls.filter(args => args[0] === 'gate').length, 1); await f.complete();
});

test('a push command claiming success without the remote holding the commit cannot complete', async t => {
  const f = fixture(t); f.edit(); f.deps.publishDeps.push = () => ({ ok: true, text: '' });
  await assert.rejects(f.finish(), /publication failed/); assert.equal(f.pr(), null); held(f);
});

test('existing PR identity cannot change, disappear, or be duplicated', async t => {
  for (const prs of [[], [{ number: 999 }], [{ number: 77 }, { number: 88 }]]) {
    const f = fixture(t, { existing: 77 }); f.edit(); const gh = f.gh;
    f.deps.publishDeps.gh = args => args[1] === 'list' ? { ok: true, stdout: JSON.stringify(prs) } : gh(args);
    await assert.rejects(f.finish(), /publication failed/); assert.equal(f.pr().number, 77); held(f);
    assert.equal(git(f.cwd, 'ls-remote', '--heads', 'origin', f.project), '');
  }
});

test('changes after gate/commit or unconfirmed/changed PR state cannot record a normal handoff', async t => {
  for (const kind of ['edit', 'empty-commit', 'closed-pr', 'pr-head', 'marker', 'unknown-completion', 'interrupted', 'children', 'control']) {
    const f = fixture(t); f.edit(); await f.finish(); let result = completion;
    if (kind === 'edit') writeFileSync(join(f.cwd, 'implementation.js'), 'changed\n');
    if (kind === 'empty-commit') git(f.cwd, 'commit', '--allow-empty', '-qm', 'unmeasured head');
    if (kind === 'closed-pr') f.pr().state = 'CLOSED';
    if (kind === 'pr-head') f.pr().headRefName = 'other-branch';
    if (kind === 'marker') f.pr().body = '';
    if (kind === 'unknown-completion') result = null;
    if (kind === 'interrupted') result = { ...completion, interrupted: true };
    if (kind === 'children') result = { ...completion, recovery_ready: false };
    if (kind === 'control') result = { ...completion, control_persisted: false };
    await assert.rejects(f.complete(result));
    assert.equal(f.stateNow().current_handoff, null, kind); held(f);
  }
});

test('new v2 PRs remain nonmergeable through direct, docs and resumed-round entrypoints without a readable plan/state', async t => {
  const f = fixture(t); f.edit(); await f.finish();
  rmSync(f.paths.project); rmSync(join(f.paths.projectDir, 'PLAN.json'));
  const refused = await autonomousMergeDoor({ repoPath: f.cwd, pr: 42, root: f.root, gh: () => ({ status: 1 }) });
  assert.equal(refused.stop, 'autonomous-review-required');
  for (const flag of [[], ['--docs'], ['--admin']]) {
    const code = await mergeCommand(['memoro-cli', '42', ...flag], { root: f.root, env: f.env,
      resolveRepoPath: () => f.cwd, prFiles: () => flag.length ? ['docs/note.md'] : ['src/code.js'],
      gh: f.gh, stdout: f.deps.stdout, stderr: f.deps.stderr,
      runDocsMerge: () => assert.fail('no docs landing'), startMerger: () => assert.fail('no merger') });
    assert.equal(code, 1);
  }
  const report = await runMergeRound({ repoPath: f.cwd, pr: 42, env: f.env, gh: f.gh,
    gate: () => assert.fail('no resumed round gate') });
  assert.equal(report.stopped_at, 'autonomous-review-required');
  const bodyOnly = await autonomousMergeDoor({ repoPath: f.cwd, pr: 42, root: join(f.root, 'different-machine'), gh: f.gh });
  assert.equal(bodyOnly.ok, false, 'persistent GitHub marker survives missing local state');
  const docs = await runDocsMerge({ repoPath: f.cwd, pr: 42, root: f.root, gh: f.gh,
    measure: () => assert.fail('no lower-level docs measurement') });
  assert.equal(docs.stopped_at, 'autonomous-review-required');
});

test('ordinary publish cannot bypass v2 finish, and the typed finish command prepares without asserting normal exit', async t => {
  const f = fixture(t); f.edit();
  assert.equal(await publishCommand([], { ...f.deps, env: f.env, cwd: f.cwd }), 1);
  assert.equal(await publishCommand([], { ...f.deps, root: f.root, env: {}, cwd: f.cwd }), 1, 'v2 branch does not become v1 without runner env');
  const file = join(f.root, 'finish-input.json'); writeFileSync(file, JSON.stringify(f.input));
  assert.equal(await projectCommand(['finish', `${f.programme}/${f.project}`, '--expected-revision', String(f.options().revision), '--input-file', file],
    { ...f.deps, root: f.root, env: f.env, cwd: f.cwd, actor: builder }), 0);
  assert.match(f.output.join(''), /"normal_exit":false/); assert.equal(f.stateNow().current_handoff, null); held(f);
});

test('publication selection uses affected code, added tests, declaration flags and command gates', async t => {
  const f = fixture(t); f.edit(); writeFileSync(join(f.cwd, 'added.test.js'), 'export {};\n');
  const command = { id: 'command', packageScript: 'check', passBaseRef: true };
  let invocation;
  const selected = await publicationGateSelection(f.cwd, f.env, {
    declaration: () => ({ ok: true, declaration: { select: 'fixture-selector --base-ref main', pr_tests_flags: ['--import', './isolation.js'] } }),
    select: async ({ command: text }) => { invocation = text; return { ok: true, files: ['schema.test.js'], commands: [command] }; },
  });
  assert.match(invocation, /--changed-path 'implementation.js'/); assert.match(invocation, /--changed-path 'added.test.js'/);
  assert.deepEqual(selected.selection.files.sort(), ['added.test.js', 'schema.test.js']);
  assert.deepEqual(selected.selection.commands, [command]); assert.deepEqual(selected.selection.flags, ['--import', './isolation.js']);
});

test('a lost PR read-back retains its identity and resumes the same PR; closed PRs cannot be replaced', async t => {
  const f = fixture(t); f.edit(); const gh = f.gh; let fail = true;
  f.deps.publishDeps.gh = args => args[1] === 'view' && fail ? { ok: false, text: 'read-back unavailable' } : gh(args);
  await assert.rejects(f.finish(), /publication failed/);
  assert.equal(f.stateNow().publication.phase, 'pushed'); assert.equal(f.stateNow().ownership.pr, 42); held(f);
  fail = false; await f.finish(); await f.complete();
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 1);
  f.pr().state = 'CLOSED';
  await assert.rejects(f.finish(), /publication failed/);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 1);
});

test('failure between immutable handoff and current pointer is retryable without an unchecked completion', async t => {
  const f = fixture(t); f.edit(); await f.finish();
  f.deps.handoffDeps = { writeCurrent: () => { throw new Error('pointer write interrupted'); } };
  await assert.rejects(f.complete(), /pointer write interrupted/);
  assert.equal(f.stateNow().publication.phase, 'pr_resolved'); assert.equal(f.stateNow().current_handoff, null); held(f);
  delete f.deps.handoffDeps; await f.complete();
  assert.equal(f.stateNow().publication.phase, 'handoff_committed');
});

test('active/unknown gate or previous process ownership cannot release a prepared publication', async t => {
  for (const kind of ['gate', 'process']) {
    const f = fixture(t); f.edit(); await f.finish();
    const gitDir = git(f.cwd, 'rev-parse', '--absolute-git-dir');
    if (kind === 'gate') writeFileSync(join(gitDir, 'mc-gate.json'), JSON.stringify({ pid: process.pid }));
    else writeFileSync(join(gitDir, 'mc-autonomous-session.json'), JSON.stringify({ run_id: 'unknown', pid: null }));
    await assert.rejects(f.complete(), /quiescent|completion unknown/);
    assert.equal(f.stateNow().current_handoff, null); held(f);
  }
});

test('fresh publication on the next reserved run keeps the same branch/PR and avoids an empty commit', async t => {
  const f = fixture(t); f.edit(); await f.finish(); await f.complete();
  const head = git(f.cwd, 'rev-parse', 'HEAD');
  // The following continuation transition belongs to step 3. This isolated
  // fixture supplies it solely to exercise a fresh run's publication boundary.
  let state = f.stateNow(); state.phase = 'ready'; state.active_run = null;
  writeFileSync(f.paths.project, JSON.stringify(state));
  const next = { run_id: 'build-2', role: 'step' };
  state = startAutonomousBuild(f.root, f.programme, f.project, { actor: next, revision: state.revision,
    assignment: state.contract, branch: f.project, profile,
    observation: { sequence: 0, at_ms: 2000, awake_ms: 0, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  state = observeProjectSessionControl(f.root, f.programme, f.project, { actor: next, revision: state.revision,
    observation: { sequence: 1, at_ms: 2200, awake_ms: 200, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  const input = structuredClone(f.input); input.result.run_id = next.run_id; input.result.handoff.run_id = next.run_id;
  input.result.handoff.evidence.forEach(item => { item.run_id = next.run_id; });
  const options = { ...f.options(), actor: next, revision: state.revision };
  const prepared = await finishAutonomousPublication(options, input, f.deps);
  assert.equal(prepared.head, head); assert.equal(prepared.pr, 42);
  const done = await completeAutonomousPublication(options, completion, f.deps);
  assert.equal(done.phase, 'handoff_committed'); assert.equal(done.run_id, next.run_id);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 1);
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head);
});

test('a criterion update invalidating a prepared report prevents normal completion', async t => {
  const f = fixture(t); f.edit(); await f.finish();
  mutateAutonomousProject(f.root, f.programme, f.project, 'progress', { id: 'schema-recheck', criterion_id: 'schema',
    status: 'unknown', reference: null }, { actor: builder, revision: f.stateNow().revision });
  await assert.rejects(f.complete(), /current verified builder evidence/);
  assert.equal(f.stateNow().current_handoff, null); held(f);
});
