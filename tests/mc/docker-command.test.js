/**
 * `mc docker` as a command, against the fake machine in `_helpers/docker-io.js`.
 *
 * Each test gives its own root, so a lease from one test is never seen by
 * another, and passes `env: {}` so a host `DOCKER_CONTEXT` cannot leak in.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { liveLeases, readState, releasePid, takeLease } from '../../src/mc/docker.js';
import { run, usage } from '../../src/mc/commands/docker.js';
import { fakeIo, INFO } from './_helpers/docker-io.js';

const DF = '{"Type":"Images","TotalCount":"10","Size":"7.519GB"}\n'
  + '{"Type":"Containers","TotalCount":"2","Size":"475.1kB"}\n'
  + '{"Type":"Local Volumes","TotalCount":"11","Size":"3.232GB"}\n'
  + '{"Type":"Build Cache","TotalCount":"0","Size":"0B"}\n';

function sink() {
  const chunks = [];
  return { write: (text) => { chunks.push(text); }, text: () => chunks.join('') };
}

function withRoot(body) {
  const root = mkdtempSync(join(tmpdir(), 'mc-docker-cmd-'));
  return Promise.resolve()
    .then(() => body(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

async function invoke(argv, { root, io, ppid = 7777 }) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, { stdout, stderr, root, env: {}, io, ppid });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const dockerCalls = (calls) => calls.filter((call) => call.argv[0] === 'docker');

describe('mc docker', () => {
  it('status with OrbStack stopped runs no docker command and says stopped', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({ answers: { 'orbctl status': { status: 0, stdout: 'Stopped\n' } } });
    const { code, stdout } = await invoke([], { root, io });
    assert.equal(code, 0);
    assert.match(stdout, /^docker: orbstack stopped\nno lease\n/u);
    assert.deepEqual(dockerCalls(calls), []);
  }));

  it('status with OrbStack up lists the lease, the disk and the unlabelled objects', () => withRoot(async (root) => {
    const { io } = fakeIo({
      live: [5000],
      answers: {
        'orbctl status': { status: 0, stdout: 'Running\n' },
        [INFO]: { status: 0, stdout: '28.0.1\n' },
        'docker system df --format {{json .}}': { status: 0, stdout: DF },
        'docker ps -a --format {{json .}}': {
          status: 0,
          stdout: '{"ID":"aaa","Names":"a","State":"exited","Labels":"mc.holder=5000,mc.run=merge #7"}\n'
            + '{"ID":"bbb","Names":"b","State":"running","Labels":""}\n',
        },
        'docker volume ls --format {{json .}}': { status: 0, stdout: '{"Name":"v2","Labels":""}\n' },
      },
    });
    takeLease({ pid: 5000, run: 'merge #7', repo: 'memoro', root, io });
    const { code, stdout } = await invoke([], { root, io });
    assert.equal(code, 0);
    assert.match(stdout, /lease  pid 5000  merge #7  memoro/u);
    assert.match(stdout, /images 10 \(7\.519GB\) · containers 2 · volumes 11 \(3\.232GB\) · build cache 0B/u);
    assert.match(stdout, /labelled by mc: 1 containers, 0 volumes · unlabelled: 1 containers, 1 volumes — reported, never removed/u);
    assert.deepEqual(readState({ root }).inventory.unlabelled, { containers: 1, volumes: 1 });
  }));

  it('ensure prints the lease and exits 0; a runtime that cannot start exits 69', () => withRoot(async (root) => {
    const answers = {
      'orbctl status': { status: 0, stdout: 'Stopped\n' },
      'orbctl start': { status: 0 },
      [INFO]: [
        { status: 1, stderr: 'Cannot connect to the Docker daemon\n' },
        { status: 0, stdout: '28.0.1\n' },
      ],
    };
    const up = await invoke(['ensure'], { root, io: fakeIo({ live: [7777], answers }).io });
    assert.equal(up.code, 0);
    assert.match(up.stdout, /docker: up — started in \d+ s \(server 28\.0\.1\) — lease for pid 7777: /u);

    const down = await invoke(['ensure'], {
      root,
      io: fakeIo({
        live: [7777],
        answers: { 'orbctl status': { status: 0, stdout: 'Stopped\n' }, 'orbctl start': { status: 1, stderr: 'boom\n' }, [INFO]: { status: 1, stderr: 'no\n' } },
      }).io,
    });
    assert.equal(down.code, 69);
    assert.match(down.stderr, /mc: docker could not be started — .*boom/u);
  }));

  it('release drops the caller\'s leases and nothing else', () => withRoot(async (root) => {
    const { io } = fakeIo({ live: [7777, 8888] });
    takeLease({ pid: 7777, root, io });
    takeLease({ pid: 8888, root, io });
    const { code, stdout } = await invoke(['release'], { root, io });
    assert.equal(code, 0);
    assert.equal(stdout, 'released 1 lease of pid 7777\n');
    assert.deepEqual(liveLeases({ root, io }).leases.map((lease) => lease.pid), [8888]);
    assert.equal(releasePid(8888, { root, io }), 1);
  }));

  it('prune removes only labelled objects whose holder is gone', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({
      live: [5000],
      answers: {
        'orbctl status': { status: 0, stdout: 'Running\n' },
        [INFO]: { status: 0, stdout: '28.0.1\n' },
        'docker system df --format {{json .}}': { status: 0, stdout: '' },
        'docker ps -a --format {{json .}}': {
          status: 0,
          stdout: '{"ID":"aaa","Names":"a","State":"exited","Labels":"mc.holder=41100"}\n'
            + '{"ID":"bbb","Names":"b","State":"running","Labels":"mc.holder=5000"}\n'
            + '{"ID":"ccc","Names":"c","State":"running","Labels":""}\n',
        },
        'docker volume ls --format {{json .}}': {
          status: 0,
          stdout: '{"Name":"v1","Labels":"mc.holder=41100"}\n{"Name":"v2","Labels":""}\n',
        },
        'docker rm --force --volumes aaa': { status: 0 },
        'docker volume rm v1': { status: 0 },
      },
    });
    const { code, stdout } = await invoke(['prune'], { root, io });
    assert.equal(code, 0);
    const removals = calls.filter((call) => call.argv[1] === 'rm' || (call.argv[1] === 'volume' && call.argv[2] === 'rm'));
    assert.deepEqual(removals.map((call) => call.argv), [
      ['docker', 'rm', '--force', '--volumes', 'aaa'],
      ['docker', 'volume', 'rm', 'v1'],
    ]);
    assert.match(stdout, /removed 1 container\(s\) and 1 volume\(s\) labelled by a holder that is gone/u);
    assert.match(stdout, /unlabelled: 1 containers \(1 running\), 1 volumes — reported, never removed/u);
  }));

  it('prune --dry-run makes no rm call and says would remove', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({
      live: [5000],
      answers: {
        'orbctl status': { status: 0, stdout: 'Running\n' },
        [INFO]: { status: 0, stdout: '28.0.1\n' },
        'docker system df --format {{json .}}': { status: 0, stdout: '' },
        'docker ps -a --format {{json .}}': { status: 0, stdout: '{"ID":"aaa","Names":"a","State":"exited","Labels":"mc.holder=41100"}\n' },
        'docker volume ls --format {{json .}}': { status: 0, stdout: '{"Name":"v1","Labels":"mc.holder=41100"}\n' },
      },
    });
    const { code, stdout } = await invoke(['prune', '--dry-run'], { root, io });
    assert.equal(code, 0);
    assert.match(stdout, /would remove 1 container\(s\) and 1 volume\(s\)/u);
    assert.deepEqual(calls.filter((call) => call.argv[1] === 'rm' || call.argv[2] === 'rm'), []);
  }));

  it('prune with the runtime down starts nothing', () => withRoot(async (root) => {
    const { io, calls } = fakeIo({ answers: { 'orbctl status': { status: 0, stdout: 'Stopped\n' } } });
    const { code, stdout } = await invoke(['prune'], { root, io });
    assert.equal(code, 0);
    assert.match(stdout, /never starts it/u);
    assert.deepEqual(dockerCalls(calls), []);
  }));

  it('an unknown word or a bad --pid is exit 2 with the usage', () => withRoot(async (root) => {
    const { io } = fakeIo();
    const word = await invoke(['frob'], { root, io });
    assert.equal(word.code, 2);
    assert.match(word.stderr, /unknown word frob/u);
    assert.match(word.stderr, /usage: mc docker/u);

    const pid = await invoke(['ensure', '--pid', 'abc'], { root, io });
    assert.equal(pid.code, 2);
    assert.match(pid.stderr, /--pid is a process id/u);
  }));

  it('usage starts with the usage line', () => {
    assert.match(usage(), /^usage: mc docker/u);
  });
});
