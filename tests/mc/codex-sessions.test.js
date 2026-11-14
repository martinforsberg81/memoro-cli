/**
 * A Codex entrance session: one `codex app-server` per session, the person's
 * terminal a `--remote` client. Process, socket, fs-clock and rpc boundaries
 * are injected; no real Codex, network or wait runs here.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { CodexServerError, readThreads, withCodexServer } from '../../src/mc/codex-rpc.js';
import { clientArgs, codexSessionDriver, serverArgs, sessionThread, splitLaunchArgs, turnRunning } from '../../src/mc/codex-sessions.js';
import { foregroundDir } from '../../src/mc/foreground.js';
import { rememberRuntimeSecretNames } from '../../src/mc/runtime-secrets.js';
import { prepareSessionEntrance } from '../../src/mc/session-entrance.js';
import { interactiveLaunchPlan } from '../../src/mc/work-open.js';

const STARTED = '2026-11-14T00:00:00Z';
const SERVER_PID = 4242;
const MC_PID = 777;
const thread = (id, fields = {}) => ({ id, ephemeral: false, parentThreadId: null, preview: 'a first turn', updatedAt: 1,
  status: { type: 'idle' }, ...fields });

/** A desk, a Codex plan for it, and a driver whose every boundary is a recording stub. */
async function world({ billing = 'plan', why = 'no key', settings = {}, deps = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-codex-sessions-'));
  const worktree = join(root, 'work', 'programs', 'example');
  mkdirSync(worktree, { recursive: true });
  const env = { HOME: root, PATH: process.env.PATH, TERM: 'xterm-256color', MC_HOME: join(root, 'home'),
    MC_WORK_ROOT: join(root, 'work'), CODEX_HOME: join(root, 'codex'), SSH_CONNECTION: 'ssh',
    MC_GOAL: 'example/goal', MC_HEADLESS: '1', OPENAI_API_KEY: 'sk-test-key', MC_TEST_SECRET: 'runtime-secret' };
  rememberRuntimeSecretNames(['MC_TEST_SECRET'], env);
  const lines = [];
  const base = { areaRoot: worktree, worktree: { path: worktree, is_git: false }, env, verb: 'plan', roleName: 'plan',
    programme: 'example', areaName: 'programs/example', tool: 'codex', overlay: 'ROLE TEXT', isInteractive: () => true,
    conversations: () => [], identify: () => ({ role: 'plan', programme: 'example' }),
    billingRoute: () => ({ billing, why }), stdout: { write() {} }, stderr: { write: line => lines.push(line) }, ...settings };
  const plan = await interactiveLaunchPlan(base);
  assert.equal(plan.ok, true, plan.reason);
  const live = new Set();
  const w = { root, worktree, env, plan, lines, killed: [], registered: [], asked: [], run: { calls: [], result: { status: null, signal: 'SIGHUP' } },
    held: new Map(), down: new Set(), pids: [SERVER_PID, SERVER_PID + 1, SERVER_PID + 2], live };
  w.spawn = Object.assign((bin, args, opts) => {
    const pid = w.pids.shift();
    w.spawn.calls.push({ bin, args, opts, pid });
    live.add(pid);
    return { pid, once() {}, unref() {} };
  }, { calls: [] });
  w.options = { ...base, launch: plan.launch };
  let clock = 0;
  w.driver = codexSessionDriver({
    spawnProcess: w.spawn, alive: pid => live.has(pid), mcPid: MC_PID,
    run: (bin, args, opts) => { w.run.calls.push({ bin, args, opts }); return w.run.result; },
    threads: async (socket) => {
      w.asked.push(socket);
      if (w.down.has(socket)) throw new CodexServerError('unreachable', `server not answering on its socket ${socket}: ECONNREFUSED`);
      return w.held.get(socket) ?? [];
    },
    register: entry => w.registered.push({ ...entry, env: undefined, started: STARTED }),
    kill: (pid, signal) => { w.killed.push([pid, signal]); live.delete(pid); },
    now: () => clock, sleep: async ms => { clock += ms; }, ...deps,
  });
  w.entrance = (options = {}, entranceDeps = {}) => prepareSessionEntrance({ ...w.options, ...options }, w.driver, {
    lock: () => async () => {}, records: () => w.registered, alive: pid => live.has(pid),
    choose: () => assert.fail('must not ask'), ...entranceDeps });
  w.cleanup = () => rmSync(root, { recursive: true, force: true });
  return w;
}

const configOf = args => args.slice(0, args.indexOf('app-server')).filter((_, index) => index % 2 === 1);

test('server argv: root-level configuration, app-server listening on the session socket, started in the worktree', async () => {
  const w = await world({ settings: { prompt: 'hello' } });
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    const { bin, args, opts } = w.spawn.calls[0];
    assert.equal(bin, w.plan.launch.spec.bin);
    const at = args.indexOf('app-server');
    assert.deepEqual(args.slice(at), ['app-server', '--listen', `unix://${session.socket}`]);
    assert.ok(args.slice(0, at).every((arg, index) => index % 2 === 1 || arg === '-c'), 'configuration pairs only');
    const config = configOf(args);
    assert.ok(config.some(entry => entry.startsWith('developer_instructions=') && entry.includes('ROLE TEXT')));
    for (const entry of ['model="gpt-6.1-sol"', 'project_doc_max_bytes=0', 'features.multi_agent=true']) assert.ok(config.includes(entry), entry);
    assert.equal(args.includes('hello'), false, 'the first words are the client\'s');
    assert.equal(opts.cwd, w.worktree);
    assert.equal(opts.detached, true);
    assert.equal(session.pid, SERVER_PID);
  } finally { w.cleanup(); }
});

