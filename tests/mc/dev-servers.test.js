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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  admission, admit, checkManifest, freeMemoryPercent, listServers, registerManifest, serversUnder,
  stopServersUnder, unregisterManifest,
} from '../../src/mc/dev-servers.js';
import { run } from '../../src/mc/commands/dev.js';
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

    const result = unregisterManifest(source, { root });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.deepEqual(listServers({ root }).servers, []);
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
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
    assert.equal(readdirSync(root).length, 0, 'the sweep removes the file, not just the row');

    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
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
    assert.equal(JSON.parse(gone.text()).removed, true);

    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('says what it does not have a verb for', async () => {
    const stderr = capture();
    const code = await run(['ensure'], { stdout: capture(), stderr, root: scratch() });
    assert.equal(code, 2);
    assert.match(stderr.text(), /mc dev ensure\? — list, register, unregister/u);
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
    service: 'memoro-measure',
    worktree_path: worktree,
    started_at: '2026-09-26T08:00:00.000Z',
    url: 'http://127.0.0.1:8921',
    resource_class: 'standard',
    live: true,
    ...overrides,
  });
  const ask = (servers, overrides = {}) => admission({
    servers, service: 'memoro-measure', worktree: '/w/third', cap: 2, minFreePercent: 15, freePercent: 40, ...overrides,
  });

  it('refuses a third with both holders named', () => {
    const verdict = ask([live('measure-a', '/w/a'), live('measure-b', '/w/b')]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'cap');
    assert.equal(verdict.cap, 2);
    assert.equal(verdict.free_percent, 40);
    assert.deepEqual(verdict.holders.map((holder) => holder.instance_id), ['measure-a', 'measure-b']);
    assert.deepEqual(Object.keys(verdict.holders[0]).sort(), ['instance_id', 'service', 'started_at', 'url', 'worktree_path']);
  });

  it('a light server does not count', () => {
    assert.deepEqual(ask([live('static-a', '/w/a', { resource_class: 'light' }), live('measure-b', '/w/b')]), { ok: true });
  });

  it('the asker\'s own worktree and service does not count — a restart replaces itself', () => {
    assert.deepEqual(ask([live('measure-a', '/w/third'), live('measure-b', '/w/b')]), { ok: true });
    // The same worktree with another service does count.
    const other = ask([live('static-a', '/w/third', { service: 'memoro-static' }), live('measure-b', '/w/b')]);
    assert.equal(other.reason, 'cap');
  });

  it('refuses on memory below the floor, before counting', () => {
    const verdict = ask([], { freePercent: 10 });
    assert.deepEqual(verdict, { ok: false, reason: 'memory', holders: [], free_percent: 10, cap: 2 });
  });

  it('skips the memory check when the free percentage is unknown', () => {
    assert.deepEqual(ask([], { freePercent: null }), { ok: true });
  });

  it('reads kern.memorystatus_level, and null on any failure', () => {
    assert.equal(freeMemoryPercent(() => ({ status: 0, stdout: '31\n' })), 31);
    assert.equal(freeMemoryPercent(() => ({ status: 1, stdout: '' })), null);
    assert.equal(freeMemoryPercent(() => ({ status: 0, stdout: 'nope' })), null);
    assert.equal(freeMemoryPercent(() => { throw new Error('no sysctl'); }), null);
  });
});

describe('admit — waiting for a slot', () => {
  function register(root, worktree, id) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest(worktree, { instance_id: id, service: 'memoro-measure' })));
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
      service: 'memoro-measure',
      worktree: '/w/third',
      waitSeconds: 900,
      env: {},
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
    assert.deepEqual(verdict, { ok: true });
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0].holders.map((holder) => holder.instance_id), ['measure-a', 'measure-b']);
    assert.deepEqual(events, [{
      event: 'dev-server-admitted', fields: { service: 'memoro-measure', worktree_path: '/w/third', waited_s: 20 },
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
      service: 'memoro-measure',
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
        service: 'memoro-measure', worktree_path: '/w/third', reason: 'cap', holders: ['measure-a', 'measure-b'], free_percent: null,
      },
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('mc dev admit prints JSON and exits 75 on a refusal, 0 on an admission', async () => {
    const root = scratch();
    register(root, '/w/a', 'measure-a');
    register(root, '/w/b', 'measure-b');
    const out = capture();
    const code = await run(['admit', 'memoro-measure', '--worktree', '/w/third', '--wait', '0', '--json'], {
      root, stdout: out, stderr: capture(), env: {}, freeMemory: () => 40,
    });
    assert.equal(code, 75);
    const refused = JSON.parse(out.text());
    assert.equal(refused.reason, 'cap');
    assert.deepEqual(refused.holders.map((holder) => holder.worktree_path), ['/w/a', '/w/b']);

    rmSync(join(root, 'measure-b.json'));
    const text = capture();
    assert.equal(await run(['admit', 'memoro-measure', '--worktree', '/w/third'], {
      root, stdout: text, stderr: capture(), env: {}, freeMemory: () => 40,
    }), 0);
    assert.equal(text.text(), 'mc: admitted\n');

    const low = capture();
    assert.equal(await run(['admit', 'memoro-measure', '--worktree', '/w/third'], {
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
