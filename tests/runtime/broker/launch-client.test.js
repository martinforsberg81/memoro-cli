import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CODEX_SQLITE_RETRY_DELAYS_MS,
  __test__ as launchClientTest,
  brokerSessionPaths,
  ensureBrokerRunning,
  isRetryableCodexSqliteStartupFailure,
  launchBrokerOwnedSession as launchBrokerOwnedSessionImpl,
  managedBoundaryRemedy,
  registerGitHubSessionProjection,
} from '../../../src/runtime/broker/launch-client.js';
import { BROKER_PROTOCOL_VERSION } from '../../../src/runtime/broker/daemon.js';
import { BROKER_RUNTIME_IDENTITY } from '../../../src/runtime/broker/runtime-identity.js';
import { LOCAL_AUTH_MODES } from '../../../src/mc/local-auth-mode.js';
import {
  deriveHandoffControllerRoot,
} from '../../../src/mc/handoff-controller-capability.js';
import {
  buildManagedGenerationIntent,
} from '../../../src/mc/managed-generation-journal.js';

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
const RUNTIME_GENERATION = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const NEXT_RUNTIME_GENERATION = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';

const SESSION_CAPABILITIES = Object.freeze({
  schema: 1,
  github: {
    state: 'ready',
    transport: 'mc-broker-v1',
    actor: 'installation',
    account: 'acme',
    repository: {
      id: 301,
      full_name: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      private: true,
      archived: false,
      account: 'acme',
    },
    operations: ['connection.status', 'repository.metadata', 'pull_request.list', 'pull_request.view', 'checks.list'],
  },
});

describe('brokerLaunchFailureReason', () => {
  test('prefers the stable broker reason over generic adapter error text', () => {
    assert.equal(
      launchClientTest.brokerLaunchFailureReason({
        ok: false,
        reason: 'managed-provider-version-unsupported',
        error: 'managed Codex provider boundary is unavailable',
      }),
      'managed-provider-version-unsupported',
    );
  });

  test('does not render arbitrary broker error text', () => {
    assert.equal(
      launchClientTest.brokerLaunchFailureReason({
        ok: false,
        error: 'failed while reading /private/path/with user data',
      }),
      'broker-launch-failed',
    );
  });
});

function launchBrokerOwnedSession(options) {
  return launchBrokerOwnedSessionImpl({
    ...options,
    deps: {
      installClaudeArtifactHooks: async () => {},
      installCodexArtifactHooks: async () => {},
      fetchGitHubSessionBootstrap: async () => ({
        capabilities: SESSION_CAPABILITIES,
        source: { id: 'local:device:test', kind: 'local' },
      }),
      registerGitHubSessionProjection: async () => true,
      resolveRepositoryIdentity: () => ({
        ok: true,
        id: 'repo_111111111111111111111111',
        kind: 'remote',
        canonical: 'example.test/org/repo',
      }),
      prepareGitHubSessionForLaunch: async ({ baseEnv, capabilities, socketPath }) => ({
        env: {
          ...baseEnv,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          PATH: `/tmp/mc-github-shim:${baseEnv.PATH || ''}`,
          MC_SESSION_CAPABILITIES: JSON.stringify(capabilities),
          MC_GITHUB_BROKER_SOCKET: socketPath,
        },
        capabilities,
        shim_path: '/tmp/mc-github-shim/gh',
      }),
      ...(options.deps || {}),
    },
  });
}

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

function launchCodexWithMocks({
  request,
  attach,
  streams,
  sleepFn = async () => {},
  randomUUID,
  ambiguousBrokerReconcileDelaysMs,
}) {
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
      ...(randomUUID ? { randomUUID } : {}),
      ...(ambiguousBrokerReconcileDelaysMs
        ? { ambiguousBrokerReconcileDelaysMs }
        : {}),
    },
  });
}