test('server environment keeps the role identity and drops the goal, headless mark, provider key and runtime secret', async () => {
  const w = await world();
  try {
    await w.driver.start(w.options, w.plan, 'mc plan example');
    const { env } = w.spawn.calls[0].opts;
    assert.equal(env.MC_ROLE, 'plan');
    assert.equal(env.MC_PROGRAMME, 'example');
    for (const name of ['MC_GOAL', 'MC_HEADLESS', 'OPENAI_API_KEY', 'MC_TEST_SECRET']) assert.equal(name in env, false, name);
    assert.equal(env.CODEX_HOME, w.env.CODEX_HOME);
  } finally { w.cleanup(); }
});

test('the session directory is private, user-owned and holds the socket, the log and the session record', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    const directory = dirname(session.socket);
    const stat = statSync(directory);
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, process.getuid());
    assert.equal(statSync(join(directory, 'server.log')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8')).pid, SERVER_PID);
    assert.ok(directory.startsWith(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions')), 'only inside mc\'s work root');
  } finally { w.cleanup(); }
});

test('plan billing starts the server directly; credits start it behind the gateway wrapper with no key on argv', async () => {
  const plain = await world();
  const credits = await world({ billing: 'credits' });
  try {
    await plain.driver.start(plain.options, plain.plan, 'mc plan example');
    assert.equal(plain.spawn.calls[0].bin, plain.plan.launch.spec.bin);
    await credits.driver.start(credits.options, credits.plan, 'mc plan example');
    const call = credits.spawn.calls[0];
    assert.equal(call.bin, process.execPath);
    assert.deepEqual(call.args.slice(1, 4), ['codex', '*', credits.plan.launch.spec.bin]);
    assert.ok(existsSync(call.args[0]), 'the wrapper is a script that exists');
    assert.ok(call.args.slice(4).includes('app-server'));
    assert.doesNotMatch(JSON.stringify(call), /sk-test-key|runtime-secret/u);
  } finally { plain.cleanup(); credits.cleanup(); }
});

