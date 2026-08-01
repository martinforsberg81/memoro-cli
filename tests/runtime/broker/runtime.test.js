import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { BrokerRuntime } from '../../../src/runtime/broker/runtime.js';
import { mcHome } from '../../../src/mc/paths.js';
import { authenticateHandoffSwitchJournal } from '../../../src/runtime/broker/handoff-switch-journal.js';
import {
  deriveHandoffControllerCapability,
  deriveHandoffControllerRoot,
  handoffControllerCapabilityDigest,
} from '../../../src/mc/handoff-controller-capability.js';

const handoffControllerCapability = 'c'.repeat(64);
const handoffControllerDigest = handoffControllerCapabilityDigest(
  handoffControllerCapability,
);
const sessionControllerCapability = 'b'.repeat(64);
const testControllerToken = 'test-runtime-controller-token';

function authenticatedJournal(journal, controllerRoot) {
  const unsigned = { ...journal };
  delete unsigned.authentication_digest;
  return {
    ...unsigned,
    authentication_digest: authenticateHandoffSwitchJournal(
      unsigned,
      controllerRoot,
    ),
  };
}

function makeFakePtyFactory({ exitOnExitSubscription = null, throwOnSpawn = false } = {}) {
  const ptys = [];
  const calls = [];
  const factory = {
    spawn(bin, args, options) {
      if (throwOnSpawn) throw new Error('fixture-spawn-failed');
      let dataHandler = null;
      let exitHandler = null;
      const pty = {
        pid: 9100 + ptys.length,
        writes: [],
        resizes: [],
        kills: [],
        onData(handler) { dataHandler = handler; },
        onExit(handler) {
          exitHandler = handler;
          if (exitOnExitSubscription) handler(exitOnExitSubscription);
        },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push({ cols, rows }); },
        kill(signal) { this.kills.push(signal); },
        emitData(data) { dataHandler?.(data); },
        emitExit(event) { exitHandler?.(event); },
      };
      calls.push({ bin, args, options });
      ptys.push(pty);
      return pty;
    },
  };
  return { factory, calls, ptys };
}

function makeLaunchResolver({ ok = true } = {}) {
  const calls = [];
  return {
    calls,
    resolve(toolInput) {
      calls.push(toolInput);
      if (!ok) {
        return { ok: false, reason: 'missing-bin', hint: `missing ${toolInput}` };
      }
      return {
        ok: true,
        id: 'claude-code',
        shortName: 'claude',
        spec: {
          bin: 'claude',
          args: (argv = []) => ['--wrapped', ...argv],
        },
      };
    },
  };
}

function makeRuntime(opts = {}) {
  const fake = makeFakePtyFactory(opts.pty || {});
  const resolver = makeLaunchResolver(opts.launch || {});
  const sidecars = [];
  const lifecycleWrites = [];
  const managedReceiptWrites = [];
  const interlock = opts.c1Interlock || makeInterlockFixture();
  let now = 1_000;
  const runtime = new BrokerRuntime({
    ptyFactory: fake.factory,
    launchResolver: resolver.resolve.bind(resolver),
    env: { BASE: '1', MC_GROUNDING_TOOL: 'codex' },
    cwd: () => '/fallback',
    clock: () => now,
    managedProviderResolver: opts.managedProviderResolver,
    credentialDomainCloser: opts.credentialDomainCloser,
    managedGenerationInspector: opts.managedGenerationInspector
      || (({
        codingSessionId,
        runtimeGeneration,
        credentialDomain,
        transaction,
      }) => ({
        kind: 'present',
        phase: 'domain-ready',
        terminal: false,
        intent: {
          sequence: transaction.sequence,
          intent_digest: transaction.intent_digest,
        },
        receipts: {
          'domain-ready': {
            data: {
              domain_generation: credentialDomain.generation,
              manifest_digest: credentialDomain.manifest_sha256,
            },
          },
        },
        coding_session_id: codingSessionId,
        runtime_generation: runtimeGeneration,
      })),
    managedReceiptWriter: opts.managedReceiptWriter || ((receipt) => {
      managedReceiptWrites.push(receipt);
      return { ok: true, receipt };
    }),
    providerArtifactContextBuilder: opts.providerArtifactContextBuilder || (({
      tool,
      provider,
    }) => ({
      schema: 'mc-test-provider-artifact-context/v1',
      custody: provider?.descriptor ? 'managed' : 'native-compat',
      tool,
      adapter_context: {},
    })),
    providerArtifactObserver: opts.providerArtifactObserver || (() => ({
      ok: false,
      reason: 'test-provider-artifact-not-observed',
    })),
    providerArtifactValidator: opts.providerArtifactValidator || (() => ({
      ok: false,
      reason: 'test-provider-artifact-not-configured',
    })),
    lifecycleWriter: (record) => {
      lifecycleWrites.push(record);
      return record;
    },
    handoffSwitchReader: opts.handoffSwitchReader,
    handoffSwitchBegin: opts.handoffSwitchBegin,
    handoffSwitchAdvance: opts.handoffSwitchAdvance,
    controllerBindings: opts.controllerBindings,
    c1Runner: opts.c1Runner,
    c1CertificationWriter: opts.c1CertificationWriter || (() => ({ ok: true })),
    c1Interlock: interlock,
    sidecarFactory: opts.sidecarFactory || ((spec) => {
      const sidecar = {
        spec,
        started: false,
        stopped: false,
        stopOptions: null,
        start() { this.started = true; },
        stop(options) {
          this.stopped = true;
          this.stopOptions = options;
        },
        currentProjection() {
          return {
            contract_version: 'mc-session-projection-v1',
            status: 'active',
            reason_code: 'recent_output',
            observed_at: '2026-07-21T08:00:00.000Z',
            classifier_version: 'mc-session-projector-v1',
            classification_basis: 'runtime_fallback',
            runtime: null,
            git: null,
          };
        },
      };
      sidecars.push(sidecar);
      return sidecar;
    }),
  });
  const controllerCapabilities = new Map();
  const rawHandle = runtime.handle.bind(runtime);
  runtime.handle = (message) => {
    if (message?.type === 'run_claude_c1') return rawHandle(message);
    if (message?.type === 'launch_session' && message.session) {
      const id = message.session.id;
      const supplied = message.session.session_controller_capability;
      const hasExplicitCapability = Object.hasOwn(
        message.session,
        'session_controller_capability',
      );
      const session = message.session;
      const capability = hasExplicitCapability
        ? supplied
        : deriveHandoffControllerRoot({
            token: testControllerToken,
            codingSessionId: id,
          }) || controllerCapabilities.get(id) || sessionControllerCapability;
      if (capability) {
        controllerCapabilities.set(id, capability);
        if (!hasExplicitCapability && !session.credential_domain) {
          runtime.handoffControllerRoots.set(id, capability);
        }
      }
      return rawHandle({
        ...message,
        session: {
          ...session,
          session_controller_capability: capability,
        },
      });
    }
    if (message && !Object.hasOwn(message, 'session_controller_capability')) {
      return rawHandle({
        ...message,
        session_controller_capability: controllerCapabilities.get(message.id)
          || sessionControllerCapability,
      });
    }
    return rawHandle(message);
  };
  const rawAttachConnection = runtime.attachConnection.bind(runtime);
  runtime.attachConnection = (message, ...args) => rawAttachConnection(
    Object.hasOwn(message || {}, 'session_controller_capability')
      ? message
      : {
          ...message,
          session_controller_capability: controllerCapabilities.get(
            message?.id || message?.session_id,
          ) || sessionControllerCapability,
        },
    ...args,
  );
  return {
    runtime,
    fake,
    resolver,
    sidecars,
    lifecycleWrites,
    managedReceiptWrites,
    tick(ms = 1) {
      now += ms;
      return now;
    },
  };
}

function makeInterlockFixture() {
  const providers = new Set();
  let c1 = false;
  return {
    acquireProvider() {
      if (c1) return { ok: false, reason: 'c1-global-lock-active' };
      const marker = Symbol('provider');
      providers.add(marker);
      return {
        ok: true,
        lease: {
          release() {
            providers.delete(marker);
            return { ok: true };
          },
        },
      };
    },
    acquireC1() {
      if (c1 || providers.size) return { ok: false, reason: 'provider-marker-active' };
      c1 = true;
      return {
        ok: true,
        lease: {
          release() {
            c1 = false;
            return { ok: true };
          },
        },
      };
    },
  };
}

