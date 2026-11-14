/** SSH/provider/fs/time boundaries are injected; the wire, routing and lifecycle are real. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { remoteCommand, serverLink } from '../../src/mc/server-link.js';
import { descriptor, sessionDescriptor, validateDescriptor, MC_VERSION } from '../../src/mc/server-protocol.js';
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
    const result = await routeServerEntrance(entrance, args, { env, isInteractive: () => interactive,
      read: () => destination, stdout: sink(), stderr: sink(), link: dest => {
        calls.push(dest);
        return { request: () => { throw new Error('recorded boundary'); } };
      } });
    assert.deepEqual(calls, remote ? ['tc'] : []);
    assert.equal(result, remote ? 1 : null);
  });
}
for (const [verb, args] of [['run', []], ['goal', []], ['gate', []], ['server', []], ['manager', ['--headless']],
  ['helper', ['--intake']], ['helper', ['--collect']], ['plan', ['--archive']], ['martin', ['get']]]) {
  test(`${verb} ${args.join(' ')} non-entrance stays local`, async () => {
    assert.equal(await routeServerEntrance(verb, args, { env: {}, isInteractive: () => true,
      read: () => assert.fail('must not read configuration'), link: () => assert.fail('must not call SSH') }), null);
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
function clientFixture({ outcome = 'clean', resume = null, version = 'codex 0.168.0', root = '/mc', mode = 0o700 } = {}) {
  const calls = []; const removed = []; const modes = []; const present = new Set();
  let tunnelProcess; let client; let clock = 0; let ended;
  const io = {
    mkdirSync: (path, options) => { modes.push([path, options.mode]); },
    mkdtempSync: prefix => `${prefix}abcdef`, chmodSync: (path, value) => modes.push([path, value]),
    statSync: () => ({ uid: process.getuid(), mode }), existsSync: path => present.has(path),
    rmSync: (path, options) => removed.push([path, options]),
  };
  let resolveConnection;
  const connection = { session: session({ resume }), closed: new Promise(resolve => { resolveConnection = resolve; }),
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
for (const resume of [null, 'thread-a']) test(`Codex ${resume ? 'join' : 'new thread'} argv by member; tunnel argv and private short socket`, async () => {
  const f = clientFixture({ resume });
  assert.equal((await f.link.codexClient(f.connection)).status, 0);
  const forward = f.calls.find(call => call.bin === 'ssh');
  const socket = '/mc/runner/s/c-abcdef/s';
  assert.deepEqual(forward.args, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${socket}:/server/socket`, 'tc']);
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.deepEqual(f.modes, [['/mc/runner/s', 0o700], ['/mc/runner/s/c-abcdef', 0o700]]);
  const tui = f.calls.find(call => call.bin === 'codex' && call.args[0] !== '--version');
  assert.deepEqual(tui.args, [...(resume ? ['resume', resume] : ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']), '--remote', `unix://${socket}`]);
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
