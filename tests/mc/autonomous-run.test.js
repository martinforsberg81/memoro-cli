import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunner, realDeps } from '../../src/mc/run.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { AUTONOMOUS_EXECUTION_ENABLED } from '../../src/mc/autonomous-project.js';
import { readAutonomousState, readProgrammeState, sendAutonomousProject, mutateAutonomousProject,
  createAutonomousDraft, autonomousPaths } from '../../src/mc/autonomous-state.js';
import { normaliseCapacity, applyRefusal } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { SESSION_START_MAX_BYTES } from '../../src/mc/session-handoff.js';
import { stateFixture, planner } from './autonomous-state-fixture.js';
import { autonomousProject } from './autonomy-fixtures.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';

const profile = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = { status: 0, stdout: JSON.stringify({ subtype: 'success', num_turns: 1, session_id: 'fixture-session' }), stderr: '',
  normal_exit: true, recovery_ready: true, control_persisted: true };
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t) {
  const f = stateFixture(); t.after(f.cleanup);
  f.setupProject();
  const primaryHome = join(f.root, 'primary'); const primary = join(primaryHome, 'memoro-cli');
  const remote = join(f.root, 'remote.git');
  mkdirSync(primary, { recursive: true });
  git(primary, 'init', '-q', '-b', 'main');
  writeFileSync(join(primary, 'base.txt'), 'base\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'Initial');
  git(f.root, 'clone', '-q', '--bare', primary, remote);
  git(primary, 'remote', 'add', 'origin', remote); git(primary, 'fetch', '-q', 'origin');
  const env = { ...process.env, MC_WORK_ROOT: f.root, MC_REPOS_HOME: primaryHome };
  delete env.MC_STEP;
  const calls = []; const log = []; let capacity = normaliseCapacity(null); const sleeps = [];
  const deps = { ...realDeps(env), now: () => new Date('2026-10-28T12:00:00Z'), log: line => log.push(line),
    catalog: () => DEFAULT_CATALOG, capacity: { read: () => capacity, write: next => { capacity = next; } },
    laneCount: () => ({ per_repo: 2, total: 2 }), billing: { readMode: () => 'plan' },
    attachDeps: async () => ({ ok: true }),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'Claude', spec: { bin: 'fixture' }, adapter: claudeAdapter }),
    addWorktree: ({ name, branch, from }) => {
      const cwd = join(f.root, name, 'memoro-cli'); mkdirSync(join(f.root, name), { recursive: true });
      const existing = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: primary }).status === 0;
      git(primary, 'worktree', 'add', '-q', ...(existing ? [cwd, branch] : ['-b', branch, cwd, from]));
      return { ok: true, path: cwd };
    },
    session: async call => { calls.push(call); return completed; },
    gh: () => ({ ok: true, stdout: '[]', stderr: '' }),
    // Tests control lane release explicitly, without polling a real clock.
    sleep: () => { const wait = deferred(); sleeps.push(wait); return wait.promise; },
  };
  const capability = { profile, pollMs: 10, clock: () => ({ at_ms: 1000, awake_ms: 0 }),
    gate: async (args, options) => { assert.deepEqual(args, []); assert.equal(options.env, env); return 0; } };
  const state = (project = f.project) => readAutonomousState(f.root, f.programme, project);
  const add = (project = f.project, overrides = {}) => {
    let value;
    if (project === f.project) value = state();
    else value = createAutonomousDraft(f.root, f.programme, project, autonomousProject({ project_id: project, ...overrides }),
      { actor: planner, revision: readProgrammeState(f.root, f.programme).revision });
    sendAutonomousProject(f.root, f.programme, project, { actor: planner, revision: value.revision });
    value = mutateAutonomousProject(f.root, f.programme, project, 'release', null, { actor: planner, revision: value.revision });
    // The later planner/activation door is not implemented here. Only this
    // isolated fixture supplies a ready assignment; no live command enables it.
    value.phase = 'ready'; writeFileSync(autonomousPaths(f.root, f.programme, project).project, JSON.stringify(value));
    return { project, programme: f.programme, repo: 'memoro-cli', path: join(f.paths.projectDir, 'PLAN.json'), plan: value.contract };
  };
  const record = add();
  const world = (...records) => ({ names: records.map(r => r.project), plans: records, prs: [], prsFailed: [] });
  const cwd = project => join(f.root, 'step', project, 'memoro-cli');
  const advanceMain = text => {
    writeFileSync(join(primary, 'base.txt'), text); git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'Move main');
    git(remote, 'fetch', '-q', primary, 'main:main');
    return git(primary, 'rev-parse', 'HEAD');
  };
  return { ...f, deps, capability, primary, remote, calls, log, sleeps, record, world, state, add, cwd, advanceMain,
    refuse: () => { capacity = applyRefusal(capacity, 'claude', '2026-10-29T12:00:00Z'); } };
}