test('unavailable billing is refused with its reason before anything is created or started', async () => {
  const w = await world({ billing: 'unavailable', why: 'credits exhausted' });
  try {
    const result = await w.driver.start(w.options, w.plan, 'mc plan example');
    assert.deepEqual(result, { ok: false, reason: 'Codex billing unavailable: credits exhausted' });
    assert.equal(w.spawn.calls.length, 0);
    assert.equal(existsSync(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions')), false);
  } finally { w.cleanup(); }
});

test('the client argv names the server, the conversation and the first words, and carries no configuration', async () => {
  const w = await world({ settings: { prompt: 'hello' } });
  const resumed = await world({ settings: { conversations: () => [{ id: 'conv-1', tool: 'codex', updated_ms: 1 }] } });
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    await w.driver.join(w.options, session);
    assert.deepEqual(w.run.calls[0].args, ['--remote', `unix://${session.socket}`, 'hello']);
    const second = await resumed.driver.start(resumed.options, resumed.plan, 'mc plan example');
    await resumed.driver.join(resumed.options, second.session);
    const argv = resumed.run.calls[0].args;
    assert.deepEqual(argv, ['resume', 'conv-1', '--remote', `unix://${second.session.socket}`]);
    for (const [world_, call] of [[w, w.run.calls[0]], [resumed, resumed.run.calls[0]]]) {
      assert.equal(call.args.some(arg => /^(-c|-m|--model|--sandbox|--add-dir)$|developer_instructions/u.test(arg)), false);
      assert.equal(call.opts.cwd, world_.worktree);
      assert.equal('MC_ROLE' in call.opts.env, false, 'the terminal client is not the role\'s session');
      assert.equal('OPENAI_API_KEY' in call.opts.env, false);
    }
  } finally { w.cleanup(); resumed.cleanup(); }
});

test('the TUI flags a server has no flag for become configuration; an unknown flag is refused by name', () => {
  assert.deepEqual(splitLaunchArgs(['--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--add-dir', '/a', '--add-dir', '/b',
    '-m', 'gpt', '-c', 'k=v', 'first words']), {
    config: ['sandbox_mode="workspace-write"', 'approval_policy="never"', 'model="gpt"', 'k=v',
      'sandbox_workspace_write.writable_roots=["/a","/b"]'],
    resume: null, prompt: 'first words' });
  assert.deepEqual(splitLaunchArgs(['resume', '-m', 'gpt', 'conv-1']), { config: ['model="gpt"'], resume: 'conv-1', prompt: null });
  assert.deepEqual(splitLaunchArgs(['resume', 'conv-1', 'reply']).prompt, 'reply');
  assert.throws(() => splitLaunchArgs(['--full-auto']), /--full-auto has no app-server equivalent/u);
  assert.throws(() => splitLaunchArgs(['-m']), /-m has no value/u);
  assert.throws(() => splitLaunchArgs(['resume']), /names no conversation/u);
  assert.deepEqual(clientArgs('/s', { prompt: '-x' }), ['--remote', 'unix:///s', '--', '-x']);
  assert.deepEqual(serverArgs('/s', ['k=v']), ['-c', 'k=v', 'app-server', '--listen', 'unix:///s']);
});

test('the session thread is the loaded, non-ephemeral, parentless one that has had a turn, newest first', () => {
  const title = thread('title', { ephemeral: true });
  const child = thread('child', { parentThreadId: 'real' });
  assert.equal(sessionThread([title, thread('real'), child]).id, 'real');
  assert.equal(sessionThread([title, child]), null);
  assert.equal(sessionThread([thread('empty', { preview: '', updatedAt: 9 }), thread('used', { updatedAt: 1 })]).id, 'used');
  assert.equal(sessionThread([thread('old', { updatedAt: 1 }), thread('new', { updatedAt: 2 })]).id, 'new');
  assert.equal(turnRunning([thread('a'), thread('b', { status: { type: 'active', activeFlags: [] } })]), true);
  assert.equal(turnRunning([thread('a'), thread('b', { status: { type: 'systemError' } })]), false);
});

test('a server that dies, never answers or cannot be spawned is cleared away and never registered', async () => {
  for (const [name, deps, pattern] of [
    ['exits', { threads: async () => { throw new CodexServerError('unreachable', 'ECONNREFUSED'); }, alive: () => false }, /exited before answering on its socket/u],
    ['is silent', { threads: async () => { throw new CodexServerError('unreachable', 'ECONNREFUSED'); } }, /not answering on its socket .* within 15000 ms/u],
    ['answers with garbage', { threads: async () => { throw new CodexServerError('overflow', 'server sent more than 1 bytes'); } }, /sent more than/u],
  ]) {
    const w = await world({ deps });
    try {
      const result = await w.driver.start(w.options, w.plan, 'mc plan example');
      assert.equal(result.ok, false, name);
      assert.match(result.reason, pattern, name);
      assert.deepEqual(w.registered, [], name);
      assert.deepEqual(readdirSync(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions')), [], `${name}: nothing left behind`);
    } finally { w.cleanup(); }
  }
});

test('a server that is slow to answer is polled until it does, then registered on the server pid', async () => {
  let refusals = 3;
  const w = await world({ deps: { threads: async () => { if (refusals-- > 0) throw new CodexServerError('unreachable', 'ENOENT'); return []; } } });
  try {
    const result = await w.driver.start(w.options, w.plan, 'mc plan example');
    assert.equal(result.ok, true);
    assert.deepEqual(w.registered.map(entry => entry.pid), [SERVER_PID]);
  } finally { w.cleanup(); }
});

// Entrance rules, through the provider-neutral entrance with the Codex driver.

test('a desk with no session starts one, registers the server pid and leaves it running when the terminal hangs up', async () => {
  const w = await world();
  try {
    const prepared = await w.entrance();
    const result = await prepared.start(w.plan);
    assert.equal(result.ok, true);
    assert.equal(w.spawn.calls.length, 1);
    assert.deepEqual(w.registered.map(entry => [entry.pid, entry.verb, entry.programme]), [[SERVER_PID, 'plan', 'example']]);
    assert.notEqual(w.registered[0].pid, process.pid, 'the register names the server, not the launcher');
    assert.equal(result.running, true);
    assert.deepEqual(w.killed, []);
    assert.equal(readdirSync(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions')).length, 1);
  } finally { w.cleanup(); }
});

test('an existing session is offered next to a new one; joining attaches without starting a second server', async () => {
  const w = await world();
  try {
    await (await w.entrance()).start(w.plan);
    const offered = [];
    const prepared = await w.entrance({}, { choose: (title, items) => { offered.push(items.map(item => item.label)); return items[0].value; } });
    assert.deepEqual(offered, [[`mc plan example  started ${STARTED}`, 'start a new one']]);
    assert.equal(prepared.result.ok, true);
    assert.equal(prepared.result.running, true);
    assert.equal(w.spawn.calls.length, 1);
    assert.equal(w.run.calls.length, 2, 'the first start and the join each ran a client');
  } finally { w.cleanup(); }
});

test('--new starts another server named with the lowest free suffix, without asking', async () => {
  const w = await world();
  try {
    await (await w.entrance()).start(w.plan);
    const prepared = await w.entrance({ pick: 'new' });
    await prepared.start(w.plan);
    assert.equal(w.spawn.calls.length, 2);
    const names = readdirSync(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions'))
      .map(name => JSON.parse(readFileSync(join(w.env.MC_WORK_ROOT, 'runner', 'codex-sessions', name, 'session.json'), 'utf8')).name);
    assert.deepEqual(names.sort(), ['mc plan example', 'mc plan example 2']);
  } finally { w.cleanup(); }
});

test('--resume of a held conversation joins the server that holds it', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.held.set(session.socket, [thread('conv-1')]);
    const prepared = await w.entrance({ chosen: { id: 'conv-1' }, pick: 'conv-1' });
    assert.equal(prepared.result.ok, true);
    assert.deepEqual(w.run.calls.map(call => call.args), [['resume', 'conv-1', '--remote', `unix://${session.socket}`]]);
    assert.equal(w.spawn.calls.length, 1);
  } finally { w.cleanup(); }
});

test('joining refuses --model and a different --tool and starts or stops nothing', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.held.set(session.socket, [thread('conv-1')]);
    for (const flags of [{ model: 'other' }, { resumeTool: 'claude' }]) {
      const prepared = await w.entrance({ chosen: { id: 'conv-1' }, ...flags });
      assert.equal(prepared.result.ok, false);
      assert.match(prepared.result.reason, /cannot apply --model or a different --tool/u);
    }
    assert.equal(w.spawn.calls.length, 1);
    assert.deepEqual(w.killed, []);
    assert.equal(w.run.calls.length, 0);
  } finally { w.cleanup(); }
});

test('a conversation held by a server nobody registered refuses a second server for it', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.held.set(session.socket, [thread('conv-1')]);
    w.registered.length = 0;
    const prepared = await w.entrance({ chosen: { id: 'conv-1' }, pick: 'conv-1' });
    assert.match(prepared.result.reason, /without matching desk registration/u);
  } finally { w.cleanup(); }
});

