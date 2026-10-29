import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { sessionTransport } from '../../src/adapters/index.js';
import { createSessionObservation } from '../../src/mc/session-observation.js';
import { createSessionControl, decideSessionControl, interruptSessionControl } from '../../src/mc/session-control.js';
import { projectSessionObserver } from '../../src/mc/session-supervision.js';
import { preserveSession, groupAlive, reconcilePreviousSession, reconcileSessionGate, sessionGitDir } from '../../src/mc/session-recovery.js';
import { streamSession } from '../../src/mc/run.js';
import { startProjectSessionControl, projectSessionCheckpoint, readAutonomousState } from '../../src/mc/autonomous-state.js';
import { takeGateLock, gateLockPath } from '../../src/mc/gate-lock.js';
import { readClaim } from '../../src/mc/resource-claim.js';
import { builder, stateFixture } from './autonomous-state-fixture.js';
import { attribution } from './autonomy-fixtures.js';

// All event payloads below are synthetic protocol fixtures. They establish mc's
// interpretation, not telemetry capabilities of a paid/live provider session.
const profile = () => ({ soft_active_ms: 500, upper_active_ms: 1000, emergency_active_ms: 2000, reserve_active_ms: 500,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 800, tool_wait_ms: 2500, lane_wait_ms: 2500, total_awake_ms: 4000,
  no_progress_ms: 10000, max_stagnant_sessions: 3, max_failures: 3 });
const sample = (at_ms = 0, awake_ms = at_ms, sequence = 0) => ({ at_ms, awake_ms, sequence });
function fresh(tool = 'codex', extra = {}) {
  const transport = createSessionObservation(tool, extra);
  const state = createSessionControl({ binding: { ...attribution(), run_id: 'build-1' }, profile: profile(), observation: transport.sample(sample()) });
  return { transport, state };
}
function repo(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mc-session-observation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repo'); mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(cwd, 'code.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  return { directory, cwd, git, gitDir: sessionGitDir(cwd) };
}

