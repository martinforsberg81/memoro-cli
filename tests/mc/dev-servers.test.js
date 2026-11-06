/**
 * The cross-worktree inventory, and the two failures that decided its shape.
 *
 * It was removed on 2026-09-03 as unreachable and measured in `mc-dev-1` as
 * unread: 565 invocations in a month, ten of them by a person, and 33
 * registered manifests with not one live pid. So the rules asserted here are
 * the answers to those two facts — a `list` that sweeps what it reads, and a
 * `list` that a caller can use as a capability probe on an empty machine.
 *
 * Everything runs against a temporary directory. No dev server is started and
 * none has to exist: a registration is a file, and every rule about it is a
 * rule about text.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, it } from 'node:test';

import {
  admission, admit, checkManifest, freeMemoryPercent, holdersOf, keptHolds, listServers, processCwd, refusalText, registerManifest, serversUnder,
  stopServersUnder, strayCwd, touchServer, unregisterManifest, waitingLine, DEFAULT_MAX_SERVERS, DEFAULT_HOLDER_STALE_MINUTES,
} from '../../src/mc/dev-servers.js';
import {
  devQueuePath, GATE_PRIORITY_MS, joinQueue, leaveQueue, nextInQueue, queueOrder, readQueue,
} from '../../src/mc/dev-queue.js';
import { run } from '../../src/mc/commands/dev.js';
import {
  addReservationPid, devPoolPath, disownReservation, LockError, readReservations, SLOT_LIMIT, slotCapOf, withFileLock,
} from '../../src/mc/dev-reservations.js';
import { setLogPath } from '../../src/mc/logger.js';

/** A pid that is certainly not running, and one that certainly is. */
const DEAD_PID = 2_147_483_646;
const LIVE_PID = process.pid;

function scratch() {
  return mkdtempSync(join(tmpdir(), 'mc-dev-servers-'));
}

/** A manifest of the shape memoro's `buildMcDevManifest` writes. */
function manifest(worktree, overrides = {}) {
  return {
    schema_version: 1,
    instance_id: 'dev-0123abcd',
    service: 'memoro-worker',
    profile: 'agent',
    definition_fingerprint: `sha256:${'a'.repeat(64)}`,
    start_argv: ['npm', 'run', 'dev', '--', '--skip-containers'],
    resource_class: 'standard',
    session_name: 'weather-assets',
    coding_session_id: 'sess_example',
    worktree_path: worktree,
    pid: LIVE_PID,
    process_group_id: LIVE_PID,
    url: 'http://127.0.0.1:8890',
    port: 8890,
    health_url: 'http://127.0.0.1:8890/api/version',
    log_path: join(worktree, '.wrangler', 'dev-server', 'logs', 'dev.log'),
    started_at: '2026-09-05T10:00:00.000Z',
    control: {
      stop: { argv: ['/usr/bin/node', join(worktree, 'scripts', 'dev.mjs'), '--stop'], timeout_ms: 30_000 },
      restart: { argv: ['/usr/bin/node', join(worktree, 'scripts', 'dev.mjs'), '--restart'], detached: true },
    },
    ...overrides,
  };
}

/** Write a source manifest where the protocol says it has to live. */
function writeSource(worktree, overrides = {}) {
  const dir = join(worktree, '.wrangler', 'dev-server', 'run');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mc-dev.json');
  writeFileSync(path, `${JSON.stringify(manifest(worktree, overrides), null, 2)}\n`);
  return path;
}

/** A yes: admitted, and the slot held by a reservation. */
function assertReserved(verdict, message) {
  assert.equal(verdict.ok, true, message || JSON.stringify(verdict));
  assert.match(verdict.reservation, /^res-/u, message || JSON.stringify(verdict));
}

function capture() {
  const out = [];
  return { write: (text) => out.push(text), text: () => out.join('') };
}

