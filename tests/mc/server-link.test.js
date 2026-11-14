/** SSH/provider/fs/time boundaries are injected; the wire, routing and lifecycle are real. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runModule, VERB_MODULES } from '../../src/mc-verbs.js';
import { remoteCommand, serverLink } from '../../src/mc/server-link.js';
import { descriptor, sessionDescriptor, validateDescriptor, MC_VERSION } from '../../src/mc/server-protocol.js';
import { run as serverSession } from '../../src/mc/commands/session.js';
import { openInWorkArea } from '../../src/mc/work-open.js';
import { splitLaunchArgs } from '../../src/mc/codex-sessions.js';
import { routeServerEntrance, remoteEntrance } from '../../src/mc/server-client.js';

const session = (fields = {}) => sessionDescriptor({ id: 'session-a', name: 'mc manager', resume: null,
  started: '2026-11-14T10:00:00Z', socket: '/server/socket', access: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request'], ...fields }, 'codex', 'codex 0.168.0');
const sink = () => { let value = ''; return { write: s => { value += s; }, get value() { return value; } }; };

for (const entrance of ['plan', 'manager', 'brief', 'martin', 'helper']) {
  const cases = [
    ['interactive configured', {}, [], true, 'tc', true],
    ['--local', {}, ['--local'], true, 'tc', false],
    ['no server', {}, [], true, null, false],
    ['headless', { MC_HEADLESS: '1' }, [], true, 'tc', false],
    ['noninteractive', {}, [], false, 'tc', false],
  ];
  for (const [name, env, args, interactive, destination, remote] of cases) test(`${entrance}: ${name} ${remote ? 'goes remote' : 'stays local'}`, async () => {
    const calls = [];
    const result = await runModule(VERB_MODULES[entrance], args, { load: async () => ({ run: () => 17 }),
      routeEntrance: (verb, forwarded) => routeServerEntrance(verb, forwarded, { env, isInteractive: () => interactive,
      read: () => destination, stdout: sink(), stderr: sink(), link: dest => {
        calls.push(dest);
        return { request: () => { throw new Error('recorded boundary'); } };
      } }) });
    assert.deepEqual(calls, remote ? ['tc'] : []);
    assert.equal(result, remote ? 1 : 17);
  });
}
for (const [verb, args] of [['run', []], ['goal', []], ['gate', []], ['server', []], ['manager', ['--headless']],
  ['helper', ['--intake']], ['helper', ['--collect']], ['plan', ['--archive']], ['martin', ['get']]]) {
  test(`${verb} ${args.join(' ')} non-entrance stays local`, async () => {
    assert.equal(await runModule(VERB_MODULES[verb], args, { load: async () => ({ run: () => 17 }),
      routeEntrance: (entrance, forwarded) => routeServerEntrance(entrance, forwarded, { env: {}, isInteractive: () => true,
        read: () => assert.fail('must not read configuration'), link: () => assert.fail('must not call SSH') }) }), 17);
  });
}

test('descriptor accepts enumerated members only: provider version and new-thread access, never launch secrets or configuration', () => {
  const value = session({ role: 'secret role', model: 'model', grant: 'grant', key: 'key', environment: { TOKEN: 'key' }, instructions: 'instructions' });
  assert.deepEqual(Object.keys(value).sort(), ['version', 'mcVersion', 'kind', 'provider', 'providerVersion', 'id', 'name', 'sessionId', 'started', 'socket', 'access'].sort());
  assert.equal(value.providerVersion, 'codex 0.168.0');
  assert.deepEqual(value.access, ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']);
  assert.deepEqual(session({ resume: 'thread' }).access, []);
  const claude = sessionDescriptor({ id: 'claude-id', name: 'mc manager', sessionId: 'history', access: ['x'] }, 'claude-code', '2.1.325');
  assert.deepEqual(Object.keys(claude).sort(), ['version', 'mcVersion', 'kind', 'provider', 'providerVersion', 'id', 'name', 'sessionId', 'started'].sort());
  assert.equal(validateDescriptor(value), value);
});
for (const [name, fields] of [['unknown version', { version: 8 }], ['unknown field', { grant: 'not allowed' }],
  ['stale thread access', { sessionId: 'thread' }], ['unknown access', { access: ['--model', 'x'] }]]) test(`descriptor refuses ${name}, naming both mc versions`, () => {
  assert.throws(() => validateDescriptor({ ...session(), mcVersion: 'other-mc', ...fields }, { destination: 'tc' }),
    error => error.message.includes(`mc ${MC_VERSION} here, mc other-mc on tc`));
});

test('a server refusal is relayed as on <destination>: measured instruction', () => {
  const link = serverLink('tc', { env: {}, run: () => ({ status: 1, stdout: JSON.stringify(descriptor('refusal', { reason: 'open /server/workspace in Claude once' })) }) });
  assert.throws(() => link.request('start', 'helper'), /^Error: on tc: open \/server\/workspace in Claude once$/u);
});

/** Decode just the POSIX single-quote language emitted by the boundary. No shell/network fixture. */
function shellWords(command) {
  const words = []; let word = ''; let quoted = false; let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") { quoted = !quoted; started = true; }
    else if (!quoted && char === '\\') { word += command[++i]; started = true; }
    else if (!quoted && char === ' ') { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  assert.equal(quoted, false);
  if (started) words.push(word);
  return words;
}

test('injection table: programme, resume id and model reach the server as exact literal argv', () => {
  for (const value of ['two words', "a'b", 'a"b', 'x; touch /bad', '$(touch /bad)', 'a\nb', '']) {
    const args = ['mc', 'session', 'list', 'plan', value, '--resume', value, '--model', value];
    assert.deepEqual(shellWords(remoteCommand(args)), args);
    const link = serverLink('tc', { env: {}, run: (bin, actual) => {
      assert.equal(bin, 'ssh'); assert.equal(actual[0], 'tc');
      assert.deepEqual(shellWords(actual[1]), [...args, '--json', '--answers', '[]']);
      return { status: 0, stdout: JSON.stringify(descriptor('handshake')) };
    } });
    link.request('list', 'plan', args.slice(4));
  }
});

function processStub() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.killedWith = [];
  child.kill = signal => { child.killedWith.push(signal); queueMicrotask(() => child.emit('close', null, signal)); };
  return child;
}
function clientFixture({ outcome = 'clean', resume = null, version = 'codex 0.168.0', root = '/mc', mode = 0o700, prompt = null } = {}) {
  const calls = []; const removed = []; const modes = []; const present = new Set();
  let tunnelProcess; let client; let clock = 0; let ended;
  const io = {
    mkdirSync: (path, options) => { modes.push([path, options.mode]); },
    mkdtempSync: prefix => `${prefix}abcdef`, chmodSync: (path, value) => modes.push([path, value]),
    statSync: () => ({ uid: process.getuid(), mode }), existsSync: path => present.has(path),
    rmSync: (path, options) => removed.push([path, options]),
  };
  let resolveConnection;
  const connection = { session: session({ resume, prompt }), closed: new Promise(resolve => { resolveConnection = resolve; }),
    finish: async clean => { ended = clean; return { status: 0 }; } };
  const link = serverLink('tc', { env: { MC_WORK_ROOT: root }, io, now: () => clock,
    sleep: async ms => { clock += ms; }, run: (bin, args) => { calls.push({ bin, args }); return { status: 0, stdout: version }; },
    spawnProcess: (bin, args, options) => {
      const child = processStub(); calls.push({ bin, args, options, child });
      if (bin === 'ssh') { tunnelProcess = child; present.add(args[4].split(':')[0]); }
      else {
        client = child;
        queueMicrotask(() => {
          if (outcome === 'tunnel lost') tunnelProcess.emit('close', 255, null);
          else if (outcome === 'connection lost') resolveConnection({ status: 255 });
          else child.emit('close', outcome === 'nonzero' ? 1 : outcome === 'signal' ? null : 0, outcome === 'signal' ? 'SIGHUP' : null);
        });
      }
      return child;
    } });
  return { link, connection, calls, removed, modes, get ended() { return ended; }, get client() { return client; } };
}