test('a server reporting two thread ids is its title helper and its conversation: the conversation is the session', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.held.set(session.socket, [thread('title-helper', { ephemeral: true, preview: '', updatedAt: 9 }), thread('conv-1')]);
    const [row] = await w.driver.list(w.options);
    assert.equal(row.sessionId, 'conv-1');
    assert.equal(row.resume, 'conv-1');
    assert.equal(row.pid, SERVER_PID);
  } finally { w.cleanup(); }
});

test('a session whose conversation has had no turn is joined plainly, not resumed', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.held.set(session.socket, [thread('conv-1', { preview: '' })]);
    const [row] = await w.driver.list(w.options);
    assert.deepEqual([row.sessionId, row.resume], ['conv-1', null]);
    await w.driver.join(w.options, row);
    assert.deepEqual(w.run.calls[0].args, ['--remote', `unix://${session.socket}`]);
  } finally { w.cleanup(); }
});

test('a thread belongs to the server that reported it: another server\'s thread is never the session\'s', async () => {
  const w = await world();
  try {
    const first = (await w.driver.start(w.options, w.plan, 'mc plan example')).session;
    const second = (await w.driver.start(w.options, w.plan, 'mc plan example 2')).session;
    w.held.set(first.socket, [thread('conv-A')]);
    w.held.set(second.socket, [thread('conv-B')]);
    const rows = await w.driver.list(w.options);
    assert.deepEqual(rows.map(row => [row.pid, row.sessionId]).sort(), [[SERVER_PID, 'conv-A'], [SERVER_PID + 1, 'conv-B']]);
    // A server of another worktree is not asked at all.
    const other = join(w.root, 'work', 'programs', 'other');
    mkdirSync(other);
    w.asked.length = 0;
    assert.deepEqual(await w.driver.list({ ...w.options, worktree: { path: other } }), []);
    assert.deepEqual(w.asked, []);
  } finally { w.cleanup(); }
});