function legacy(f) {
  const plan = { schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['Legacy goal.'], contract: ['Preserve fixed steps.'],
    out_of_scope: ['V2.'], success_criteria: [{ met: false, criterion: 'Legacy step runs.', check: 'Inspect fixture.' }], documents: [],
    steps: [{ title: 'Legacy work', status: 'ready', instruction: ['Do legacy work.'], done_when: 'Legacy work is done.' }] };
  const dir = join(f.root, 'programs', 'test-programme', 'legacy'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PLAN.json'), JSON.stringify(plan));
  return { project: 'legacy', programme: f.programme, repo: 'memoro-cli', path: join(dir, 'PLAN.json'), plan };
}

test('normal runner remains inactive for explicit v2, even with activation-looking environment', async t => {
  const f = fixture(t); f.deps.env.MC_AUTONOMOUS_ENABLED = 'true';
  const runner = createRunner({ deps: f.deps });
  assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false);
  assert.equal(runner.nextStep({ world: f.world(f.record) }), null);
  assert.equal(await runner.runStep(f.project, f.world(f.record)), 'skipped:autonomous-disabled');
  assert.equal(f.state().active_run, null); assert.equal(f.calls.length, 0); assert.equal(existsSync(f.cwd(f.project)), false);
});

test('v1 and v2 execute concurrently through the same runner with one owner per project', async t => {
  const f = fixture(t); const v1 = legacy(f); const entered = deferred(); const finish = deferred(); t.after(finish.resolve);
  let count = 0;
  f.deps.session = async call => { f.calls.push(call); if (++count === 2) entered.resolve(); await finish.promise; return completed; };
  const runner = createRunner({ merge: false, deps: f.deps, autonomous: f.capability });
  const world = f.world(f.record, v1);
  const v2 = runner.runStep(f.project, world, { lane: 0 });
  const old = runner.runStep('legacy', world, { lane: 1 });
  await entered.promise;
  assert.equal(runner.claims.size, 2); assert.equal(f.calls.length, 2);
  assert.equal(await runner.runStep(f.project, world, { lane: 2 }), 'skipped');
  assert.equal(f.state().active_run.role, 'step');
  const current = JSON.parse(readFileSync(runner.paths.currentFor('memoro-cli'), 'utf8'));
  assert.equal(current.flavor, 'autonomous'); assert.equal(current.kind, 'step');
  assert.equal(current.run_id, f.state().active_run.run_id);
  const fresh = f.calls.find(call => call.autonomous);
  const oldCall = f.calls.find(call => !call.autonomous);
  assert.ok(oldCall.prompt.includes('Legacy work'));
  assert.ok(!fresh.args.includes('--resume'));
  assert.equal(fresh.env.MC_STEP, undefined); assert.equal(fresh.env.MC_AUTONOMOUS_ROLE, 'step');
  assert.equal(JSON.parse(fresh.prompt).assignment.version, 2);
  assert.ok(Buffer.byteLength(fresh.prompt) <= SESSION_START_MAX_BYTES);
  assert.ok(!fresh.args.join(' ').includes('Legacy work'));
  finish.resolve(); assert.equal(await v2, 'ran'); assert.equal(await old, 'ran');
  assert.equal(runner.claims.size, 0);
  assert.equal(f.state().phase, 'running'); // exit 0 is not a green handoff
  assert.equal(existsSync(runner.paths.currentFor('memoro-cli')), false);
});