it('both adapter transports declare durable-only autonomous control and honest context support', () => {
  assert.equal(sessionTransport('codex').prompt, 'argument');
  assert.equal(sessionTransport('claude').prompt, 'stdin-jsonl');
  for (const tool of ['codex', 'claude-code']) assert.equal(sessionTransport(tool).live_control, false);
  assert.throws(() => sessionTransport('not-a-tool'));
});
it('Codex cumulative usage never becomes current context, even with a configured window', () => {
  const { transport, state } = fresh('codex', { contextWindow: 100 });
  transport.event({ type: 'turn.completed', usage: { input_tokens: 900000, output_tokens: 200 } }, 0);
  const next = decideSessionControl(state, transport.sample(sample(1000, 1000, 1)));
  assert.equal(next.context.quality, 'unknown'); assert.equal(next.context.fraction, null);
  assert.equal(next.phase, 'closing', 'unknown context uses the active-time upper boundary');
  assert.equal(transport.telemetry.cumulative_usage.input_tokens, 900000);
  assert.equal(transport.telemetry.last_request_context, null);
});
it('Claude request context is explicitly estimated, timestamped, stale/absent is unknown, subagents ignored', () => {
  const { transport, state } = fresh('claude', { contextWindow: 100 });
  const event = { type: 'assistant', message: { model: 'fixture', usage: { input_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }, content: [] } };
  transport.event(event, 0);
  transport.event({ ...event, parent_tool_use_id: 'subagent', message: { ...event.message, usage: { input_tokens: 99 } } }, 0);
  const next = decideSessionControl(state, transport.sample(sample(10, 10, 1)));
  assert.equal(next.context.fraction, 0.6); assert.equal(next.context.quality, 'estimated'); assert.equal(next.context.at_ms, 0);
  assert.match(next.context.source, /assistant.usage/);
  const stale = decideSessionControl(next, transport.sample(sample(51, 51, 2)));
  assert.equal(stale.context.quality, 'unknown'); assert.equal(stale.context.fraction, null); assert.equal(stale.context.at_ms, 0);
  const noWindow = fresh('claude').transport; noWindow.event(event, 0);
  assert.equal(noWindow.sample(sample()).context, null);
  transport.event({ ...event, message: { model: '<synthetic>', usage: { input_tokens: 99 } } }, 52);
  assert.equal(transport.telemetry.last_request_context.tokens, 60);
});
it('synthetic lifecycle events track both transports, including concurrent calls and background tasks', () => {
  const codex = fresh().transport;
  for (const [id, type] of [['a', 'command_execution'], ['b', 'mcp_tool_call']]) codex.event({ type: 'item.started', item: { id, type } }, 0);
  const first = codex.sample(sample()).activity; assert.equal(first.kind, 'tool'); assert.match(first.id, /^tool-[a-f0-9]+$/);
  codex.event({ type: 'item.completed', item: { id: 'a', type: 'command_execution' } }, 1);
  assert.notEqual(codex.sample(sample()).activity.id, first.id);
  codex.event({ type: 'item.completed', item: { id: 'b', type: 'mcp_tool_call' } }, 2);
  assert.equal(codex.sample(sample()).activity.kind, 'model');
  const claude = fresh('claude').transport;
  claude.event({ type: 'assistant', message: { model: 'fixture', content: [{ type: 'tool_use', id: 'call-1' }] } }, 0);
  assert.equal(claude.sample(sample()).activity.kind, 'tool');
  claude.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } }, 1);
  claude.event({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] }, 1);
  claude.event({ type: 'result', subtype: 'success', num_turns: 1 }, 1);
  assert.equal(claude.completed, false);
  claude.event({ subtype: 'background_tasks_changed', tasks: [] }, 2);
  assert.equal(claude.sample(sample()).activity.kind, 'model');
});
it('known gate/lane waits and explicit suspend clocks feed the policy without output counting as progress', () => {
  const { transport, state } = fresh();
  const asleep = decideSessionControl(state, transport.sample({ ...sample(60000, 0, 1), activity: { kind: 'gate', id: 'gate-1' } }));
  assert.equal(asleep.totals.sleep_ms, 60000); assert.equal(asleep.totals.active_ms, 0);
  const expired = decideSessionControl(asleep, transport.sample({ ...sample(62500, 2500, 2), activity: { kind: 'model', id: null } }));
  assert.equal(expired.reason, 'gate-wait-exhausted'); assert.equal(expired.result.normal_exit, false);
});