test('Codex version mismatch refuses before any tunnel, naming both measured versions', async () => {
  const f = clientFixture({ version: 'codex 0.170.0' });
  await assert.rejects(f.link.codexClient(f.connection), /codex 0.170.0 here, codex 0.168.0 on tc/u);
  assert.deepEqual(f.calls.map(call => call.bin), ['codex']);
  assert.equal(f.ended, false);
  assert.deepEqual(f.removed, []);
});
for (const resume of [null, 'thread-a']) for (const prompt of [null, 'opening words', '-dash message']) test(`Codex ${resume ? 'join' : 'new thread'} argv by member (${prompt ?? 'no prompt'}); tunnel argv and private short socket`, async () => {
  const f = clientFixture({ resume, prompt });
  assert.equal((await f.link.codexClient(f.connection)).status, 0);
  const forward = f.calls.find(call => call.bin === 'ssh');
  const socket = '/mc/runner/s/c-abcdef/s';
  assert.deepEqual(forward.args, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${socket}:/server/socket`, 'tc']);
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.deepEqual(f.modes, [['/mc/runner/s', 0o700], ['/mc/runner/s/c-abcdef', 0o700]]);
  const tui = f.calls.find(call => call.bin === 'codex' && call.args[0] !== '--version');
  assert.deepEqual(tui.args, [...(resume ? ['resume', resume] : ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']), '--remote', `unix://${socket}`, ...(prompt ? (prompt.startsWith('-') ? ['--', prompt] : [prompt]) : [])]);
  for (const forbidden of ['-c', '--model', '--add-dir', '--effort', 'instructions']) assert.equal(tui.args.includes(forbidden), false);
  assert.deepEqual(forward.child.killedWith, ['SIGTERM']);
  assert.deepEqual(f.removed, [['/mc/runner/s/c-abcdef', { recursive: true, force: true }]]);
});
for (const outcome of ['clean', 'nonzero', 'signal', 'tunnel lost', 'connection lost']) test(`Codex exit ${outcome}: end rule only on clean quit; process and socket cleaned`, async () => {
  const f = clientFixture({ outcome });
  await f.link.codexClient(f.connection);
  assert.equal(f.ended, outcome === 'clean');
  const forward = f.calls.find(call => call.bin === 'ssh');
  assert.deepEqual(forward.child.killedWith, outcome === 'tunnel lost' ? [] : ['SIGTERM']);
  assert.deepEqual(f.removed.map(row => row[0]), ['/mc/runner/s/c-abcdef']);
});
for (const [name, options, reason] of [['overlong path', { root: `/${'a'.repeat(90)}` }, /bytes \(must be under 100\)/u],
  ['loose permissions', { mode: 0o755 }, /not private: mode 755/u]]) test(`Codex refuses ${name} before forwarding, cleans the directory`, async () => {
  const f = clientFixture(options);
  await assert.rejects(f.link.codexClient(f.connection), reason);
  assert.equal(f.calls.some(call => call.bin === 'ssh'), false);
  assert.equal(f.ended, false);
  assert.deepEqual(f.removed.map(row => row[0]), [options.root ? `${options.root}/runner/s/c-abcdef` : '/mc/runner/s/c-abcdef']);
});

test('Claude uses ssh -t with exact literal start/join argv and returns the SSH status; no local Claude', () => {
  const calls = [];
  const link = serverLink('tc', { env: {}, run: (bin, args) => { calls.push({ bin, args }); return { status: 17 }; } });
  for (const operation of ['start', 'join']) {
    assert.equal(link.passthrough(operation, 'plan', ['programme', '--resume', "id';x", '--model', 'two words']).status, 17);
    const { bin, args } = calls.at(-1);
    assert.equal(bin, 'ssh'); assert.deepEqual(args.slice(0, 2), ['-t', 'tc']);
    assert.deepEqual(shellWords(args[2]), ['mc', 'session', operation, 'plan', 'programme', '--resume', "id';x", '--model', 'two words', '--answers', '[]', '--host', 'tc']);
  }
  assert.deepEqual(calls.map(call => call.bin), ['ssh', 'ssh']);
});

test('remote driver reuses join-or-new choice locally and joins without starting or replacing a provider', async () => {
  const row = session({ resume: 'thread-a' }); const calls = [];
  const link = { destination: 'tc', request: () => descriptor('snapshot', { provider: 'codex', providerVersion: row.providerVersion, chosen: null, sessions: [row] }),
    connect: (...args) => { calls.push(args); return { session: row }; }, codexClient: () => ({ status: 0 }) };
  const result = await remoteEntrance('manager', [], link, { stdout: sink(), stderr: sink(), choose: (title, items) => {
    assert.equal(title, 'join a session, or start a new one?');
    assert.deepEqual(items.map(item => item.value), ['session-a', 'new']);
    return 'session-a';
  } });
  assert.equal(result, 0);
  assert.deepEqual(calls, [['join', 'manager', ['--session', 'session-a'], []]]);
});


/** Server entrance adapter with only provider, register, lock and launch boundaries replaced. */
function serverFixture({ prompt = null, resumePrompt = null, historical = false, joining = false, entrance = 'manager' } = {}) {
  const input = new PassThrough(); const output = sink(); const errors = sink(); const attaches = [];
  const row = { id: 'session-a', name: 'mc manager', pid: 42, cwd: '/server/desk', socket: '/server/socket',
    resume: 'thread-a', sessionId: 'thread-a', prompt: undefined };
  const programme = entrance === 'plan' ? 'example' : null;
  const records = [{ pid: 42, verb: entrance, programme, area: programme ? 'programs/example' : null, tool: 'codex', started: '2026-11-14T10:00:00Z' }];
  const launch = { ok: true, id: 'codex', shortName: 'codex', spec: { bin: '/provider/codex', executionAccess: 'host', args: args => args[0] === 'resume' ? ['resume', '--sandbox', 'danger-full-access', ...args.slice(1)] : ['--sandbox', 'danger-full-access', ...args] },
    adapter: { modelArgs: value => value ? ['-m', value] : [], resumeArgs: ({ sessionId }) => ['resume', sessionId] } };
  const settings = { areaRoot: '/server/desk', worktree: { path: '/server/desk' }, verb: entrance, roleName: entrance, programme, areaName: programme ? 'programs/example' : null,
    prompt, resumePrompt, pick: historical ? 'thread-a' : 'new', tool: 'codex' };
  let started = null;
  const deps = { env: { MC_WORK_ROOT: '/server', MC_HOME: '/server/home' }, stdin: input, stdout: output, stderr: errors,
    realpath: path => path, records: () => records, alive: () => true,
    run: () => ({ status: 0, stdout: 'codex 0.168.0' }),
    entranceDeps: { lock: () => () => {}, records: () => records, alive: () => true },
    load: async () => ({ run: async (_args, { open }) => {
      const result = await open(settings);
      if (!result.ok) { errors.write(result.reason); return 1; }
      return result.code;
    } }),
    open: options => openInWorkArea({ ...options, resolve: () => launch,
      conversations: () => historical ? [{ id: 'thread-a', tool: 'codex', updated_ms: 1 }] : [],
      identify: () => ({ role: entrance, programme }), billingRoute: () => ({ billing: 'plan' }) }),
    drivers: { codex: boundaries => ({
      list: async () => joining ? [row] : [],
      start: async (_options, plan, name) => {
        started = plan;
        return { ok: true, session: { ...row, name, ...splitLaunchArgs(plan.args) } };
      },
      join: async (_options, session) => {
        const result = await boundaries.run('/provider/codex', []);
        attaches.push({ session, result });
        return result;
      },
    }) },
  };
  return { deps, input, output, errors, attaches, get started() { return started; } };
}
for (const [name, options, expected] of [
  ['fresh plan', { entrance: 'plan', prompt: 'plan opening' }, 'plan opening'],
  ['fresh helper', { entrance: 'helper', prompt: 'helper opening' }, 'helper opening'],
  ['historical resumePrompt', { entrance: 'martin', prompt: 'not repeated', resumePrompt: 'refresh current queue', historical: true }, 'refresh current queue'],
  ['join of a running session', { prompt: 'not repeated', resumePrompt: 'not refreshed', joining: true }, undefined],
]) test(`server descriptor opening message: ${name}, no other launch settings cross`, async () => {
  const f = serverFixture(options);
  f.input.end();
  assert.equal(await serverSession([options.joining ? 'join' : 'start', options.entrance || 'manager', '--json', ...(options.joining ? ['--session', 'session-a'] : [])], f.deps), 1);
  const value = validateDescriptor(JSON.parse(f.output.value));
  assert.equal(value.kind, 'session', f.output.value + f.errors.value);
  assert.equal(value.prompt, expected);
  assert.equal(Object.hasOwn(value, 'prompt'), expected !== undefined);
  assert.equal(value.providerVersion, 'codex 0.168.0');
  assert.deepEqual(value.access, options.historical || options.joining ? [] : ['--sandbox', 'danger-full-access']);
  assert.deepEqual(Object.keys(value).sort(), ['version', 'mcVersion', 'kind', 'provider', 'providerVersion', 'id', 'name', 'sessionId', 'started', 'socket', 'access', ...(expected ? ['prompt'] : [])].sort());
});
for (const clean of [false, true]) test(`server connection holder: ${clean ? 'explicit end' : 'EOF'} ${clean ? 'permits' : 'does not permit'} the driver's end rule`, async () => {
  const f = serverFixture();
  f.input.end(clean ? 'end\n' : '');
  const status = await serverSession(['start', 'manager', '--json'], f.deps);
  assert.equal(status, clean ? 0 : 1, f.output.value + f.errors.value);
  assert.equal(f.attaches[0].result.status, clean ? 0 : 1);
  assert.equal(f.attaches[0].result.signal, null);
});

test('opening message schema refuses nonstrings and NUL, while role/model/effort/roots remain forbidden', () => {
  for (const fields of [{ prompt: 4 }, { prompt: 'a\0b' }, { prompt: '' }, { role: 'role' }, { model: 'model' }, { effort: 'high' }, { roots: ['/root'] }]) {
    assert.throws(() => validateDescriptor({ ...session(), ...fields }), /descriptor|opening user message/u);
  }
});

for (const clean of [true, false]) test(`SSH connection lifetime: ${clean ? 'clean end' : 'disconnection'} sends ${clean ? 'end' : 'EOF'}, then closes the holder`, async () => {
  const child = processStub(); const writes = []; let clock = 0;
  child.stdin.on('data', data => writes.push(String(data)));
  child.stdin.end = data => { if (data) writes.push(data); queueMicrotask(() => child.emit('close', 0, null)); };
  const link = serverLink('tc', { env: {}, now: () => clock, sleep: async ms => { clock += ms; },
    spawnProcess: (bin, args) => {
      assert.equal(bin, 'ssh');
      assert.deepEqual(shellWords(args[1]), ['mc', 'session', 'start', 'manager', '--new', '--json', '--answers', '[]']);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(session())}\n`));
      return child;
    } });
  const connection = await link.connect('start', 'manager', ['--new']);
  assert.equal(connection.session.name, 'mc manager');
  assert.equal((await connection.finish(clean)).status, 0);
  assert.deepEqual(writes, clean ? ['end\n'] : []);
  assert.deepEqual(child.killedWith, []);
});
for (const [name, response, reason] of [
  ['stale descriptor', { ...session(), version: 9 }, /descriptor v9/u],
  ['server refusal', descriptor('refusal', { reason: 'measured refusal' }), /on tc: measured refusal/u],
  ['silent connection', null, /no session descriptor within 30000 ms/u],
]) test(`SSH startup ${name} refuses and closes the connection without applying end`, async () => {
  const child = processStub(); const writes = []; let clock = 0;
  child.stdin.on('data', data => writes.push(String(data)));
  const link = serverLink('tc', { env: {}, now: () => clock, sleep: async ms => { clock += ms; },
    spawnProcess: () => {
      if (response) queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
      return child;
    } });
  await assert.rejects(link.connect('start', 'manager'), reason);
  assert.deepEqual(writes, []);
  assert.deepEqual(child.killedWith, ['SIGTERM']);
});

test('a stale Codex descriptor closes the holder without opening a tunnel', async () => {
  const f = clientFixture();
  f.connection.session.version = 9;
  await assert.rejects(f.link.codexClient(f.connection), /descriptor v9/u);
  assert.deepEqual(f.calls, []);
  assert.equal(f.ended, false);
});

test('failure to finish a clean client still cleans the tunnel process and local socket', async () => {
  const f = clientFixture();
  f.connection.finish = async () => { throw new Error('measured connection close failure'); };
  await assert.rejects(f.link.codexClient(f.connection), /measured connection close failure/u);
  assert.deepEqual(f.calls.find(call => call.bin === 'ssh').child.killedWith, ['SIGTERM']);
  assert.deepEqual(f.removed.map(row => row[0]), ['/mc/runner/s/c-abcdef']);
});

for (const [name, args, chosen, operation, allowed] of [
  ['--new starts rather than joining', ['--new', '--model', 'new-model'], null, 'start', true],
  ['--resume joins its held conversation without asking', ['--resume', 'thread-a'], 'thread-a', 'join', true],
  ['join refuses --model without starting', ['--model', 'new-model'], null, null, false],
]) test(`remote driver: ${name}`, async () => {
  const row = session({ resume: 'thread-a' }); const calls = []; const errors = sink();
  const link = { destination: 'tc',
    request: () => descriptor('snapshot', { provider: 'codex', providerVersion: row.providerVersion, chosen, sessions: [row] }),
    connect: (...values) => { calls.push(values); return { session: row }; }, codexClient: () => ({ status: 0 }) };
  const result = await remoteEntrance('manager', args, link, { stdout: sink(), stderr: errors,
    choose: () => { assert.equal(chosen, null); assert.equal(allowed, false); return 'session-a'; } });
  assert.equal(result, allowed ? 0 : 1);
  assert.deepEqual(calls, operation ? [[operation, 'manager', [...args, ...(operation === 'join' ? ['--session', row.id] : [])], []]] : []);
  if (!allowed) assert.match(errors.value, /on tc: joining an existing session cannot apply --model/u);
});

test('remote plan identifies its programme after a model value when reporting the entrance', async () => {
  const output = sink(); const row = session();
  const link = { destination: 'tc', request: () => descriptor('snapshot', { provider: 'codex', providerVersion: row.providerVersion, chosen: null, sessions: [] }),
    connect: () => ({ session: row }), codexClient: () => ({ status: 0 }) };
  assert.equal(await remoteEntrance('plan', ['--model', 'new-model', 'example', '--new'], link, { stdout: output, stderr: sink() }), 0);
  assert.match(output.value, /with mc plan example\./u);
  assert.doesNotMatch(output.value, /mc plan new-model/u);
});