test('a running server that does not answer refuses the entrance with what was measured', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.down.add(session.socket);
    await assert.rejects(w.driver.list(w.options), new RegExp(`pid ${SERVER_PID}\\) is running but server not answering on its socket .*ECONNREFUSED.*kill ${SERVER_PID}`, 'u'));
  } finally { w.cleanup(); }
});

test('a session whose server has ended is cleared from the work root and the register', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    const registerFile = join(foregroundDir(w.env), `${SERVER_PID}.json`);
    mkdirSync(dirname(registerFile), { recursive: true });
    writeFileSync(registerFile, '{}');
    w.live.delete(SERVER_PID);
    assert.deepEqual(await w.driver.list(w.options), []);
    assert.equal(existsSync(dirname(session.socket)), false);
    assert.equal(existsSync(registerFile), false);
  } finally { w.cleanup(); }
});

// The end rule: the session ends only when its person left it.

async function attached(w, { result, held = [thread('conv-1')], clients = [] } = {}) {
  const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
  const directory = dirname(session.socket);
  const registerFile = join(foregroundDir(w.env), `${session.pid}.json`);
  mkdirSync(dirname(registerFile), { recursive: true });
  writeFileSync(registerFile, '{}');
  w.held.set(session.socket, held);
  for (const pid of clients) {
    mkdirSync(join(directory, 'clients'), { recursive: true });
    writeFileSync(join(directory, 'clients', String(pid)), '');
    w.live.add(pid);
  }
  w.run.result = result;
  await w.driver.join(w.options, session);
  return { session, directory, registerFile, stopped: !existsSync(directory) };
}