function localObserver(tool = 'codex') {
  let control = fresh(tool).state;
  return { control, observe: o => (control = decideSessionControl(control, o)),
    interrupt: reason => (control = interruptSessionControl(control, reason)) };
}
// These tests measure exit outcomes, not budgets. Synthetic clock: wall time is
// real but awake time stays frozen, so cold fixture startup under lane load
// cannot reach the closing/emergency boundary and kill the fixture before it
// prints the events under test. Budgets are exercised in the policy tests.
function shortSession(work, observer, extra = {}) {
  const began = Date.now();
  return streamSession({ bin: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/session-process.js', import.meta.url)), extra.tool || 'codex', extra.mode || '--success'],
    cwd: work.cwd, env: process.env, prompt: extra.tool === 'claude' ? 'fixture' : null,
    ...extra.session,
    autonomous: { version: 1, tool: extra.tool || 'codex', ...observer,
      clock: () => ({ at_ms: Date.now() - began, awake_ms: 0 }),
      directory: join(work.directory, 'attempt'), pollMs: 20, termMs: 100, ...extra.autonomous } });
}
for (const tool of ['codex', 'claude']) it(`${tool}: observed cooperative process exit is distinct from green publication evidence`, async t => {
  const work = repo(t); const result = await shortSession(work, localObserver(tool), { tool });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.normal_exit, true); assert.equal(result.recovery_ready, true);
  assert.equal(result.control.result, null, 'transport completion does not manufacture a handoff/gate result');
  assert.equal(existsSync(join(work.directory, 'attempt', 'snapshot', 'checkpoint.json')), true);
});
it('exit zero without an observed complete result is durably incomplete, not success', async t => {
  const work = repo(t); const result = await shortSession(work, localObserver(), { mode: '--unexpected' });
  assert.equal(result.status, 1); assert.equal(result.normal_exit, false); assert.equal(result.control.result.outcome, 'incomplete');
  assert.equal(JSON.parse(readFileSync(join(work.directory, 'attempt', 'result.json'), 'utf8')).normal_exit, false);
});
it('unreconciled transport tools cannot be assumed dead just because the provider group exited', async t => {
  const work = repo(t); const result = await shortSession(work, localObserver(), { mode: '--pending-tool' });
  assert.equal(result.normal_exit, false); assert.equal(result.recovery_ready, false);
  assert.equal(result.recovery.reason, 'tool-children-unknown'); assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
});
it('lost observation or persistence cannot create a successful or recoverable normal exit', async t => {
  const work = repo(t);
  const result = await shortSession(work, localObserver(), { autonomous: {
    clock: () => { throw new Error('clock unavailable'); }, interrupt: () => { throw new Error('disk unavailable'); },
  } });
  assert.equal(result.normal_exit, false); assert.equal(result.control.result.outcome, 'incomplete');
  assert.equal(result.recovery_ready, false); assert.match(result.stderr, /disk unavailable/);
  assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
});
it('failed code preservation blocks recovery even after a successful transport result', async t => {
  const work = repo(t);
  const result = await shortSession(work, localObserver(), { session: { onSpawn: () => mkdirSync(join(work.directory, 'attempt', 'snapshot')) } });
  assert.equal(result.normal_exit, false); assert.equal(result.recovery_ready, false); assert.equal(result.control.reason, 'preservation-failed');
  assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
});
it('failed result artifact write cannot finalize a recoverable workarea manifest', async t => {
  const work = repo(t);
  const result = await shortSession(work, localObserver(), { session: { onSpawn: () => mkdirSync(join(work.directory, 'attempt', 'result.json')) } });
  assert.equal(result.normal_exit, false); assert.equal(result.recovery_ready, false);
  assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
});
it('a foreign/corrupt checkpoint or code changed after the snapshot refuses recovery', async t => {
  const work = repo(t); await shortSession(work, localObserver());
  assert.equal(reconcilePreviousSession(work.gitDir).ok, true);
  writeFileSync(join(work.cwd, 'code.txt'), 'changed after exit\n');
  assert.equal(reconcilePreviousSession(work.gitDir).reason, 'previous-worktree-changed');
  writeFileSync(join(work.cwd, 'code.txt'), 'base\n');
  const path = join(work.directory, 'attempt', 'snapshot', 'checkpoint.json');
  const checkpoint = JSON.parse(readFileSync(path, 'utf8')); checkpoint.control.binding.run_id = 'foreign-run';
  writeFileSync(path, JSON.stringify(checkpoint));
  assert.equal(reconcilePreviousSession(work.gitDir).reason, 'previous-snapshot-mismatch');
  writeFileSync(path, '{'); assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
});
it('a gate still running after cooperative transport exit blocks the next builder and cannot count as success', async t => {
  const work = repo(t);
  const result = await shortSession(work, localObserver(), { session: { onSpawn: () => writeFileSync(join(work.gitDir, 'mc-gate.json'), JSON.stringify({ pid: process.pid })) } });
  assert.equal(result.status, 1); assert.equal(result.normal_exit, false); assert.equal(result.recovery_ready, false);
  assert.equal(result.control.reason, 'gate-worker-alive'); assert.equal(reconcilePreviousSession(work.gitDir).ok, false);
  assert.equal(result.recovery.reason, 'gate-worker-alive', JSON.stringify(result));
  assert.equal(JSON.parse(readFileSync(join(work.directory, 'attempt', 'snapshot', 'checkpoint.json'), 'utf8')).control.phase, 'incomplete');
});
it('supervision refuses missing clocks, terminal control or in-worktree artifacts before spawning', async t => {
  const work = repo(t); const observer = localObserver();
  await assert.rejects(shortSession(work, observer, { autonomous: { clock: null } }), /contract/);
  await assert.rejects(shortSession(work, observer, { autonomous: { directory: join(work.cwd, 'output') } }), /outside/);
  await assert.rejects(shortSession(work, { ...observer, control: observer.interrupt('test') }), /terminal/);
  assert.equal(existsSync(join(work.cwd, 'output')), false);
});

