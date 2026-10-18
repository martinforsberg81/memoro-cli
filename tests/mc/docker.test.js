/**
 * The container runtime and its leases, against a fake machine.
 *
 * No runtime is started and none has to exist: `orbctl` and `docker` answer
 * from a table, the clock moves only when `sleep` is called, and a lease is a
 * file in a temporary directory.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  currentContext, ensure, inventory, leasesDir, liveLeases, needsDocker, readState, release, releasePid, runtimeOf, sweepDocker, takeLease,
  writeState,
} from '../../src/mc/docker.js';
import { fakeIo, INFO } from './_helpers/docker-io.js';

function withRoot(body) {
  const root = mkdtempSync(join(tmpdir(), 'mc-docker-'));
  return Promise.resolve()
    .then(() => body(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function leaseFiles(root) {
  return existsSync(leasesDir(root)) ? readdirSync(leasesDir(root)) : [];
}

async function startsStopped(root) {
  const fake = fakeIo({
    live: [5000],
    answers: {
      'orbctl status': { status: 0, stdout: 'Stopped\n' },
      'orbctl start': { status: 0 },
      [INFO]: [
        { status: 1, stderr: 'Cannot connect to the Docker daemon\n' },
        { status: 1, stderr: 'Cannot connect to the Docker daemon\n' },
        { status: 0, stdout: '28.0.1\n' },
      ],
    },
  });
  const result = await ensure({ pid: 5000, run: 'merge #7', repo: 'memoro', root, env: {}, io: fake.io });
  return { ...fake, result };
}

const EMPTY = { status: 0, stdout: '' };

/** An OrbStack that is up and holds nothing, with `orbctl stop` answering. */
function idleUp({ live = [], ps = EMPTY } = {}) {
  return fakeIo({
    live,
    answers: {
      'orbctl status': { status: 0, stdout: 'Running\n' },
      'docker system df --format {{json .}}': EMPTY,
      'docker ps -a --format {{json .}}': ps,
      'docker volume ls --format {{json .}}': EMPTY,
      'docker rm --force --volumes c1': { status: 0 },
      'orbctl stop': { status: 0 },
    },
  });
}

function argvs(calls) {
  return calls.map((call) => call.argv.join(' '));
}

async function neverAnswers(root) {
  const fake = fakeIo({
    live: [5000],
    answers: {
      'orbctl status': { status: 0, stdout: 'Running\n' },
      [INFO]: { status: 1, stderr: 'Cannot connect\n' },
    },
  });
  const result = await ensure({ pid: 5000, timeoutMs: 3000, root, env: {}, io: fake.io });
  return { ...fake, result };
}

