import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  brokerSessionPaths,
  ensureBrokerRunning,
  launchBrokerOwnedSession,
} from '../../../src/mc/broker/launch-client.js';

function makeStreams() {
  let out = '';
  let err = '';
  return {
    stdout: {
      columns: 100,
      rows: 30,
      write: (s) => { out += s; },
    },
    stderr: {
      write: (s) => { err += s; },
    },
    out: () => out,
    err: () => err,
  };
}

describe('launchBrokerOwnedSession', () => {
  test('prepares sidecars, launches through broker, then attaches', async () => {
    const streams = makeStreams();
    const sequence = [];
    const requests = [];
    let attached = null;
    let launched = null;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      label: null,
      focus: 'fix tests',
      tool: 'claude',
      argv: ['--resume'],
      apiArgv: [],
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color' },
      now: () => 10_000,
      ensureBroker: async () => {
        sequence.push('ensureBroker');
        return { ok: true, broker: { pid: 42 } };
      },
      request: async (message) => {
        sequence.push('request');
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      attach: async (opts) => {
        sequence.push('attach');
        attached = opts;
        return 0;
      },
      onLaunched: async (event) => {
        sequence.push('onLaunched');
        launched = event;
      },
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async ({ cwd, focus }) => {
          assert.equal(cwd, '/repo');
          assert.equal(focus, 'fix tests');
          return { ok: true };
        },
        hostname: () => 'machine',
        lookupOrMint: async (identity) => {
          assert.equal(identity.repoIdentity, 'git@example.com:org/repo.git');
          assert.equal(identity.machineId, 'machine');
          assert.match(identity.llmSessionId, /^mc-10000-/);
          return 'sess_abc';
        },
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_abc');
    assert.deepEqual(sequence, ['ensureBroker', 'request', 'onLaunched', 'attach']);
    assert.deepEqual(attached, { id: 'sess_abc' });
    assert.equal(launched.codingSessionId, 'sess_abc');

    const msg = requests[0];
    assert.equal(msg.type, 'launch_session');
    assert.equal(msg.session.id, 'sess_abc');
    assert.equal(msg.session.cwd, '/repo');
    assert.equal(msg.session.tool, 'claude');
    assert.deepEqual(msg.session.argv, ['--resume']);
    assert.equal(msg.session.cols, 100);
    assert.equal(msg.session.rows, 30);
    assert.equal(msg.session.sidecars.codingSessionId, 'sess_abc');
    assert.equal(msg.session.sidecars.apiUrl, 'https://memoro.test');
    assert.equal(msg.session.sidecars.token, 'tok');
    assert.equal(msg.session.sidecars.machineId, 'machine');
    assert.equal(msg.session.sidecars.source, 'claude-code');
    assert.equal(msg.session.sidecars.repo, 'repo');
    assert.equal(msg.session.sidecars.branch, 'main');
    assert.match(msg.session.sidecars.sockPath, /sess_abc\.sock$/);
    assert.match(msg.session.sidecars.metaPath, /sess_abc\.json$/);
    assert.match(streams.out(), /sess_abc/);
    assert.equal(streams.err(), '');
  });

  test('fails before broker launch when no Memoro token is available', async () => {
    const streams = makeStreams();
    let requested = false;
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      stdout: streams.stdout,
      stderr: streams.stderr,
      request: async () => { requested = true; return { ok: true }; },
      ensureBroker: async () => ({ ok: true }),
      attach: async () => 0,
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'repo', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => null,
      },
    });

    assert.equal(res.code, 1);
    assert.equal(requested, false);
    assert.match(streams.err(), /no Memoro token/);
  });
});

describe('ensureBrokerRunning', () => {
  test('returns immediately when broker already responds', async () => {
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => ({ ok: true, broker: { pid: 1 } }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyRunning, true);
    assert.equal(spawned, false);
  });

  test('spawns and polls until broker is ready', async () => {
    let requests = 0;
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => {
        requests += 1;
        if (!spawned) throw new Error('offline');
        return { ok: true, broker: { pid: 2 } };
      },
      spawnDaemon: () => {
        spawned = true;
        return { ok: true, pid: 2 };
      },
      sleep: async () => {},
    });

    assert.equal(res.ok, true);
    assert.equal(res.started, true);
    assert.equal(requests >= 2, true);
  });
});

describe('brokerSessionPaths', () => {
  test('uses MC_HOME for broker session sidecar files', () => {
    const old = process.env.MC_HOME;
    process.env.MC_HOME = '/tmp/mc-home';
    try {
      assert.deepEqual(brokerSessionPaths('sess_a'), {
        sockPath: '/tmp/mc-home/sess_a.sock',
        metaPath: '/tmp/mc-home/sess_a.json',
      });
    } finally {
      if (old == null) delete process.env.MC_HOME;
      else process.env.MC_HOME = old;
    }
  });
});
