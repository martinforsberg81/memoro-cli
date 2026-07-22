import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CODEX_SQLITE_RETRY_DELAYS_MS,
  __test__ as launchClientTest,
  brokerSessionPaths,
  ensureBrokerRunning,
  isRetryableCodexSqliteStartupFailure,
  launchBrokerOwnedSession,
} from '../../../src/mc/broker/launch-client.js';
import { BROKER_PROTOCOL_VERSION } from '../../../src/mc/broker/daemon.js';

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

const CODEX_SQLITE_LOCK_OUTPUT = `Codex couldn't start because another Codex process is using its local data.
Technical details:
  Cause: failed to initialize state runtime at /Users/test/.codex: failed to open log DB at /Users/test/.codex/logs_2.sqlite: error returned from database: (code: 5) database is locked
ERROR: failed to initialize sqlite local db at /Users/test/.codex/state_5.sqlite`;

function earlyCodexExit() {
  return {
    id: 'sess_retry',
    tool: 'codex',
    started_at: '2026-07-21T15:36:51.000Z',
    exit: { code: 1, signal: 0, at: '2026-07-21T15:36:57.000Z' },
    session_state: 'dead',
    attachable: false,
  };
}

function launchCodexWithMocks({ request, attach, streams, sleepFn = async () => {} }) {
  return launchBrokerOwnedSession({
    cwd: '/repo',
    codingSessionId: 'sess_retry',
    sessionName: 'retry',
    tool: 'codex',
    sendStartupMessage: false,
    stdout: streams.stdout,
    stderr: streams.stderr,
    env: { TERM: 'xterm-256color', MEMORO_TOKEN: 'tok' },
    ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
    ensureCloudBroker: async () => ({ ok: true }),
    request,
    attach,
    deps: {
      useSessionHost: false,
      getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      getApiUrl: () => null,
      getSecret: async () => assert.fail('env token should avoid keychain lookup'),
      findEntry: () => ({}),
      resolvePolicyForWrap: () => ({}),
      hostname: () => 'machine',
      getPackageVersion: async () => '0.test',
      prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
      readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
      resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
      prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      sleep: sleepFn,
    },
  });
}