test('mixed work obeys the existing total cap and v2 releases its slot', async t => {
  const f = fixture(t); const v1 = legacy(f); const entered = deferred(); const finish = deferred(); t.after(finish.resolve);
  f.deps.laneCount = () => ({ per_repo: 2, total: 1 });
  f.deps.session = async call => { f.calls.push(call); if (call.autonomous) { entered.resolve(); await finish.promise; } return completed; };
  const runner = createRunner({ merge: false, deps: f.deps, autonomous: f.capability });
  const world = f.world(f.record, v1); const build = runner.runStep(f.project, world);
  await entered.promise;
  const old = runner.runStep('legacy', world, { lane: 1 });
  // Legacy setup awaits dependency attachment before it asks for its slot.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); assert.equal(f.sleeps.length, 1);
  finish.resolve(); await build; f.sleeps[0].resolve(); await old;
  assert.equal(f.calls.length, 2);
  assert.ok(f.log.some(line => line.includes('1 of 1 steps in flight')));
});

test('a second runner cannot start or sync an owned interrupted context', async t => {
  const f = fixture(t); const runner = createRunner({ deps: f.deps, autonomous: f.capability });
  await runner.runStep(f.project, f.world(f.record));
  const cwd = f.cwd(f.project); writeFileSync(join(cwd, 'base.txt'), 'unsent in-memory work\n');
  git(cwd, 'add', 'base.txt'); writeFileSync(join(cwd, 'untracked.txt'), 'unsent\n');
  const before = git(cwd, 'diff', '--cached', '--binary'); const head = git(cwd, 'rev-parse', 'HEAD');
  f.advanceMain('new main\n');
  const other = createRunner({ deps: f.deps, autonomous: f.capability });
  assert.equal(await other.runStep(f.project, f.world(f.record)), 'skipped:autonomous-owned');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head); assert.equal(git(cwd, 'diff', '--cached', '--binary'), before);
  assert.equal(readFileSync(join(cwd, 'untracked.txt'), 'utf8'), 'unsent\n'); assert.equal(f.calls.length, 1);
});

test('independent v2 projects have distinct durable run IDs and share lanes', async t => {
  const f = fixture(t); const second = f.add('second-project'); const finish = deferred(); t.after(finish.resolve); const entered = deferred();
  f.deps.session = async call => { f.calls.push(call); if (f.calls.length === 2) entered.resolve(); await finish.promise; return completed; };
  const runner = createRunner({ deps: f.deps, autonomous: f.capability }); const world = f.world(f.record, second);
  const a = runner.runStep(f.project, world); const b = runner.runStep(second.project, world, { lane: 1 });
  await entered.promise;
  assert.notEqual(f.state().active_run.run_id, f.state(second.project).active_run.run_id);
  assert.equal(runner.nextStep({ world }), null);
  finish.resolve(); await Promise.all([a, b]);
});

test('fresh build integrates current main and checks the starting affected gate before launch', async t => {
  const f = fixture(t); const head = f.advanceMain('new main\n'); const events = [];
  f.capability.gate = async (args, { cwd }) => { assert.deepEqual(args, []); assert.equal(git(cwd, 'rev-parse', 'HEAD'), head); events.push('gate'); return 0; };
  f.deps.session = async call => { events.push('build'); assert.equal(readFileSync(join(call.cwd, 'base.txt'), 'utf8'), 'new main\n'); return completed; };
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.deepEqual(events, ['gate', 'build']);
});

for (const code of [1, 2, 3]) test(`starting gate exit ${code} is not permission to build or merge`, async t => {
  const f = fixture(t); f.capability.gate = async () => code;
  f.deps.queueMerge = () => assert.fail('must not merge');
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(f.calls.length, 0); assert.equal(f.state().phase, 'plan_pending');
  assert.equal(f.state().attempts[0].outcome, 'incomplete'); assert.ok(f.state().active_run);
});