for (const tool of ['codex', 'claude']) it(`${tool}: ignored durable closure and SIGTERM force bounded process-group cleanup and preserve code`, { timeout: 15000 }, async t => {
  const work = repo(t); const fx = stateFixture(); t.after(fx.cleanup); fx.setupProject(); const start = fx.switchProject(builder);
  writeFileSync(join(work.cwd, 'code.txt'), 'staged\n'); work.git('add', 'code.txt'); writeFileSync(join(work.cwd, 'code.txt'), 'unstaged\n');
  writeFileSync(join(work.cwd, 'new.txt'), 'untracked\n'); chmodSync(join(work.cwd, 'new.txt'), 0o755); symlinkSync('code.txt', join(work.cwd, 'link'));
  const before = work.git('status', '--porcelain=v1');
  const began = Date.now(); const ready = join(work.directory, 'ready'); let activeStart = null;
  // Synthetic clock: freeze active time until the fixture has installed its
  // handlers/status command. Cold module/git startup under lane load is NOT
  // the behavior this test measures. Wall time remains real; no policy budget
  // or threshold is relaxed, and a fixture that never becomes ready fails.
  const clock = () => {
    const now = Date.now();
    if (activeStart === null && existsSync(ready)) activeStart = now;
    if (activeStart === null && now - began > 10000) throw new Error('fixture did not become ready');
    return { at_ms: now - began, awake_ms: activeStart === null ? 0 : now - activeStart };
  };
  startProjectSessionControl(fx.root, fx.programme, fx.project, { actor: builder, revision: start.revision,
    profile: profile(), observation: fresh(tool).transport.sample(sample()) });
  const observer = projectSessionObserver({ root: fx.root, programme: fx.programme, project: fx.project, actor: builder });
  const closing = join(work.directory, 'closing.json'); let pid;
  t.after(() => { if (pid && groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* own fixture already gone */ } } });
  const result = await streamSession({ bin: process.execPath, args: [fileURLToPath(new URL('./fixtures/session-process.js', import.meta.url)), tool],
    cwd: work.cwd, env: { ...process.env, MC_TEST_STATE: fx.paths.project, MC_TEST_ROOT: fx.root, MC_TEST_CLOSING: closing, MC_TEST_READY: ready },
    prompt: tool === 'claude' ? 'synthetic fixture assignment' : null, onSpawn: value => { pid = value; },
    autonomous: { version: 1, tool, ...observer, clock, directory: join(work.directory, 'attempt'), pollMs: 20, termMs: 100 } });
  assert.equal(result.status !== 0, true, result.stderr); assert.equal(result.normal_exit, false); assert.equal(result.interrupted, true);
  assert.equal(result.recovery_ready, true, JSON.stringify(result.recovery)); assert.equal(groupAlive(pid), false);
  assert.match(result.stdout, /fixture-child:\d+/); assert.equal(JSON.parse(readFileSync(closing, 'utf8')).next_action, 'finish-session');
  assert.equal(result.control.result.normal_exit, false); assert.equal(result.control.context.quality, 'unknown');
  const snapshot = join(work.directory, 'attempt', 'snapshot');
  assert.equal(readFileSync(join(snapshot, 'files', 'code.txt'), 'utf8'), 'unstaged\n');
  assert.equal(readFileSync(join(snapshot, 'files', 'new.txt'), 'utf8'), 'untracked\n');
  assert.ok(lstatSync(join(snapshot, 'files', 'new.txt')).mode & 0o111); assert.equal(readlinkSync(join(snapshot, 'files', 'link')), 'code.txt');
  assert.match(readFileSync(join(snapshot, 'index.patch'), 'utf8'), /\+staged/);
  assert.equal(JSON.parse(readFileSync(join(snapshot, 'checkpoint.json'), 'utf8')).control.phase, 'incomplete');
  assert.equal(work.git('status', '--porcelain=v1'), before); assert.equal(reconcilePreviousSession(work.gitDir).ok, true);
  const durable = readAutonomousState(fx.root, fx.programme, fx.project);
  assert.equal(projectSessionCheckpoint(fx.root, fx.programme, fx.project, 'status', {}, { actor: builder, revision: durable.revision }).next_action, 'stop-session');
});