function makeConn() {
  const writes = [];
  return {
    writes,
    handlers: new Map(),
    write(data) { writes.push(String(data)); },
    end() {
      this.ended = true;
      this.handlers.get('end')?.();
    },
    on(event, handler) { this.handlers.set(event, handler); },
    off(event, handler) {
      if (this.handlers.get(event) === handler) this.handlers.delete(event);
    },
    emit(event, value) { this.handlers.get(event)?.(value); },
  };
}

function markSessionC1Eligible(runtime, sessionId) {
  const session = runtime.manager.get(sessionId);
  assert.ok(session, `missing C1 fixture session ${sessionId}`);
  runtime.c1ProviderBoundariesBySession.set(session, Object.freeze({
    schema: 'mc-managed-credential-boundary-evidence-v1',
    provider_adapter: 'codex-managed-local-v1',
    boundary_profile: 'mc-managed-portable',
    session_id: sessionId,
    generation: '11111111-1111-4111-8111-111111111111',
    launch_nonce: 'n'.repeat(43),
    release_digest: 'a'.repeat(64),
    policy_digest: 'b'.repeat(64),
    manifest_digest: 'c'.repeat(64),
    c1_eligible: true,
  }));
}

function managedC1Descriptor(sessionId) {
  return {
    schema: 'mc-local-codex-credential-domain/v1',
    provider_adapter: 'codex-managed-local-v1',
    profile: 'mc-managed-portable',
    session_id: sessionId,
    generation: '22222222-2222-4222-8222-222222222222',
    launch_nonce: 'm'.repeat(43),
    native_binary_sha256: 'd'.repeat(64),
    provider_config_sha256: 'e'.repeat(64),
    manifest_sha256: 'f'.repeat(64),
  };
}

const MANAGED_RUNTIME_GENERATION = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const NEXT_MANAGED_RUNTIME_GENERATION = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';

function managedDescriptor(sessionId, overrides = {}) {
  return {
    schema: 'mc-local-codex-credential-domain/v1',
    session_id: sessionId,
    generation: '22222222-2222-4222-8222-222222222222',
    manifest_sha256: 'f'.repeat(64),
    ...overrides,
  };
}

function managedTransaction(sessionId, runtimeGeneration = MANAGED_RUNTIME_GENERATION) {
  return {
    schema: 'mc-managed-generation-transaction',
    version: 1,
    sequence: runtimeGeneration === MANAGED_RUNTIME_GENERATION ? 1 : 2,
    coding_session_id: sessionId,
    runtime_generation: runtimeGeneration,
    intent_digest: createHash('sha256')
      .update(`${sessionId}:${runtimeGeneration}`)
      .digest('hex'),
  };
}

function managedLaunchSession({
  id,
  descriptor,
  runtimeGeneration = MANAGED_RUNTIME_GENERATION,
  ...session
}) {
  return {
    id,
    runtime_generation: runtimeGeneration,
    credential_domain: descriptor,
    managed_transaction: managedTransaction(id, runtimeGeneration),
    sidecars: { enabled: false },
    ...session,
  };
}