test('capacity refusal is shared with v1 routing and does not reserve a run', async t => {
  const f = fixture(t); f.refuse();
  assert.equal(await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record)), 'skipped:no-capacity');
  assert.equal(f.state().active_run, null); assert.equal(f.calls.length, 0);
});

test('explicit version dispatch allows only the owned PR and leaves v1 selection unchanged', t => {
  const f = fixture(t); const runner = createRunner({ deps: f.deps, autonomous: f.capability });
  assert.equal(runner.nextStep({ world: f.world(f.record) }).name, f.project);
  let state = f.state(); state.ownership = { branch: f.project, pr: 42 }; writeFileSync(f.paths.project, JSON.stringify(state));
  const world = f.world(f.record); world.prs = [{ repo: 'memoro-cli', number: 42, headRefName: f.project, isDraft: true }];
  assert.equal(runner.nextStep({ world }).name, f.project);
  world.prs[0].number = 43; assert.equal(runner.nextStep({ world }), null);
  const bad = { ...f.record, plan: { ...f.record.plan, execution: { kind: 'fixed' } } };
  assert.equal(autonomousChoice({ root: f.root, record: bad, capability: f.capability }).kind, null);
  assert.equal(runner.nextStep({ world: f.world({ ...f.record, plan: { ...f.record.plan, version: 99 } }) }), null);
});

function conflicting(f) {
  const cwd = f.cwd(f.project); mkdirSync(join(f.root, 'step', f.project), { recursive: true });
  git(f.primary, 'worktree', 'add', '-qb', f.project, cwd, 'origin/main');
  writeFileSync(join(cwd, 'base.txt'), 'project intent\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Project change');
  const state = f.state(); state.ownership.branch = f.project; writeFileSync(f.paths.project, JSON.stringify(state));
  f.advanceMain('main intent\n'); return cwd;
}

test('conflicts are resolved by step integration before the starting gate and implementation', async t => {
  const f = fixture(t); const cwd = conflicting(f); const order = [];
  f.capability.integrateConflicts = async ({ actor, conflicts, instructions }) => {
    assert.equal(actor.role, 'step'); assert.deepEqual(conflicts, ['base.txt']); assert.ok(instructions.includes('resolve-conflicts-only'));
    order.push('resolve'); writeFileSync(join(cwd, 'base.txt'), 'project intent\nmain intent\n');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Keep both intents');
  };
  f.capability.gate = async () => { order.push('gate'); assert.equal(git(cwd, 'diff', '--name-only', '--diff-filter=U'), ''); return 0; };
  f.deps.session = async () => { order.push('build'); return completed; };
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.deepEqual(order, ['resolve', 'gate', 'build']); assert.equal(git(cwd, 'branch', '--show-current'), f.project);
});

test('unresolved integration is preserved as an incomplete attempt, never aborted or built', async t => {
  const f = fixture(t); const cwd = conflicting(f); f.capability.integrateConflicts = async () => {};
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(git(cwd, 'diff', '--name-only', '--diff-filter=U'), 'base.txt');
  assert.equal(f.calls.length, 0); assert.equal(f.state().phase, 'plan_pending');
});

test('unexpected process exit never releases ownership or starts another builder', async t => {
  const f = fixture(t); f.deps.session = async call => { f.calls.push(call); return { ...completed, normal_exit: false, reason: 'unexpected-process-exit' }; };
  const runner = createRunner({ deps: f.deps, autonomous: f.capability });
  await runner.runStep(f.project, f.world(f.record));
  assert.equal(f.state().phase, 'plan_pending'); assert.ok(f.state().active_run);
  assert.equal(await runner.runStep(f.project, f.world(f.record)), 'skipped:autonomous-owned');
  assert.equal(f.calls.length, 1);
});


test('durable admission arbitrates two runner instances without removing the winner current file', async t => {
  const f = fixture(t); const entered = deferred(); const finish = deferred(); t.after(finish.resolve);
  f.deps.session = async call => { f.calls.push(call); entered.resolve(); await finish.promise; return completed; };
  const a = createRunner({ deps: f.deps, autonomous: f.capability });
  const b = createRunner({ deps: f.deps, autonomous: f.capability });
  const first = a.runStep(f.project, f.world(f.record));
  const second = b.runStep(f.project, f.world(f.record));
  await entered.promise;
  assert.equal(await second, 'skipped:autonomous-owned');
  assert.ok(existsSync(a.paths.currentFor('memoro-cli'))); assert.equal(f.calls.length, 1);
  finish.resolve(); await first;
});