describe('what a manifest has to say', () => {
  it('accepts the shape the wrapper writes', () => {
    const worktree = scratch();
    assert.deepEqual(checkManifest(manifest(worktree), { sourcePath: writeSource(worktree) }), {
      ok: true, problems: [],
    });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses an endpoint that is not loopback', () => {
    const worktree = scratch();
    const checked = checkManifest(manifest(worktree, { url: 'http://192.168.1.10:8787' }));
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.some((problem) => problem.startsWith('url:')), checked.problems.join('; '));
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses an instance id that is a path', () => {
    const worktree = scratch();
    for (const instanceId of ['../escape', 'a/b', '..', '']) {
      const checked = checkManifest(manifest(worktree, { instance_id: instanceId }));
      assert.equal(checked.ok, false, `${JSON.stringify(instanceId)} was accepted`);
      assert.ok(checked.problems.some((problem) => problem.startsWith('instance_id:')));
    }
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses a log or a manifest that escapes the worktree it claims', () => {
    const worktree = scratch();
    const outside = checkManifest(manifest(worktree, { log_path: '/tmp/elsewhere/dev.log' }));
    assert.equal(outside.ok, false);
    assert.ok(outside.problems.some((problem) => problem.startsWith('log_path:')));

    // A sibling directory whose name starts with the worktree's own is not
    // inside it, however the two strings compare.
    const sibling = checkManifest(manifest(worktree), { sourcePath: `${worktree}-other/mc-dev.json` });
    assert.equal(sibling.ok, false);
    assert.ok(sibling.problems.some((problem) => problem.includes('inside worktree_path')));
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses a control command written as a shell string', () => {
    const worktree = scratch();
    const checked = checkManifest(manifest(worktree, {
      control: { stop: { argv: 'npm run dev -- --stop' } },
    }));
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.some((problem) => problem.startsWith('control.stop.argv:')));
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses a schema it does not know', () => {
    const worktree = scratch();
    const checked = checkManifest(manifest(worktree, { schema_version: 2 }));
    assert.equal(checked.ok, false);
    assert.ok(checked.problems.some((problem) => problem.startsWith('schema_version:')));
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('registering and forgetting', () => {
  it('keeps a copy that says where it came from, and replaces it on a restart', () => {
    const root = scratch();
    const worktree = scratch();
    const source = writeSource(worktree);

    const first = registerManifest(source, { root });
    assert.equal(first.ok, true);
    assert.equal(first.replaced, false);

    const second = registerManifest(source, { root });
    assert.equal(second.replaced, true, 'a restart keeps its instance id and replaces the record');

    const { servers } = listServers({ root });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].source_manifest_path, source);
    assert.equal(servers[0].registered_at, listServers({ root }).servers[0].registered_at);
    assert.equal(servers[0].live, true);

    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses an invalid manifest instead of normalising it', () => {
    const root = scratch();
    const worktree = scratch();
    const source = writeSource(worktree, { url: 'http://memoro.example:8787' });
    const result = registerManifest(source, { root });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
    assert.equal(readdirSync(root).length, 0, 'nothing is written for a manifest that was refused');
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('unregisters by the source path after the source file is gone', () => {
    const root = scratch();
    const worktree = scratch();
    const source = writeSource(worktree);
    registerManifest(source, { root });
    rmSync(source, { force: true });

    const result = unregisterManifest(source, { root, alive: () => false });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.deepEqual(listServers({ root }).servers, []);
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('live unregister retains capacity after source removal until confirmed death', async () => {
    const root = scratch();
    const worktree = scratch();
    try {
      const source = writeSource(worktree);
      registerManifest(source, { root });
      unregisterManifest(source, { root });
      rmSync(source);
      const leaving = unregisterManifest(source, { root });
      const refused = await admit({ root, service: 'memoro-worker', worktree: '/w/replacement', env: { MC_DEV_MAX_SERVERS: '1' }, freeMemory: () => 90 });
      assert.equal(refused.reason, 'cap');
      assert.deepEqual(refused.holders.map((item) => item.instance_id), ['dev-0123abcd']);
      assert.equal(leaving.removed, false);
      assert.equal(leaving.reason, 'still-running');
      const same = await admit({ root, service: 'memoro-worker', worktree, env: {}, freeMemory: () => 90 });
      assert.equal(same.reuse, 'dev-0123abcd', 'restart cannot reserve while the old pid is live');
      assert.equal(unregisterManifest(source, { root, alive: () => false }).removed, true);
      assert.deepEqual(listServers({ root }).servers, []);
      const next = await admit({ root, service: 'memoro-worker', worktree, env: {}, freeMemory: () => 90 });
      assert.match(next.reservation, /^res-/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('is not an error to unregister what was never registered', () => {
    const root = scratch();
    const result = unregisterManifest(join(root, 'nothing', 'mc-dev.json'), { root });
    assert.deepEqual(result, { ok: true, instance_id: null, removed: false, reason: 'not-registered' });
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the sweep', () => {
  it('a registration whose process is gone is not a server', () => {
    const root = scratch();
    const worktree = scratch();
    const source = writeSource(worktree, { pid: DEAD_PID });
    registerManifest(source, { root });

    assert.equal(listServers({ root, reap: false }).servers.length, 1, 'the file is there before the sweep');

    const swept = listServers({ root });
    assert.deepEqual(swept.servers, []);
    assert.deepEqual(swept.reaped, ['dev-0123abcd']);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.json')), [], 'the sweep removes the file, not just the row');

    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('each swept record is logged as dev-server-gone, and a live one is not', () => {
    const root = scratch();
    const dead = scratch();
    const alive = scratch();
    registerManifest(writeSource(dead, { pid: DEAD_PID, started_at: '2026-09-26T10:00:00.000Z' }), { root });
    registerManifest(writeSource(alive, { instance_id: 'dev-live0001' }), { root });
    const logFile = join(scratch(), 'mc.log');
    setLogPath(logFile);
    try {
      const swept = listServers({ root, now: () => Date.parse('2026-09-26T10:04:54.900Z') });
      assert.deepEqual(swept.reaped, ['dev-0123abcd']);
      assert.deepEqual(swept.servers.map((s) => s.instance_id), ['dev-live0001']);
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].event, 'dev-server-gone');
      assert.equal(lines[0].instance_id, 'dev-0123abcd');
      assert.equal(lines[0].worktree_path, dead);
      assert.equal(lines[0].server_pid, DEAD_PID);
      assert.equal(lines[0].age_s, 294);

      listServers({ root });
      assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1, 'swept once, logged once');
    } finally {
      setLogPath(null);
    }
  });

  it('a started_at that does not parse is an age of null, not a guess', () => {
    const root = scratch();
    registerManifest(writeSource(scratch(), { pid: DEAD_PID, started_at: 'yesterday-ish' }), { root });
    const logFile = join(scratch(), 'mc.log');
    setLogPath(logFile);
    try {
      listServers({ root });
      const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
      assert.equal(line.event, 'dev-server-gone');
      assert.equal(line.age_s, null);
    } finally {
      setLogPath(null);
    }
  });

  it('a file that is not JSON is ignored rather than thrown over', () => {
    const root = scratch();
    writeFileSync(join(root, 'broken.json'), 'not json at all\n');
    assert.deepEqual(listServers({ root }).servers, []);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the verb memoro calls', () => {
  it('list --json exits 0 and prints JSON on an empty machine', async () => {
    // This is the capability probe. An mc that does not have the verb exits 2
    // with a message; an empty inventory must not look like that.
    const root = join(scratch(), 'not-created-yet');
    const stdout = capture();
    const code = await run(['list', '--json'], { stdout, stderr: capture(), root });
    assert.equal(code, 0);
    const answer = JSON.parse(stdout.text());
    assert.deepEqual(answer.servers, []);
    assert.equal(answer.schema_version, 1);
  });

  it('register then unregister, in the words the wrapper uses', async () => {
    const root = scratch();
    const worktree = scratch();
    const source = writeSource(worktree);

    const registered = capture();
    assert.equal(await run(['register', source, '--json'], { stdout: registered, stderr: capture(), root }), 0);
    assert.equal(JSON.parse(registered.text()).instance_id, 'dev-0123abcd');

    const listed = capture();
    await run(['list', '--json'], { stdout: listed, stderr: capture(), root });
    assert.equal(JSON.parse(listed.text()).servers.length, 1);

    const gone = capture();
    assert.equal(await run(['unregister', source, '--json'], { stdout: gone, stderr: capture(), root }), 0);
    assert.equal(JSON.parse(gone.text()).removed, false);
    assert.equal(JSON.parse(gone.text()).reason, 'still-running');

    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('says what it does not have a verb for', async () => {
    const stderr = capture();
    const code = await run(['ensure'], { stdout: capture(), stderr, root: scratch() });
    assert.equal(code, 2);
    assert.match(stderr.text(), /mc dev ensure\? — list, status, register, unregister/u);
  });

  it('register without a manifest is a usage error, not a crash', async () => {
    const stderr = capture();
    assert.equal(await run(['register'], { stdout: capture(), stderr, root: scratch() }), 2);
    assert.match(stderr.text(), /needs the path of the manifest/u);
  });
});

describe('admission — may one more server start', () => {
  const live = (id, worktree, overrides = {}) => ({
    instance_id: id,
    service: 'memoro-worker',
    worktree_path: worktree,
    started_at: '2026-09-26T08:00:00.000Z',
    url: 'http://127.0.0.1:8921',
    resource_class: 'standard',
    live: true,
    ...overrides,
  });
  const ask = (servers, overrides = {}) => admission({
    servers, service: 'memoro-worker', worktree: '/w/third', cap: 2, minFreePercent: 15, freePercent: 40, ...overrides,
  });

  it('refuses a third with both holders named', () => {
    const verdict = ask([live('measure-a', '/w/a'), live('measure-b', '/w/b')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'cap');
    assert.equal(verdict.cap, 2);
    assert.equal(verdict.free_percent, 40);
    assert.deepEqual(verdict.holders.map((holder) => holder.instance_id), ['measure-a', 'measure-b']);
    assert.deepEqual(Object.keys(verdict.holders[0]).sort(), ['instance_id', 'last_used_at', 'resource_class', 'service', 'started_at', 'url', 'worktree_path']);
  });

  it('names the holders mc may stop, oldest use first, only past staleBefore and only with a stop command', () => {
    const stop = { control: { stop: { argv: ['node', 'dev.mjs', '--stop'] } } };
    const verdict = ask([
      live('measure-a', '/w/a', { ...stop, last_used_at: '2026-10-19T19:30:00.000Z' }),
      live('measure-b', '/w/b', { ...stop, last_used_at: '2026-10-19T19:00:00.000Z' }),
      live('measure-c', '/w/c', { last_used_at: '2026-10-19T18:00:00.000Z' }),
    ], { cap: 3, staleBefore: Date.parse('2026-10-19T19:45:00Z') });
    assert.deepEqual(verdict.evictable, ['measure-b', 'measure-a'], 'c declares no stop command');
    assert.equal(ask([live('measure-a', '/w/a', stop), live('measure-b', '/w/b', stop)]).evictable, undefined, 'no staleBefore names none');
  });

  it('a light server takes a slot like any other', () => {
    const verdict = ask([live('static-a', '/w/a', { resource_class: 'light', service: 'memoro-static' }), live('measure-b', '/w/b')]);
    assert.equal(verdict.reason, 'cap');
    assert.deepEqual(verdict.holders.map((holder) => [holder.instance_id, holder.resource_class]), [['static-a', 'light'], ['measure-b', 'standard']]);
  });

  it('a live server for the asker\'s own worktree and service is reused, and takes no new slot', () => {
    assert.deepEqual(ask([live('measure-a', '/w/third'), live('measure-b', '/w/b')]), { ok: true, reuse: 'measure-a' });
    // The same worktree with another service does count.
    const other = ask([live('static-a', '/w/third', { service: 'memoro-static' }), live('measure-b', '/w/b')]);
    assert.equal(other.reason, 'cap');
  });

  it('refuses on memory below the floor, before counting', () => {
    const verdict = ask([], { freePercent: 10 });
    assert.deepEqual(verdict, { ok: false, reason: 'memory', holders: [], pending: [], free_percent: 10, cap: 2 });
  });

  it('skips the memory check when the free percentage is unknown', () => {
    assert.deepEqual(ask([], { freePercent: null }), { ok: true });
  });

  it('keeps the Darwin sysctl behavior and does not read Linux meminfo', () => {
    let read = false;
    assert.equal(freeMemoryPercent(() => ({ status: 0, stdout: '31\n' }), {
      platform: 'darwin', readFile: () => { read = true; throw new Error('must not read'); },
    }), 31);
    assert.equal(freeMemoryPercent(() => ({ status: 1, stdout: '' }), { platform: 'darwin' }), null);
    assert.equal(freeMemoryPercent(() => ({ status: 0, stdout: 'nope' }), { platform: 'darwin' }), null);
    assert.equal(freeMemoryPercent(() => { throw new Error('no sysctl'); }, { platform: 'darwin' }), null);
    assert.equal(read, false);
  });

  it('uses one valid host MemAvailable and MemTotal entry on Linux without invoking sysctl', () => {
    let command = false;
    let path;
    const result = freeMemoryPercent(() => { command = true; throw new Error('must not run'); }, {
      platform: 'linux', readFile: (file, encoding) => {
        path = [file, encoding];
        return 'MemTotal: 1000 kB\nMemFree: 900 kB\nMemAvailable: 150 kB\nCached: 700 kB\n';
      },
    });
    assert.equal(result, 15);
    assert.deepEqual(path, ['/proc/meminfo', 'utf8']);
    assert.equal(command, false);
  });

  it('reports zero, exact-floor and fractional Linux percentages without rounding', () => {
    const sample = (available, total = 100) => freeMemoryPercent(undefined, {
      platform: 'linux', readFile: () => `MemAvailable: ${available} kB\nMemTotal: ${total} kB\n`,
    });
    assert.equal(sample(0), 0);
    assert.equal(sample(15), 15);
    assert.equal(sample(100, 300), 100 / 3);
  });

  it('returns null for missing, duplicate, malformed, unsafe or inconsistent Linux fields and read failures', () => {
    const samples = [
      'MemTotal: 100 kB\n',
      'MemAvailable: 10 kB\n',
      'MemAvailable: 10 kB\nMemAvailable: 11 kB\nMemTotal: 100 kB\n',
      'MemAvailable: 10 kB\nMemTotal: 100 kB\nMemTotal: 100 kB\n',
      'MemAvailable: 10 MB\nMemTotal: 100 kB\n',
      'MemAvailable: -1 kB\nMemTotal: 100 kB\n',
      'MemAvailable: 10.5 kB\nMemTotal: 100 kB\n',
      'MemAvailable: 9007199254740992 kB\nMemTotal: 9007199254740992 kB\n',
      'MemAvailable: 10 kB\nMemTotal: 0 kB\n',
      'MemAvailable: 101 kB\nMemTotal: 100 kB\n',
    ];
    for (const contents of samples) {
      assert.equal(freeMemoryPercent(undefined, { platform: 'linux', readFile: () => contents }), null, contents);
    }
    assert.equal(freeMemoryPercent(undefined, { platform: 'linux', readFile: () => { throw new Error('unreadable'); } }), null);
  });

  it('does not probe either mechanism on unsupported platforms', () => {
    let command = false;
    let read = false;
    assert.equal(freeMemoryPercent(() => { command = true; }, {
      platform: 'freebsd', readFile: () => { read = true; },
    }), null);
    assert.equal(command, false);
    assert.equal(read, false);
  });

  it('feeds the real Linux reading through dev admission at the unchanged 15 percent floor', async () => {
    const root = scratch();
    const reading = (available) => freeMemoryPercent(undefined, {
      platform: 'linux', readFile: () => `MemAvailable: ${available} kB\nMemTotal: 100 kB\n`,
    });
    const ask = (available, worktree) => admit({
      service: 'memoro-worker', worktree, waitSeconds: 0, root, freeMemory: () => reading(available), logEvent: () => {},
    });
    const low = await ask(14, '/w/low');
    assert.equal(low.ok, false);
    assert.equal(low.reason, 'memory');
    assert.equal(low.free_percent, 14);
    assertReserved(await ask(15, '/w/at-floor'), 'the real sampler admits at the dev floor');
    const unknown = await admit({
      service: 'memoro-worker', worktree: '/w/unknown', waitSeconds: 0, root,
      freeMemory: () => freeMemoryPercent(undefined, { platform: 'freebsd' }), logEvent: () => {},
    });
    assertReserved(unknown, 'unknown sampler output keeps the existing fail-open behavior');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('admit — waiting for a slot', () => {
  // The cases below are about waiting and evicting, with two holders against
  // the cap and the stale age these tests were written for, pinned here.
  const TWO_SLOTS = { MC_DEV_MAX_SERVERS: '2', MC_DEV_HOLDER_STALE_MINUTES: '30' };

  function register(root, worktree, id) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest(worktree, { instance_id: id, service: 'memoro-worker' })));
  }

  it('waits while two are live and is admitted when one leaves, saying so once', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    let t = 0;
    let polls = 0;
    const waiting = [];
    const events = [];
    const verdict = await admit({
      service: 'memoro-worker',
      worktree: '/w/third',
      waitSeconds: 900,
      env: TWO_SLOTS,
      root,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        polls += 1;
        if (polls === 2) rmSync(join(root, 'measure-b.json'));
      },
      freeMemory: () => 50,
      onWaiting: (refused) => waiting.push(refused),
      logEvent: (event, fields) => events.push({ event, fields }),
    });
    assertReserved(verdict);
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0].holders.map((holder) => holder.instance_id), ['measure-a', 'measure-b']);
    assert.deepEqual(events, [{
      event: 'dev-server-admitted', fields: { service: 'memoro-worker', worktree_path: '/w/third', waited_s: 20, place_at_join: 1 },
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('gives up with the last refusal when the wait runs out, and logs it', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    let t = 0;
    const events = [];
    const waiting = [];
    const verdict = await admit({
      service: 'memoro-worker',
      worktree: '/w/third',
      waitSeconds: 130,
      env: { MC_DEV_MAX_SERVERS: '2' },
      root,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      freeMemory: () => null,
      onWaiting: (refused) => waiting.push(refused),
      logEvent: (event, fields) => events.push({ event, fields }),
    });
    assert.equal(verdict.reason, 'cap');
    assert.equal(waiting.length, 3, 'once a minute: at 0, 60 and 120 s');
    assert.deepEqual(events, [{
      event: 'dev-server-refused',
      fields: {
        service: 'memoro-worker', worktree_path: '/w/third', reason: 'cap', holders: ['measure-a', 'measure-b'], free_percent: null, place: 1,
      },
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('with evict, stops the holder mc has used least, past the stale age, and is admitted', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    touchServer('measure-a', { root, now: () => new Date('2026-10-19T19:00:00Z') });
    touchServer('measure-b', { root, now: () => new Date('2026-10-19T19:50:00Z') });
    const stopped = [];
    const events = [];
    let t = Date.parse('2026-10-19T20:00:00Z');
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/third', waitSeconds: 900, env: TWO_SLOTS, root, evict: true,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      freeMemory: () => 50,
      stop: (server) => { stopped.push(server.instance_id); rmSync(join(root, `${server.instance_id}.json`)); return { ok: true }; },
      logEvent: (event, fields) => events.push({ event, fields }),
    });
    assertReserved(verdict);
    assert.deepEqual(stopped, ['measure-a'], 'only the one unused for an hour; b was used ten minutes ago');
    assert.equal(events[0].event, 'dev-server-stopped');
    assert.equal(events[0].fields.reason, 'stale-holder');
    assert.equal(events[0].fields.unused_s, 3600);
    rmSync(root, { recursive: true, force: true });
  });

  it('with evict, a holder that fails to stop is tried once and the wait goes on to its refusal', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    let t = Date.parse('2026-10-19T20:00:00Z');
    const stopped = [];
    const events = [];
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/third', waitSeconds: 60, env: TWO_SLOTS, root, evict: true,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      freeMemory: () => 50,
      stop: (server) => { stopped.push(server.instance_id); return { ok: false, error: 'exited 1' }; },
      logEvent: (event, fields) => events.push({ event, fields }),
    });
    assert.equal(verdict.reason, 'cap');
    assert.deepEqual(stopped.sort(), ['measure-a', 'measure-b'], 'each holder once, never again');
    assert.deepEqual(events.map((e) => e.event), ['dev-server-evict-failed', 'dev-server-evict-failed', 'dev-server-refused']);
    rmSync(root, { recursive: true, force: true });
  });

  it('without evict, nothing is stopped however stale the holders are', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    let t = Date.parse('2026-10-19T20:00:00Z');
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/third', waitSeconds: 0, env: TWO_SLOTS, root,
      now: () => t, sleep: async (ms) => { t += ms; }, freeMemory: () => 50,
      stop: () => { throw new Error('must not stop'); }, logEvent: () => {},
    });
    assert.equal(verdict.reason, 'cap');
    assert.equal(verdict.evictable, undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('by default three slots, of any class; MC_DEV_MAX_SERVERS lowers it and cannot raise it; a holder unused five minutes is stale', async () => {
    assert.equal(DEFAULT_MAX_SERVERS, 3);
    assert.equal(DEFAULT_HOLDER_STALE_MINUTES, 5);
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    const ask = (worktree, env = {}) => admit({
      service: 'memoro-worker', worktree, waitSeconds: 0, env, root, pid: DEAD_PID,
      now: () => 0, sleep: async () => {}, freeMemory: () => 50, logEvent: () => {},
    });
    assertReserved(await ask('/w/third'), 'two live: a third is admitted');
    assert.equal((await ask('/w/third', { MC_DEV_MAX_SERVERS: '2' })).reason, 'cap', 'lowered to two, the third is refused');
    // A static server is the third holder: a fourth is refused, however high the override.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'static-c.json'), JSON.stringify(manifest('/w/c', { instance_id: 'static-c', service: 'memoro-static', resource_class: 'light' })));
    for (const env of [{}, { MC_DEV_MAX_SERVERS: '4' }, { MC_DEV_MAX_SERVERS: '99' }, { MC_DEV_MAX_SERVERS: 'lots' }]) {
      const refused = await ask('/w/fourth', env);
      assert.equal(refused.reason, 'cap', JSON.stringify(env));
      assert.equal(refused.cap, 3, JSON.stringify(env));
      assert.deepEqual(refused.holders.map((holder) => holder.instance_id), ['measure-a', 'measure-b', 'static-c']);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('touchServer records mc\'s use, and a re-registration keeps it', () => {
    const root = scratch();
    const worktree = join(root, 'wt');
    const source = join(worktree, 'manifest.json');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(source, JSON.stringify(manifest(worktree, { instance_id: 'measure-a' })));
    assert.equal(registerManifest(source, { root }).ok, true);
    assert.equal(touchServer('measure-a', { root, now: () => new Date('2026-10-19T19:00:00Z') }), true);
    assert.equal(registerManifest(source, { root }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(root, 'measure-a.json'), 'utf8')).last_used_at, '2026-10-19T19:00:00.000Z');
    assert.equal(touchServer('gone', { root }), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('mc dev admit prints JSON and exits 75 on a refusal, 0 on an admission', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    const out = capture();
    const code = await run(['admit', 'memoro-worker', '--worktree', '/w/third', '--wait', '0', '--json'], {
      root, stdout: out, stderr: capture(), env: TWO_SLOTS, freeMemory: () => 40,
    });
    assert.equal(code, 75);
    const refused = JSON.parse(out.text());
    assert.equal(refused.reason, 'cap');
    assert.deepEqual(refused.holders.map((holder) => holder.worktree_path), ['/w/a', '/w/b']);

    rmSync(join(root, 'measure-b.json'));
    const text = capture();
    assert.equal(await run(['admit', 'memoro-worker', '--worktree', '/w/third'], {
      root, stdout: text, stderr: capture(), env: TWO_SLOTS, freeMemory: () => 40,
    }), 0);
    assert.match(text.text(), /^mc: admitted — res-[0-9a-f-]+\n$/u);

    const low = capture();
    assert.equal(await run(['admit', 'memoro-worker', '--worktree', '/w/fourth'], {
      root, stdout: low, stderr: capture(), env: { MC_DEV_MIN_FREE_PERCENT: '101' }, freeMemory: () => 40,
    }), 75);
    assert.equal(low.text(), 'mc: only 40% memory free (floor 101%)\n');
    rmSync(root, { recursive: true, force: true });
  });

  it('mc dev admit needs a service, and --wait belongs to it alone', async () => {
    const err = capture();
    assert.equal(await run(['admit', '--worktree', '/w/x'], { stdout: capture(), stderr: err }), 2);
    assert.match(err.text(), /needs the service/u);
    const other = capture();
    assert.equal(await run(['list', '--wait', '5'], { stdout: capture(), stderr: other }), 2);
    assert.match(other.text(), /belong to mc dev admit/u);
  });
});

describe('main: the main server is not evicted or counted, and a kept browser holds its server', () => {
  const MAIN = { worktree: '/w/main', service: 'memoro-worker' };
  const STOP = { control: { stop: { argv: ['node', 'dev.mjs', '--stop'] } } };
  const at = Date.parse('2026-10-19T12:00:00Z');
  const live = (id, worktree) => ({
    instance_id: id, service: 'memoro-worker', worktree_path: worktree, started_at: '2026-10-19T07:00:00.000Z',
    url: 'http://127.0.0.1:8921', resource_class: 'standard', live: true,
  });
  function register(root, worktree, id, overrides = {}) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest(worktree, { instance_id: id, service: 'memoro-worker', ...overrides })));
  }
  const askOpts = (root, extra = {}) => ({
    service: 'memoro-worker',
    worktree: '/w/third',
    waitSeconds: 0,
    env: { MC_DEV_MAX_SERVERS: '1', MC_DEV_HOLDER_STALE_MINUTES: '30' },
    root,
    evict: true,
    main: MAIN,
    now: () => at,
    sleep: async () => {},
    freeMemory: () => 50,
    logEvent: () => {},
    ...extra,
  });

  it('main: a main server is not counted against the cap, so it never refuses a worktree', () => {
    const servers = [live('main-a', '/w/main')];
    const ask = (main) => admission({
      servers, service: 'memoro-worker', worktree: '/w/third', cap: 1, minFreePercent: 15, freePercent: 40, main,
    });
    assert.deepEqual(ask(MAIN), { ok: true });
    assert.equal(ask(null).reason, 'cap', 'named as nothing, the same server counts');
    assert.deepEqual(holdersOf(servers, { service: 'memoro-worker', worktree: '/w/third', main: MAIN }), []);
  });

  it('main: a main server is never stopped as a stale holder, however long it goes unused', async () => {
    const root = scratch();
    register(root, '/w/main', 'main-a', STOP);
    touchServer('main-a', { root, now: () => new Date('2026-10-19T04:00:00Z') });
    const stopped = [];
    const verdict = await admit(askOpts(root, {
      stop: (server) => { stopped.push(server.instance_id); return { ok: true }; },
    }));
    assertReserved(verdict, 'not counted, so the one slot is free');
    assert.deepEqual(stopped, []);
    rmSync(root, { recursive: true, force: true });
  });

  it('main: among the holders only a worktree server is stopped to make room; the main one stays', async () => {
    const root = scratch();
    register(root, '/w/main', 'main-a', STOP);
    register(root, '/w/b', 'measure-b', STOP);
    touchServer('main-a', { root, now: () => new Date('2026-10-19T04:00:00Z') });
    touchServer('measure-b', { root, now: () => new Date('2026-10-19T04:30:00Z') });
    const stopped = [];
    const verdict = await admit(askOpts(root, {
      stop: (server) => {
        stopped.push(server.instance_id);
        rmSync(join(root, `${server.instance_id}.json`));
        return { ok: true };
      },
    }));
    assertReserved(verdict);
    assert.deepEqual(stopped, ['measure-b'], 'the main server is the oldest use and still is not stopped');
    rmSync(root, { recursive: true, force: true });
  });

  it('main: a request for the main server is not queued behind waiters for the cap; the memory floor still refuses it', async () => {
    const base = scratch();
    const root = join(base, 'dev-servers');
    register(root, '/w/b', 'measure-b');
    const queue = devQueuePath(root);
    const ahead = {
      id: 'ahead', pid: LIVE_PID, worktree_path: '/w/c', service: 'memoro-worker', holder: 'step:ahead', gate: false,
      joined_at: new Date(at - 5 * 60_000).toISOString(),
    };
    writeFileSync(queue, JSON.stringify({ schema_version: 1, tickets: [ahead] }));
    const opts = askOpts(root, {
      worktree: '/w/main', waitSeconds: 900, sleep: async () => { throw new Error('must not wait'); },
    });
    const first = await admit({ ...opts, pid: DEAD_PID });
    assertReserved(first, 'admitted at once, though the cap is full and one waits');
    assert.deepEqual(JSON.parse(readFileSync(queue, 'utf8')).tickets.map((item) => item.id), ['ahead'], 'no ticket taken');
    const short = await admit({ ...opts, waitSeconds: 0, freeMemory: () => 5 });
    assert.equal(short.reason, 'memory');
    assert.equal(short.place, undefined, 'not in the queue');
    rmSync(base, { recursive: true, force: true });
  });

  it('main: a server a kept browser stepped on in the last 60 s is not stopped, however stale its use', async () => {
    const root = scratch();
    const sessions = scratch();
    register(root, '/w/b', 'measure-b', STOP);
    touchServer('measure-b', { root, now: () => new Date('2026-10-19T04:00:00Z') });
    writeFileSync(join(sessions, 's1.json'), JSON.stringify({
      id: 's1', server_id: 'measure-b', last_used: '2026-10-19T11:59:30.000Z',
    }));
    assert.equal(keptHolds({ instance_id: 'measure-b' }, { now: at, dir: sessions }), true, 'stepped 30 s ago');
    const stopped = [];
    const verdict = await admit(askOpts(root, {
      main: null,
      sessionsDir: sessions,
      stop: (server) => { stopped.push(server.instance_id); return { ok: true }; },
    }));
    assert.equal(verdict.ok, false);
    assert.deepEqual(stopped, [], 'the holder stays, and the request is refused');
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });
});

describe('queue: admission in order', () => {
  const T0 = Date.parse('2026-11-03T10:00:00Z');
  const MIN = 60_000;
  const ticket = (id, joinedAt, overrides = {}) => ({
    id, pid: LIVE_PID, worktree_path: `/w/${id}`, service: 'memoro-worker', holder: `step:${id}`, gate: false,
    joined_at: new Date(joinedAt).toISOString(), ...overrides,
  });
  /** A registry root of its own, so its queue file (beside it) is the test's alone. */
  function place() {
    const base = scratch();
    const root = join(base, 'dev-servers');
    mkdirSync(root, { recursive: true });
    return { base, root, queue: devQueuePath(root) };
  }
  function register(root, worktree, id, overrides = {}) {
    writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest(worktree, { instance_id: id, service: 'memoro-worker', ...overrides })));
  }
  function writeQueue(file, tickets) {
    writeFileSync(file, JSON.stringify({ schema_version: 1, tickets }));
  }
  const queued = (file) => JSON.parse(readFileSync(file, 'utf8')).tickets;

  it('queue: the default queue sits beside the registry, at ~/.memoro/mc/dev-queue.json', () => {
    assert.equal(devQueuePath('/home/me/.memoro/mc/dev-servers'), '/home/me/.memoro/mc/dev-queue.json');
  });

  it('queue: FIFO — a later ticket is never next before an earlier one', () => {
    const tickets = [ticket('c', T0 + 2 * MIN), ticket('a', T0), ticket('b', T0 + MIN)];
    assert.equal(nextInQueue(tickets, T0 + 10 * MIN).id, 'a');
    assert.deepEqual(queueOrder(tickets, T0 + 10 * MIN).map((item) => item.id), ['a', 'b', 'c']);
    assert.equal(nextInQueue([], T0), null);
  });

  it('queue: a free slot goes to the earlier ticket; the later one waits, told its place, and is admitted after', async () => {
    const { base, root, queue } = place();
    register(root, '/w/x', 'measure-x');
    register(root, '/w/y', 'measure-y');
    writeQueue(queue, [ticket('earlier', T0 - 5 * MIN)]);
    let t = T0;
    let polls = 0;
    const waiting = [];
    const events = [];
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/later', waitSeconds: 900, env: { MC_DEV_MAX_SERVERS: '2' }, root,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        polls += 1;
        // A holder leaves: the slot is free, and the earlier ticket still waits for it.
        if (polls === 1) rmSync(join(root, 'measure-y.json'));
        if (polls === 1) assert.deepEqual(queued(queue).map((item) => item.id).slice(0, 1), ['earlier']);
        // The earlier one is admitted and leaves the queue.
        if (polls === 3) writeQueue(queue, queued(queue).filter((item) => item.id !== 'earlier'));
      },
      freeMemory: () => 50,
      onWaiting: (refused) => waiting.push(refused),
      logEvent: (event, fields) => events.push({ event, fields }),
    });
    assertReserved(verdict);
    assert.equal(polls, 3, 'not admitted while the earlier ticket was at the head, though a slot was free');
    assert.equal(waiting[0].place, 2);
    assert.deepEqual(waiting[0].queue.map((item) => item.holder), ['step:earlier', null]);
    assert.deepEqual(events, [{
      event: 'dev-server-admitted',
      fields: { service: 'memoro-worker', worktree_path: '/w/later', waited_s: 30, place_at_join: 2 },
    }]);
    assert.deepEqual(queued(queue), [], 'the ticket leaves the queue when it is admitted');
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: a dead pid\'s ticket is swept on read and holds no one up', async () => {
    const { base, root, queue } = place();
    writeQueue(queue, [ticket('dead', T0 - 10 * MIN, { pid: DEAD_PID }), ticket('live', T0 - MIN)]);
    assert.deepEqual(readQueue({ file: queue }).map((item) => item.id), ['live']);
    assert.deepEqual(queued(queue).map((item) => item.id), ['live'], 'written back without it');
    writeQueue(queue, [ticket('dead', T0 - 10 * MIN, { pid: DEAD_PID })]);
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/new', waitSeconds: 0, env: {}, root, now: () => T0, freeMemory: () => 50, logEvent: () => {},
    });
    assertReserved(verdict);
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: a gate ticket that has waited two minutes goes ahead of non-gate tickets, not ahead of an earlier gate ticket', () => {
    assert.equal(GATE_PRIORITY_MS, 2 * MIN);
    const tickets = [
      ticket('shot-1', T0),
      ticket('gate-1', T0 + MIN, { gate: true }),
      ticket('shot-2', T0 + 2 * MIN),
      ticket('gate-2', T0 + 3 * MIN, { gate: true }),
    ];
    assert.deepEqual(queueOrder(tickets, T0 + 5 * MIN).map((item) => item.id), ['gate-1', 'gate-2', 'shot-1', 'shot-2']);
    assert.equal(nextInQueue(tickets, T0 + 5 * MIN).id, 'gate-1', 'the earlier gate ticket stays ahead of the later one');
  });

  it('queue: a gate ticket that has waited less than two minutes does not move', () => {
    const tickets = [ticket('shot-1', T0), ticket('gate-1', T0 + MIN, { gate: true }), ticket('shot-2', T0 + 2 * MIN)];
    assert.deepEqual(queueOrder(tickets, T0 + 2 * MIN + 59_000).map((item) => item.id), ['shot-1', 'gate-1', 'shot-2']);
    assert.deepEqual(queueOrder(tickets, T0 + 3 * MIN).map((item) => item.id), ['gate-1', 'shot-1', 'shot-2'], 'at two minutes it moves');
  });

  it('queue: a ticket says who holds it and whether it is a gate round', () => {
    const { base, queue } = place();
    const gate = joinQueue({ file: queue, worktree: '/w/g', service: 'memoro-worker', env: { MC_GATE_ROUND: 'gate-1' }, now: T0 });
    const step = joinQueue({ file: queue, worktree: '/w/s', service: 'memoro-worker', env: { MC_STEP: 'dev-queue:0', MC_GATE_ROUND: 'gate-2' }, now: T0 });
    const session = joinQueue({ file: queue, worktree: '/w/c', service: 'memoro-worker', env: { CLAUDE_CODE_SESSION_ID: 'sess-1' }, now: T0 });
    assert.deepEqual([gate, step, session].map((item) => [item.holder, item.gate, item.pid]),
      [['gate-1', true, process.pid], ['dev-queue:0', true, process.pid], ['sess-1', false, process.pid]]);
    leaveQueue(step.id, { file: queue });
    assert.deepEqual(queued(queue).map((item) => item.id), [gate.id, session.id]);
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: a request for a worktree and service with a live server of its own is a reuse, not queued', async () => {
    const { base, root, queue } = place();
    register(root, '/w/mine', 'measure-mine');
    writeQueue(queue, [ticket('ahead', T0 - MIN)]);
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/mine', waitSeconds: 900, env: {}, root, now: () => T0,
      sleep: async () => { throw new Error('must not wait'); }, freeMemory: () => 50, logEvent: () => {},
    });
    assert.deepEqual(verdict, { ok: true, reuse: 'measure-mine' }, 'reused, and no slot reserved');
    assert.deepEqual(queued(queue).map((item) => item.id), ['ahead'], 'no ticket was taken');
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: a request that does not wait cannot overtake the queue', async () => {
    const { base, root, queue } = place();
    writeQueue(queue, [ticket('ahead', T0 - MIN)]);
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/new', waitSeconds: 0, env: {}, root, now: () => T0, freeMemory: () => 50, logEvent: () => {},
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'queue');
    assert.equal(verdict.place, 2);
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: the head alone stops a stale holder; a gate ticket behind it stops nothing', async () => {
    const { base, root, queue } = place();
    register(root, '/w/x', 'measure-x');
    touchServer('measure-x', { root, now: () => new Date(T0 - 60 * MIN) });
    writeQueue(queue, [ticket('ahead', T0 - 10 * MIN)]);
    let t = T0;
    const verdict = await admit({
      service: 'memoro-worker', worktree: '/w/gate', waitSeconds: 30, env: { MC_DEV_MAX_SERVERS: '1', MC_GATE_ROUND: 'gate-9' }, root, evict: true,
      now: () => t, sleep: async (ms) => { t += ms; }, freeMemory: () => 50,
      stop: () => { throw new Error('must not stop'); }, logEvent: () => {},
    });
    assert.equal(verdict.reason, 'cap');
    assert.equal(verdict.place, 2);
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: the waiting line names the place, the holders and mc\'s last use; --json adds place and queue to a refusal', async () => {
    const { base, root, queue } = place();
    register(root, '/w/x', 'measure-x');
    touchServer('measure-x', { root, now: () => new Date(T0 - 4 * MIN) });
    writeQueue(queue, [ticket('ahead', T0 - MIN)]);
    let t = T0;
    const out = capture();
    const err = capture();
    const code = await run(['admit', 'memoro-worker', '--worktree', '/w/third', '--wait', '30', '--json'], {
      root, stdout: out, stderr: err, env: { MC_DEV_MAX_SERVERS: '1' }, freeMemory: () => 40,
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    assert.equal(code, 75);
    assert.equal(err.text(), 'mc: waiting for a slot — place 2 of 2; held by measure-x (/w/x, used 4 min ago)\n');
    const refused = JSON.parse(out.text());
    assert.equal(refused.place, 2);
    assert.deepEqual(refused.queue.map((item) => item.holder), ['step:ahead', null]);
    assert.equal(refused.holders[0].last_used_at, new Date(T0 - 4 * MIN).toISOString());
    assert.equal(waitingLine({ holders: [], place: 1, queue: [] }), 'mc: waiting for a slot — place 1 of 1; held by no app server');
    assert.equal(waitingLine({ holders: [{ instance_id: 'a', worktree_path: '/w/a' }] }), 'mc: waiting for a slot — held by a (/w/a)');
    rmSync(base, { recursive: true, force: true });
  });

  it('queue: mc dev status prints the servers, the queue in order, the cap and free memory', async () => {
    const { base, root, queue } = place();
    register(root, '/w/x', 'measure-x');
    touchServer('measure-x', { root, now: () => new Date(T0 - 4 * MIN) });
    register(root, '/w/s', 'static-s', { resource_class: 'light' });
    writeQueue(queue, [
      ticket('shot', T0 - 5 * MIN),
      ticket('gate', T0 - 3 * MIN, { gate: true, holder: 'gate-7' }),
      ticket('gone', T0 - 9 * MIN, { pid: DEAD_PID }),
    ]);
    const out = capture();
    assert.equal(await run(['status'], { root, stdout: out, stderr: capture(), env: {}, freeMemory: () => 38, now: () => T0 }), 0);
    assert.equal(out.text(), [
      'mc: 2 of 3 dev-server slots · 38% memory free (floor 15%)',
      '  measure-x  memoro-worker  /w/x  used 4 min ago',
      '  static-s  memoro-worker  /w/s  used 1416 h ago',
      'mc: 2 waiting, in the order they will be admitted',
      '  1. gate-7 (gate)  memoro-worker  /w/gate  joined 3 min ago',
      '  2. step:shot  memoro-worker  /w/shot  joined 5 min ago',
      '',
    ].join('\n'));
    const json = capture();
    assert.equal(await run(['status', '--json'], { root, stdout: json, stderr: capture(), env: {}, freeMemory: () => null, now: () => T0 }), 0);
    const parsed = JSON.parse(json.text());
    assert.deepEqual([parsed.cap, parsed.free_percent, parsed.min_free_percent], [3, null, 15]);
    assert.deepEqual(parsed.servers.map((server) => server.instance_id), ['measure-x', 'static-s']);
    assert.deepEqual(parsed.pending, []);
    assert.deepEqual(parsed.queue.map((item) => [item.holder, item.gate, item.waited_s]), [['gate-7', true, 180], ['step:shot', false, 300]]);

    writeQueue(queue, []);
    const empty = capture();
    await run(['status'], { root, stdout: empty, stderr: capture(), env: {}, freeMemory: () => 38, now: () => T0 });
    assert.match(empty.text(), /mc: nobody is waiting\n$/u);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('a server that runs somewhere else', () => {
  it('processCwd reads lsof\'s n line, and null on any failure', () => {
    const asked = [];
    const run = (command, args, options) => {
      asked.push({ command, args, options });
      return { status: 0, stdout: 'p123\nfcwd\nn/Users/x/memoro\n' };
    };
    assert.equal(processCwd(123, { run }), '/Users/x/memoro');
    assert.equal(asked[0].command, 'lsof');
    assert.deepEqual(asked[0].args, ['-a', '-p', '123', '-d', 'cwd', '-Fn']);

    assert.equal(processCwd(123, { run: () => ({ status: 1, stdout: '' }) }), null);
    assert.equal(processCwd(123, { run: () => ({ status: 0, stdout: 'p123\n' }) }), null);
    assert.equal(processCwd(123, { run: () => { throw new Error('no lsof'); } }), null);
  });

  it('strayCwd: its own worktree, a symlink to it and an unknown cwd are not stray; another directory is', () => {
    const a = scratch();
    const b = scratch();
    const link = join(scratch(), 'link');
    symlinkSync(a, link);

    assert.equal(strayCwd({ pid: 1, worktree_path: a }, { cwdOf: () => a }), null);
    assert.equal(strayCwd({ pid: 1, worktree_path: a }, { cwdOf: () => link }), null);
    assert.equal(strayCwd({ pid: 1, worktree_path: a }, { cwdOf: () => null }), null);
    assert.deepEqual(strayCwd({ pid: 1, worktree_path: a }, { cwdOf: () => b }), { cwd: b });
    assert.equal(strayCwd({ worktree_path: a }, { cwdOf: () => b }), null);
  });

  it('mc dev list marks a stray server in text and leaves --json alone', async () => {
    const root = scratch();
    const worktree = scratch();
    await run(['register', writeSource(worktree), '--json'], { stdout: capture(), stderr: capture(), root });

    const text = capture();
    assert.equal(await run(['list'], { stdout: text, stderr: capture(), root, processCwd: () => '/somewhere/else' }), 0);
    assert.match(text.text(), /  \(runs in \/somewhere\/else — not this worktree's\)\n/u);

    const home = capture();
    assert.equal(await run(['list'], { stdout: home, stderr: capture(), root, processCwd: () => worktree }), 0);
    assert.doesNotMatch(home.text(), /runs in/u);

    const json = capture();
    const code = await run(['list', '--json'], {
      stdout: json,
      stderr: capture(),
      root,
      processCwd: () => { throw new Error('not for json'); },
    });
    assert.equal(code, 0);
    const { servers } = JSON.parse(json.text());
    assert.equal(servers.length, 1);
    assert.equal(Object.keys(servers[0]).some((key) => key.includes('cwd')), false);
  });
});

describe('stopping what a worktree runs', () => {
  /** Three registered servers: a worktree, a directory below it, and a sibling sharing its prefix. */
  function neighbours() {
    const root = scratch();
    const base = scratch();
    const here = join(base, 'memoro');
    const below = join(here, 'nested');
    const sibling = join(base, 'memoro2');
    registerManifest(writeSource(here, { instance_id: 'dev-here' }), { root });
    registerManifest(writeSource(below, { instance_id: 'dev-below' }), { root });
    registerManifest(writeSource(sibling, { instance_id: 'dev-sibling' }), { root });
    return { root, here, sibling };
  }

  it('serversUnder is the worktree and what is below it, never a sibling with the same prefix', () => {
    const { root, here, sibling } = neighbours();
    assert.deepEqual(serversUnder(here, { root }).map((s) => s.instance_id).sort(), ['dev-below', 'dev-here']);
    assert.deepEqual(serversUnder(`${here}/`, { root }).map((s) => s.instance_id).sort(), ['dev-below', 'dev-here']);
    assert.deepEqual(serversUnder(sibling, { root }).map((s) => s.instance_id), ['dev-sibling']);
  });

  it('stopServersUnder stops each through the injected stop and logs one line per server', () => {
    const { root, here } = neighbours();
    const logFile = join(scratch(), 'mc.log');
    setLogPath(logFile);
    try {
      const asked = [];
      const result = stopServersUnder(here, {
        root,
        reason: 'worktree-removed',
        stop: (server) => {
          asked.push(server.instance_id);
          return server.instance_id === 'dev-here' ? { ok: true } : { ok: false, error: 'exited 1' };
        },
      });
      assert.deepEqual(asked.sort(), ['dev-below', 'dev-here']);
      assert.deepEqual(result.stopped, ['dev-here']);
      assert.deepEqual(result.failed, [{ instance_id: 'dev-below', error: 'exited 1' }]);
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      for (const line of lines) {
        assert.equal(line.event, 'dev-server-stopped');
        assert.equal(line.reason, 'worktree-removed');
        assert.equal(line.service, 'memoro-worker');
      }
      assert.deepEqual(lines.map((l) => [l.instance_id, l.ok]).sort(), [['dev-below', false], ['dev-here', true]]);
    } finally {
      setLogPath(null);
    }
  });

  it('mc dev stop with an id nothing runs under exits 1 and says where to look', async () => {
    const stderr = capture();
    let stopped = false;
    const code = await run(['stop', 'dev-nobody'], {
      stdout: capture(), stderr, root: scratch(), stopServer: () => { stopped = true; return { ok: true }; },
    });
    assert.equal(code, 1);
    assert.equal(stopped, false);
    assert.match(stderr.text(), /mc dev stop: no live server dev-nobody — mc dev list shows what is running/u);
  });

  it('mc dev stop stops a live server through its own stop command and logs it as asked', async () => {
    const root = scratch();
    const worktree = scratch();
    registerManifest(writeSource(worktree), { root });
    const logFile = join(scratch(), 'mc.log');
    setLogPath(logFile);
    try {
      const stdout = capture();
      const asked = [];
      const code = await run(['stop', 'dev-0123abcd'], {
        stdout, stderr: capture(), root, stopServer: (server) => { asked.push(server.control.stop.argv.at(-1)); return { ok: true }; },
      });
      assert.equal(code, 0);
      assert.deepEqual(asked, ['--stop']);
      assert.equal(stdout.text(), 'mc: stopped dev-0123abcd (http://127.0.0.1:8890)\n');
      const line = JSON.parse(readFileSync(logFile, 'utf8').trim());
      assert.equal(line.event, 'dev-server-stopped');
      assert.equal(line.reason, 'asked');
      assert.equal(line.ok, true);
    } finally {
      setLogPath(null);
    }
  });

  it('mc dev stop needs exactly one instance id', async () => {
    assert.equal(await run(['stop'], { stdout: capture(), stderr: capture(), root: scratch() }), 2);
    assert.equal(await run(['stop', 'a', 'b'], { stdout: capture(), stderr: capture(), root: scratch() }), 2);
  });
});

describe('reservations: the slot is held from yes to registration', () => {
  const ASK = {
    service: 'memoro-worker', waitSeconds: 0, env: {}, now: () => 0, sleep: async () => {}, freeMemory: () => 50, logEvent: () => {},
  };
  /** A registry root of its own; its reservations live inside it. */
  function pool() {
    const base = scratch();
    const root = join(base, 'dev-servers');
    mkdirSync(root, { recursive: true });
    return { base, root, file: devPoolPath(root) };
  }
  function register(root, worktree, id, overrides = {}) {
    writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest(worktree, { instance_id: id, ...overrides })));
  }
  const held = (file) => readReservations(file).map((item) => item.worktree_path);

  it('reservations: three starts that have not registered take all three slots; a fourth of any class is refused, naming them', async () => {
    assert.equal(SLOT_LIMIT, 3);
    const { base, root, file } = pool();
    for (const worktree of ['/w/a', '/w/b', '/w/c']) assertReserved(await admit({ ...ASK, worktree, root }), worktree);
    assert.deepEqual(held(file), ['/w/a', '/w/b', '/w/c']);
    const refused = await admit({ ...ASK, worktree: '/w/d', root, service: 'memoro-static' });
    assert.equal(refused.reason, 'cap');
    assert.deepEqual(refused.holders, []);
    assert.deepEqual(refused.pending.map((item) => item.worktree_path), ['/w/a', '/w/b', '/w/c']);
    assert.match(refusalOf(refused), /0 running and 3 starting \(res-.+ for \/w\/a, .+\) of 3 dev-server slots/u);
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: a registration fulfils its reservation — the server is counted once, not twice', async () => {
    const { base, root, file } = pool();
    const worktree = join(base, 'wt');
    const first = await admit({ ...ASK, worktree, root });
    assertReserved(first);
    assertReserved(await admit({ ...ASK, worktree: '/w/b', root }));
    const source = writeSource(worktree, { instance_id: 'dev-a', reservation_id: first.reservation });
    const done = registerManifest(source, { root });
    assert.deepEqual([done.ok, done.reservation], [true, first.reservation]);
    assert.deepEqual(held(file), ['/w/b'], 'the registered one left the reservations');
    // One registered and one starting: a third fits, a fourth does not.
    assertReserved(await admit({ ...ASK, worktree: '/w/c', root }));
    const refused = await admit({ ...ASK, worktree: '/w/d', root });
    assert.deepEqual([refused.reason, refused.holders.map((item) => item.instance_id), refused.pending.map((item) => item.worktree_path)],
      ['cap', ['dev-a'], ['/w/b', '/w/c']]);
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: an older wrapper that names no reservation fulfils the one for its service and worktree', async () => {
    const { base, root, file } = pool();
    const worktree = join(base, 'wt');
    assertReserved(await admit({ ...ASK, worktree, root }));
    assert.equal(registerManifest(writeSource(worktree, { instance_id: 'dev-old' }), { root }).ok, true);
    assert.deepEqual(held(file), []);
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: a second start for the same service and worktree is not a second slot — starting, then a reuse', async () => {
    const { base, root } = pool();
    const worktree = join(base, 'wt');
    const first = await admit({ ...ASK, worktree, root });
    assertReserved(first);
    const again = await admit({ ...ASK, worktree, root });
    assert.deepEqual([again.ok, again.reason, again.reservation], [false, 'starting', first.reservation]);
    let polls = 0;
    const waited = await admit({
      ...ASK, worktree, root, waitSeconds: 900,
      sleep: async () => { polls += 1; if (polls === 2) registerManifest(writeSource(worktree, { instance_id: 'dev-a', reservation_id: first.reservation }), { root }); },
    });
    assert.deepEqual(waited, { ok: true, reuse: 'dev-a' }, 'it waited for the first and took it');
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: MAIN takes no slot and there is one — a second MAIN start waits on the first', async () => {
    const { base, root, file } = pool();
    const main = { worktree: '/w/main', service: 'memoro-worker' };
    for (const worktree of ['/w/a', '/w/b', '/w/c']) assertReserved(await admit({ ...ASK, worktree, root, main }));
    const mainStart = await admit({ ...ASK, worktree: '/w/main', root, main });
    assertReserved(mainStart, 'three slots taken, MAIN still starts');
    assert.equal(readReservations(file).find((item) => item.id === mainStart.reservation).main, true);
    assert.equal((await admit({ ...ASK, worktree: '/w/main', root, main })).reason, 'starting', 'never a second MAIN');
    // The checkout's other service is not MAIN: it needs a slot, and there is none.
    assert.equal((await admit({ ...ASK, worktree: '/w/main', root, main, service: 'memoro-static' })).reason, 'cap');
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: held while any of its processes lives, however old; swept and logged once none does', async () => {
    const { base, root, file } = pool();
    const events = [];
    const slow = await admit({ ...ASK, worktree: '/w/slow', root, now: () => Date.parse('2026-01-01T00:00:00Z') });
    const dead = await admit({ ...ASK, worktree: '/w/dead', root, pid: DEAD_PID });
    assertReserved(slow);
    assertReserved(dead);
    // Months later the slow build's process is still alive: still its slot.
    const later = await admit({ ...ASK, worktree: '/w/next', root, now: () => Date.parse('2026-11-05T00:00:00Z'), logEvent: (event, fields) => events.push({ event, fields }) });
    assertReserved(later);
    assert.deepEqual(held(file), ['/w/slow', '/w/next']);
    assert.deepEqual(events, [{
      event: 'dev-reservation-swept', fields: { reservation: dead.reservation, service: 'memoro-worker', worktree_path: '/w/dead', pids: [DEAD_PID] },
    }]);
    rmSync(base, { recursive: true, force: true });
  });

  it('reservations: the child mc spawned holds it after mc lets go; letting go of the last live pid frees it', async () => {
    const { base, root, file } = pool();
    const asked = await admit({ ...ASK, worktree: '/w/a', root });
    assert.equal(addReservationPid({ file, id: asked.reservation, pid: process.ppid }), true);
    assert.deepEqual(disownReservation({ file, id: asked.reservation, pids: [process.pid] }), { removed: false, held: true });
    assert.deepEqual(readReservations(file)[0].pids, [process.ppid], 'the child keeps the slot');
    assert.deepEqual(disownReservation({ file, id: asked.reservation, pids: [process.ppid] }), { removed: true, held: false });
    assert.deepEqual(held(file), []);
    rmSync(base, { recursive: true, force: true });
  });

  it('handoff: mc dev admit reserves for its owner, and a wrapper adopts mc\'s reservation once — "1" or a stranger\'s id is no pass', async () => {
    const { base, root, file } = pool();
    const ask = async (worktree, env, deps = {}) => {
      const out = capture();
      const code = await run(['admit', 'memoro-worker', '--worktree', worktree, '--json'], {
        root, stdout: out, stderr: capture(), env: { MC_DEV_OWNER_PID: String(process.pid), ...env }, freeMemory: () => 40, main: null, ...deps,
      });
      return { code, verdict: JSON.parse(out.text()) };
    };
    const mine = await ask('/w/a', {});
    assert.equal(mine.code, 0);
    assert.deepEqual(readReservations(file).find((item) => item.id === mine.verdict.reservation).pids, [process.pid], 'held by the wrapper, not by the exiting mc');
    // The wrapper it was started for is dead: nothing is reserved for it, whoever its parent is.
    const orphan = await ask('/w/b', { MC_DEV_OWNER_PID: String(DEAD_PID) }, { ppid: process.ppid });
    assert.deepEqual([orphan.code, orphan.verdict.reason], [75, 'owner-gone']);
    assert.equal(readReservations(file).some((item) => item.worktree_path === '/w/b'), false, 'no slot is held for a gone owner');
    // A third, made by mc for /w/c, is adopted by its wrapper and not doubled.
    const made = await admit({ ...ASK, worktree: '/w/c', root });
    const adopted = await ask('/w/c', { MC_DEV_ADMITTED: made.reservation });
    assert.deepEqual(adopted.verdict, { ok: true, reservation: made.reservation, adopted: true });
    assert.deepEqual(readReservations(file).find((item) => item.id === made.reservation).pids, [process.pid]);
    assert.equal(readReservations(file).length, 2, 'adopting took no slot (the gone owner made none)');
    // A second process that inherited the id is no second starter.
    const second = await ask('/w/c', { MC_DEV_ADMITTED: made.reservation, MC_DEV_OWNER_PID: String(process.ppid) });
    assert.deepEqual([second.code, second.verdict.reason], [75, 'starting']);
    // "1", or mc's id for another worktree, is asked like any other request: the pool is full.
    await admit({ ...ASK, worktree: '/w/e', root });
    for (const handed of ['1', made.reservation]) {
      const other = await ask('/w/d', { MC_DEV_ADMITTED: handed });
      assert.deepEqual([other.code, other.verdict.reason], [75, 'cap'], handed);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('an admission whose owner has gone gives up at its next poll, and reserves nothing', async () => {
    const { base, root, file } = pool();
    // Memory is short, so the request waits; its owner is alive until 10 s and gone from then on.
    let t = 0;
    const verdict = await admit({
      ...ASK,
      worktree: '/w/a',
      root,
      owner: 4242,
      alive: (pid) => pid !== 4242 || t < 10_000,
      freeMemory: () => 5,
      waitSeconds: 900,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'owner-gone');
    assert.equal(t, 10_000, `gave up at ${t}ms — one poll after the owner went, not at the deadline`);
    assert.deepEqual(readReservations(file), [], 'no reservation was made for it');
    rmSync(base, { recursive: true, force: true });
  });

  it('fail closed: a lock held by a live process is a refusal with reason lock, and nothing is reserved or registered', async () => {
    const { base, root, file } = pool();
    mkdirSync(join(root, '.pool'), { recursive: true });
    writeFileSync(`${file}.lock`, String(process.ppid));
    const lock = { waitMs: 40, pollMs: 10 };
    const events = [];
    const verdict = await admit({ ...ASK, worktree: '/w/a', root, lock, logEvent: (event, fields) => events.push({ event, fields }) });
    assert.deepEqual([verdict.ok, verdict.reason], [false, 'lock']);
    assert.match(verdict.error, /held by pid \d+ — gave up after 40 ms/u);
    assert.deepEqual(events.map((item) => [item.event, item.fields.reason]), [['dev-server-refused', 'lock']]);
    const registered = registerManifest(writeSource(join(base, 'wt')), { root, lock });
    assert.deepEqual([registered.ok, registered.reason], [false, 'lock']);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.json')), [], 'no record written past the lock');
    assert.deepEqual(readdirSync(join(root, '.pool')), ['reservations.json.lock'], 'and no reservation file either');
    rmSync(`${file}.lock`);
    // A reservation file that does not parse is refused too, never read as empty.
    writeFileSync(file, '{ half');
    assert.equal((await admit({ ...ASK, worktree: '/w/a', root })).reason, 'lock');
    rmSync(base, { recursive: true, force: true });
  });

  it('fail closed: a lock whose holder is dead is broken; the queue lock fails closed the same way', () => {
    const { base, root, file } = pool();
    mkdirSync(join(root, '.pool'), { recursive: true });
    writeFileSync(`${file}.lock`, String(DEAD_PID));
    assert.equal(withFileLock(file, () => 'ran'), 'ran');
    const queue = devQueuePath(root);
    writeFileSync(`${queue}.lock`, String(process.ppid));
    assert.throws(() => withFileLock(queue, () => 'ran', { waitMs: 30, pollMs: 10 }), LockError);
    rmSync(base, { recursive: true, force: true });
  });

  it('the cap reads MC_DEV_MAX_SERVERS as a lowering only', () => {
    assert.deepEqual(['', '0', '1', '2', '3', '4', '99', '-1', '2.5', 'many'].map((raw) => slotCapOf({ MC_DEV_MAX_SERVERS: raw })), [3, 0, 1, 2, 3, 3, 3, 3, 3, 3]);
    assert.equal(slotCapOf({}), 3);
  });

  it('race: four threads counting and reserving at the same moment through the file lock take exactly three slots', async () => {
    // admit counts and reserves inside one updateReservations callback (the
    // cases above); this is that lock under real parallelism — four threads,
    // each doing the same synchronous read-count-write on one file, released
    // together. Threads, not processes: the same O_EXCL lock, without paying
    // four node startups.
    const { base, file } = pool();
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = join(base, 'reserve.mjs');
    writeFileSync(worker, `
      import { workerData, parentPort } from 'node:worker_threads';
      const { newReservation, updateReservations } = await import(${JSON.stringify(new URL('../../src/mc/dev-reservations.js', import.meta.url).href)});
      parentPort.postMessage('ready');
      Atomics.wait(workerData.gate, 0, 0);
      const won = updateReservations(workerData.file, (held) => {
        if (held.length >= 3) return { result: false };
        return { reservations: [...held, newReservation({ service: 'memoro-worker', worktree: workerData.worktree, pid: process.pid })], result: true };
      });
      parentPort.postMessage({ worktree: workerData.worktree, won });
    `);
    const ready = [];
    const results = ['a', 'b', 'c', 'd'].map((name) => {
      const thread = new Worker(worker, { workerData: { gate, file, worktree: `/w/${name}` } });
      ready.push(new Promise((done) => { thread.once('message', done); }));
      return new Promise((resolve, reject) => {
        thread.on('message', (message) => { if (message !== 'ready') resolve(message); });
        thread.once('error', reject);
      });
    });
    await Promise.all(ready);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const answers = await Promise.all(results);
    const winners = answers.filter((item) => item.won).map((item) => item.worktree).sort();
    assert.equal(winners.length, 3, JSON.stringify(answers));
    assert.deepEqual(readReservations(file).map((item) => item.worktree_path).sort(), winners, 'exactly the three that won are held');
    rmSync(base, { recursive: true, force: true });
  });
});

function refusalOf(verdict) {
  return refusalText(verdict, { env: {} });
}