describe('launchBrokerOwnedSession', () => {
  test('classifies only the exact early Codex SQLite startup failure', () => {
    assert.equal(isRetryableCodexSqliteStartupFailure({
      output: CODEX_SQLITE_LOCK_OUTPUT,
      session: earlyCodexExit(),
    }), true);
    assert.equal(isRetryableCodexSqliteStartupFailure({
      output: CODEX_SQLITE_LOCK_OUTPUT,
      session: {
        ...earlyCodexExit(),
        exit: { code: 1, signal: 0, at: '2026-07-21T15:37:12.000Z' },
      },
    }), false, 'established sessions must never be retried');
    assert.equal(isRetryableCodexSqliteStartupFailure({
      output: 'database is locked',
      session: earlyCodexExit(),
    }), false, 'generic SQLite text is not specific enough');
    assert.equal(isRetryableCodexSqliteStartupFailure({
      output: CODEX_SQLITE_LOCK_OUTPUT,
      session: { ...earlyCodexExit(), tool: 'claude' },
    }), false, 'other tools are outside the retry policy');
    assert.equal(isRetryableCodexSqliteStartupFailure({
      output: CODEX_SQLITE_LOCK_OUTPUT,
      session: { ...earlyCodexExit(), exit: { ...earlyCodexExit().exit, code: 0 } },
    }), false, 'successful Codex exits must never be retried');
  });

  test('retries an early Codex SQLite lock and attaches to the successful relaunch', async () => {
    const streams = makeStreams();
    const requestTypes = [];
    const sleeps = [];
    const attachCodes = [0, 0];
    let outputFetches = 0;
    const res = await launchCodexWithMocks({
      streams,
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') return { ok: true, session: { id: 'sess_retry' } };
        if (message.type === 'fetch_session_output') {
          outputFetches += 1;
          if (outputFetches === 2) {
            return {
              ok: true,
              session: { ...earlyCodexExit(), exit: { ...earlyCodexExit().exit, code: 0 } },
              output: 'Goodbye.',
            };
          }
          return { ok: true, session: earlyCodexExit(), output: CODEX_SQLITE_LOCK_OUTPUT };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        assert.fail(`unexpected broker request: ${message.type}`);
      },
      attach: async () => attachCodes.shift(),
      sleepFn: async (delayMs) => { sleeps.push(delayMs); },
    });

    assert.equal(res.code, 0);
    assert.deepEqual(requestTypes, [
      'launch_session',
      'fetch_session_output',
      'remove_session',
      'launch_session',
      'fetch_session_output',
    ]);
    assert.deepEqual(sleeps, [CODEX_SQLITE_RETRY_DELAYS_MS[0]]);
    assert.match(streams.err(), /retrying startup in 2s \(1\/2\)/);
  });

  test('bounds repeated Codex SQLite startup retries to two', async () => {
    const streams = makeStreams();
    const requestTypes = [];
    const sleeps = [];
    const res = await launchCodexWithMocks({
      streams,
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') return { ok: true, session: { id: 'sess_retry' } };
        if (message.type === 'fetch_session_output') {
          return { ok: true, session: earlyCodexExit(), output: CODEX_SQLITE_LOCK_OUTPUT };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        assert.fail(`unexpected broker request: ${message.type}`);
      },
      attach: async () => 0,
      sleepFn: async (delayMs) => { sleeps.push(delayMs); },
    });

    assert.equal(res.code, 0);
    assert.equal(requestTypes.filter((type) => type === 'launch_session').length, 3);
    assert.equal(requestTypes.filter((type) => type === 'remove_session').length, 2);
    assert.deepEqual(sleeps, [...CODEX_SQLITE_RETRY_DELAYS_MS]);
    assert.match(streams.err(), /retrying startup in 4s \(2\/2\)/);
  });

  test('does not retry other Codex startup failures', async () => {
    const streams = makeStreams();
    const requestTypes = [];
    const res = await launchCodexWithMocks({
      streams,
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') return { ok: true, session: { id: 'sess_retry' } };
        if (message.type === 'fetch_session_output') {
          return { ok: true, session: earlyCodexExit(), output: 'Authentication failed.' };
        }
        assert.fail(`unexpected broker request: ${message.type}`);
      },
      attach: async () => 0,
    });

    assert.equal(res.code, 0);
    assert.deepEqual(requestTypes, ['launch_session', 'fetch_session_output']);
    assert.doesNotMatch(streams.err(), /retrying startup/);
  });

  test('routes new launches through a per-session host broker when enabled', async () => {
    const requests = [];
    const stderr = makeStreams().stderr;
    const res = await launchClientTest.resolveLaunchBroker({
      codingSessionId: 'sess_hosted',
      request: async (message, options) => {
        requests.push({ message, options });
        return { ok: true };
      },
      ensureBroker: async () => assert.fail('global broker should not be used'),
      cloudBroker: {},
      stderr,
      deps: {
        useSessionHost: true,
        ensureSessionHost: async ({ sessionId }) => {
          assert.equal(sessionId, 'sess_hosted');
          return {
            ok: true,
            socketPath: '/tmp/mc-hosted.sock',
            broker: { pid: 123 },
          };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.hostKind, 'session');
    assert.equal(res.socketPath, '/tmp/mc-hosted.sock');
    assert.deepEqual(res.broker, { pid: 123 });

    await res.request({ type: 'launch_session', session: { id: 'sess_hosted' } });
    assert.deepEqual(requests, [{
      message: { type: 'launch_session', session: { id: 'sess_hosted' } },
      options: { socketPath: '/tmp/mc-hosted.sock' },
    }]);
  });

  test('prepares sidecars, launches through broker, then attaches', async () => {
    const streams = makeStreams();
    const sequence = [];
    const requests = [];
    let attached = null;
    let launched = null;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      sessionName: 'feature',
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
      ensureCloudBroker: async () => {
        sequence.push('ensureCloudBroker');
        return { ok: true, alreadyRunning: true, pid: 43 };
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
        getRepoContext: async () => ({ remoteUrl: 'https://token:secret@github.com/org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async ({ cwd, focus, codingSessionId }) => {
          assert.equal(cwd, '/repo');
          assert.equal(focus, 'fix tests');
          assert.equal(codingSessionId, 'sess_abc');
          return { ok: true };
        },
        hostname: () => 'machine',
        lookupOrMint: async (identity) => {
          assert.equal(identity.repoIdentity, 'https://token:secret@github.com/org/repo.git');
          assert.equal(identity.machineId, 'machine');
          assert.match(identity.llmSessionId, /^mc-10000-/);
          return 'sess_abc';
        },
        prepareLocalResourceGuardEnv: ({ baseEnv, config, codingSessionId }) => {
          assert.equal(config.apiUrl, 'https://memoro.test');
          assert.equal(codingSessionId, 'sess_abc');
          return { env: { ...baseEnv, MC_LOCAL_RESOURCE_PROFILE: 'conservative' } };
        },
        prepareDevCommandGuardEnv: ({ baseEnv, worktreePath, codingSessionId }) => {
          assert.equal(worktreePath, '/repo');
          assert.equal(codingSessionId, 'sess_abc');
          return { env: { ...baseEnv, MC_DEV_COMMAND_GUARD: 'sha256:abc123' } };
        },
        resolveDevPlan: async () => ({
          service: { name: 'web', source: '.mc/dev.json' },
          profile: { name: 'agent', source: '.mc/dev.json' },
          definition_fingerprint: 'sha256:abc123',
        }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_abc');
    assert.deepEqual(sequence, ['ensureBroker', 'request', 'ensureCloudBroker', 'onLaunched', 'attach']);
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
    assert.equal(msg.session.env.MC_LOCAL_RESOURCE_PROFILE, 'conservative');
    assert.equal(msg.session.env.MC_DEV_COMMAND_GUARD, 'sha256:abc123');
    assert.equal(msg.session.env.MC_SESSION_NAME, 'feature');
    assert.equal(msg.session.env.MC_CODING_SESSION_ID, 'sess_abc');
    assert.equal(msg.session.env.MC_DEV_SERVICE, 'web');
    assert.equal(msg.session.env.MC_DEV_PROFILE, 'agent');
    assert.equal(msg.session.env.MC_DEV_DEFINITION_FINGERPRINT, 'sha256:abc123');
    assert.equal(msg.session.sidecars.codingSessionId, 'sess_abc');
    assert.equal(msg.session.sidecars.apiUrl, 'https://memoro.test');
    assert.equal(msg.session.sidecars.token, 'tok');
    assert.equal(msg.session.sidecars.machineId, 'machine');
    assert.equal(msg.session.sidecars.source, 'claude-code');
    assert.equal(msg.session.sidecars.repo, 'repo');
    assert.equal(msg.session.sidecars.repoRef, 'org/repo');
    assert.equal(msg.session.sidecars.branch, 'main');
    assert.match(msg.session.sidecars.sockPath, /sess_abc\.sock$/);
    assert.match(msg.session.sidecars.metaPath, /sess_abc\.json$/);
    assert.match(streams.out(), /sess_abc/);
    assert.equal(streams.err(), '');
  });

  test('uses an explicit coding session id without minting a new one', async () => {
    const streams = makeStreams();
    const requests = [];
    let attached = null;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_server123',
      sessionName: 'cloud-coordinator',
      focus: 'cloud task',
      tool: 'claude',
      attachAfterLaunch: false,
      cloudBroker: {
        sourceId: 'cloud:cld_123456',
        sourceKind: 'cloud',
        sourceName: 'Memoro Cloud',
        cloudSessionId: 'cld_123456',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      now: () => 10_000,
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      attach: async (opts) => {
        attached = opts;
        return 0;
      },
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async ({ codingSessionId }) => {
          assert.equal(codingSessionId, 'sess_server123');
          return { ok: true };
        },
        hostname: () => 'cloud-runner',
        lookupOrMint: async () => assert.fail('explicit codingSessionId should avoid lookupOrMint'),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_server123');
    assert.equal(res.attached, false);
    assert.equal(attached, null);
    assert.equal(requests[0].session.id, 'sess_server123');
    assert.equal(requests[0].session.sidecars.codingSessionId, 'sess_server123');
    assert.match(requests[0].session.sidecars.sockPath, /sess_server123\.sock$/);
    assert.match(streams.out(), /sess_server123/);
  });

  test('routes cloud Codex interactive login through device auth without auto-submitting grounding', async () => {
    const streams = makeStreams();
    const requests = [];
    let ensuredBroker = false;
    let grounded = false;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_cloudcodex',
      sessionName: 'cloud-codex',
      focus: 'cloud task',
      tool: 'codex',
      attachAfterLaunch: false,
      cloudBroker: {
        sourceId: 'cloud:cld_123456',
        sourceKind: 'cloud',
        sourceName: 'Memoro Cloud',
        cloudSessionId: 'cld_123456',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      now: () => 10_000,
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      ensureBroker: async () => {
        ensuredBroker = true;
        return { ok: true, broker: { pid: 42 } };
      },
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => {
          grounded = true;
          return { ok: true, message: 'cloud task grounding' };
        },
        hostname: () => 'cloud-runner',
        getPackageVersion: async () => '0.test',
        prepareCloudCodexAuth: async () => ({
          ok: true,
          source: 'interactive-login',
          interactiveLogin: true,
          startupMessageSafe: false,
        }),
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_cloudcodex');
    assert.equal(ensuredBroker, true);
    assert.equal(grounded, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].session.tool, 'codex');
    assert.equal(requests[0].session.launch_options.startupMessage, null);
    assert.equal(requests[0].session.launch_options.codexDeviceAuthBeforeLaunch, true);
  });

  test('prepares cloud Codex auth and passes scrubbed env to broker launch', async () => {
    const streams = makeStreams();
    const requests = [];

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_cloudcodex',
      sessionName: 'cloud-codex',
      focus: 'cloud task',
      tool: 'codex',
      attachAfterLaunch: false,
      cloudBroker: {
        sourceId: 'cloud:cld_123456',
        sourceKind: 'cloud',
        sourceName: 'Memoro Cloud',
        cloudSessionId: 'cld_123456',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {
        TERM: 'xterm-256color',
        MC_CODEX_API_KEY: 'sk-cloud',
      },
      now: () => 10_000,
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => ({ ok: true }),
        hostname: () => 'cloud-runner',
        getPackageVersion: async () => '0.test',
        prepareCloudCodexAuth: async ({ env }) => {
          env.CODEX_HOME = '/workspace/.codex-cloud';
          delete env.MC_CODEX_API_KEY;
          return { ok: true };
        },
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_cloudcodex');
    assert.equal(requests[0].session.tool, 'codex');
    assert.equal(requests[0].session.env.CODEX_HOME, '/workspace/.codex-cloud');
    assert.equal(requests[0].session.env.MC_CODEX_API_KEY, undefined);
  });

  test('uses the broker-returned session id when launch is deduplicated', async () => {
    const streams = makeStreams();
    let attached = null;
    let launched = null;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color' },
      now: () => 10_000,
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      request: async (message) => ({
        ok: true,
        reused: true,
        session: { id: 'sess_existing', cwd: message.session.cwd },
      }),
      attach: async (opts) => {
        attached = opts;
        return 0;
      },
      onLaunched: async (event) => {
        launched = event;
      },
      deps: {
        getRepoContext: async () => ({
          remoteUrl: 'git@example.com:org/repo.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => ({ ok: true }),
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_new',
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_existing');
    assert.deepEqual(attached, { id: 'sess_existing' });
    assert.equal(launched.codingSessionId, 'sess_existing');
    assert.match(streams.out(), /sess_existing/);
    assert.doesNotMatch(streams.out(), /sess_new/);
  });

  test('can launch headlessly for cloud-owned sessions', async () => {
    const streams = makeStreams();
    const requests = [];
    let attachCalled = false;
    let cloudArgs = null;
    let brokerArgs = null;

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      sessionName: 'cloud-coordinator',
      focus: 'cloud work',
      tool: 'claude',
      attachAfterLaunch: false,
      cloudBroker: {
        sourceId: 'cloud:cld_123456',
        sourceKind: 'cloud',
        sourceName: 'Memoro Cloud',
        cloudSessionId: 'cld_123456',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', MEMORO_TOKEN: 'env_tok' },
      now: () => 10_000,
      ensureBroker: async (args) => {
        brokerArgs = args;
        return { ok: true, broker: { pid: 42 } };
      },
      ensureCloudBroker: (args) => {
        cloudArgs = args;
        return { ok: true, started: true, pid: 43 };
      },
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      attach: async () => {
        attachCalled = true;
        return 0;
      },
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => assert.fail('env MEMORO_TOKEN should avoid keychain lookup'),
        groundSession: async () => ({ ok: true }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        hostname: () => 'cloud-runner',
        lookupOrMint: async () => 'sess_cloud',
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(res.codingSessionId, 'sess_cloud');
    assert.equal(res.attached, false);
    assert.equal(attachCalled, false);
    assert.equal(brokerArgs.timeoutMs, 10_000);
    assert.deepEqual(cloudArgs, {
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Memoro Cloud',
      cloudSessionId: 'cld_123456',
    });
    assert.equal(requests[0].session.name, 'cloud-coordinator');
    assert.equal(requests[0].session.sidecars.token, 'env_tok');
    assert.equal(requests[0].session.env.MEMORO_TOKEN, undefined);
  });

  test('repairs headless terminal env for Claude broker launches too', async () => {
    const streams = makeStreams();
    const requests = [];

    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {
        TERM: 'dumb',
        NO_COLOR: '1',
        CLICOLOR: '0',
        PATH: '/bin',
      },
      now: () => 10_000,
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true, alreadyRunning: true, pid: 43 }),
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      attach: async () => 0,
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => ({ ok: true }),
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_claude',
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    const session = requests[0].session;
    assert.equal(session.tool, 'claude');
    assert.equal(session.term_name, 'xterm-256color');
    assert.equal(session.env.TERM, 'xterm-256color');
    assert.equal(session.env.NO_COLOR, undefined);
    assert.equal(session.env.CLICOLOR, undefined);
    assert.equal(session.env.COLORTERM, 'truecolor');
  });

  test('continues local launch when cloud bridge auto-start fails', async () => {
    const streams = makeStreams();
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color' },
      now: () => 10_000,
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: false, error: 'spawn failed' }),
      request: async (message) => ({ ok: true, session: { id: message.session.id } }),
      attach: async () => 0,
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => ({ ok: true }),
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_cloud_soft_fail',
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.match(streams.err(), /broker cloud bridge not started/);
    assert.match(streams.err(), /continuing with local broker only/);
  });

  test('skips startup grounding for resume relaunches', async () => {
    const streams = makeStreams();
    const requests = [];
    let grounded = false;
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      sendStartupMessage: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color' },
      now: () => 10_000,
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true, alreadyRunning: true, pid: 43 }),
      request: async (message) => {
        requests.push(message);
        return { ok: true, session: { id: message.session.id } };
      },
      attach: async () => 0,
      deps: {
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:org/repo.git', branch: 'main', toplevel: '/repo' }),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => {
          grounded = true;
          return { ok: true, message: 'grounding prompt' };
        },
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_no_prompt',
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(grounded, false);
    assert.equal(requests[0].session.launch_options.startupMessage, null);
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
      request: async () => ({ ok: true, broker: { pid: 1, protocol_version: BROKER_PROTOCOL_VERSION } }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyRunning, true);
    assert.equal(spawned, false);
  });

  test('refuses to replace a stale broker with live sessions', async () => {
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => ({
        ok: true,
        broker: { pid: 1 },
        sessions: [{ id: 'sess_live', session_state: 'live', cwd: '/repo', tool: 'codex' }],
      }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
    });

    assert.equal(res.ok, false);
    assert.equal(res.stale, true);
    assert.match(res.error, /stale/);
    assert.deepEqual(res.live_sessions, [{
      id: 'sess_live',
      name: null,
      cwd: '/repo',
      tool: 'codex',
    }]);
    assert.equal(spawned, false);
  });

  test('restarts a stale broker when no live sessions are present', async () => {
    const seen = [];
    let spawned = false;
    const responses = [
      { ok: true, broker: { pid: 1 }, sessions: [] },
      { ok: true, stopping: true },
      null,
      { ok: true, broker: { pid: 2, protocol_version: BROKER_PROTOCOL_VERSION } },
    ];
    const res = await ensureBrokerRunning({
      request: async (msg) => {
        seen.push(msg.type);
        const next = responses.shift();
        if (next === null) throw new Error('offline');
        return next;
      },
      spawnDaemon: () => {
        spawned = true;
        return { ok: true, pid: 2 };
      },
      sleep: async () => {},
    });

    assert.equal(res.ok, true);
    assert.equal(res.started, true);
    assert.equal(spawned, true);
    assert.deepEqual(seen, ['status', 'stop', 'status', 'status']);
  });

  test('spawns and polls until broker is ready', async () => {
    let requests = 0;
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => {
        requests += 1;
        if (!spawned) throw new Error('offline');
        return { ok: true, broker: { pid: 2, protocol_version: BROKER_PROTOCOL_VERSION } };
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