test('end rule: exit 0 with no turn running stops the server and clears its directory and register entry', async () => {
  const w = await world();
  try {
    const end = await attached(w, { result: { status: 0, signal: null } });
    assert.deepEqual(w.killed, [[SERVER_PID, 'SIGTERM']]);
    assert.equal(end.stopped, true);
    assert.equal(existsSync(end.registerFile), false);
    assert.deepEqual(w.lines, []);
  } finally { w.cleanup(); }
});

test('end rule: a hangup leaves the server, its directory and its register entry', async () => {
  const w = await world();
  try {
    const end = await attached(w, { result: { status: null, signal: 'SIGHUP' } });
    assert.deepEqual(w.killed, []);
    assert.equal(end.stopped, false);
    assert.equal(existsSync(end.registerFile), true);
    assert.match(w.lines.join(''), /the client ended on SIGHUP; the session was left running/u);
  } finally { w.cleanup(); }
});

test('end rule: any other signal leaves the server', async () => {
  const w = await world();
  try {
    const end = await attached(w, { result: { status: null, signal: 'SIGTERM' } });
    assert.deepEqual(w.killed, []);
    assert.equal(end.stopped, false);
  } finally { w.cleanup(); }
});

test('end rule: a nonzero exit leaves the server', async () => {
  const w = await world();
  try {
    const end = await attached(w, { result: { status: 1, signal: null } });
    assert.deepEqual(w.killed, []);
    assert.equal(end.stopped, false);
    assert.match(w.lines.join(''), /exited with status 1/u);
  } finally { w.cleanup(); }
});

test('end rule: a running turn leaves the server even on exit 0', async () => {
  const w = await world();
  try {
    const end = await attached(w, { result: { status: 0, signal: null }, held: [thread('conv-1', { status: { type: 'active', activeFlags: [] } })] });
    assert.deepEqual(w.killed, []);
    assert.equal(end.stopped, false);
    assert.match(w.lines.join(''), /a turn is still running/u);
  } finally { w.cleanup(); }
});

test('end rule: a server that cannot be asked is left, not stopped on a guess', async () => {
  const w = await world();
  try {
    const { session } = await w.driver.start(w.options, w.plan, 'mc plan example');
    w.down.add(session.socket);
    w.run.result = { status: 0, signal: null };
    await w.driver.join(w.options, session);
    assert.deepEqual(w.killed, []);
    assert.match(w.lines.join(''), /could not tell whether a turn is running \(server not answering on its socket/u);
  } finally { w.cleanup(); }
});

test('end rule: a client that never started, or another attached terminal, leaves the server', async () => {
  const w = await world();
  try {
    const failed = await attached(w, { result: { error: new Error('spawn codex ENOENT') } });
    assert.equal(failed.stopped, false);
    assert.match(w.lines.join(''), /the client did not start \(spawn codex ENOENT\)/u);
  } finally { w.cleanup(); }
  const shared = await world();
  try {
    const end = await attached(shared, { result: { status: 0, signal: null }, clients: [888] });
    assert.deepEqual(shared.killed, []);
    assert.equal(end.stopped, false);
    assert.match(shared.lines.join(''), /another terminal is attached/u);
  } finally { shared.cleanup(); }
});

test('end rule: stopping one session never touches another desk session', async () => {
  const w = await world();
  try {
    const other = (await w.driver.start(w.options, w.plan, 'mc plan example')).session;
    const end = await attached(w, { result: { status: 0, signal: null } });
    assert.deepEqual(w.killed, [[end.session.pid, 'SIGTERM']]);
    assert.equal(existsSync(dirname(other.socket)), true);
    assert.equal(w.live.has(other.pid), true);
  } finally { w.cleanup(); }
});

test('end rule: a server that outlives its stop is left with the measured wait', async () => {
  const w = await world({ deps: { kill: pid => w.killed.push([pid, 'SIGTERM']) } });
  try {
    const end = await attached(w, { result: { status: 0, signal: null } });
    assert.equal(end.stopped, false);
    assert.match(w.lines.join(''), /did not exit within 5000 ms; the session was left running/u);
  } finally { w.cleanup(); }
});

// The rpc client: bounded in time and bytes, and limited to what mc asks.

function socketOf(answer) {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.send = data => {
    const message = JSON.parse(data);
    ws.sent.push(message.method);
    const reply = message.id === undefined ? null : answer?.(message);
    if (reply) queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify({ id: message.id, ...reply }))));
  };
  ws.terminate = () => { ws.terminated = true; };
  queueMicrotask(() => ws.emit('open'));
  return ws;
}
const never = {};
const rpcOptions = (ws, extra = {}) => ({ connect: () => ws, resolvePath: path => path, setTimer: () => never, clearTimer: () => {}, ...extra });