it('gate reconciliation holds live/unknown detached children and preserves a successor lane owner', t => {
  const work = repo(t); const root = join(work.directory, 'mc'); mkdirSync(root);
  const request = join(work.directory, 'gate.request'); const log = join(work.directory, 'gate.log'); const lockPath = join(work.gitDir, 'mc-gate.json');
  writeFileSync(request, JSON.stringify({ reservation: { root, lane: 'light' } }));
  const lock = { pid: 2147483000, request, log };
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.equal(reconcileSessionGate(work.gitDir, { alive: () => true }).reason, 'gate-worker-alive');
  assert.equal(reconcileSessionGate(work.gitDir).reason, 'gate-children-unknown');
  assert.ok(existsSync(lockPath));
  writeFileSync(`${request}.result`, JSON.stringify({ ok: true, code: 0 })); writeFileSync(`${log}.exit`, '\n');
  assert.equal(reconcileSessionGate(work.gitDir).reason, 'gate-children-unknown', 'an empty exit record is not exit zero');
  assert.equal(takeGateLock({ root, lane: 'light', pid: process.pid }).ok, true);
  const claim = readClaim(`${gateLockPath(root, 'light')}.claim`);
  writeFileSync(`${request}.result`, JSON.stringify({ ok: false, code: 1 })); writeFileSync(`${log}.exit`, '1\n');
  assert.equal(reconcileSessionGate(work.gitDir).ok, true); assert.equal(existsSync(lockPath), false);
  assert.equal(readClaim(`${gateLockPath(root, 'light')}.claim`).marker, claim.marker);
});
it('an unobserved predecessor or missing snapshot refuses another builder without signalling it', t => {
  const work = repo(t); const path = join(work.gitDir, 'mc-autonomous-session.json');
  writeFileSync(path, JSON.stringify({ pid: null, process_closed: false }));
  assert.equal(reconcilePreviousSession(work.gitDir).reason, 'previous-start-unknown');
  writeFileSync(path, JSON.stringify({ pid: 2147483000, process_closed: true }));
  assert.equal(reconcilePreviousSession(work.gitDir).reason, 'previous-snapshot-required');
});
it('snapshots include export-ignored raw files and refuse artifacts inside the worktree', t => {
  const work = repo(t); writeFileSync(join(work.cwd, '.gitattributes'), 'code.txt export-ignore\n');
  const directory = join(work.directory, 'attempt'); mkdirSync(directory);
  const snapshot = preserveSession({ cwd: work.cwd, directory, control: {}, telemetry: {}, process: {} });
  assert.equal(readFileSync(join(snapshot, 'files', 'code.txt'), 'utf8'), 'base\n');
  assert.throws(() => preserveSession({ cwd: work.cwd, directory: work.cwd, control: {} }), /outside/);
});
it('without explicit autonomous input, both v1 stream watches retain their launch and result behavior', async () => {
  for (const prompt of [null, 'legacy']) {
    const child = new EventEmitter(); let launch; const written = [];
    child.pid = 42; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { writable: true, write: line => written.push(line), end() {} });
    const running = streamSession({ bin: 'fixture', args: [], cwd: '/unused', prompt,
      spawn: (...args) => { launch = args[2]; return child; } });
    assert.equal(launch.detached, undefined); assert.equal(launch.stdio[0], prompt === null ? 'ignore' : 'pipe');
    assert.equal(written.length, prompt === null ? 0 : 1);
    child.emit('close', 0, null); assert.equal((await running).status, 0);
  }
});
