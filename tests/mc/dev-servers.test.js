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
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  checkManifest, listServers, registerManifest, unregisterManifest,
} from '../../src/mc/dev-servers.js';
import { run } from '../../src/mc/commands/dev.js';

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