test('rpc: reads the loaded threads in the order initialize, list, read, then closes', async () => {
  const ws = socketOf(message => ({
    initialize: { result: {} }, 'thread/loaded/list': { result: { data: ['a', 'b'] } },
    'thread/read': { result: { thread: { id: message.params.threadId } } } })[message.method]);
  assert.deepEqual(await readThreads('/s', rpcOptions(ws)), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(ws.sent, ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/read']);
  assert.equal(ws.terminated, true);
});

test('rpc: a thread that unloaded between the list and the read is skipped; one still loaded is an error', async () => {
  let listed = 0;
  const answers = stillLoaded => message => ({
    initialize: { result: {} },
    'thread/loaded/list': { result: { data: listed++ === 0 ? ['a', 'gone'] : stillLoaded ? ['a', 'gone'] : ['a'] } },
    'thread/read': message.params.threadId === 'gone' ? { error: { message: 'no such thread' } } : { result: { thread: { id: 'a' } } } })[message.method];
  assert.deepEqual(await readThreads('/s', rpcOptions(socketOf(answers(false)))), [{ id: 'a' }]);
  listed = 0;
  await assert.rejects(readThreads('/s', rpcOptions(socketOf(answers(true)))), /no such thread/u);
});

test('rpc: a method outside initialize and the two thread reads is refused and never sent', async () => {
  const ws = socketOf(() => ({ result: {} }));
  await assert.rejects(withCodexServer('/s', request => request('turn/start', {}), rpcOptions(ws)), /turn\/start is not sent to a session server/u);
  assert.equal(ws.sent.includes('turn/start'), false);
});

test('rpc: a server that says nothing is cut off at the deadline and named', async () => {
  let fire;
  const ws = socketOf(() => null);
  const silent = withCodexServer('/s', async () => {}, rpcOptions(ws, { timeoutMs: 50, setTimer: callback => { fire = callback; return never; } }));
  await new Promise(resolve => setImmediate(resolve));
  fire();
  await assert.rejects(silent, error => error.kind === 'silent' && /not answering on its socket \/s within 50 ms/u.test(error.message));
  assert.equal(ws.terminated, true);
});

test('rpc: more bytes than the limit is an overflow, not a result', async () => {
  const ws = socketOf(() => ({ result: { filler: 'x'.repeat(200) } }));
  await assert.rejects(withCodexServer('/s', async () => {}, rpcOptions(ws, { maxBytes: 100 })),
    error => error.kind === 'overflow' && /more than 100 bytes/u.test(error.message));
});

test('rpc: nothing listening, a refused connection and a server error are different, named failures', async () => {
  await assert.rejects(withCodexServer('/s', async () => {}, { resolvePath: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }),
    error => error.kind === 'unreachable' && /not answering on its socket \/s: ENOENT/u.test(error.message));
  const refused = new EventEmitter();
  queueMicrotask(() => refused.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
  await assert.rejects(withCodexServer('/s', async () => {}, rpcOptions(refused)), error => error.kind === 'unreachable' && /ECONNREFUSED/u.test(error.message));
  await assert.rejects(withCodexServer('/s', async () => {}, rpcOptions(socketOf(() => ({ error: { message: 'boom' } })))),
    error => error.kind === 'protocol' && /boom/u.test(error.message));
});