describe('BrokerRuntime', () => {
  test('run_claude_c1 is exact, host-bound, generation-bound, and status-only', async () => {
    const sessionId = 'sess_c1bound';
    const runtimeGeneration = '6b7e85d9-b14a-4c17-baf9-7181bb2becae';
    const controllerRoot = 'a'.repeat(64);
    const seen = [];
    let certificationWrites = 0;
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Runner(context) {
        seen.push(context);
        return { status: 'passed', diagnostic: 'must-not-escape' };
      },
      c1CertificationWriter() {
        certificationWrites += 1;
        return { ok: true };
      },
    });

    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: runtimeGeneration,
        session_controller_capability: controllerRoot,
      },
    }).ok, true);
    markSessionC1Eligible(runtime, sessionId);

    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), {
      ok: false,
      status: 'failed',
    }, 'a live ordinary provider must exit before custody can open');
    assert.equal(seen.length, 0);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), {
      ok: true,
      status: 'passed',
    });
    assert.deepEqual(seen, [{
      session_id: sessionId,
      runtime_generation: runtimeGeneration,
    }]);
    assert.equal(Object.isFrozen(seen[0]), true);
    assert.equal(certificationWrites, 1);

    for (const key of [
      'argv', 'env', 'path', 'secret_id', 'callback', 'tool', 'generation', 'unknown',
    ]) {
      assert.deepEqual(await runtime.handle({
        type: 'run_claude_c1',
        id: sessionId,
        session_controller_capability: controllerRoot,
        [key]: 'attacker-choice',
      }), {
        ok: false,
        status: 'failed',
      }, key);
    }
    assert.equal(seen.length, 1);
  });

  test('run_claude_c1 fails closed for missing, wrong, or incomplete host authority', async () => {
    const sessionId = 'sess_c1closed';
    const runtimeGeneration = 'b00ec72e-f8e5-4608-b4c0-ddd2a27ff0f4';
    const controllerRoot = 'd'.repeat(64);
    let calls = 0;
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Runner() { calls += 1; return { status: 'passed' }; },
    });

    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: runtimeGeneration,
        session_controller_capability: controllerRoot,
      },
    }).ok, true);
    markSessionC1Eligible(runtime, sessionId);
    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: 'e'.repeat(64),
    }), { ok: false, status: 'failed' });
    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      id: 'sess_c1wrong',
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
    }), { ok: false, status: 'failed' });
    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    runtime.handoffControllerRoots.set(sessionId, 'e'.repeat(64));
    assert.deepEqual(runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    assert.equal(calls, 0);

    const withoutRunner = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: 'sess_c1norun',
        session_controller_capability: controllerRoot,
      }],
    }).runtime;
    assert.deepEqual(withoutRunner.handle({
      type: 'run_claude_c1',
      id: 'sess_c1norun',
      session_controller_capability: controllerRoot,
    }), {
      ok: false,
      status: 'failed',
    });
  });

  test('run_claude_c1 allows only the three public status values', async () => {
    const sessionId = 'sess_c1status';
    const controllerRoot = 'f'.repeat(64);
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Runner: async () => ({ status: 'indeterminate', raw_output: 'not-public' }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: 'adf7a8f0-2a05-4d59-b2f6-30d95314a78d',
        session_controller_capability: controllerRoot,
      },
    }).ok, true);
    markSessionC1Eligible(runtime, sessionId);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), {
      ok: false,
      status: 'indeterminate',
    });
  });

  test('run_claude_c1 never opens custody before terminal cleanup is confirmed', async () => {
    const sessionId = 'sess_c1cleanup';
    const controllerRoot = '1'.repeat(64);
    let calls = 0;
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Runner() {
        calls += 1;
        return { status: 'passed' };
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: '28989230-bfa0-4a63-894f-f4464e0804e0',
        session_controller_capability: controllerRoot,
      },
    }).ok, true);
    markSessionC1Eligible(runtime, sessionId);
    const ownedSession = runtime.manager.get(sessionId);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    runtime.exitFinalizationsBySession.set(
      ownedSession,
      Promise.resolve({ ok: false, reason: 'fixture-cleanup-unconfirmed' }),
    );

    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    assert.equal(calls, 0);
  });

  test('run_claude_c1 reserves the dead session until custody teardown completes', async () => {
    const sessionId = 'sess_c1lease';
    const controllerRoot = '2'.repeat(64);
    let resolveRunner;
    let calls = 0;
    const runnerResult = new Promise((resolve) => { resolveRunner = resolve; });
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Runner() {
        calls += 1;
        return runnerResult;
      },
    });
    const launch = {
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: 'f8a23aa8-7544-4c02-9db6-ed185048180e',
        session_controller_capability: controllerRoot,
      },
    };
    assert.equal(runtime.handle(launch).ok, true);
    markSessionC1Eligible(runtime, sessionId);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    const running = runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' }, 'parallel custody lease must be refused');
    assert.deepEqual(runtime.handle(launch), {
      ok: false,
      reason: 'c1-security-check-in-progress',
      error: 'a C1 credential-boundary check owns this session',
    }, 'the next provider must not start while custody is open');
    assert.deepEqual(await runtime.handle({
      type: 'remove_session',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), {
      ok: false,
      removed: false,
      reason: 'c1-security-check-in-progress',
      error: 'a C1 credential-boundary check owns this session',
    }, 'session removal must not make broker shutdown possible during custody');

    resolveRunner({ status: 'passed' });
    assert.deepEqual(await running, { ok: true, status: 'passed' });
    assert.equal(runtime.handle(launch).ok, true, 'launch may resume only after runner teardown');
  });

  test('launch_session resolves the tool locally and creates an owned PTY session', () => {
    const { runtime, fake, resolver } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/repo/a',
        tool: 'claude',
        argv: ['--resume'],
        cols: 120,
        rows: 32,
        env: { EXTRA: '2' },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.session.id, 'sess_a');
    assert.equal(res.session.name, 'alpha');
    assert.equal(res.session.tool, 'claude');
    assert.equal(res.session.pty_pid, 9100);
    assert.deepEqual(resolver.calls, ['claude']);
    assert.deepEqual(fake.calls[0].args, ['--wrapped', '--resume']);
    assert.equal(fake.calls[0].options.cwd, '/repo/a');
    assert.equal(fake.calls[0].options.cols, 120);
    assert.equal(fake.calls[0].options.rows, 32);
    assert.equal(fake.calls[0].options.env.BASE, '1');
    assert.equal(fake.calls[0].options.env.EXTRA, '2');
    assert.equal(fake.calls[0].options.env.MEMORO_MC_BROKER, '1');
    assert.equal(fake.calls[0].options.env.MEMORO_MC_PARENT, '1');
  });

  test('launch_session reuses an existing live session for the same cwd', () => {
    const { runtime, fake } = makeRuntime();

    const first = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/repo/a',
        tool: 'codex',
      },
    });
    const second = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_b',
        name: 'alpha',
        cwd: '/repo/a/',
        tool: 'claude',
      },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.session.id, 'sess_a');
    assert.equal(second.session.cwd, '/repo/a');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(runtime.handle({ type: 'sessions' }).sessions.map((s) => s.id), ['sess_a']);
  });

  test('launch_session defaults tool, cwd, terminal size, and argv', () => {
    const { runtime, fake, resolver } = makeRuntime();

    const res = runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.equal(res.ok, true);
    assert.deepEqual(resolver.calls, ['codex']);
    assert.equal(fake.calls[0].options.cwd, '/fallback');
    assert.equal(fake.calls[0].options.cols, 80);
    assert.equal(fake.calls[0].options.rows, 24);
    assert.deepEqual(fake.calls[0].args, ['--wrapped']);
    assert.match(
      fake.calls[0].options.env.MC_PROVIDER_ARTIFACT_SOCKET,
      /provider-artifact\.sock$/,
    );
    assert.doesNotMatch(
      fake.calls[0].options.env.MC_PROVIDER_ARTIFACT_SOCKET,
      /broker\.sock$/,
    );
  });

  test('launch_session repairs headless terminal env before spawning the PTY', () => {
    const { runtime, fake } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        term_name: 'dumb',
        env: {
          TERM: 'dumb',
          NO_COLOR: '1',
          CLICOLOR: '0',
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(fake.calls[0].options.name, 'xterm-256color');
    assert.equal(fake.calls[0].options.env.TERM, 'xterm-256color');
    assert.equal(fake.calls[0].options.env.NO_COLOR, undefined);
    assert.equal(fake.calls[0].options.env.CLICOLOR, undefined);
    assert.equal(fake.calls[0].options.env.COLORTERM, 'truecolor');
  });

  test('handoff launch binds the target generation and journals delivery before success', async () => {
    const codingSessionId = 'sess_handoff_runtime';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const runtimeGeneration = '9937ac60-46ce-42dd-9302-6533f1c6c38c';
    let journal = {
      transaction_id: transactionId,
      phase: 'target_launch_started',
      target_tool: 'claude-code',
      controller_capability_digest: handoffControllerDigest,
      target_latest_sequence: 2,
      target_message_digest: '7a62bca86c85e878c0682777149684546b6416d5c29cc16851401d4959cf37cf',
      target_runtime_generation: null,
    };
    const advances = [];
    const { runtime, fake } = makeRuntime({
      handoffSwitchReader: () => ({
        kind: 'present',
        journal: authenticatedJournal(journal, root),
      }),
      handoffSwitchAdvance: (input) => {
        advances.push(input);
        assert.equal(journal.phase, input.expectedPhase);
        journal = {
          ...journal,
          ...input.patch,
          phase: input.nextPhase,
        };
        return { ok: true, journal: authenticatedJournal(journal, root) };
      },
    });

    const launching = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        runtime_generation: runtimeGeneration,
        launch_options: { handoffUserMessage: 'bounded handoff' },
        handoff_transaction: {
          transaction_id: transactionId,
          controller_capability: handoffControllerCapability,
        },
      },
    });
    assert.equal(typeof launching?.then, 'function');
    assert.equal(runtime.handle({
      type: 'write_session',
      id: 'sess_handoff_runtime',
      data: 'provider-originated bypass',
    }).reason, 'handoff-delivery-in-progress');
    assert.equal(runtime.handle({
      type: 'dispatch_session',
      id: 'sess_handoff_runtime',
      message: 'provider-originated bypass',
    }).reason, 'handoff-delivery-in-progress');
    runtime.sessionMetadata.get('sess_handoff_runtime').provider_artifact = {
      coding_session_id: 'sess_handoff_runtime',
      runtime_generation: runtimeGeneration,
      tool: 'claude-code',
    };
    runtime.manager.get('sess_handoff_runtime').handoffMessageController.sendNow();
    const result = await launching;

    assert.equal(result.ok, true);
    assert.equal(result.handoff_delivery, 'confirmed');
    assert.equal(advances.length, 2);
    assert.deepEqual(advances[0].patch, {
      target_runtime_generation: runtimeGeneration,
    });
    assert.equal(advances[1].nextPhase, 'delivery_acknowledged');
    assert.deepEqual(fake.calls[0].args, ['--wrapped']);
    assert.deepEqual(fake.ptys[0].writes, ['bounded handoff\r']);
  });

  test('handoff launch rejects message bytes not bound by the journal digest', () => {
    const codingSessionId = 'sess_handoff_wrong_message';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const { runtime, fake } = makeRuntime({
      handoffSwitchReader: () => ({
        kind: 'present',
        journal: authenticatedJournal({
          transaction_id: transactionId,
          phase: 'target_launch_started',
          target_tool: 'codex',
          controller_capability_digest: handoffControllerDigest,
          target_message_digest: 'f'.repeat(64),
        }, root),
      }),
    });
    const unbound = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'codex',
        runtime_generation: '9937ac60-46ce-42dd-9302-6533f1c6c38c',
      },
    });
    assert.equal(unbound.ok, false);
    assert.equal(unbound.reason, 'handoff-transaction-required');
    const result = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'codex',
        runtime_generation: '9937ac60-46ce-42dd-9302-6533f1c6c38c',
        launch_options: { handoffUserMessage: 'attacker-selected message' },
        handoff_transaction: {
          transaction_id: transactionId,
          controller_capability: handoffControllerCapability,
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'handoff-target-launch-unbound');
    assert.equal(fake.calls.length, 0);
  });

  test('handoff delivery is not acknowledged before the exact target artifact exists', async () => {
    const codingSessionId = 'sess_handoff_missing_artifact';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const runtimeGeneration = '9937ac60-46ce-42dd-9302-6533f1c6c38c';
    let journal = {
      transaction_id: transactionId,
      phase: 'target_launch_started',
      target_tool: 'claude-code',
      controller_capability_digest: handoffControllerDigest,
      target_message_digest: '7a62bca86c85e878c0682777149684546b6416d5c29cc16851401d4959cf37cf',
      target_runtime_generation: null,
    };
    const { runtime, fake } = makeRuntime({
      handoffSwitchReader: () => ({
        kind: 'present',
        journal: authenticatedJournal(journal, root),
      }),
      handoffSwitchAdvance: (input) => {
        journal = {
          ...journal,
          ...input.patch,
          phase: input.nextPhase,
        };
        return { ok: true, journal: authenticatedJournal(journal, root) };
      },
    });

    const launching = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        runtime_generation: runtimeGeneration,
        launch_options: { handoffUserMessage: 'bounded handoff' },
        handoff_transaction: {
          transaction_id: transactionId,
          controller_capability: handoffControllerCapability,
        },
      },
    });
    runtime.manager.get(
      codingSessionId,
    ).handoffMessageController.sendNow();
    setImmediate(() => fake.ptys[0].emitExit({ exitCode: 1, signal: 15 }));
    const result = await launching;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'handoff-target-artifact-unconfirmed');
    assert.equal(journal.phase, 'target_launch_started');
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
  });

  test('a provider that publishes its artifact after delivery is still confirmed', async () => {
    // Claude Code cannot be observed on the filesystem — its artifact adapter
    // says so outright — so it publishes only from its own SessionStart hook,
    // which lands after the handoff message. Demanding the artifact at the
    // exact delivery boundary made every switch to Claude fail closed.
    const codingSessionId = 'sess_handoff_late_artifact';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const runtimeGeneration = '9937ac60-46ce-42dd-9302-6533f1c6c38c';
    let journal = {
      transaction_id: transactionId,
      phase: 'target_launch_started',
      target_tool: 'claude-code',
      controller_capability_digest: handoffControllerDigest,
      target_message_digest: '7a62bca86c85e878c0682777149684546b6416d5c29cc16851401d4959cf37cf',
      target_runtime_generation: null,
    };
    const { runtime } = makeRuntime({
      handoffSwitchReader: () => ({
        kind: 'present',
        journal: authenticatedJournal(journal, root),
      }),
      handoffSwitchAdvance: (input) => {
        journal = { ...journal, ...input.patch, phase: input.nextPhase };
        return { ok: true, journal: authenticatedJournal(journal, root) };
      },
    });

    const launching = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        runtime_generation: runtimeGeneration,
        launch_options: { handoffUserMessage: 'bounded handoff' },
        handoff_transaction: {
          transaction_id: transactionId,
          controller_capability: handoffControllerCapability,
        },
      },
    });
    runtime.manager.get(codingSessionId).handoffMessageController.sendNow();
    // The hook publishes only after the delivery boundary has already passed.
    setTimeout(() => {
      runtime.sessionMetadata.get(codingSessionId).provider_artifact = {
        coding_session_id: codingSessionId,
        runtime_generation: runtimeGeneration,
        tool: 'claude-code',
      };
    }, 400);

    const result = await launching;
    assert.equal(result.ok, true, 'a late provider artifact must still confirm delivery');
    assert.equal(result.handoff_delivery, 'confirmed');
    assert.equal(journal.phase, 'delivery_acknowledged');
  });

  test('handoff journal mutation requires controller authority never inherited by the provider', () => {
    const codingSessionId = 'sess_handoff_authority';
    const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
    const root = deriveHandoffControllerRoot({
      token: 'memoro-controller-token-canary',
      codingSessionId,
    });
    const capability = deriveHandoffControllerCapability({ root, transactionId });
    const journal = authenticatedJournal({
      transaction_id: transactionId,
      controller_capability_digest: handoffControllerCapabilityDigest(capability),
    }, root);
    let begun = 0;
    let advanced = 0;
    let journalVisible = false;
    let providerInput = null;
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        session_id: codingSessionId,
        session_controller_capability: root,
      }],
      handoffSwitchBegin: ({ journal: received }) => {
        begun += 1;
        return { ok: true, duplicate: false, journal: received };
      },
      handoffSwitchReader: () => journalVisible
        ? { kind: 'present', journal }
        : { kind: 'absent' },
      handoffSwitchAdvance: () => {
        advanced += 1;
        return { ok: true, duplicate: false, journal };
      },
      managedProviderResolver: ({ launch, input }) => {
        providerInput = input;
        return {
          ok: true,
          launch,
          environmentMode: 'inherit',
          env: input.env || {},
        };
      },
    });
    const launched = runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        session_controller_capability: root,
        sidecars: {
          enabled: false,
          token: 'memoro-controller-token-canary',
        },
      },
    });
    assert.equal(launched.ok, true);
    journalVisible = true;
    assert.equal(
      JSON.stringify(fake.calls[0].options.env).includes('memoro-controller-token-canary'),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(providerInput),
      /memoro-controller-token-canary/,
    );
    assert.equal(Object.hasOwn(providerInput, 'sidecars'), false);

    const denied = runtime.handle({
      type: 'handoff_switch_begin',
      id: codingSessionId,
      journal,
      controller_capability: 'a'.repeat(64),
    });
    assert.deepEqual(denied, {
      ok: false,
      reason: 'handoff-controller-capability-invalid',
    });
    assert.equal(begun, 0);

    const accepted = runtime.handle({
      type: 'handoff_switch_begin',
      id: codingSessionId,
      journal,
      controller_capability: capability,
    });
    assert.equal(accepted.ok, true);
    assert.equal(begun, 1);

    const mutationDenied = runtime.handle({
      type: 'handoff_switch_advance',
      id: codingSessionId,
      transaction_id: transactionId,
      controller_capability: 'a'.repeat(64),
      expected_phase: 'prepared',
      next_phase: 'source_terminal_confirmed',
      updated_at: '2026-07-28T12:00:00.000Z',
    });
    assert.deepEqual(mutationDenied, {
      ok: false,
      reason: 'handoff-controller-capability-invalid',
    });
    assert.equal(advanced, 0);
  });

  test('provider-originated controller socket calls cannot read or control PTY state', () => {
    let providerInput = null;
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => {
        providerInput = input;
        return {
          ok: true,
          launch,
          environmentMode: 'inherit',
          env: input.env || {},
        };
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_controller_boundary',
        tool: 'claude',
      },
    }).ok, true);
    fake.ptys[0].emitData('private-pty-output-canary');
    assert.doesNotMatch(
      JSON.stringify(fake.calls[0]),
      new RegExp(sessionControllerCapability),
    );
    assert.equal(
      Object.hasOwn(providerInput, 'session_controller_capability'),
      false,
    );
    assert.equal(Object.hasOwn(providerInput, 'handoff_transaction'), false);
    assert.equal(Object.hasOwn(providerInput, 'sidecars'), false);

    for (const message of [
      {
        type: 'fetch_session_output',
        id: 'sess_controller_boundary',
      },
      {
        type: 'handoff_switch_read',
        id: 'sess_controller_boundary',
      },
      {
        type: 'write_session',
        id: 'sess_controller_boundary',
        data: 'provider-input-canary',
      },
      {
        type: 'dispatch_session',
        id: 'sess_controller_boundary',
        message: 'provider-dispatch-canary',
      },
      {
        type: 'resize_session',
        id: 'sess_controller_boundary',
        cols: 100,
        rows: 40,
      },
      {
        type: 'stop_session',
        id: 'sess_controller_boundary',
      },
      {
        type: 'remove_session',
        id: 'sess_controller_boundary',
      },
    ]) {
      const denied = runtime.handle({
        ...message,
        session_controller_capability: null,
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'session-controller-capability-invalid');
      assert.doesNotMatch(JSON.stringify(denied), /private-pty-output-canary/);
    }
    assert.deepEqual(fake.ptys[0].writes, []);
    assert.deepEqual(fake.ptys[0].kills, []);

    const conn = makeConn();
    runtime.attachConnection({
      type: 'attach_session',
      id: 'sess_controller_boundary',
      session_controller_capability: null,
    }, conn);
    assert.equal(conn.ended, true);
    assert.doesNotMatch(conn.writes.join(''), /private-pty-output-canary/);

    const launchDenied = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_provider_relaunch',
        tool: 'codex',
        session_controller_capability: null,
      },
    });
    assert.equal(launchDenied.reason, 'session-controller-capability-invalid');
    assert.equal(fake.calls.length, 1);
  });

  test('a fresh unbound session cannot choose its own controller root', () => {
    const attackerChosenRoot = 'e'.repeat(64);
    const { runtime, fake } = makeRuntime();

    const denied = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_unbound_controller',
        tool: 'claude',
        session_controller_capability: attackerChosenRoot,
        sidecars: {
          enabled: false,
          token: 'attacker-selected-token',
        },
      },
    });

    assert.deepEqual(denied, {
      ok: false,
      reason: 'session-controller-capability-invalid',
      error: 'broker controller authority is not bound to this session',
    });
    assert.equal(fake.calls.length, 0);
  });

  test('live broker fails closed if its witnessed handoff journal disappears or changes', () => {
    const codingSessionId = 'sess_handoff_witness';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const originalJournal = authenticatedJournal({
      transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
      phase: 'complete',
      controller_root_digest: handoffControllerCapabilityDigest(root),
    }, root);
    let journalResult = { kind: 'present', journal: originalJournal };
    const { runtime, fake } = makeRuntime({
      handoffSwitchReader: () => journalResult,
    });

    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        sidecars: {
          enabled: false,
          token: testControllerToken,
        },
      },
    }).ok, true);

    journalResult = { kind: 'absent' };
    assert.deepEqual(runtime.handle({
      type: 'handoff_switch_read',
      id: codingSessionId,
    }), {
      ok: false,
      reason: 'handoff-switch-journal-integrity-lost',
    });
    assert.equal(runtime.handle({
      type: 'write_session',
      id: codingSessionId,
      data: 'must-not-reach-provider',
    }).reason, 'handoff-switch-journal-unavailable');
    assert.deepEqual(fake.ptys[0].writes, []);

    journalResult = {
      kind: 'present',
      journal: {
        ...originalJournal,
        phase: 'prepared',
      },
    };
    assert.equal(runtime.handle({
      type: 'handoff_switch_read',
      id: codingSessionId,
    }).reason, 'handoff-switch-journal-integrity-lost');
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        sidecars: {
          enabled: false,
          token: testControllerToken,
        },
      },
    }).reason, 'handoff-switch-journal-unavailable');
    assert.equal(fake.calls.length, 1);
  });

  test('a restarted broker rejects a structurally plausible journal with a stale HMAC', () => {
    const codingSessionId = 'sess_handoff_restart_tamper';
    const root = deriveHandoffControllerRoot({
      token: testControllerToken,
      codingSessionId,
    });
    const authenticated = authenticatedJournal({
      transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
      phase: 'complete',
      controller_root_digest: handoffControllerCapabilityDigest(root),
    }, root);
    const tampered = {
      ...authenticated,
      phase: 'prepared',
    };
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        session_id: codingSessionId,
        session_controller_capability: root,
      }],
      handoffSwitchReader: () => ({
        kind: 'present',
        journal: tampered,
      }),
    });

    assert.deepEqual(runtime.handle({
      type: 'handoff_switch_read',
      id: codingSessionId,
      session_controller_capability: root,
    }), {
      ok: false,
      reason: 'handoff-switch-journal-integrity-lost',
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: codingSessionId,
        tool: 'claude',
        session_controller_capability: root,
      },
    }).reason, 'handoff-switch-journal-unavailable');
    assert.equal(fake.calls.length, 0);
  });

  test('managed launch replaces broker env and closes its credential domain on exit', async () => {
    const closed = [];
    const descriptor = managedDescriptor('sess_managed', {
      domain_path: '/credential/domain',
    });
    const {
      runtime,
      fake,
      lifecycleWrites,
      managedReceiptWrites,
      sidecars,
    } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch: {
          ...launch,
          shortName: 'codex',
          spec: {
            bin: '/verified/codex',
            args: () => ['--strict-config'],
          },
        },
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/credential/home',
          CODEX_HOME: '/credential/home/.codex',
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: async (input) => {
        closed.push(input);
        return { ok: true, persisted: true };
      },
    });

    const request = {
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_managed',
        descriptor,
        tool: 'codex',
        env: {
          MEMORO_TOKEN: 'must-not-reach-child',
          OPENAI_API_KEY: 'must-not-reach-child-either',
        },
        sidecars: {
          enabled: true,
          codingSessionId: 'sess_managed',
          runtimeGeneration: MANAGED_RUNTIME_GENERATION,
          label: 'managed',
          machineId: 'machine',
          source_id: 'local:machine',
          source_kind: 'local',
          source_name: 'machine',
          cloud_session_id: null,
          source: 'codex',
          repo: 'widgets',
          repoRef: 'acme/widgets',
          branch: 'main',
          tool: 'codex',
          sockPath: join(mcHome(), 'sess_managed.sock'),
          metaPath: join(mcHome(), 'sess_managed.json'),
          presenceIdentity: 'broker-local',
          heartbeat: true,
          upload: false,
          transcriptAccess: false,
          githubCapabilities: {
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
              operations: ['connection.status', 'repository.metadata'],
            },
          },
        },
      }),
    };
    const result = runtime.handle(request);

    assert.equal(result.ok, true);
    assert.equal(result.session.managed_provider, true);
    assert.deepEqual(result.sidecars, { ok: true });
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].spec.coding.apiUrl, undefined);
    assert.equal(sidecars[0].spec.coding.token, undefined);
    assert.equal(sidecars[0].spec.coding.githubCapabilities.github.state, 'ready');
    assert.deepEqual(
      managedReceiptWrites.map((receipt) => receipt.phase),
      ['broker-accepted', 'live'],
    );
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [['live', MANAGED_RUNTIME_GENERATION]],
    );
    const retried = runtime.handle(request);
    assert.equal(retried.ok, true);
    assert.equal(retried.reused, true);
    assert.equal(fake.ptys.length, 1);
    const childEnv = fake.calls[0].options.env;
    assert.equal(childEnv.BASE, undefined);
    assert.equal(childEnv.MEMORO_TOKEN, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.CODEX_HOME, '/credential/home/.codex');
    assert.equal(childEnv.MEMORO_MC_BROKER, '1');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      managedReceiptWrites.map((receipt) => receipt.phase),
      ['broker-accepted', 'live', 'live', 'exited'],
    );
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [
        ['live', MANAGED_RUNTIME_GENERATION],
        ['exited', MANAGED_RUNTIME_GENERATION],
      ],
    );
    assert.deepEqual(closed, [{
      descriptor,
      providerArtifact: null,
      portal: {
        apiUrl: null,
        token: null,
      },
      managedTransaction: managedTransaction('sess_managed'),
    }]);
  });

  test('managed launch rejects credential-bearing or caller-shaped sidecars before spawn', () => {
    const descriptor = managedDescriptor('sess_managed_sidecar_reject');
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: {},
        descriptor: input.credential_domain,
      }),
    });
    const result = runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_managed_sidecar_reject',
        descriptor,
        tool: 'codex',
        sidecars: {
          enabled: true,
          token: 'memoro-credential-canary',
          githubCapabilities: { schema: 1 },
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'managed-capability-sidecar-invalid');
    assert.equal(fake.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /memoro-credential-canary/);
  });

  test('provider global marker begins before spawn and survives mandatory terminal cleanup', async () => {
    const events = [];
    let finishCleanup;
    const c1Interlock = {
      acquireProvider() {
        events.push('marker-acquired');
        return {
          ok: true,
          lease: {
            release() {
              events.push('marker-released');
              return { ok: true };
            },
          },
        };
      },
      acquireC1() { return { ok: false, reason: 'fixture-not-used' }; },
    };
    const descriptor = {
      ...managedC1Descriptor('sess_global_marker_cleanup'),
      domain_path: '/credential/domain',
    };
    const { runtime, fake } = makeRuntime({
      c1Interlock,
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: { PATH: '/usr/bin:/bin', HOME: '/credential/home' },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: () => new Promise((resolve) => { finishCleanup = resolve; }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_global_marker_cleanup',
        descriptor,
        tool: 'codex',
      }),
    }).ok, true);
    assert.deepEqual(events, ['marker-acquired']);
    assert.equal(fake.ptys.length, 1, 'marker acquisition precedes PTY spawn');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['marker-acquired'],
      'provider marker remains while mandatory credential cleanup is pending');
    finishCleanup({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['marker-acquired', 'marker-released']);
  });

  test('an unmanaged provider exit leaves a durable fail-closed C1 barrier', async () => {
    const sessionId = 'sess_c1_unmanaged_barrier';
    const controllerRoot = '9'.repeat(64);
    let releases = 0;
    let c1Acquisitions = 0;
    let runnerCalls = 0;
    const { runtime, fake } = makeRuntime({
      controllerBindings: [{
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: sessionId,
        session_controller_capability: controllerRoot,
      }],
      c1Interlock: {
        acquireProvider() {
          return {
            ok: true,
            lease: {
              release() {
                releases += 1;
                return { ok: true };
              },
            },
          };
        },
        acquireC1() {
          c1Acquisitions += 1;
          return { ok: true, lease: { release() { return { ok: true }; } } };
        },
      },
      c1Runner() {
        runnerCalls += 1;
        return { status: 'passed' };
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: sessionId,
        runtime_generation: '0cc26fdb-6978-4edb-829a-0f1ddb36be08',
        session_controller_capability: controllerRoot,
      },
    }).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(releases, 0, 'PTY exit cannot certify an unmanaged descendant tree');
    assert.deepEqual(await runtime.handle({
      type: 'run_claude_c1',
      id: sessionId,
      session_controller_capability: controllerRoot,
    }), { ok: false, status: 'failed' });
    assert.equal(c1Acquisitions, 0);
    assert.equal(runnerCalls, 0);
  });

  test('unconfirmed provider cleanup leaves the global marker fail-closed', async () => {
    let releases = 0;
    const c1Interlock = {
      acquireProvider() {
        return { ok: true, lease: { release() { releases += 1; return { ok: true }; } } };
      },
      acquireC1() { return { ok: false, reason: 'provider-marker-active' }; },
    };
    const descriptor = managedDescriptor('sess_global_marker_failure', {
      provider_adapter: 'codex-managed-local-v1',
      profile: 'mc-managed-portable',
      domain_path: '/credential/domain',
    });
    const { runtime, fake } = makeRuntime({
      c1Interlock,
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: { PATH: '/usr/bin:/bin', HOME: '/credential/home' },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: async () => ({ ok: false, reason: 'fixture-cleanup-unconfirmed' }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_global_marker_failure',
        descriptor,
        tool: 'codex',
      }),
    }).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 0,
      'a failed finalization must remain durable evidence, not be treated as process liveness');
  });

  test('launch failure before provider start releases its marker', () => {
    let releases = 0;
    const c1Interlock = {
      acquireProvider() {
        return { ok: true, lease: { release() { releases += 1; return { ok: true }; } } };
      },
      acquireC1() { return { ok: false, reason: 'fixture-not-used' }; },
    };
    const { runtime } = makeRuntime({
      pty: { throwOnSpawn: true },
      c1Interlock,
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_global_marker_spawn_failure', tool: 'claude' },
    }).ok, false);
    assert.equal(releases, 1);
  });

  test('managed reopen waits for prior credential custody to close before replacing the dead runtime', async () => {
    const firstDescriptor = managedDescriptor('sess_managed_reopen', {
      domain_path: '/credential/first',
    });
    const nextDescriptor = managedDescriptor('sess_managed_reopen', {
      generation: '33333333-3333-4333-8333-333333333333',
      manifest_sha256: 'e'.repeat(64),
      domain_path: '/credential/next',
    });
    const closeCalls = [];
    let finishFirstClose;
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: input.credential_domain.domain_path,
          CODEX_HOME: `${input.credential_domain.domain_path}/.codex`,
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: (input) => {
        closeCalls.push(input);
        if (closeCalls.length === 1) {
          return new Promise((resolve) => { finishFirstClose = resolve; });
        }
        return Promise.resolve({ ok: true, persisted: true });
      },
    });
    const launch = (descriptor, runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_managed_reopen',
        descriptor,
        runtimeGeneration,
        tool: 'codex',
      }),
    });

    assert.equal(launch(firstDescriptor, MANAGED_RUNTIME_GENERATION).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    const reopening = launch(nextDescriptor, NEXT_MANAGED_RUNTIME_GENERATION);

    assert.equal(typeof reopening?.then, 'function');
    assert.equal(fake.ptys.length, 1, 'replacement must wait for prior custody close');
    finishFirstClose({ ok: true, persisted: true });
    const reopened = await reopening;

    assert.equal(reopened.ok, true);
    assert.equal(fake.ptys.length, 2);
    assert.equal(fake.calls[1].options.env.CODEX_HOME, '/credential/next/.codex');
    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls.length, 2);
    assert.equal(closeCalls[1].descriptor, nextDescriptor);
  });

  test('a duplicate old managed exit never closes the replacement credential domain', async () => {
    const firstDescriptor = managedDescriptor('sess_managed_generation_owner', {
      domain_path: '/credential/first',
    });
    const nextDescriptor = managedDescriptor('sess_managed_generation_owner', {
      generation: '33333333-3333-4333-8333-333333333333',
      manifest_sha256: 'e'.repeat(64),
      domain_path: '/credential/next',
    });
    const closeCalls = [];
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: { PATH: '/usr/bin:/bin', HOME: input.credential_domain.domain_path },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: async (input) => {
        closeCalls.push(input.descriptor);
        return { ok: true, persisted: true };
      },
    });
    const launch = (descriptor, runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_managed_generation_owner',
        descriptor,
        runtimeGeneration,
        tool: 'codex',
      }),
    });

    assert.equal(launch(firstDescriptor, MANAGED_RUNTIME_GENERATION).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor]);

    assert.equal(launch(nextDescriptor, NEXT_MANAGED_RUNTIME_GENERATION).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor]);

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor, nextDescriptor]);
  });

  test('managed launch never reuses an existing native broker session', () => {
    const { runtime } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => {
        if (input.credential_domain) {
          assert.fail('conflicting domain must not be opened by broker');
        }
        return {
          ok: true,
          launch,
          environmentMode: 'inherit',
          env: input.env || {},
        };
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_existing', cwd: '/repo', tool: 'codex' },
    }).ok, true);

    const conflict = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_managed_new',
        cwd: '/repo',
        tool: 'codex',
        ...managedLaunchSession({
          id: 'sess_managed_new',
          descriptor: managedDescriptor('sess_managed_new'),
        }),
      },
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'managed-provider-session-conflict');
  });

  test('managed removal waits for provider exit and confirmed credential cleanup', async () => {
    const descriptor = managedDescriptor('sess_managed_remove', {
      domain_path: '/credential/domain',
    });
    const closeCalls = [];
    let finishClose;
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/credential/home',
          CODEX_HOME: '/credential/home/.codex',
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: (input) => {
        closeCalls.push(input);
        return new Promise((resolve) => { finishClose = resolve; });
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: managedLaunchSession({
        id: 'sess_managed_remove',
        descriptor,
        tool: 'codex',
      }),
    }).ok, true);

    const removing = runtime.handle({
      type: 'remove_session',
      id: 'sess_managed_remove',
    });
    assert.equal(typeof removing?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    assert.equal(closeCalls.length, 0, 'custody must not refresh before provider exit');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].providerArtifact, null);
    assert.equal(runtime.handle({ type: 'sessions' }).sessions.length, 1);

    finishClose({ ok: true, persisted: true });
    assert.deepEqual(await removing, {
      ok: true,
      removed: true,
      credential_cleanup: 'confirmed',
    });
    assert.equal(runtime.handle({ type: 'sessions' }).sessions.length, 0);
  });

  test('list and status expose live broker sessions', () => {
    const { runtime } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.deepEqual(runtime.handle({ type: 'sessions' }).sessions.map((s) => s.id), ['sess_a']);
    const status = runtime.handle({ type: 'session_status', id: 'sess_a' });
    assert.equal(status.ok, true);
    assert.equal(status.session.id, 'sess_a');
    assert.equal(status.session.session_state, 'live');
  });

  test('list exposes repo and worktree metadata for browser session lists', () => {
    const { runtime } = makeRuntime();

    runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/Users/me/.memoro/mc/worktrees/memoro-cli/alpha',
        sidecars: {
          repo: 'memoro-cli',
          repoRef: 'martinforsberg81/memoro-cli',
          branch: 'sess/alpha',
          worktreeName: 'alpha',
          transcriptPath: '/Users/me/.codex/sessions/alpha.jsonl',
        },
      },
    });

    const [session] = runtime.handle({ type: 'sessions' }).sessions;
    assert.equal(session.name, 'alpha');
    assert.equal(session.repo, 'memoro-cli');
    assert.equal(session.repo_ref, 'martinforsberg81/memoro-cli');
    assert.equal(session.branch, 'sess/alpha');
    assert.equal(session.worktree_name, 'alpha');
    assert.equal('transcript_path' in session, false);
    assert.equal('provider_sessions_dir' in session, false);
    assert.equal('codex_artifact_capture' in session, false);
  });

  test('list derives repo and worktree metadata from cwd for older sessions', () => {
    const { runtime } = makeRuntime();

    runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        cwd: '/Users/me/.memoro/mc/worktrees/memoro-cli/smoke-test',
      },
    });

    const [session] = runtime.handle({ type: 'sessions' }).sessions;
    assert.equal(session.repo, 'memoro-cli');
    assert.equal(session.worktree_name, 'smoke-test');
  });

  test('write, dispatch, resize, stop, and remove forward to the session manager', async () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.equal(runtime.handle({ type: 'write_session', id: 'sess_a', data: 'raw' }).ok, true);
    assert.equal(runtime.handle({ type: 'dispatch_session', id: 'sess_a', message: 'prompt' }).ok, true);
    assert.equal(runtime.handle({ type: 'resize_session', id: 'sess_a', cols: 100, rows: 40 }).ok, true);
    assert.equal(runtime.handle({ type: 'stop_session', id: 'sess_a', signal: 'SIGHUP' }).ok, true);
    assert.deepEqual(fake.ptys[0].writes, ['raw', 'prompt\r']);
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 100, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].kills, ['SIGHUP']);

    const removed = runtime.handle({ type: 'remove_session', id: 'sess_a' });
    assert.equal(typeof removed?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGHUP', 'SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await removed, { ok: true, removed: true });
    assert.deepEqual(runtime.handle({ type: 'sessions' }), { ok: true, sessions: [] });
  });

  test('fetch_session_output returns recent PTY output without attaching', () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    fake.ptys[0].emitData('hello');
    fake.ptys[0].emitData(' world');

    const res = runtime.handle({ type: 'fetch_session_output', id: 'sess_a' });

    assert.equal(res.ok, true);
    assert.equal(res.output, 'hello world');
    assert.equal(res.session.id, 'sess_a');
    assert.equal(res.session.session_state, 'live');
    assert.equal(res.session.attachable, true);
  });

  test('attachConnection bridges a raw socket to an owned PTY session', () => {
    const { runtime, fake } = makeRuntime();
    const conn = makeConn();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    fake.ptys[0].emitData('snapshot');

    const res = runtime.attachConnection({ id: 'sess_a', cols: 100, rows: 40 }, conn, Buffer.from('first'));

    assert.equal(res.ok, true);
    assert.equal(JSON.parse(conn.writes[0]).ok, true);
    assert.equal(conn.writes[1], 'snapshot');
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 100, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].writes, ['first']);

    conn.emit('data', Buffer.from('input'));
    fake.ptys[0].emitData('output');
    assert.deepEqual(fake.ptys[0].writes, ['first', 'input']);
    assert.equal(conn.writes.at(-1), 'output');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(conn.ended, true);
  });

  test('cloud attaches cannot narrow the PTY while a local attach is active', () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    const local = makeConn();
    const cloud = makeConn();

    runtime.attachConnection({
      id: 'sess_a',
      attach_id: 'att_local',
      side: 'local',
      cols: 120,
      rows: 40,
    }, local);
    runtime.attachConnection({
      id: 'sess_a',
      attach_id: 'att_cloud',
      side: 'cloud',
      cols: 42,
      rows: 20,
    }, cloud);

    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 120, rows: 40 }]);
    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 44,
      rows: 22,
      side: 'cloud',
      attach_id: 'att_cloud',
    }), { ok: true, applied: false });
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 120, rows: 40 }]);

    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 132,
      rows: 44,
    }), { ok: true, applied: true });
    assert.deepEqual(fake.ptys[0].resizes, [
      { cols: 120, rows: 40 },
      { cols: 132, rows: 44 },
    ]);

    local.emit('end');
    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 52,
      rows: 24,
      side: 'cloud',
      attach_id: 'att_cloud',
    }), { ok: true, applied: true });
    assert.deepEqual(fake.ptys[0].resizes.at(-1), { cols: 52, rows: 24 });
  });

  test('attachConnection lets parallel attaches write to the same PTY', () => {
    const { runtime, fake } = makeRuntime();
    const makeConn = () => {
      const writes = [];
      return {
        writes,
        handlers: new Map(),
        write(data) { writes.push(String(data)); },
        end() { this.handlers.get('end')?.(); },
        on(event, handler) { this.handlers.set(event, handler); },
        off(event, handler) {
          if (this.handlers.get(event) === handler) this.handlers.delete(event);
        },
        emit(event, value) { this.handlers.get(event)?.(value); },
      };
    };

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    const first = makeConn();
    const second = makeConn();

    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_first' }, first);
    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_second' }, second);

    assert.equal(JSON.parse(first.writes[0]).writer, true);
    assert.equal(JSON.parse(second.writes[0]).writer, true);
    assert.equal(JSON.parse(second.writes[0]).attach.mode, 'write');
    assert.deepEqual(runtime.listSessions()[0].attached.map((a) => a.attach_id), ['att_first', 'att_second']);
    assert.equal(runtime.listSessions()[0].writer_attach_id, null);

    first.emit('data', Buffer.from('yes'));
    second.emit('data', Buffer.from('no'));
    assert.deepEqual(fake.ptys[0].writes, ['yes', 'no']);

    first.emit('end');
    assert.equal(runtime.listSessions()[0].writer_attach_id, null);

    const next = makeConn();
    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_next' }, next);
    assert.equal(JSON.parse(next.writes[0]).writer, true);
    next.emit('data', Buffer.from('again'));
    assert.deepEqual(fake.ptys[0].writes, ['yes', 'no', 'again']);
  });

  test('attachConnection cleans up when the client socket is already gone', () => {
    const { runtime } = makeRuntime();
    const conn = {
      handlers: new Map(),
      write() {
        const err = new Error('write EPIPE');
        err.code = 'EPIPE';
        throw err;
      },
      end() {},
      on(event, handler) { this.handlers.set(event, handler); },
      off(event, handler) {
        if (this.handlers.get(event) === handler) this.handlers.delete(event);
      },
    };

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.deepEqual(runtime.attachConnection({ id: 'sess_a', attach_id: 'att_dead' }, conn), { ok: true });
    assert.deepEqual(runtime.listSessions()[0].attached, []);
  });

  test('launch_session starts and stops sidecars when requested', () => {
    const { runtime, fake, sidecars } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        sidecars: {
          codingSessionId: 'sess_real',
          apiUrl: 'https://memoro.test',
          token: 'tok',
        },
      },
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.sidecars, { ok: true });
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].started, true);
    assert.equal(sidecars[0].spec.session.id, 'sess_a');
    assert.equal(sidecars[0].spec.coding.codingSessionId, 'sess_real');
    assert.equal(res.session.session_projection.status, 'active');
    assert.equal(runtime.listSessions()[0].session_projection.reason_code, 'recent_output');

    runtime.handle({ type: 'remove_session', id: 'sess_a' });
    assert.equal(sidecars[0].stopped, false, 'sidecars stay alive until the PTY confirms exit');
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(sidecars[0].stopped, true);
    assert.deepEqual(sidecars[0].stopOptions, { terminal: true });
  });

  test('journals the exact runtime generation before launch and before terminal sidecar cleanup', () => {
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const { runtime, fake, sidecars, lifecycleWrites } = makeRuntime();
    const launched = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_lifecycle',
        runtime_generation: generation,
        sidecars: {
          codingSessionId: 'sess_lifecycle',
          runtimeGeneration: generation,
          apiUrl: 'https://memoro.test',
          token: 'secret-stays-broker-side',
        },
      },
    });

    assert.equal(launched.ok, true);
    assert.equal(lifecycleWrites.length, 1);
    assert.equal(lifecycleWrites[0].state, 'live');
    assert.equal(lifecycleWrites[0].runtimeGeneration, generation);
    assert.equal(JSON.stringify(lifecycleWrites[0]).includes('secret-stays-broker-side'), false);
    assert.equal(runtime.listSessions()[0].runtime_generation, generation);

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.equal(lifecycleWrites.length, 2);
    assert.equal(lifecycleWrites[1].state, 'exited');
    assert.equal(lifecycleWrites[1].runtimeGeneration, generation);
    assert.equal(lifecycleWrites[1].exitCode, 0);
    assert.equal(sidecars[0].stopped, true);
    assert.deepEqual(sidecars[0].stopOptions, { terminal: true });
  });

  test('replacement waits for the previous PTY exit and a duplicate old exit cannot overwrite it', async () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake, sidecars, lifecycleWrites } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_replaced',
        runtime_generation: runtimeGeneration,
        sidecars: {
          codingSessionId: 'sess_replaced',
          runtimeGeneration,
          apiUrl: 'https://memoro.test',
          token: 'broker-only',
        },
      },
    });

    assert.equal(launch(firstGeneration).ok, true);
    const removing = runtime.handle({ type: 'remove_session', id: 'sess_replaced' });
    assert.equal(typeof removing?.then, 'function');
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removing).ok, true);
    assert.equal(launch(nextGeneration).ok, true);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [['live', firstGeneration], ['exited', firstGeneration], ['live', nextGeneration]],
    );

    // Node-pty should only emit once, but a duplicate late notification from
    // the retired generation must not touch the replacement state.
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.equal(sidecars[0].stopped, true);
    assert.equal(sidecars[1].stopped, false);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [['live', firstGeneration], ['exited', firstGeneration], ['live', nextGeneration]],
      'old exit must not overwrite the replacement live journal',
    );

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.equal(sidecars[1].stopped, true);
    assert.deepEqual(lifecycleWrites.at(-1), {
      path: lifecycleWrites.at(-1).path,
      codingSessionId: 'sess_replaced',
      runtimeGeneration: nextGeneration,
      state: 'exited',
      observedAt: lifecycleWrites.at(-1).observedAt,
      exitCode: 0,
    });
  });

  test('removing a replacement generation never reuses the prior generation finalization', async () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_generation_owner', runtime_generation: runtimeGeneration },
    });

    assert.equal(launch(firstGeneration).ok, true);
    const removeFirst = runtime.handle({ type: 'remove_session', id: 'sess_generation_owner' });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removeFirst).ok, true);
    assert.equal(launch(nextGeneration).ok, true);

    const removeSecond = runtime.handle({ type: 'remove_session', id: 'sess_generation_owner' });
    assert.equal(typeof removeSecond?.then, 'function');
    assert.equal(runtime.handle({ type: 'session_status', id: 'sess_generation_owner' }).session.session_state, 'live');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.handle({ type: 'session_status', id: 'sess_generation_owner' }).session.session_state, 'live');

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removeSecond).ok, true);
  });

  test('generation-scoped removal cannot stop a replacement runtime', async () => {
    const retiredGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const liveGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake } = makeRuntime();

    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_generation_scoped_remove',
        runtime_generation: liveGeneration,
      },
    }).ok, true);

    assert.deepEqual(await runtime.handle({
      type: 'remove_session',
      id: 'sess_generation_scoped_remove',
      expected_runtime_generation: retiredGeneration,
    }), {
      ok: false,
      removed: false,
      reason: 'runtime-generation-mismatch',
      error: 'broker session belongs to a different runtime generation',
    });
    assert.deepEqual(fake.ptys[0].kills, []);
    assert.equal(
      runtime.handle({
        type: 'session_status',
        id: 'sess_generation_scoped_remove',
      }).session.runtime_generation,
      liveGeneration,
    );

    const removed = runtime.handle({
      type: 'remove_session',
      id: 'sess_generation_scoped_remove',
      expected_runtime_generation: liveGeneration,
    });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removed).ok, true);
  });

  test('late removal finalization cannot delete a replacement runtime', async () => {
    const retiredGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const liveGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_late_remove',
        runtime_generation: runtimeGeneration,
      },
    });

    assert.equal(launch(retiredGeneration).ok, true);
    const removing = runtime.handle({
      type: 'remove_session',
      id: 'sess_late_remove',
      expected_runtime_generation: retiredGeneration,
    });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    // Promise continuations run in the next microtask. A competing controller
    // can therefore replace the exited row before the old remove continuation.
    assert.equal(launch(liveGeneration).ok, true);
    assert.deepEqual(await removing, { ok: true, removed: true });
    const status = runtime.handle({
      type: 'session_status',
      id: 'sess_late_remove',
    });
    assert.equal(status.ok, true);
    assert.equal(status.session.runtime_generation, liveGeneration);
    assert.equal(status.session.session_state, 'live');
    assert.deepEqual(fake.ptys[1].kills, []);

    const removeReplacement = runtime.handle({
      type: 'remove_session',
      id: 'sess_late_remove',
      expected_runtime_generation: liveGeneration,
    });
    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removeReplacement).ok, true);
  });

  test('synchronous PTY exit owns metadata before launch and never starts sidecars', () => {
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const { runtime, sidecars, lifecycleWrites } = makeRuntime({
      pty: { exitOnExitSubscription: { exitCode: 1, signal: null } },
    });

    const result = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_immediate_exit',
        runtime_generation: generation,
        sidecars: { codingSessionId: 'sess_immediate_exit', runtimeGeneration: generation },
      },
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'broker-session-exited',
      error: 'broker session exited before it could become live',
    });
    assert.equal(sidecars.length, 0);
    assert.deepEqual(lifecycleWrites.map((entry) => [entry.state, entry.runtimeGeneration]), [
      ['live', generation],
      ['exited', generation],
    ]);
  });

  test('sidecar startup failure stops the runtime and waits for terminal finalization', async () => {
    let finishTerminal;
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() { throw new Error('socket bind failed'); },
        stop() { return new Promise((resolve) => { finishTerminal = resolve; }); },
      }),
    });

    const launch = runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_sidecar_failure', sidecars: { codingSessionId: 'sess_sidecar_failure' } },
    });
    assert.equal(typeof launch?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 1, signal: null });
    finishTerminal(true);
    const result = await launch;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sidecar-start-failed');
    assert.match(result.error, /socket bind failed/);
  });

  test('shutdown waits for PTY exit and terminal sidecar finalization', async () => {
    let finishTerminal;
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() {},
        stop() { return new Promise((resolve) => { finishTerminal = resolve; }); },
      }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_shutdown', sidecars: { codingSessionId: 'sess_shutdown' } },
    }).ok, true);

    const stopping = runtime.shutdown({ timeoutMs: 1_000 });
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    finishTerminal(true);
    assert.deepEqual(await stopping, { ok: true, credential_cleanup: 'confirmed' });
  });

  test('terminal presence failure is advisory once the exit journal is durable', async () => {
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() {},
        stop() { return false; },
      }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_terminal_advisory', sidecars: { codingSessionId: 'sess_terminal_advisory' } },
    }).ok, true);

    const removing = runtime.handle({ type: 'remove_session', id: 'sess_terminal_advisory' });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await removing, { ok: true, removed: true });

    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_terminal_advisory_shutdown', sidecars: { codingSessionId: 'sess_terminal_advisory_shutdown' } },
    }).ok, true);
    const shutdown = runtime.shutdown();
    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await shutdown, { ok: true, credential_cleanup: 'confirmed' });
  });

  test('relaunch replaces the retained dead broker row for the same coding session id', () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake, lifecycleWrites } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_reopen',
        runtime_generation: runtimeGeneration,
      },
    });

    assert.equal(launch(firstGeneration).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(runtime.listSessions()[0].session_state, 'dead');

    const reopened = launch(nextGeneration);

    assert.equal(reopened.ok, true);
    assert.equal(fake.ptys.length, 2);
    assert.equal(runtime.listSessions().length, 1);
    assert.equal(runtime.listSessions()[0].session_state, 'live');
    assert.equal(runtime.listSessions()[0].runtime_generation, nextGeneration);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [
        ['live', firstGeneration],
        ['exited', firstGeneration],
        ['live', nextGeneration],
      ],
    );
  });

  test('returns structured errors for launch failures and invalid payloads', () => {
    const failed = makeRuntime({ launch: { ok: false } }).runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_a', tool: 'codex' },
    });
    assert.deepEqual(failed, {
      ok: false,
      reason: 'missing-bin',
      error: 'missing codex',
    });

    const { runtime } = makeRuntime();
    assert.equal(runtime.handle({ type: 'bogus' }), null);
    assert.match(runtime.handle({ type: 'launch_session', session: { id: '' } }).error, /session id/);
    assert.deepEqual(runtime.handle({ type: 'session_status', id: 'missing' }), {
      ok: false,
      reason: 'session-not-found',
      error: 'unknown broker session: missing',
    });
    assert.match(
      runtime.handle({ type: 'write_session', id: 'missing', data: 'x' }).error,
      /controller capability/,
    );
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_validation' },
    }).ok, true);
    assert.match(runtime.handle({
      type: 'resize_session',
      id: 'sess_validation',
      cols: 0,
      rows: 24,
    }).error, /cols/);
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_unpaired_handoff',
        cwd: '/repo/unpaired-handoff',
        runtime_generation: '9937ac60-46ce-42dd-9302-6533f1c6c38c',
        handoff_transaction: {
          transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
        },
      },
    }).reason, 'handoff-launch-pair-invalid');
  });
});
