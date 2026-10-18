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
  currentContext, ensure, leasesDir, liveLeases, needsDocker, readState, release, releasePid, runtimeOf, takeLease,
} from '../../src/mc/docker.js';

const INFO = 'docker info --format {{.ServerVersion}}';

function fakeIo({ answers = {}, live = [], context = 'orbstack' } = {}) {
  const calls = [];
  const logged = [];
  const used = new Map();
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const io = {
    run: async (tool, args, opts = {}) => {
      calls.push({ argv: [tool, ...args], timeoutMs: opts.timeoutMs });
      const key = [tool, ...args].join(' ');
      const answer = answers[key];
      if (!Array.isArray(answer)) return answer ?? { status: 1, stderr: `no answer for ${key}\n` };
      const index = used.get(key) ?? 0;
      used.set(key, index + 1);
      return answer[Math.min(index, answer.length - 1)];
    },
    readFile: (path) => {
      if (path === '/home/u/.docker/config.json') return JSON.stringify({ currentContext: context });
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    home: '/home/u',
    alive: (pid) => live.includes(pid),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    platform: 'darwin',
    log: (event, fields) => { logged.push({ event, ...fields }); },
  };
  return { io, calls, logged };
}

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
});
