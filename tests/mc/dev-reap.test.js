/**
 * The reaper's three rules, both ways, on text alone.
 *
 * Every case is a line of `ps` and a registration file's worth of fields: no
 * process is started and none is signalled. `reap` itself is tested with its
 * signals, liveness and registry faked, so the only thing that could reach a
 * real process is the code under test — and it is handed none.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { commandHead, etimeSeconds, parsePs, reap, reapPlan } from '../../src/mc/dev-reap.js';
import { run } from '../../src/mc/commands/dev.js';
import { setLogPath } from '../../src/mc/logger.js';

const WT = '/Users/me/mc/area/memoro';
const STATIC = `node ${WT}/scripts/testing/static-server.mjs`;
const MEASURE = `node ${WT}/scripts/testing/measure-server.mjs`;
const DEV = `node ${WT}/scripts/dev.mjs --skip-containers`;
const ESBUILD = `${WT}/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping`;
const WORKERD = `${WT}/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary --experimental`;

const HOUR = 3_600;

function plan(processes, { servers = [], exists = () => true, minAgeSeconds } = {}) {
  return reapPlan({ processes, servers, now: new Date('2026-09-26T12:00:00Z'), exists, minAgeSeconds });
}

function proc(pid, ppid, ageS, command) {
  return { pid, ppid, age_s: ageS, command };
}

describe('etimeSeconds', () => {
  it('reads mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    assert.equal(etimeSeconds('05:03'), 303);
    assert.equal(etimeSeconds('01:02:03'), 3723);
    assert.equal(etimeSeconds('4-08:46:50'), 4 * 86_400 + 8 * 3600 + 46 * 60 + 50);
  });

  it('refuses what is not an etime', () => {
    assert.equal(etimeSeconds('yesterday'), null);
  });
});

describe('parsePs', () => {
  it('keeps the whole command, spaces and all', () => {
    assert.deepEqual(parsePs(`  45607     1 6-01:00:00 ${STATIC}\n  812  4242   00:12 /bin/zsh -l\n`), [
      proc(45607, 1, 6 * 86_400 + 3600, STATIC),
      proc(812, 4242, 12, '/bin/zsh -l'),
    ]);
  });
});

describe('rule 1 — an unregistered server whose parent is gone', () => {
  it('reaps an old static-server, measure-server and scripts/dev.mjs with ppid 1', () => {
    const got = plan([proc(10, 1, 6 * 86_400, STATIC), proc(11, 1, HOUR, MEASURE), proc(12, 1, HOUR, DEV)]);
    assert.deepEqual(got.map(({ pid, kind, why }) => ({ pid, kind, why })), [
      { pid: 10, kind: 'server', why: 'orphaned static-server' },
      { pid: 11, kind: 'server', why: 'orphaned measure-server' },
      { pid: 12, kind: 'server', why: 'orphaned dev' },
    ]);
  });

  it('leaves a static-server with a live parent', () => {
    assert.deepEqual(plan([proc(10, 4242, 6 * 86_400, STATIC)]), []);
  });

  it('leaves a static-server with ppid 1 that is only 60 s old — mc starts servers detached', () => {
    assert.deepEqual(plan([proc(10, 1, 60, STATIC)]), []);
  });

  it('reaps the young one only when the floor is lowered', () => {
    assert.equal(plan([proc(10, 1, 60, STATIC)], { minAgeSeconds: 0 }).length, 1);
  });

  it('leaves a registered static-server with ppid 1', () => {
    const servers = [{ instance_id: 'dev-1', pid: 10, worktree_path: WT }];
    assert.deepEqual(plan([proc(10, 1, 6 * 86_400, STATIC)], { servers }), []);
  });

  it('leaves any other node script with ppid 1', () => {
    assert.deepEqual(plan([proc(10, 1, 6 * 86_400, `node ${WT}/scripts/other.mjs`)]), []);
  });
});

describe('rule 2 — a runtime helper whose node parent is gone', () => {
  it('reaps an esbuild service and a workerd with ppid 1 past 120 s', () => {
    const got = plan([proc(20, 1, 4 * 86_400, ESBUILD), proc(21, 1, 121, WORKERD)]);
    assert.deepEqual(got.map(({ pid, kind }) => ({ pid, kind })), [{ pid: 20, kind: 'esbuild' }, { pid: 21, kind: 'workerd' }]);
  });

  it('leaves an esbuild and a workerd with a live parent', () => {
    assert.deepEqual(plan([proc(20, 4242, 4 * 86_400, ESBUILD), proc(21, 4242, 4 * 86_400, WORKERD)]), []);
  });

  it('keeps its 120 s floor even at --min-age-seconds 0', () => {
    assert.deepEqual(plan([proc(20, 1, 119, ESBUILD), proc(21, 1, 30, WORKERD)], { minAgeSeconds: 0 }), []);
  });

  it('leaves an esbuild that is not a service', () => {
    assert.deepEqual(plan([proc(20, 1, HOUR, `${WT}/node_modules/@esbuild/darwin-arm64/bin/esbuild src/app.js --bundle`)]), []);
  });
});

describe('rule 3 — a registration whose worktree is gone', () => {
  const server = { instance_id: 'dev-9', pid: 30, worktree_path: '/gone/memoro' };

  it('is reaped, with its process when it is still there', () => {
    const got = plan([proc(30, 1, HOUR, STATIC)], { servers: [server], exists: (p) => p !== '/gone/memoro' });
    assert.deepEqual(got.map(({ pid, instance_id: id, kind }) => ({ pid, id, kind })), [{ pid: 30, id: 'dev-9', kind: 'registration' }]);
  });

  it('leaves a registration whose worktree exists', () => {
    assert.deepEqual(plan([proc(30, 1, HOUR, STATIC)], { servers: [{ ...server, worktree_path: WT }] }), []);
  });
});

describe('reap', () => {
  // Every entry is logged; into a file of this test's own, never mc's.
  const logFile = join(mkdtempSync(join(tmpdir(), 'mc-dev-reap-')), 'mc.log');
  before(() => setLogPath(logFile));
  after(() => setLogPath(null));
  const logged = () => readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((line) => line.event === 'dev-server-reaped');

  function world({ processes, servers = [], exists = () => true, dies = true }) {
    const alive = new Set(processes.map((p) => p.pid));
    const calls = { signals: [], unregistered: [] };
    const deps = {
      processes: () => processes,
      servers: () => servers,
      exists,
      alive: (pid) => alive.has(pid),
      signal: (pid, sig) => { calls.signals.push([pid, sig]); if (dies || sig === 'SIGKILL') alive.delete(pid); },
      sleep: async () => {},
      unregister: (id) => { calls.unregistered.push(id); },
    };
    return { deps, calls };
  }

  it('signals nothing on a dry run', async () => {
    const w = world({ processes: [proc(10, 1, 6 * 86_400, STATIC)] });
    const got = await reap({ dryRun: true, deps: w.deps });
    assert.deepEqual(got.map((e) => e.done), ['would-reap']);
    assert.deepEqual(w.calls.signals, []);
  });

  it('SIGTERMs, and SIGKILLs what does not go in 5 s', async () => {
    const polite = world({ processes: [proc(10, 1, 6 * 86_400, STATIC)] });
    assert.deepEqual((await reap({ deps: polite.deps })).map((e) => e.done), ['reaped']);
    assert.deepEqual(polite.calls.signals, [[10, 'SIGTERM']]);

    const stubborn = world({ processes: [proc(20, 1, HOUR, ESBUILD)], dies: false });
    assert.deepEqual((await reap({ deps: stubborn.deps })).map((e) => e.done), ['reaped']);
    assert.deepEqual(stubborn.calls.signals, [[20, 'SIGTERM'], [20, 'SIGKILL']]);
    assert.deepEqual(logged().map((line) => [line.kind, line.pid, line.command_head.slice(0, 5)]), [['server', 10, 'node '], ['esbuild', 20, '/User']]);
  });

  it('unregisters a registration whose worktree is gone', async () => {
    const w = world({ processes: [], servers: [{ instance_id: 'dev-9', pid: 30, worktree_path: '/gone' }], exists: () => false });
    const got = await reap({ deps: w.deps });
    assert.deepEqual(got.map((e) => e.done), ['reaped']);
    assert.deepEqual(w.calls.signals, []);
    assert.deepEqual(w.calls.unregistered, ['dev-9']);
    assert.deepEqual(logged().filter((line) => line.kind === 'registration').map((line) => [line.pid, line.instance_id]), [[30, 'dev-9']]);
  });

  it('logs a command head with home as ~ and no more than 80 characters', () => {
    const head = commandHead(`node /Users/me/${'x'.repeat(200)}`, '/Users/me');
    assert.ok(head.startsWith('node ~/'));
    assert.equal(head.length, 80);
  });
});

describe('mc dev reap', () => {
  function capture() {
    let text = '';
    return { stream: { write: (chunk) => { text += chunk; } }, text: () => text };
  }

  it('prints a line per entry', async () => {
    const out = capture();
    const code = await run(['reap', '--dry-run', '--min-age-seconds', '0'], {
      stdout: out.stream,
      root: '/nowhere',
      reap: async (options) => {
        assert.deepEqual({ dryRun: options.dryRun, minAgeSeconds: options.minAgeSeconds }, { dryRun: true, minAgeSeconds: 0 });
        return [{ pid: 45607, kind: 'server', why: 'orphaned static-server', age_s: 6 * 86_400, done: 'would-reap' }];
      },
    });
    assert.equal(code, 0);
    assert.equal(out.text(), 'would reap pid 45607 server — orphaned static-server, 6d\n');
  });

  it('says when there is nothing', async () => {
    const out = capture();
    assert.equal(await run(['reap'], { stdout: out.stream, root: '/nowhere', reap: async () => [] }), 0);
    assert.equal(out.text(), 'mc: nothing to reap\n');
  });

  it('refuses a floor that is not a number, and reap flags on another verb', async () => {
    const err = capture();
    assert.equal(await run(['reap', '--min-age-seconds', 'soon'], { stdout: capture().stream, stderr: err.stream }), 2);
    assert.match(err.text(), /whole number of seconds/u);
    assert.equal(await run(['list', '--dry-run'], { stdout: capture().stream, stderr: capture().stream }), 2);
  });
});