describe('docker.js', () => {
  it('runtimeOf asks orbctl for an OrbStack context and runs no docker command', async () => {
    const { io, calls } = fakeIo({ answers: { 'orbctl status': { status: 0, stdout: 'Stopped\n' } } });
    const rt = await runtimeOf({ env: {}, io });
    assert.equal(rt.kind, 'orbstack');
    assert.equal(rt.context, 'orbstack');
    assert.equal(rt.up, false);
    assert.ok(!rt.reason);
    assert.deepEqual(calls.map((call) => call.argv.join(' ')), ['orbctl status']);
    assert.ok(calls.every((call) => call.argv[0] !== 'docker'));
  });

  it('ensure starts a stopped OrbStack, waits for docker info, and takes a lease', () => withRoot(async (root) => {
    const { result, calls } = await startsStopped(root);
    assert.equal(result.ok, true);
    assert.equal(result.started, true);
    assert.equal(result.server, '28.0.1');
    const files = leaseFiles(root);
    assert.equal(files.length, 1);
    const lease = JSON.parse(readFileSync(join(leasesDir(root), files[0]), 'utf8'));
    assert.equal(lease.pid, 5000);
    assert.equal(lease.run, 'merge #7');
    assert.equal(lease.repo, 'memoro');
    assert.equal(result.lease, join(leasesDir(root), files[0]));
    assert.equal(readState({ root }).started_by_mc, true);
    assert.deepEqual(readState({ root }).leases.map((l) => l.pid), [5000]);
    assert.deepEqual(calls.map((call) => call.argv.join(' ')), ['orbctl status', 'orbctl start', INFO, INFO, INFO]);
  }));

  it('ensure on a running runtime starts nothing', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({
      live: [5000],
      answers: { 'orbctl status': { status: 0, stdout: 'Running\n' }, [INFO]: { status: 0, stdout: '28.0.1\n' } },
    });
    const result = await ensure({ pid: 5000, root, env: {}, io });
    assert.equal(result.ok, true);
    assert.equal(result.started, false);
    assert.ok(calls.every((call) => call.argv.join(' ') !== 'orbctl start'));
    assert.equal('started_by_mc' in readState({ root }), false);
  }));

  it('ensure gives up after its timeout and takes no lease', () => withRoot(async (root) => {
    const { result, logged } = await neverAnswers(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /docker info did not answer within 3 s: Cannot connect/u);
    assert.equal(result.lease, null);
    assert.deepEqual(leaseFiles(root), []);
    assert.ok(logged.some((entry) => entry.event === 'docker-ensure-failed'));
  }));

  it('a context mc cannot start is unavailable with the reason', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({ context: 'colima', answers: { [INFO]: { status: 1, stderr: 'no daemon\n' } } });
    const result = await ensure({ pid: 5000, root, env: {}, io });
    assert.equal(result.ok, false);
    assert.match(result.reason, /context colima is not one mc can start/u);
    assert.ok(calls.every((call) => call.argv[0] !== 'orbctl'));
    assert.deepEqual(leaseFiles(root), []);
  }));

  it('docker not installed', () => withRoot(async (root) => {
    const error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const { io } = fakeIo({ context: 'default', answers: { [INFO]: { status: null, error } } });
    const result = await ensure({ pid: 5000, root, env: {}, io });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'docker is not installed');
  }));

  it('a lease whose pid is dead is removed by the next reader and counts as a release', () => withRoot(async (root) => {
    const { io, logged } = fakeIo({ live: [5000] });
    takeLease({ pid: 5000, root, io });
    const dead = takeLease({ pid: 41100, root, io });
    const { leases, swept } = liveLeases({ root, io });
    assert.deepEqual(leases.map((lease) => lease.pid), [5000]);
    assert.deepEqual(swept, [{ pid: 41100, run: null, repo: null }]);
    assert.equal(existsSync(dead.path), false);
    assert.equal(readState({ root }).last_release_at, '2026-10-18T12:00:00.000Z');
    assert.ok(logged.some((entry) => entry.event === 'docker-lease-gone' && entry.pid === 41100));
  }));

  it('release removes only its own file and stamps the release; releasePid releases every lease of a pid', () => withRoot(async (root) => {
    const { io } = fakeIo({ live: [5000, 6000] });
    const first = takeLease({ pid: 5000, root, io });
    takeLease({ pid: 5000, root, io });
    const other = takeLease({ pid: 6000, root, io });
    assert.equal(release(first.path, { root, io }), true);
    assert.equal(release(first.path, { root, io }), false);
    assert.equal(readState({ root }).last_release_at, '2026-10-18T12:00:00.000Z');
    assert.equal(releasePid(5000, { root, io }), 1);
    assert.equal(existsSync(other.path), true);
    assert.deepEqual(liveLeases({ root, io }).leases.map((lease) => lease.pid), [6000]);
  }));

  it('takeLease refuses a pid that is not a positive integer', () => withRoot(async (root) => {
    const { io } = fakeIo();
    for (const pid of [0, -1, 1.5, '5000', undefined]) assert.throws(() => takeLease({ pid, root, io }), TypeError);
  }));

  it('needsDocker reads the selector entry', () => {
    assert.equal(needsDocker({ needs: ['docker'] }), true);
    assert.equal(needsDocker({}), false);
    assert.equal(needsDocker({ needs: 'docker' }), false);
    assert.equal(needsDocker({ needs: ['postgres'] }), false);
    assert.equal(needsDocker(null), false);
  });

  it('every machine call carries a timeout', () => withRoot(async (root) => {
    const calls = [...(await startsStopped(root)).calls, ...(await neverAnswers(root)).calls];
    assert.ok(calls.length > 0);
    for (const call of calls) assert.ok(Number.isFinite(call.timeoutMs), `${call.argv.join(' ')} has no timeout`);
  }));

  it('currentContext reads the environment before the file', () => {
    const { io } = fakeIo({ context: 'orbstack' });
    assert.equal(currentContext({ env: { DOCKER_CONTEXT: 'x' }, io }), 'x');
    assert.equal(currentContext({ env: { DOCKER_HOST: 'unix:///s' }, io }), 'DOCKER_HOST');
    assert.equal(currentContext({ env: {}, io }), 'orbstack');
    const broken = { ...io, readFile: () => { throw new Error('EACCES'); } };
    assert.equal(currentContext({ env: {}, io: broken }), 'default');
    assert.equal(currentContext({ env: {}, io: { ...io, readFile: () => '{not json' } }), 'default');
  });

  it('inventory reads holders from labels and records what failed', async () => {
    const { io } = fakeIo({
      answers: {
        'docker system df --format {{json .}}': { status: 0, stdout: '{"Type":"Images","TotalCount":"1","Size":"1GB"}\n' },
        'docker ps -a --format {{json .}}': { status: 0, stdout: '{"ID":"a","Names":"a","State":"exited","Labels":"mc.holder=41100"}\n' },
        'docker volume ls --format {{json .}}': { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
      },
    });
    const inv = await inventory({ io });
    assert.deepEqual(inv.containers, [{ id: 'a', name: 'a', state: 'exited', holder: 41100 }]);
    assert.deepEqual(inv.volumes, []);
    assert.equal(inv.df.images.count, 1);
    assert.equal(inv.errors.length, 1);
    assert.match(inv.errors[0], /docker volume ls: ETIMEDOUT/u);
  });

  it('with OrbStack down the sweep runs no docker command and sweeps dead leases', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({ answers: { 'orbctl status': { status: 0, stdout: 'Stopped\n' } } });
    takeLease({ pid: 41100, root, io });
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.up, false);
    assert.equal(result.stopped, false);
    assert.equal(result.line, 'docker: swept 1 lease(s) whose pid is gone');
    assert.ok(calls.every((call) => call.argv[0] !== 'docker'));
    assert.equal(readState({ root }).started_by_mc, false);
  }));

  it('an OrbStack mc started, idle past the grace, is stopped', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const { io, calls, logged } = idleUp();
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.stopped, true);
    assert.ok(argvs(calls).includes('orbctl stop'));
    assert.match(result.line, /docker: idle 11 min with no lease, no dev server and no unlabelled container running — orbctl stop/u);
    assert.equal(readState({ root }).started_by_mc, false);
    assert.ok(logged.some((entry) => entry.event === 'docker-idle-stop' && entry.idle_ms === 11 * 60_000));
    for (const call of calls) assert.ok(Number.isFinite(call.timeoutMs), `${call.argv.join(' ')} has no timeout`);
  }));

  it('inside the grace it is not stopped and the state says when', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:55:00.000Z' }, { root });
    const { io, calls } = idleUp();
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.stopped, false);
    assert.equal(result.line, null);
    assert.ok(!argvs(calls).includes('orbctl stop'));
    assert.equal(readState({ root }).idle_stop, '2026-10-18T12:05:00.000Z');
  }));

  it('a live dev server holds it up', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const { io, calls } = idleUp();
    const result = await sweepDocker({ root, env: {}, io, servers: () => [{ instance_id: 'memoro-app', live: true }] });
    assert.equal(result.stopped, false);
    assert.ok(!argvs(calls).includes('orbctl stop'));
    assert.equal(readState({ root }).idle_stop, null);
  }));

  it('a running unlabelled container holds it up', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const ps = { status: 0, stdout: '{"ID":"c1","Names":"workerd-x","State":"running","Labels":""}\n' };
    const { io, calls } = idleUp({ ps });
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.stopped, false);
    assert.ok(!argvs(calls).includes('orbctl stop'));
    assert.ok(calls.every((call) => !call.argv.includes('rm')));
    assert.equal(readState({ root }).inventory.unlabelled.running, 1);
  }));

  it('a runtime mc did not start is never stopped', () => withRoot(async (root) => {
    writeState({ started_by_mc: false, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const { io, calls } = idleUp();
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.stopped, false);
    assert.ok(!argvs(calls).includes('orbctl stop'));
  }));

  it('a live lease holds it up', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const { io, calls } = idleUp({ live: [5000] });
    takeLease({ pid: 5000, root, io });
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.equal(result.stopped, false);
    assert.ok(!argvs(calls).includes('orbctl stop'));
    assert.deepEqual(readState({ root }).leases.map((lease) => lease.pid), [5000]);
  }));

  it('labelled leftovers of a dead holder are removed in the sweep', () => withRoot(async (root) => {
    const ps = { status: 0, stdout: '{"ID":"c1","Names":"pg-ref","State":"exited","Labels":"mc.holder=41100,mc.run=merge"}\n' };
    const { io, calls } = idleUp({ ps });
    const result = await sweepDocker({ root, env: {}, io, servers: () => [] });
    assert.ok(argvs(calls).includes('docker rm --force --volumes c1'));
    assert.match(result.line, /removed 1 container\(s\) and 0 volume\(s\)/u);
    assert.equal(result.stopped, false);
  }));

  it('an orbctl stop that fails is said', () => withRoot(async (root) => {
    writeState({ started_by_mc: true, last_release_at: '2026-10-18T11:49:00.000Z' }, { root });
    const { io } = idleUp();
    const failing = { ...io, run: async (tool, args, opts) => (tool === 'orbctl' && args[0] === 'stop' ? { status: 1, stderr: 'vm busy\n' } : io.run(tool, args, opts)) };
    const result = await sweepDocker({ root, env: {}, io: failing, servers: () => [] });
    assert.equal(result.stopped, false);
    assert.equal(result.line, 'docker: orbctl stop failed — vm busy');
    assert.equal(readState({ root }).started_by_mc, true);
  }));
});