test('a live previous gate forbids main sync and a new builder', async t => {
  const f = fixture(t); const cwd = f.cwd(f.project);
  mkdirSync(join(f.root, 'step', f.project), { recursive: true });
  git(f.primary, 'worktree', 'add', '-qb', f.project, cwd, 'origin/main');
  const state = f.state(); state.ownership.branch = f.project; writeFileSync(f.paths.project, JSON.stringify(state));
  const head = git(cwd, 'rev-parse', 'HEAD');
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitDir, 'mc-gate.json'), JSON.stringify({ pid: process.pid }));
  f.advanceMain('new main\n');
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head); assert.equal(f.calls.length, 0);
  assert.ok(f.state().attempts[0].reason.includes('gate-worker-alive'));
});


test('autonomous integration keeps both .gitignore intents instead of taking legacy theirs-only resolution', async t => {
  const f = fixture(t); const cwd = f.cwd(f.project);
  mkdirSync(join(f.root, 'step', f.project), { recursive: true });
  git(f.primary, 'worktree', 'add', '-qb', f.project, cwd, 'origin/main');
  writeFileSync(join(cwd, '.gitignore'), 'project-cache/\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Project ignore');
  const state = f.state(); state.ownership.branch = f.project; writeFileSync(f.paths.project, JSON.stringify(state));
  writeFileSync(join(f.primary, '.gitignore'), 'main-cache/\n'); f.advanceMain('new main\n');
  let resolved = false;
  f.capability.integrateConflicts = async ({ conflicts }) => {
    assert.deepEqual(conflicts, ['.gitignore']); resolved = true;
    writeFileSync(join(cwd, '.gitignore'), 'project-cache/\nmain-cache/\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Keep both ignores');
  };
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(resolved, true); assert.equal(f.calls.length, 1);
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), 'project-cache/\nmain-cache/\n');
});

test('oversize current assignments fail closed without truncation or a model launch', async t => {
  const f = fixture(t); const state = f.state();
  state.contract.goal = ['x'.repeat(SESSION_START_MAX_BYTES)];
  writeFileSync(f.paths.project, JSON.stringify(state));
  writeFileSync(join(f.paths.projectDir, 'PLAN.json'), JSON.stringify(state.contract));
  const record = { ...f.record, plan: state.contract };
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(record));
  assert.equal(f.calls.length, 0); assert.equal(f.state().phase, 'plan_pending');
  assert.ok(f.state().attempts[0].reason.includes('session start: exceeds'));
});


test('recreating an owned checkout preserves its existing unpublished branch and commits', async t => {
  const f = fixture(t);
  git(f.primary, 'checkout', '-qb', f.project);
  writeFileSync(join(f.primary, 'local.txt'), 'unpublished commit\n'); git(f.primary, 'add', '.'); git(f.primary, 'commit', '-qm', 'Local work');
  const head = git(f.primary, 'rev-parse', 'HEAD'); git(f.primary, 'checkout', '-q', 'main');
  const state = f.state(); state.ownership.branch = f.project; writeFileSync(f.paths.project, JSON.stringify(state));
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(f.calls.length, 1); assert.equal(git(f.cwd(f.project), 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(f.cwd(f.project), 'local.txt'), 'utf8'), 'unpublished commit\n');
});

test('an existing unowned project-named worktree is preserved, not adopted or synced', async t => {
  const f = fixture(t); const cwd = conflicting(f); const state = f.state();
  state.ownership.branch = null; writeFileSync(f.paths.project, JSON.stringify(state));
  const head = git(cwd, 'rev-parse', 'HEAD');
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(f.calls.length, 0); assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(git(cwd, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.ok(f.state().attempts[0].reason.includes('unowned worktree'));
});