describe('launchBrokerOwnedSession', () => {
  test('managed local auth rejects unsupported tools before identity, config, repo, broker, or PTY work', async () => {
    const streams = makeStreams();
    const fail = (surface) => async () => assert.fail(`must not access ${surface}`);
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {
        MEMORO_TOKEN: 'memoro-token-canary',
        MC_VAULT_STARTUP_DONE: '1',
      },
      ensureBroker: fail('broker'),
      ensureCloudBroker: fail('cloud broker'),
      request: fail('broker request'),
      attach: fail('PTY attach'),
      deps: {
        managedProviderAdapterForTool: () => null,
        getRepoContext: fail('repo'),
        readConfig: fail('config'),
        resolveBootstrapIdentity: fail('device identity'),
        getSecret: fail('keychain'),
        fetchGitHubSessionBootstrap: fail('GitHub bootstrap'),
      },
    });

    assert.equal(result.code, 1);
    assert.equal(result.reason, 'managed-provider-tool-unsupported');
    assert.match(streams.err(), /no managed provider adapter is installed/);
    assert.doesNotMatch(streams.err(), /memoro-token-canary/);
    assert.equal(streams.out(), '');
  });

  test('managed providers never install host-global Claude hooks', async () => {
    const streams = makeStreams();
    let hookCalls = 0;
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color' },
      deps: {
        managedProviderAdapterForTool: () => ({
          schema: 'mc-managed-provider-adapter/v2',
          tool_id: 'claude-code',
          provider_adapter_id: 'claude-managed-local-v1',
        }),
        getRepoContext: async () => ({
          remoteUrl: 'git@example.com:org/repo.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        installClaudeArtifactHooks: async () => {
          hookCalls += 1;
          throw new Error('host-global hook must not be touched');
        },
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        resolveBootstrapIdentity: async () => null,
      },
    });

    assert.equal(result.code, 1);
    assert.equal(hookCalls, 0);
    assert.match(streams.err(), /no Memoro token/);
    assert.doesNotMatch(streams.err(), /provider artifact hook/);
  });

  test('managed handoff rejects a transaction bound to native custody before launch', async () => {
    const streams = makeStreams();
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'codex',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      handoffUserMessage: 'bounded handoff',
      handoffTransaction: {
        transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
        controller_capability: 'c'.repeat(64),
        target_custody: 'native',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(result.code, 1);
    assert.equal(result.reason, 'handoff-launch-pair-invalid');
    assert.match(streams.err(), /requires one bound message and transaction/u);
  });

  test('managed Codex launch carries a token-free GitHub capability without broker credentials', async () => {
    const streams = makeStreams();
    const requests = [];
    const descriptor = {
      schema: 'mc-local-codex-credential-domain/v1',
      provider_adapter: 'codex-managed-local-v1',
      generation: '687c338a-1ed4-4c20-9828-1f9a39d37067',
      domain_path: '/credential/domain',
      codex_home: '/credential/domain/home/.codex',
      executor_root: '/executor/domain',
      manifest_sha256: 'a'.repeat(64),
    };
    const managedReceipts = [];
    const managedOrder = [];
    let preparedGeneration = null;
    const forbidden = (surface) => () => assert.fail(`managed launch must not call ${surface}`);
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_managed_launch',
      tool: 'codex',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      attachAfterLaunch: false,
      cloudBroker: {
        sourceId: 'cloud:managed-test',
        sourceKind: 'cloud',
        cloudSessionId: 'cloud-managed-test',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: {
        PATH: '/usr/bin:/bin',
        TERM: 'xterm-256color',
        MEMORO_TOKEN: 'memoro-token-canary',
        OPENAI_API_KEY: 'openai-key-canary',
        MC_VAULT_PASSPHRASE: 'vault-passphrase-canary',
      },
      request: async (message, options) => {
        requests.push(message);
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        findEntry: () => ({
          tool_session_id: 'claude-source-native-id',
          tool_transcript_path: '/private/claude-source-transcript.jsonl',
        }),
        resolvePolicyForWrap: () => ({ permissions: { workspace: 'full' } }),
        hostname: () => 'machine',
        groundSession: async ({ sessionCapabilities }) => {
          assert.equal(sessionCapabilities.github.state, 'ready');
          return { ok: true, message: 'safe grounding' };
        },
        resolveDevPlan: forbidden('repo dev environment'),
        prepareCloudCodexAuth: forbidden('native cloud Codex auth'),
        prepareLocalResourceGuardEnv: forbidden('native local guard'),
        prepareCloudflareGuardEnv: forbidden('native Cloudflare guard'),
        prepareDevCommandGuardEnv: forbidden('native dev guard'),
        prepareManagedCredentialDomain: async ({
          portal,
          domainGeneration,
          githubCapability,
        }) => {
          managedOrder.push('prepare-domain');
          assert.equal(portal.token, 'memoro-token-canary');
          assert.equal(githubCapability, true);
          preparedGeneration = domainGeneration;
          return {
            ok: true,
            descriptor,
            env: {
              PATH: '/managed/bin',
              HOME: '/credential/domain/home',
              CODEX_HOME: '/credential/domain/home/.codex',
              TMPDIR: '/credential/domain/tmp',
              TERM: 'xterm-256color',
            },
          };
        },
        beginManagedGeneration: (input) => {
          managedOrder.push('claim-intent');
          return {
            ok: true,
            intent: buildManagedGenerationIntent({
              ...input,
              sequence: 1,
              tool: 'codex',
            }),
          };
        },
        appendManagedGenerationReceipt: (input) => {
          managedOrder.push(input.phase);
          managedReceipts.push(input);
          return { ok: true };
        },
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(result.code, 0, streams.err());
    assert.equal(requests.length, 1);
    const session = requests[0].session;
    assert.deepEqual(session.credential_domain, descriptor);
    assert.equal(session.managed_transaction.coding_session_id, 'sess_managed_launch');
    assert.equal(session.managed_transaction.runtime_generation, session.runtime_generation);
    assert.equal(preparedGeneration, session.runtime_generation);
    assert.equal(session.managed_transaction.intent_digest.length, 64);
    assert.deepEqual(managedReceipts.map((receipt) => receipt.phase), ['domain-ready']);
    assert.deepEqual(managedOrder, [
      'claim-intent',
      'prepare-domain',
      'domain-ready',
    ]);
    assert.equal(session.launch_options.effectivePolicy, null);
    assert.equal(session.sidecars.enabled, true);
    assert.equal(session.sidecars.codingSessionId, 'sess_managed_launch');
    assert.equal(session.sidecars.runtimeGeneration, session.runtime_generation);
    assert.equal(session.sidecars.heartbeat, true);
    assert.equal(session.sidecars.presenceIdentity, 'broker-local');
    assert.equal(session.sidecars.machineId, 'machine');
    assert.equal(session.sidecars.source_id, 'local:device:test');
    assert.equal(session.sidecars.source_kind, 'local');
    assert.equal(session.sidecars.repo, 'widgets');
    assert.equal(session.sidecars.repoRef, 'acme/widgets');
    assert.equal(session.sidecars.branch, 'main');
    assert.equal(session.sidecars.upload, false);
    assert.equal(session.sidecars.transcriptAccess, false);
    assert.deepEqual(session.sidecars.githubCapabilities, SESSION_CAPABILITIES);
    assert.equal(session.sidecars.apiUrl, undefined);
    assert.equal(session.sidecars.token, undefined);
    assert.equal(session.env.CODEX_HOME, '/credential/domain/home/.codex');
    assert.deepEqual(
      JSON.parse(session.env.MC_SESSION_CAPABILITIES),
      SESSION_CAPABILITIES,
    );
    assert.match(session.env.MC_GITHUB_BROKER_SOCKET, /sess_managed_launch\.sock$/);
    assert.equal(session.env.MEMORO_TOKEN, undefined);
    assert.equal(session.env.OPENAI_API_KEY, undefined);
    assert.equal(session.env.MC_VAULT_PASSPHRASE, undefined);
    assert.equal(session.env.MC_CODING_SESSION_ID, undefined);
    const brokerRequest = JSON.stringify(requests[0]);
    assert.doesNotMatch(
      brokerRequest,
      /memoro-token-canary|openai-key-canary|vault-passphrase-canary/,
    );
  });

  test('managed launch cleanup is allowed only before durable broker acceptance', () => {
    const intent = buildManagedGenerationIntent({
      sequence: 1,
      codingSessionId: 'sess_managed_reject',
      runtimeGeneration: RUNTIME_GENERATION,
      mode: 'fresh',
      tool: 'codex',
      recordedAt: '2026-07-29T12:00:00.000Z',
    });
    const descriptor = { generation: NEXT_RUNTIME_GENERATION };
    const aborts = [];
    const receipts = [];
    const run = (phase) => launchClientTest.abortUnacceptedManagedLaunch({
      codingSessionId: intent.coding_session_id,
      runtimeGeneration: intent.runtime_generation,
      managedIntent: intent,
      descriptor,
      failureReason: 'managed-provider-hook-mismatch',
      now: () => Date.parse('2026-07-29T12:00:01.000Z'),
      deps: {
        inspectManagedGeneration: () => ({ kind: 'present', phase }),
        abortManagedCredentialDomain: (input) => {
          aborts.push(input);
          return { ok: true };
        },
        appendManagedGenerationReceipt: (input) => {
          receipts.push(input);
          return { ok: true };
        },
      },
    });

    assert.deepEqual(run('broker-accepted'), {
      ok: false,
      reason: 'managed-generation-may-have-launched',
    });
    assert.deepEqual(aborts, []);
    assert.deepEqual(receipts, []);

    assert.deepEqual(run('domain-ready'), { ok: true });
    assert.deepEqual(aborts, [{ descriptor }]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].phase, 'aborted');
    assert.equal(receipts[0].intentDigest, intent.intent_digest);
    assert.deepEqual(receipts[0].data, {
      reason: 'launch-not-accepted',
      failure_reason: 'managed-provider-hook-mismatch',
    });
  });

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
    const launchGenerations = [];
    const sleeps = [];
    const attachCodes = [0, 0];
    let outputFetches = 0;
    const generations = [RUNTIME_GENERATION, NEXT_RUNTIME_GENERATION];
    const res = await launchCodexWithMocks({
      streams,
      request: async (message, options) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') {
          launchGenerations.push(message.session.runtime_generation);
          assert.equal(
            message.session.sidecars.runtimeGeneration,
            message.session.runtime_generation,
          );
          return {
            ok: true,
            session: { id: 'sess_retry', runtime_generation: message.session.runtime_generation },
          };
        }
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
        if (message.type === 'remove_session') {
          assert.equal(message.expected_runtime_generation, RUNTIME_GENERATION);
          assert.deepEqual(options, { timeoutMs: 20_000 });
          return { ok: true, removed: true };
        }
        assert.fail(`unexpected broker request: ${message.type}`);
      },
      attach: async () => attachCodes.shift(),
      sleepFn: async (delayMs) => { sleeps.push(delayMs); },
      randomUUID: () => generations.shift(),
    });

    assert.equal(res.code, 0);
    assert.deepEqual(requestTypes, [
      'launch_session',
      'fetch_session_output',
      'remove_session',
      'launch_session',
      'fetch_session_output',
    ]);
    assert.deepEqual(launchGenerations, [RUNTIME_GENERATION, NEXT_RUNTIME_GENERATION]);
    assert.deepEqual(sleeps, [CODEX_SQLITE_RETRY_DELAYS_MS[0]]);
    assert.match(streams.err(), /retrying startup in 2s \(1\/2\)/);
  });

  test('reconciles an accepted SQLite cleanup after its response is lost', async () => {
    const streams = makeStreams();
    const generations = [RUNTIME_GENERATION, NEXT_RUNTIME_GENERATION];
    const attachCodes = [1, 0];
    const requestTypes = [];
    let launches = 0;
    let outputFetches = 0;
    const res = await launchCodexWithMocks({
      streams,
      randomUUID: () => generations.shift(),
      attach: async () => attachCodes.shift(),
      request: async (message, options) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') {
          launches += 1;
          return {
            ok: true,
            session: {
              id: 'sess_retry',
              runtime_generation: message.session.runtime_generation,
            },
          };
        }
        if (message.type === 'fetch_session_output') {
          outputFetches += 1;
          return outputFetches === 1
            ? { ok: true, session: earlyCodexExit(), output: CODEX_SQLITE_LOCK_OUTPUT }
            : {
                ok: true,
                session: { ...earlyCodexExit(), exit: { ...earlyCodexExit().exit, code: 0 } },
                output: 'Goodbye.',
              };
        }
        if (message.type === 'remove_session') {
          assert.equal(message.expected_runtime_generation, RUNTIME_GENERATION);
          assert.deepEqual(options, { timeoutMs: 20_000 });
          throw new Error('broker response lost after accepted cleanup');
        }
        if (message.type === 'session_status') {
          return {
            ok: false,
            reason: 'session-not-found',
            error: 'unknown broker session: sess_retry',
          };
        }
        assert.fail(`unexpected broker request: ${message.type}`);
      },
    });

    assert.equal(res.code, 0, streams.err());
    assert.equal(launches, 2);
    assert.deepEqual(requestTypes, [
      'launch_session',
      'fetch_session_output',
      'remove_session',
      'session_status',
      'launch_session',
      'fetch_session_output',
    ]);
    assert.doesNotMatch(streams.err(), /could not confirm removal/);
  });

  test('reconciles an accepted SQLite retry launch before attaching', async () => {
    const streams = makeStreams();
    const generations = [RUNTIME_GENERATION, NEXT_RUNTIME_GENERATION];
    const attachCodes = [1, 0];
    let launches = 0;
    let outputFetches = 0;
    const requestTypes = [];
    const res = await launchCodexWithMocks({
      streams,
      randomUUID: () => generations.shift(),
      attach: async () => attachCodes.shift(),
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') {
          launches += 1;
          if (launches === 2) throw new Error('broker response lost');
          return {
            ok: true,
            session: {
              id: 'sess_retry',
              runtime_generation: message.session.runtime_generation,
            },
          };
        }
        if (message.type === 'session_status') {
          return {
            ok: true,
            session: {
              id: 'sess_retry',
              runtime_generation: NEXT_RUNTIME_GENERATION,
              session_state: 'live',
              attachable: true,
            },
          };
        }
        if (message.type === 'fetch_session_output') {
          outputFetches += 1;
          return outputFetches === 1
            ? { ok: true, session: earlyCodexExit(), output: CODEX_SQLITE_LOCK_OUTPUT }
            : {
                ok: true,
                session: { ...earlyCodexExit(), exit: { ...earlyCodexExit().exit, code: 0 } },
                output: 'Goodbye.',
              };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        assert.fail(`unexpected broker request: ${message.type}`);
      },
    });

    assert.equal(res.code, 0, streams.err());
    assert.deepEqual(requestTypes, [
      'launch_session',
      'fetch_session_output',
      'remove_session',
      'launch_session',
      'session_status',
      'fetch_session_output',
    ]);
    assert.doesNotMatch(streams.err(), /outcome is unknown/);
  });

  test('bounds repeated Codex SQLite startup retries to two', async () => {
    const streams = makeStreams();
    const requestTypes = [];
    const sleeps = [];
    const res = await launchCodexWithMocks({
      streams,
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') {
          return { ok: true, session: { id: 'sess_retry', runtime_generation: message.session.runtime_generation } };
        }
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
        if (message.type === 'launch_session') {
          return { ok: true, session: { id: 'sess_retry', runtime_generation: message.session.runtime_generation } };
        }
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
    const sessionControllerCapability = 'c'.repeat(64);
    const res = await launchClientTest.resolveLaunchBroker({
      codingSessionId: 'sess_hosted',
      sessionControllerCapability,
      request: async (message, options) => {
        requests.push({ message, options });
        return { ok: true };
      },
      ensureBroker: async () => assert.fail('global broker should not be used'),
      cloudBroker: {},
      stderr,
      deps: {
        useSessionHost: true,
        ensureSessionHost: async ({ sessionId, controllerBinding }) => {
          assert.equal(sessionId, 'sess_hosted');
          assert.deepEqual(controllerBinding, {
            schema: 'mc-broker-controller-bootstrap-v1',
            session_id: 'sess_hosted',
            session_controller_capability: sessionControllerCapability,
          });
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
      env: {
        TERM: 'xterm-256color',
        GH_TOKEN: 'github-secret-sentinel',
        GITHUB_TOKEN: 'github-secret-sentinel',
      },
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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
        registerGitHubSessionProjection: async (options) => {
          sequence.push('registerGitHub');
          assert.equal(options.codingSessionId, 'sess_abc');
          assert.equal(options.runtimeGeneration, RUNTIME_GENERATION);
          assert.equal(options.repo, 'repo');
          assert.equal(options.repoRef, 'org/repo');
          return true;
        },
        groundSession: async ({ cwd, focus, codingSessionId, sessionCapabilities }) => {
          assert.equal(cwd, '/repo');
          assert.equal(focus, 'fix tests');
          assert.equal(codingSessionId, 'sess_abc');
          assert.equal(sessionCapabilities, SESSION_CAPABILITIES);
          return { ok: true };
        },
        hostname: () => 'machine',
        randomUUID: () => RUNTIME_GENERATION,
        lookupOrMint: async (identity) => {
          assert.equal(identity.repoIdentity, 'repo_111111111111111111111111');
          assert.doesNotMatch(JSON.stringify(identity), /token|secret/u);
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
    assert.deepEqual(sequence, ['ensureBroker', 'registerGitHub', 'request', 'ensureCloudBroker', 'onLaunched', 'attach']);
    assert.deepEqual(attached, {
      id: 'sess_abc',
      controllerCapability: deriveHandoffControllerRoot({
        token: 'tok',
        codingSessionId: 'sess_abc',
      }),
    });
    assert.equal(launched.codingSessionId, 'sess_abc');

    const msg = requests[0];
    assert.equal(msg.type, 'launch_session');
    assert.equal(msg.session.id, 'sess_abc');
    assert.equal(msg.session.runtime_generation, RUNTIME_GENERATION);
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
    assert.equal(msg.session.env.GH_TOKEN, undefined);
    assert.equal(msg.session.env.GITHUB_TOKEN, undefined);
    assert.deepEqual(JSON.parse(msg.session.env.MC_SESSION_CAPABILITIES), SESSION_CAPABILITIES);
    assert.match(msg.session.env.MC_GITHUB_BROKER_SOCKET, /sess_abc\.sock$/);
    assert.match(msg.session.env.PATH, /^\/tmp\/mc-github-shim:/);
    assert.equal(msg.session.sidecars.codingSessionId, 'sess_abc');
    assert.equal(msg.session.sidecars.runtimeGeneration, RUNTIME_GENERATION);
    assert.equal(msg.session.sidecars.apiUrl, 'https://memoro.test');
    assert.equal(msg.session.sidecars.token, 'tok');
    assert.equal(msg.session.sidecars.machineId, 'machine');
    assert.equal(msg.session.sidecars.source_id, 'local:device:test');
    assert.equal(msg.session.sidecars.source_kind, 'local');
    assert.equal(msg.session.sidecars.source, 'claude-code');
    assert.equal(msg.session.sidecars.repo, 'repo');
    assert.equal(msg.session.sidecars.repoRef, 'org/repo');
    assert.equal(msg.session.sidecars.branch, 'main');
    assert.match(msg.session.sidecars.sockPath, /sess_abc\.sock$/);
    assert.match(msg.session.sidecars.metaPath, /sess_abc\.json$/);
    const childObservable = JSON.stringify({
      env: msg.session.env,
      argv: msg.session.argv,
      launch_options: msg.session.launch_options,
    });
    assert.equal(childObservable.includes('github-secret-sentinel'), false);
    assert.doesNotMatch(childObservable, /installation_id|access_token|private_key/);
    assert.match(streams.out(), /sess_abc/);
    assert.equal(streams.err(), '');
  });

  test('passes resolved git common dir as a launch option', async () => {
    const streams = makeStreams();
    const requests = [];
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'codex',
      sendStartupMessage: false,
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async (message) => {
        requests.push(message);
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        resolveRepositoryIdentity: () => ({ ok: true, id: 'repo_111111111111111111111111' }),
        resolveGitCommonDir: async () => '/repo/.git',
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        installCodexArtifactHooks: async () => {},
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_git_common',
        getPackageVersion: async () => '0.test',
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      },
    });

    assert.equal(res.code, 0);
    assert.equal(requests[0].session.launch_options.gitCommonDir, '/repo/.git');
    assert.equal(streams.err(), '');
  });

  test('does not install a session-scoped gh shim for native launches', async () => {
    const streams = makeStreams();
    const requests = [];
    let installSessionGitHubShim = null;
    const pathEnv = '/usr/local/bin:/usr/bin';
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: pathEnv },
      request: async (message) => {
        requests.push(message);
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        resolveRepositoryIdentity: () => ({ ok: true, id: 'repo_111111111111111111111111' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_no_shim',
        registerGitHubSessionProjection: async () => true,
        groundSession: async () => ({ ok: true }),
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareGitHubSessionForLaunch: async (input) => {
          installSessionGitHubShim = input.installSessionGitHubShim;
          return {
            env: {
              ...input.baseEnv,
              GH_TOKEN: undefined,
              GITHUB_TOKEN: undefined,
              GH_ENTERPRISE_TOKEN: undefined,
              GITHUB_ENTERPRISE_TOKEN: undefined,
              MC_SESSION_CAPABILITIES: JSON.stringify(input.capabilities),
              MC_GITHUB_BROKER_SOCKET: input.socketPath,
            },
            capabilities: input.capabilities,
          };
        },
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0);
    assert.equal(installSessionGitHubShim, false);
    assert.equal(requests[0].session.env.PATH, pathEnv);
    assert.equal(streams.err(), '');
  });

  test('keeps the verified GitHub boundary when advisory starting presence registration fails', async () => {
    const streams = makeStreams();
    let groundedState = null;
    let launchedCapabilities = null;
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async (message) => {
        launchedCapabilities = JSON.parse(message.session.env.MC_SESSION_CAPABILITIES);
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_register_fail',
        registerGitHubSessionProjection: async () => false,
        groundSession: async ({ sessionCapabilities }) => {
          groundedState = sessionCapabilities.github.state;
          return { ok: true };
        },
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 0, streams.err());
    assert.equal(groundedState, 'ready');
    assert.equal(launchedCapabilities.github.state, 'ready');
    assert.match(streams.err(), /session starting presence registration failed; broker will retry/);
  });

  test('registers a runtime-starting heartbeat without placing authority or credentials in its body', async () => {
    let call = null;
    const ok = await registerGitHubSessionProjection({
      apiUrl: 'https://memoro.test',
      token: 'memoro-secret-sentinel',
      codingSessionId: 'sess_register_ok',
      runtimeGeneration: RUNTIME_GENERATION,
      machineId: 'machine',
      sourceIdentity: {
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        cloud_session_id: null,
      },
      source: 'codex',
      repo: 'widgets',
      repoRef: 'acme/widgets',
      branch: 'main',
      label: 'feature',
      now: () => 10_000,
      postHeartbeat: async (options) => {
        call = options;
        return true;
      },
    });

    assert.equal(ok, true);
    assert.equal(call.apiUrl, 'https://memoro.test');
    assert.equal(call.token, 'memoro-secret-sentinel');
    assert.equal(call.maxAttempts, 1);
    assert.equal(call.memoroFetchImpl, undefined);
    assert.equal(call.payload.coding_session_id, 'sess_register_ok');
    assert.equal(call.payload.runtime_generation, RUNTIME_GENERATION);
    assert.equal(call.payload.presence_state, 'active');
    assert.equal(call.payload.repo, 'acme/widgets');
    assert.equal(call.payload.branch, 'main');
    assert.equal(call.payload.session_projection.reason_code, 'runtime_starting');
    assert.equal(call.payload.session_projection.runtime.lifecycle, 'starting');
    assert.equal('repo_ref' in call.payload, false);
    assert.equal(JSON.stringify(call.payload).includes('memoro-secret-sentinel'), false);
  });

  test('keeps GitHub unavailable when the starting projection cannot be registered', async () => {
    const ok = await registerGitHubSessionProjection({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      codingSessionId: 'sess_bind_missing',
      machineId: 'machine',
      sourceIdentity: {
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        cloud_session_id: null,
      },
      source: 'codex',
      repoRef: 'acme/widgets',
      branch: 'main',
      now: () => 10_000,
      postHeartbeat: async () => false,
    });

    assert.equal(ok, false);
  });

  test('terminalizes a registered starting generation when broker launch fails', async () => {
    const streams = makeStreams();
    const terminalCalls = [];
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_launch_fail',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async () => ({ ok: false, reason: 'pty-spawn-failed' }),
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'memoro-secret-sentinel',
        findEntry: () => ({}),
        resolvePolicyForWrap: () => ({}),
        groundSession: async () => ({ ok: true }),
        hostname: () => 'machine',
        randomUUID: () => RUNTIME_GENERATION,
        registerGitHubSessionProjection: async () => true,
        postHeartbeat: async (options) => {
          terminalCalls.push(options);
          return true;
        },
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(result.code, 1);
    assert.equal(terminalCalls.length, 1);
    assert.equal(terminalCalls[0].maxAttempts, 1);
    assert.equal(terminalCalls[0].payload.presence_state, 'terminal');
    assert.equal(terminalCalls[0].payload.runtime_generation, RUNTIME_GENERATION);
    assert.equal(terminalCalls[0].payload.coding_session_id, 'sess_launch_fail');
    assert.equal(JSON.stringify(terminalCalls[0].payload).includes('memoro-secret-sentinel'), false);
    assert.equal('last_assistant_excerpt' in terminalCalls[0].payload, false);
    assert.match(streams.err(), /broker launch failed/);
  });

  test('reconciles an accepted live launch after transport timeout without terminalizing it', async () => {
    const streams = makeStreams();
    const terminalCalls = [];
    const abortCalls = [];
    let requestCount = 0;
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_transport_live',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async (message) => {
        requestCount += 1;
        if (message.type === 'launch_session') throw new Error('broker request timed out after 1000ms');
        assert.deepEqual(message, {
          type: 'session_status',
          id: 'sess_transport_live',
        });
        return {
          ok: true,
          session: {
            id: 'sess_transport_live',
            runtime_generation: RUNTIME_GENERATION,
            session_state: 'live',
            attachable: true,
          },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({ remoteUrl: 'https://github.com/acme/widgets.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'memoro-secret-sentinel',
        hostname: () => 'machine',
        randomUUID: () => RUNTIME_GENERATION,
        registerGitHubSessionProjection: async () => true,
        postHeartbeat: async (options) => { terminalCalls.push(options); return true; },
        abortManagedCredentialDomain: (input) => abortCalls.push(input),
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(result.code, 0, streams.err());
    assert.equal(requestCount, 2);
    assert.deepEqual(terminalCalls, []);
    assert.deepEqual(abortCalls, []);
    assert.doesNotMatch(streams.err(), /outcome is unknown|broker launch failed/);
  });

  test('waits through transient absence before recovering the exact accepted launch', async () => {
    const streams = makeStreams();
    const terminalCalls = [];
    const sleeps = [];
    const requestTypes = [];
    let statusReads = 0;
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_transport_delayed',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async (message) => {
        requestTypes.push(message.type);
        if (message.type === 'launch_session') {
          throw new Error('broker request timed out after 10000ms');
        }
        statusReads += 1;
        if (statusReads === 1) {
          return { ok: false, reason: 'session-not-found' };
        }
        if (statusReads === 2) {
          throw new Error('broker status temporarily unavailable');
        }
        return {
          ok: true,
          session: {
            id: 'sess_transport_delayed',
            runtime_generation: RUNTIME_GENERATION,
            session_state: 'live',
            attachable: true,
          },
        };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({ remoteUrl: 'https://github.com/acme/widgets.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'memoro-secret-sentinel',
        hostname: () => 'machine',
        randomUUID: () => RUNTIME_GENERATION,
        registerGitHubSessionProjection: async () => true,
        postHeartbeat: async (options) => { terminalCalls.push(options); return true; },
        ambiguousBrokerReconcileDelaysMs: [0, 25, 75],
        sleep: async (delayMs) => { sleeps.push(delayMs); },
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(result.code, 0, streams.err());
    assert.deepEqual(requestTypes, [
      'launch_session',
      'session_status',
      'session_status',
      'session_status',
    ]);
    assert.deepEqual(sleeps, [25, 75]);
    assert.deepEqual(terminalCalls, []);
    assert.doesNotMatch(streams.err(), /outcome is unknown|broker launch failed/);
  });

  test('fails closed without terminalizing when an ambiguous launch remains absent', async () => {
    const streams = makeStreams();
    const terminalCalls = [];
    let registrations = 0;
    let requestCount = 0;
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_transport_unknown',
      tool: 'codex',
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async (message) => {
        requestCount += 1;
        if (message.type === 'launch_session') {
          throw new Error('broker transport unavailable');
        }
        assert.equal(message.type, 'session_status');
        return { ok: false, reason: 'session-not-found' };
      },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'https://github.com/acme/widgets.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'memoro-secret-sentinel',
        hostname: () => 'machine',
        randomUUID: () => RUNTIME_GENERATION,
        registerGitHubSessionProjection: async () => {
          registrations += 1;
          return true;
        },
        postHeartbeat: async (options) => {
          terminalCalls.push(options);
          return true;
        },
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        readRepoPolicyConfig: () => ({ config: {}, warnings: [] }),
        readRepoLocalConfig: () => ({ config: {}, warnings: [] }),
        resolveEffectiveConfig: ({ globalConfig }) => globalConfig,
        prepareCloudflareGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        ambiguousBrokerReconcileDelaysMs: [0],
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(result.code, 1);
    assert.equal(result.reason, 'broker-launch-unknown');
    assert.equal(requestCount, 2, 'one launch request and one exact-generation status read');
    assert.equal(registrations, 1);
    assert.deepEqual(terminalCalls, []);
    assert.match(streams.err(), /outcome is unknown/);
    assert.doesNotMatch(streams.err(), /memoro-secret-sentinel/);
  });

  test('fails closed before child launch when the session gh boundary cannot be installed', async () => {
    const streams = makeStreams();
    let launches = 0;
    const res = await launchBrokerOwnedSession({
      cwd: '/repo',
      tool: 'claude',
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', PATH: '/bin' },
      request: async () => { launches += 1; return { ok: true }; },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      attach: async () => 0,
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({ remoteUrl: 'git@example.com:acme/widgets.git', branch: 'main', toplevel: '/repo' }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => 'tok',
        groundSession: async () => ({ ok: true }),
        hostname: () => 'machine',
        lookupOrMint: async () => 'sess_boundary1',
        prepareGitHubSessionForLaunch: async () => { throw new Error('filesystem unavailable'); },
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        getPackageVersion: async () => '0.test',
      },
    });

    assert.equal(res.code, 1);
    assert.equal(launches, 0);
    assert.match(streams.err(), /failed to install GitHub session boundary/);
    assert.doesNotMatch(streams.err(), /token|gh auth login/i);
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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

  test('fails closed when a successful launch response has the wrong runtime generation', async () => {
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
      request: async (message) => {
        if (message.type === 'launch_session') {
          return {
            ok: true,
            reused: true,
            session: {
              id: message.session.id,
              runtime_generation: 'd5e6439f-54e2-493b-a10f-5e5e014a2904',
              cwd: message.session.cwd,
            },
          };
        }
        assert.equal(message.type, 'session_status');
        return {
          ok: true,
          session: {
            id: 'sess_new',
            runtime_generation: 'd5e6439f-54e2-493b-a10f-5e5e014a2904',
            session_state: 'live',
            attachable: true,
          },
        };
      },
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

    assert.equal(res.code, 1);
    assert.equal(res.reason, 'broker-launch-unknown');
    assert.equal(attached, null);
    assert.equal(launched, null);
    assert.equal(streams.out(), '');
    assert.match(streams.err(), /outcome is unknown/);
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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

  test('routes Claude handoff as one acknowledged user turn, never a system-prompt argument', async () => {
    const streams = makeStreams();
    const requests = [];
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const controllerCapability = 'c'.repeat(64);
    const result = await launchBrokerOwnedSession({
      cwd: '/repo',
      codingSessionId: 'sess_claude_handoff',
      sessionName: 'claude-handoff',
      tool: 'claude',
      handoffUserMessage: 'bounded handoff',
      handoffTransaction: {
        transaction_id: transactionId,
        controller_capability: controllerCapability,
      },
      attachAfterLaunch: false,
      stdout: streams.stdout,
      stderr: streams.stderr,
      env: { TERM: 'xterm-256color', MEMORO_TOKEN: 'tok' },
      ensureBroker: async () => ({ ok: true, broker: { pid: 42 } }),
      ensureCloudBroker: async () => ({ ok: true }),
      request: async (message, options) => {
        requests.push({ message, options });
        return {
          ok: true,
          handoff_delivery: 'confirmed',
          session: {
            id: message.session.id,
            runtime_generation: message.session.runtime_generation,
          },
        };
      },
      deps: {
        useSessionHost: false,
        getRepoContext: async () => ({
          remoteUrl: 'git@example.com:org/repo.git',
          branch: 'main',
          toplevel: '/repo',
        }),
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => null,
        getSecret: async () => assert.fail('env token should avoid keychain lookup'),
        findEntry: () => ({}),
        resolvePolicyForWrap: () => ({}),
        hostname: () => 'machine',
        getPackageVersion: async () => '0.test',
        groundSession: async () => assert.fail('switch must not fetch ordinary transcript grounding'),
        ensureCoordinatorSlashCommand: async () => {},
        installUpdateCommand: async () => {},
        prepareLocalResourceGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
        prepareDevCommandGuardEnv: ({ baseEnv }) => ({ env: baseEnv }),
      },
    });

    assert.equal(result.code, 0);
    const launch = requests[0];
    assert.equal(launch.message.type, 'launch_session');
    assert.equal(launch.message.session.launch_options.startupMessage, null);
    assert.equal(
      launch.message.session.launch_options.handoffUserMessage,
      'bounded handoff',
    );
    assert.deepEqual(launch.message.session.handoff_transaction, {
      transaction_id: transactionId,
      controller_capability: controllerCapability,
    });
    assert.equal(launch.message.session.sidecars.toolSessionId, null);
    assert.equal(launch.message.session.sidecars.transcriptPath, null);
    assert.equal(launch.message.session.sidecars.transcriptAccess, false);
    assert.equal(launch.message.session.sidecars.upload, false);
    assert.doesNotMatch(
      JSON.stringify(launch.message.session.sidecars),
      /claude-source-native-id|claude-source-transcript/,
    );
    assert.equal(launch.options.timeoutMs, 60_000);
    assert.doesNotMatch(
      JSON.stringify(launch.message.session.argv),
      /bounded handoff|append-system-prompt/,
    );
    assert.doesNotMatch(
      JSON.stringify(launch.message.session.env),
      new RegExp(controllerCapability),
    );
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
      request: async (message) => ({
        ok: true,
        session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
      }),
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
        return {
          ok: true,
          session: { id: message.session.id, runtime_generation: message.session.runtime_generation },
        };
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
      request: async () => ({
        ok: true,
        broker: {
          pid: 1,
          protocol_version: BROKER_PROTOCOL_VERSION,
          runtime_identity: BROKER_RUNTIME_IDENTITY,
        },
      }),
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
    assert.equal(res.reason, 'broker-protocol-incompatible-live');
    assert.match(res.error, /incompatible/);
    assert.deepEqual(res.live_sessions, [{
      id: 'sess_live',
      name: null,
      cwd: '/repo',
      tool: 'codex',
    }]);
    assert.equal(spawned, false);
  });

  test('does not launch through an older compatible-looking broker with live PTYs', async () => {
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => ({
        ok: true,
        broker: { pid: 1, protocol_version: 'mc-broker-pty-v3' },
        sessions: [{ id: 'sess_legacy_live', session_state: 'live', cwd: '/repo', tool: 'codex' }],
      }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'broker-protocol-incompatible-live');
    assert.equal(res.compatibility_reason, 'protocol_mismatch:mc-broker-pty-v3');
    assert.equal(spawned, false);
    assert.match(res.error, /mc restart/);
  });

  test('does not reuse a same-protocol broker with a different runtime closure', async () => {
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => ({
        ok: true,
        broker: {
          pid: 1,
          protocol_version: BROKER_PROTOCOL_VERSION,
          runtime_identity: 'mc-broker-runtime-identity-v1:'.concat('0'.repeat(64)),
        },
        sessions: [{
          id: 'sess_stale_runtime',
          session_state: 'live',
          cwd: '/repo',
          tool: 'codex',
        }],
      }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'broker-protocol-incompatible-live');
    assert.equal(res.compatibility_reason, 'runtime_identity_mismatch');
    assert.equal(spawned, false);
  });

  test('restarts a stale broker when no live sessions are present', async () => {
    const seen = [];
    let spawned = false;
    const responses = [
      { ok: true, broker: { pid: 1 }, sessions: [] },
      { ok: true, stopping: true },
      null,
      {
        ok: true,
        broker: {
          pid: 2,
          protocol_version: BROKER_PROTOCOL_VERSION,
          runtime_identity: BROKER_RUNTIME_IDENTITY,
        },
      },
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
        return {
          ok: true,
          broker: {
            pid: 2,
            protocol_version: BROKER_PROTOCOL_VERSION,
            runtime_identity: BROKER_RUNTIME_IDENTITY,
          },
        };
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

  test('refuses an incompatible broker discovered after a spawn attempt', async () => {
    let spawned = false;
    const res = await ensureBrokerRunning({
      request: async () => {
        if (!spawned) throw new Error('offline');
        return {
          ok: true,
          broker: { pid: 2, protocol_version: 'mc-broker-pty-v3' },
          sessions: [{ id: 'sess_legacy', session_state: 'live' }],
        };
      },
      spawnDaemon: () => { spawned = true; return { ok: true, pid: 2 }; },
      sleep: async () => {},
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'broker-protocol-incompatible-live');
    assert.match(res.error, /refusing|mc restart/);
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

test('a refused certified launch names repair and exact retry without fallback', () => {
  // The session and its worktree already exist when the boundary is refused,
  // so the user must never be left without a next step.
  const remedy = managedBoundaryRemedy({
    sessionName: 'mc-test-claude',
    codingSessionId: 'sess_abcdef',
  });
  assert.match(remedy, /mc auth status/);
  assert.match(remedy, /mc open mc-test-claude/);
  assert.match(remedy, /No fallback launch was attempted/);

  // Falls back through label to the coding session id, and never renders an
  // empty or undefined target.
  assert.match(
    managedBoundaryRemedy({ label: 'from-label', codingSessionId: 'sess_abcdef' }),
    /mc open from-label/,
  );
  assert.match(
    managedBoundaryRemedy({ codingSessionId: 'sess_abcdef' }),
    /mc open sess_abcdef/,
  );
  for (const input of [{}, { sessionName: '   ' }, { sessionName: null, label: '' }]) {
    const fallback = managedBoundaryRemedy(input);
    assert.match(fallback, /mc auth status/);
    assert.match(fallback, /No fallback launch was attempted/);
    assert.doesNotMatch(fallback, /undefined|null/);
  }
});
