/** Daemon/process, filesystem and time boundaries are inert; decisions and launch composition are real. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { interactiveLaunchPlan, openInWorkArea } from '../../src/mc/work-open.js';
import { resolveLaunch } from '../../src/adapters/index.js';
import { sessionArgs } from '../../src/adapters/claude-code.js';
import { SESSION_IDENTITY_ENV, sessionIdentity } from '../../src/mc/session-role.js';
import { registerForeground, sweep } from '../../src/mc/foreground.js';
import { openGatewayGrant, GATEWAY_SESSION_MS, GATEWAY_SESSION_REQUEST_LIMIT } from '../../src/mc/billing-gateway-session.js';
import { backgroundSettings, claudeBackgroundDriver, holdClaudeBackground,
  notifyBackgroundClient, readAgents, startDetachedBackground } from '../../src/mc/claude-background.js';

import { sessionName as backgroundName, deskSessions, lockDesk, joinSession, prepareSessionEntrance } from '../../src/mc/session-entrance.js';

// Exercise the real provider-neutral entrance with an inert provider boundary.
function prepareClaudeBackground(options, { agents, attach, start, ...deps }) {
  return prepareSessionEntrance(options, {
    list: () => agents(), start,
    join: (options, session) => attach(options, session),
  }, deps);
}

const env = { HOME: '/test', PATH: '/usr/bin', MC_WORK_ROOT: '/test/mc', MC_HOME: '/test/home', SSH_CONNECTION: 'ssh' };
const base = { areaRoot: '/test/mc/manager', worktree: { path: '/test/mc/manager' }, env,
  verb: 'manager', areaName: 'manager', roleName: 'manager', programme: null,
  tool: 'claude', platform: 'linux', isInteractive: () => true,
  conversations: () => [], identify: () => ({ role: 'manager', programme: null }),
  billingRoute: () => ({ billing: 'plan' }), stdout: { write() {} }, stderr: { write() {} },
};
const row = { id: 'bg-1', name: 'mc manager', pid: 701, cwd: base.worktree.path, sessionId: 'held-1', kind: 'local', status: 'idle' };
const record = { pid: row.pid, verb: 'manager', area: 'manager', programme: null, tool: 'claude', model: 'haiku',
  role: { name: 'manager' }, started: '2026-11-13T10:00:00Z' };
const launch = resolveLaunch('claude-code');

function memoryFs() {
  const files = new Map();
  const modes = new Map();
  const removed = [];
  const io = {
    mkdirSync(path, options) { if (files.has(path) && !options?.recursive) throw Object.assign(new Error(), { code: 'EEXIST' }); files.set(path, null); modes.set(path, options?.mode); },
    mkdtempSync(prefix) { const path = `${prefix}unique`; files.set(path, null); return path; },
    chmodSync(path, mode) { modes.set(path, mode); },
    writeFileSync(path, value, options) { files.set(path, value); modes.set(path, options?.mode); },
    readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files.get(path); },
    readdirSync(path) { return [...files.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map(key => key.slice(path.length + 1)); },
    rmSync(path) { removed.push(path); for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); },
  };
  return { io, files, modes, removed };
}

function entrance(overrides = {}) {
  const calls = [];
  const options = { ...base, launch, ...overrides };
  const deps = {
    agents: () => [row], records: () => [record], alive: () => true, owners: () => [row.pid],
    lock: () => () => calls.push('release'),
    choose: (_title, items) => { calls.push(items); return row.id; },
    attach: (_options, session) => { calls.push(['attach', session.id]); return { status: 0 }; },
    start: async (_options, plan, name) => { calls.push(['start', plan, name]); return { ok: true, session: { ...row, id: 'bg-2' } }; },
  };
  return { calls, options, deps };
}

for (const [name, changes, route] of [
  ['eligible Claude goes to background and never tmux', {}, 'background'],
  ['eligible Codex keeps tmux and never background', { tool: 'codex' }, 'tmux'],
  ['macOS Claude stays foreground even over SSH', { platform: 'darwin' }, 'foreground'],
  ['noninteractive Linux stays foreground', { isInteractive: () => false }, 'foreground'],
  ['MC_HEADLESS=1 stays foreground', { env: { ...env, MC_HEADLESS: '1' } }, 'foreground'],
]) test(name, async () => {
  const reached = [];
  const result = await openInWorkArea({ ...base, ...changes,
    terminal: () => { reached.push('tmux'); return { ok: true }; },
    background: () => ({ start: async plan => { reached.push('background'); assert.equal(plan.tool, 'claude-code'); return { ok: true }; } }),
    spawn: () => { reached.push('foreground'); return { status: 0 }; }, register: () => () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reached, [route]);
});

test('a named Claude resume resolves provider before routing without a tool flag', async () => {
  const reached = [];
  await openInWorkArea({ ...base, tool: null, pick: 'held', conversations: () => [{ id: 'held-1', tool: 'claude-code' }],
    terminal: () => { reached.push('tmux'); return { ok: true }; },
    background: options => { reached.push(options.launch.id); return { result: { ok: true } }; },
    spawn: () => { reached.push('foreground'); return { status: 0 }; },
  });
  assert.deepEqual(reached, ['claude-code']);
});

test('no session for the desk starts once and attaches', async () => {
  const f = entrance();
  const prepared = await prepareClaudeBackground(f.options, { ...f.deps, agents: () => [], records: () => [], owners: () => [] });
  const plan = await interactiveLaunchPlan(base);
  const result = await prepared.start(plan);
  assert.equal(result.background, 'bg-2');
  assert.deepEqual(f.calls.filter(Array.isArray).map(call => call[0]), ['start', 'attach']);
});

test('one or more sessions offer names and started times plus start a new one through select', async () => {
  const f = entrance();
  const result = await prepareClaudeBackground(f.options, f.deps);
  assert.deepEqual(f.calls[0], [
    { key: 1, value: row.id, name: 'mc manager', label: `mc manager  started ${record.started}` },
    { key: 2, value: 'new', name: 'start a new one', label: 'start a new one' },
  ]);
  assert.equal(result.result.background, row.id);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'start'), []);
});

test('--new bypasses session choice and starts a fresh conversation', async () => {
  const f = entrance({ pick: 'new' });
  const result = await openInWorkArea({ ...base, pick: 'new', conversations: () => [{ tool: 'claude-code', id: 'held-1' }],
    background: options => prepareClaudeBackground(options, { ...f.deps, choose: () => assert.fail('must not ask') }),
  });
  assert.equal(result.ok, true);
  const plan = f.calls.find(call => call[0] === 'start')[1];
  assert.equal(plan.chosen, null);
  assert.ok(!plan.args.includes('--resume'));
});

for (const pick of ['held-1', true]) test(`${pick === true ? '--resume picker' : '--resume <id>'} joins a held conversation without starting another process`, async () => {
  const f = entrance();
  const result = await openInWorkArea({ ...base, pick, choose: () => 'held-1',
    conversations: () => [{ id: 'held-1', tool: 'claude-code' }],
    background: options => prepareClaudeBackground(options, f.deps),
  });
  assert.equal(result.background, row.id);
  assert.deepEqual(f.calls.filter(Array.isArray), [['attach', row.id]]);
});

for (const flags of [{ model: 'opus' }, { tool: 'codex', resumeTool: 'codex' }]) test(`join refuses ${JSON.stringify(flags)} without replacing or stopping a session`, async () => {
  const f = entrance({ ...flags, chosen: { id: 'held-1' } });
  const prepared = await prepareClaudeBackground(f.options, f.deps);
  assert.equal(prepared.result.ok, false);
  assert.match(prepared.result.reason, /cannot apply --model or a different --tool/u);
  assert.deepEqual(f.calls, []);
  prepared.release();
});

test('start a new one without flags excludes every held conversation and resumes the most recent free compatible one', async () => {
  const f = entrance();
  const free = { id: 'free', tool: 'claude-code', updated_ms: 1 };
  await openInWorkArea({ ...base, conversations: () => [{ id: 'held-1', tool: 'claude-code', updated_ms: 2 }, free],
    background: options => prepareClaudeBackground(options, { ...f.deps, choose: () => 'new' }),
  });
  const plan = f.calls.find(call => call[0] === 'start')[1];
  assert.equal(plan.chosen.id, 'free');
  assert.ok(!plan.args.includes('held-1'));
});

test('names use the lowest free suffix for the normalized desk', () => {
  assert.equal(backgroundName(base, []), 'mc manager');
  assert.equal(backgroundName({ ...base, verb: 'brief', roleName: 'brief', programme: 'example' }, []), 'mc manager example');
  assert.equal(backgroundName(base, [{ name: 'mc manager' }, { name: 'mc manager 3' }]), 'mc manager 2');
});

test('discovery requires matching agents and register pids, cwd and desk, not status or attachment', () => {
  assert.deepEqual(deskSessions(base, [row], [record], () => true), [{ ...row, started: record.started }]);
  for (const [agents, records] of [[[], [record]], [[row], []], [[row], [{ ...record, pid: 702 }]],
    [[{ ...row, cwd: '/other' }], [record]], [[row], [{ ...record, programme: 'other' }]]]) {
    assert.deepEqual(deskSessions(base, agents, records, () => true), []);
  }
  assert.deepEqual(deskSessions(base, [row], [record], () => false), []);
});

test('a legacy owner or an unregistered held conversation refuses a duplicate without killing it', async () => {
  const f = entrance({ chosen: { id: 'held-1' } });
  const legacy = await prepareClaudeBackground(f.options, { ...f.deps, owners: () => [42] });
  assert.match(legacy.result.reason, /PID 42/u);
  legacy.release();
  const orphan = await prepareClaudeBackground(f.options, { ...f.deps, records: () => [], owners: () => [] });
  assert.match(orphan.result.reason, /without matching desk registration/u);
  orphan.release();
  assert.deepEqual(f.calls, ['release', 'release']);
});

test('an unreadable agents response is a discovery failure, not an empty desk', async () => {
  assert.throws(() => readAgents(launch, { env, run: () => ({ status: 1 }) }), /could not read/u);
  const f = entrance();
  const prepared = await prepareClaudeBackground(f.options, { ...f.deps, agents: () => { throw new Error('could not read Claude background agents'); } });
  assert.match(prepared.result.reason, /could not read/u);
  assert.deepEqual(f.calls, ['release']);
});

test('the desk lock refuses a concurrent selector and releases through its pipe, not a stale pid file', async () => {
  const f = memoryFs();
  let locked = false;
  const calls = [];
  const spawnProcess = (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = marker => queueMicrotask(() => {
      if (locked) child.emit('close', 1);
      else { locked = true; child.stdout.emit('data', marker); }
    });
    child.stdin.end = () => queueMicrotask(() => { locked = false; child.emit('close', 0); });
    return child;
  };
  const release = await lockDesk(base, { io: f.io, spawnProcess });
  await assert.rejects(lockDesk(base, { io: f.io, spawnProcess }), /another entrance/u);
  await release();
  await (await lockDesk(base, { io: f.io, spawnProcess }))();
  assert.equal(calls[0].bin, '/usr/bin/flock');
  assert.deepEqual(calls[0].args.slice(0, 3), ['--exclusive', '--nonblock', '--close']);
  assert.deepEqual(f.removed, [], 'the stable lock inode is never unlinked');
});

function holderFixture(billing = 'plan') {
  const f = memoryFs();
  let living = true;
  let clock = 1000;
  const calls = [];
  const request = { directory: '/test/mc/runner/claude-background/session-one', name: row.name, cwd: row.cwd,
    billing: { billing }, record, args: ['--model', 'haiku'], settings: { env: { MC_ROLE: 'manager' } } };
  let reads = 0;
  const deps = { env, io: f.io, resolveTool: () => launch,
    run: (bin, args, options) => { calls.push({ bin, args, options }); return { status: 0 }; },
    agents: () => ++reads === 1 ? [] : [row], alive: () => living, now: () => clock,
    register: value => { calls.push({ record: value }); return () => assert.fail('provider registration must not be released by the holder'); },
    report: value => calls.push({ report: value }),
    sleep: async () => { living = false; },
    openGrant: options => openGatewayGrant({ ...options, token: () => 'bounded-grant',
      readKey: async () => { calls.push('readKey'); return { ok: true, key: 'provider-key' }; },
      readApi: () => ({ claude: true }),
      createGateway: input => { calls.push({ gateway: input }); return { close: callback => { calls.push('closed'); callback(); } }; },
      listen: async () => 'http://127.0.0.1:1234',
    }),
  };
  return { ...f, request, deps, calls, expire: () => { clock += GATEWAY_SESSION_MS; } };
}

test('settings carry adapter env and every identity member; launcher env excludes identity, API keys and runtime secrets', async () => {
  const plan = await interactiveLaunchPlan({ ...base, env: { ...env, MC_ROLE: 'build-session:goal', MC_GOAL: 'other/work', MC_HEADLESS: '1',
    ANTHROPIC_API_KEY: 'provider-secret', MEMORO_TOKEN: 'runtime-secret' } });
  const document = backgroundSettings(plan.args, plan.identity, plan.record.env);
  assert.deepEqual(document.settings.env, { ...JSON.parse(sessionArgs()[1]).env,
    MC_ROLE: 'manager', MC_PROGRAMME: '', MC_GOAL: '', MC_STEP: '', MC_PROJECT: '', MC_HEADLESS: '',
    MC_HOME: env.MC_HOME, MC_WORK_ROOT: env.MC_WORK_ROOT });
  assert.deepEqual(SESSION_IDENTITY_ENV.map(key => document.settings.env[key]), ['manager', '', '', '', '', '']);
  assert.equal(sessionIdentity({ cwd: row.cwd, env: document.settings.env }).role, 'manager');
  const f = holderFixture();
  f.deps.env = plan.record.env;
  await holdClaudeBackground({ ...f.request, ...document }, f.deps);
  assert.deepEqual(f.calls.find(call => call.args).options.env,
    { HOME: '/test', PATH: '/usr/bin', MC_WORK_ROOT: '/test/mc', MC_HOME: '/test/home' });
});

test('credits holder keeps the key private, grant off argv, and settings file 0600 until provider death', async () => {
  const f = holderFixture('credits');
  let settings;
  let living = true;
  f.deps.alive = () => living;
  f.deps.sleep = async () => { settings = JSON.parse(f.io.readFileSync(join(f.request.directory, 'settings.json'))); living = false; };
  await holdClaudeBackground(f.request, f.deps);
  const spawned = f.calls.find(call => call.args);
  assert.deepEqual(spawned.args, ['--bg', '--name', 'mc manager', '--settings', join(f.request.directory, 'settings.json'), '--model', 'haiku']);
  assert.doesNotMatch(JSON.stringify(spawned), /bounded-grant|provider-key/u);
  assert.deepEqual(settings.env, { MC_ROLE: 'manager', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/claude', ANTHROPIC_AUTH_TOKEN: 'bounded-grant' });
  assert.equal(f.modes.get(join(f.request.directory, 'settings.json')), 0o600);
  const grant = f.calls.find(call => call.gateway).gateway.grants[0];
  assert.deepEqual(grant, { provider: 'claude', token: 'bounded-grant', models: ['*'], maxRequests: GATEWAY_SESSION_REQUEST_LIMIT,
    expiresAt: new Date(1000 + GATEWAY_SESSION_MS).toISOString() });
  assert.deepEqual(f.removed, [f.request.directory]);
  assert.ok(f.calls.includes('closed'));
});

test('credits holder removes settings and closes its gateway at grant expiry even with a live provider', async () => {
  const f = holderFixture('credits');
  f.deps.sleep = async () => f.expire();
  await holdClaudeBackground(f.request, f.deps);
  assert.deepEqual(f.removed, [f.request.directory]);
  assert.ok(f.calls.includes('closed'));
});

test('plan billing starts no gateway and still removes settings on provider death', async () => {
  const f = holderFixture();
  f.deps.openGrant = () => assert.fail('plan billing must not open a key');
  await holdClaudeBackground(f.request, f.deps);
  assert.deepEqual(f.removed, [f.request.directory]);
  assert.deepEqual(f.calls.filter(call => call === 'readKey' || call.gateway), []);
});

test('detached holder gets a 0700 directory and a secret-free request, not a gateway grant on argv', async () => {
  const f = memoryFs();
  const plan = await interactiveLaunchPlan(base);
  let spawned;
  const result = await startDetachedBackground(base, plan, row.name, { io: f.io, fork: (bin, args, options) => {
    spawned = { bin, args, options };
    const child = new EventEmitter(); child.unref = () => {}; child.connected = true; child.disconnect = () => {};
    queueMicrotask(() => child.emit('message', { ok: true, session: row }));
    return child;
  } });
  assert.equal(result.session.pid, row.pid);
  assert.equal(spawned.options.detached, true);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(f.modes.get('/test/mc/runner/claude-background/session-unique'), 0o700);
  assert.equal(f.modes.get(spawned.args[1]), 0o600);
  assert.doesNotMatch(JSON.stringify(spawned), /AUTH_TOKEN|API_KEY|grant/u);
});

test('API off refuses before starting any holder or session and the trusted holder rechecks before opening a key', async () => {
  const plan = await interactiveLaunchPlan({ ...base, billingRoute: () => ({ billing: 'credits' }) });
  const refused = await startDetachedBackground(base, plan, row.name, { readApi: () => ({ claude: false }), fork: () => assert.fail('no holder') });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /API is off/u);
  const f = holderFixture('credits');
  f.deps.openGrant = options => openGatewayGrant({ ...options,
    readApi: () => ({ claude: false }), readKey: () => assert.fail('no key'), createGateway: () => assert.fail('no gateway') });
  assert.equal((await holdClaudeBackground(f.request, f.deps)).ok, false);
  assert.deepEqual(f.calls, []);
});

test('registration uses the provider pid and survives launcher exit; existing sweep removes a dead provider', async () => {
  const f = holderFixture();
  const entries = new Map();
  let onExit;
  f.deps.register = input => {
    onExit = input.onExit;
    return registerForeground({ ...input,
      write: (path, value) => entries.set(path, value), list: () => [], remove: path => entries.delete(path),
    });
  };
  await holdClaudeBackground(f.request, f.deps);
  const path = '/test/mc/runner/foreground/701.json';
  const entry = entries.get(path);
  assert.deepEqual({ ...entry, started: record.started }, { ...record, started: record.started });
  onExit();
  assert.equal(entries.get(path).pid, row.pid);
  sweep({ dir: '/test/mc/runner/foreground', list: () => ['701.json'], remove: path => entries.delete(path), alive: () => false });
  assert.deepEqual([...entries], []);
});

test('attach only attaches and reports whether the provider still lives with the entrance to rejoin', async () => {
  const lines = [];
  const calls = [];
  const driver = claudeBackgroundDriver({ run: (bin, args) => { calls.push({ bin, args }); return { status: 0 }; }, agents: () => [row] });
  const result = await joinSession({ ...base, launch }, row, driver, { alive: () => true, stdout: { write: text => lines.push(text) } });
  assert.equal(result.running, true);
  assert.deepEqual(calls, [{ bin: launch.spec.bin, args: ['attach', row.id] }]);
  assert.deepEqual(lines, ['mc: mc manager is still running; rejoin with mc manager.\n']);
});

test('a held conversation with no transcript can join by id using matching live registration as identity evidence', async () => {
  const { findBackgroundConversation } = await import('../../src/mc/claude-background.js');
  const f = entrance();
  const result = await openInWorkArea({ ...base, tool: 'codex', resumeTool: null, pick: 'held',
    liveConversation: prefix => findBackgroundConversation(base, prefix, {
      agents: f.deps.agents, records: f.deps.records, alive: f.deps.alive,
    }),
    background: options => prepareClaudeBackground(options, f.deps),
  });
  assert.equal(result.background, row.id);
  assert.deepEqual(f.calls.filter(Array.isArray), [['attach', row.id]]);
});

test('a refused background launch names workspace trust without registering a nonexistent provider', async () => {
  const f = holderFixture();
  f.deps.run = () => ({ status: 1, stderr: 'Workspace not trusted. Run the provider once.' });
  const result = await holdClaudeBackground(f.request, f.deps);
  assert.match(result.reason, /workspace is not trusted/u);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.removed, [f.request.directory]);
});


test('background argv preserves the single launch plan including role, model, effort, tools, access and opening prompt', async () => {
  const plan = await interactiveLaunchPlan({ ...base, verb: 'plan', roleName: 'plan', programme: 'example',
    model: 'haiku', overlay: 'Keep this launch instruction.', prompt: 'Opening words.' });
  const document = backgroundSettings(plan.args, plan.identity, env);
  const f = holderFixture();
  await holdClaudeBackground({ ...f.request, ...document }, f.deps);
  const expected = [...plan.args];
  expected[expected.indexOf('--settings') + 1] = join(f.request.directory, 'settings.json');
  assert.deepEqual(f.calls.find(call => call.args).args, ['--bg', '--name', row.name, ...expected]);
});

test('the detached holder inherits the desk lock pipe so client death cannot admit a duplicate during startup', async () => {
  const f = memoryFs();
  const pipe = new EventEmitter();
  const plan = await interactiveLaunchPlan(base);
  let inherited;
  await startDetachedBackground({ ...base, lockPipe: pipe }, plan, row.name, { io: f.io, fork: (_bin, args, options) => {
    assert.equal(args.at(-1), '--desk-lock-pipe');
    inherited = options.stdio[4];
    const child = new EventEmitter(); child.unref = () => {}; child.connected = false;
    queueMicrotask(() => child.emit('message', { ok: true, session: row }));
    return child;
  } });
  assert.equal(inherited, pipe);
  const h = holderFixture();
  let held = true;
  h.deps.run = () => { assert.equal(held, true, 'startup still excludes another entrance'); return { status: 0 }; };
  h.deps.releaseLock = () => { held = false; };
  h.deps.report = result => { assert.equal(result.session.pid, row.pid); assert.equal(held, false, 'registration permits the next selector, not provider death'); };
  await holdClaudeBackground(h.request, h.deps);
});


test('losing the client during startup reports through an error-handled IPC send and cannot abandon holder cleanup', async () => {
  const f = holderFixture();
  let notified = false;
  f.deps.report = result => notifyBackgroundClient(result, { connected: () => true, send: (message, callback) => {
    assert.equal(message.session.pid, row.pid);
    assert.equal(typeof callback, 'function', 'the IPC error must have a callback, not an unhandled process error');
    notified = true;
    callback(Object.assign(new Error('client left'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
  } });
  assert.equal((await holdClaudeBackground(f.request, f.deps)).ok, true);
  assert.equal(notified, true);
  assert.deepEqual(f.removed, [f.request.directory]);
  notifyBackgroundClient({}, { connected: () => false, send: () => assert.fail('already disconnected') });
});

test('background provenance names the provider-assigned conversation id, not the ignored launch uuid', async () => {
  const plan = await interactiveLaunchPlan({ ...base, overlay: 'Role instructions.' });
  assert.ok(plan.openEvent.launched_id);
  assert.notEqual(plan.openEvent.launched_id, row.sessionId);
  const f = holderFixture();
  const events = [];
  f.deps.recordOpen = fields => events.push(fields);
  await holdClaudeBackground({ ...f.request, openEvent: plan.openEvent }, f.deps);
  assert.deepEqual(events, [{ ...plan.openEvent, launched_id: row.sessionId }]);
  assert.equal(events[0].role, 'manager');
  assert.equal(events[0].instruction_channel, 'append-system-prompt');
});

test('a matching live registration permits joining held history whose transcript identity is not yet readable', async () => {
  const { findBackgroundConversation } = await import('../../src/mc/claude-background.js');
  const f = entrance();
  const result = await openInWorkArea({ ...base, pick: 'held', identify: () => null,
    conversations: () => [{ id: 'held-1', tool: 'claude-code' }],
    liveConversation: prefix => findBackgroundConversation(base, prefix, {
      agents: f.deps.agents, records: f.deps.records, alive: f.deps.alive,
    }), background: options => prepareClaudeBackground(options, f.deps),
  });
  assert.equal(result.background, row.id);
  assert.deepEqual(f.calls.filter(Array.isArray), [['attach', row.id]]);
});


for (const outage of ['unreadable', 'late row']) test(`successful launch reconciles ${outage} discovery without losing its grant, registration or rejoin`, async () => {
  const f = holderFixture('credits');
  let reads = 0;
  let registered = false;
  let locked = true;
  let living = true;
  const entries = [];
  const reports = [];
  f.deps.alive = () => living;
  f.deps.agents = () => {
    reads += 1;
    if (reads === 1) return [];
    if (reads <= 55) {
      if (outage === 'unreadable') throw new Error('agents temporarily unavailable');
      return [];
    }
    return [row];
  };
  f.deps.register = input => { registered = true; entries.push({ ...record, pid: input.pid }); };
  f.deps.releaseLock = () => { assert.equal(registered, true); locked = false; };
  f.deps.report = result => reports.push(result);
  f.deps.sleep = async () => {
    assert.deepEqual(f.removed, [], 'uncertain discovery is not session death');
    assert.equal(f.calls.includes('closed'), false, 'the live session still owns its grant');
    assert.ok(f.files.has(join(f.request.directory, 'settings.json')));
    if (!registered) assert.equal(locked, true, 'no second entrance can start while ownership is uncertain');
    else living = false;
  };
  assert.equal((await holdClaudeBackground(f.request, f.deps)).ok, true);
  assert.deepEqual(reports.map(result => result.ok), [false, true]);
  assert.match(reports[0].reason, outage === 'unreadable' ? /could not read Claude background agents/u : /listed no new matching live session/u);
  assert.equal(reports[1].session.pid, row.pid);
  assert.deepEqual(entries.map(entry => entry.pid), [row.pid]);
  assert.deepEqual(f.removed, [f.request.directory]);
  assert.deepEqual(f.calls.filter(call => call.args).map(call => call.args.slice(0, 3)), [['--bg', '--name', row.name]]);
  const e = entrance();
  const recovered = await prepareClaudeBackground(e.options, { ...e.deps, records: () => entries,
    start: () => assert.fail('recovery must join the existing provider, not start another') });
  assert.equal(recovered.result.background, row.id);
  assert.deepEqual(e.calls.filter(Array.isArray).at(-1), ['attach', row.id]);
});

test('grant expiry during uncertain discovery cleans credentials once but preserves ownership until registration recovers', async () => {
  const f = holderFixture('credits');
  let reads = 0;
  let registered = false;
  let released = false;
  f.deps.agents = () => ++reads < 4 ? [] : [row];
  f.deps.sleep = async () => {
    assert.equal(released, false);
    if (reads === 2) f.expire();
    else {
      assert.deepEqual(f.removed, [f.request.directory]);
      assert.equal(f.calls.includes('closed'), true);
    }
  };
  f.deps.register = value => { registered = true; assert.equal(value.pid, row.pid); };
  f.deps.releaseLock = () => { assert.equal(registered, true); released = true; };
  await holdClaudeBackground(f.request, f.deps);
  assert.deepEqual(f.removed, [f.request.directory]);
  assert.deepEqual(f.calls.filter(call => call === 'readKey' || call === 'closed'), ['readKey', 'closed']);
});

test('the same entrance accepts a different provider driver without changing desk policy', async () => {
  const options = { ...base, launch: resolveLaunch('codex') };
  const sessions = [{ ...row, id: 'remote-thread' }];
  const calls = [];
  const prepared = await prepareSessionEntrance(options, {
    list: () => sessions,
    start: () => assert.fail('join must not start or replace a session'),
    join: (_options, session) => { calls.push(session.id); return { status: 0 }; },
  }, { lock: () => () => {}, alive: () => true, owners: () => [row.pid],
    records: () => [{ ...record, tool: 'codex' }], choose: (_title, choices) => choices[0].value });
  assert.equal(prepared.result.background, 'remote-thread');
  assert.deepEqual(calls, ['remote-thread']);
});
