import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { openLocalSessionRuntime } from '../../src/mc/session-runtime-v1.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';
const workspace = {
  workspace_id: 'mcw_000000000000000000000001',
  current_path: '/workspace/alpha',
};
const session = { mc_session_id: mcSessionId };

test('a live durable generation is probed and attached without starting a process', async () => {
  const calls = [];
  const result = await openLocalSessionRuntime({
    session,
    workspace,
    noLaunch: true,
    deps: {
      inspectRuntime: () => ({ kind: 'present' }),
      decideRuntimeAction: () => ({ action: 'attach', generation_id: generationId }),
      probeRuntimeHost: async (identity) => { calls.push(['probe', identity]); return { ok: true }; },
      reconcileRuntimeHost: (identity) => { calls.push(['reconcile', identity]); return { action: 'attach' }; },
      beginGeneration: () => assert.fail('attach must not create a generation'),
      prepareLaunchPlan: () => assert.fail('attach must not prepare a process'),
    },
  });
  assert.deepEqual(result, { ok: true, code: 0, action: 'attach', generation_id: generationId });
  assert.deepEqual(calls.map(([name]) => name), ['probe', 'reconcile']);
});

test('fresh launch owns socket, terminal, artifact binding, and completion in order', async () => {
  const order = [];
  const runtime = new FakeRuntime(order);
  const result = await openLocalSessionRuntime({
    session,
    workspace,
    stdout: { columns: 100, rows: 30 },
    deps: {
      inspectRuntime: () => ({ kind: 'present', generations: [] }),
      decideRuntimeAction: () => ({ action: 'start' }),
      beginGeneration: (intent) => {
        order.push(['begin', intent.action, intent.launchCwd]);
        return { intent: { generation_id: generationId, action: 'start' } };
      },
      resolvePortal: async () => null,
      prepareLaunchPlan: async () => ({
        ok: true,
        plan: {
          async startRuntime() { order.push(['runtime']); return runtime; },
          captureConversationArtifact() {
            order.push(['capture']);
            return { ok: true, handle: 'conversation-exact', artifact: { bounded: true } };
          },
          async closeBoundary() { order.push(['close-boundary']); return { ok: true }; },
          async abort() { assert.fail('accepted runtime must not abort its boundary'); },
        },
      }),
      ptyFactory: {},
      createSocketServer: () => ({
        async start() { order.push(['socket-start']); },
        async stop() { order.push(['socket-stop']); },
      }),
      attachTerminal: async () => {
        order.push(['attach']);
        setImmediate(() => runtime.emit('exit', { exit_code: 0, signal: null }));
        return { ok: true, code: 0 };
      },
      bindConversation: (input) => {
        order.push(['bind', input.handle]);
        return { conversation_id: 'mcc_000000000000000000000001' };
      },
      completeGeneration: (input) => order.push(['complete', input.conversationId]),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'start');
  assert.deepEqual(order.map(([name]) => name), [
    'begin',
    'runtime',
    'socket-start',
    'attach',
    'socket-stop',
    'capture',
    'bind',
    'close-boundary',
    'complete',
    'runtime-close',
  ]);
});

test('socket publication failure stops the exact runtime before aborting its boundary', async () => {
  const order = [];
  const runtime = new FakeRuntime(order, { exitOnStop: true });
  const result = await openLocalSessionRuntime({
    session,
    workspace,
    deps: {
      inspectRuntime: () => ({ kind: 'present', generations: [] }),
      decideRuntimeAction: () => ({ action: 'start' }),
      beginGeneration: () => ({
        intent: { generation_id: generationId, action: 'start' },
      }),
      resolvePortal: async () => null,
      prepareLaunchPlan: async () => ({
        ok: true,
        plan: {
          async startRuntime() { order.push(['runtime']); return runtime; },
          async abortClaimedRuntime() { order.push(['abort-boundary']); return { ok: true }; },
          async abort() { assert.fail('a claimed runtime uses claimed cleanup'); },
        },
      }),
      ptyFactory: {},
      createSocketServer: () => ({
        async start() {
          order.push(['socket-start']);
          const error = new Error('socket unavailable');
          error.reason = 'runtime-socket-publication-failed';
          throw error;
        },
      }),
      failGeneration: ({ reason }) => order.push(['fail-generation', reason]),
    },
  });

  assert.deepEqual(result, {
    ok: false,
    code: 1,
    reason: 'runtime-socket-publication-failed',
  });
  assert.deepEqual(order, [
    ['runtime'],
    ['socket-start'],
    ['runtime-stop', 'SIGTERM'],
    ['fail-generation', 'runtime-host-start-failed'],
    ['abort-boundary'],
    ['runtime-close'],
  ]);
});

test('lost conversation evidence requires explicit replacement and never times out to fresh', async () => {
  const common = {
    session,
    workspace,
    noLaunch: true,
    deps: {
      inspectRuntime: () => ({ kind: 'present', generations: [] }),
      decideRuntimeAction: () => ({
        action: 'explicit-replacement-required',
        previous_generation_id: generationId,
      }),
    },
  };
  assert.deepEqual(await openLocalSessionRuntime(common), {
    ok: false,
    code: 1,
    reason: 'explicit-replacement-required',
  });
  assert.deepEqual(await openLocalSessionRuntime({ ...common, replace: true }), {
    ok: true,
    code: 0,
    action: 'replace',
    tool: 'codex',
    workspace_id: workspace.workspace_id,
    launch_cwd: workspace.current_path,
  });
});

class FakeRuntime extends EventEmitter {
  constructor(order, { exitOnStop = false } = {}) {
    super();
    this.order = order;
    this.exitOnStop = exitOnStop;
    this.state = 'live';
  }

  status() { return { state: this.state }; }
  stop(signal) {
    this.order.push(['runtime-stop', signal]);
    if (this.exitOnStop) {
      this.state = 'exited';
      this.emit('exit', { exit_code: null, signal });
    }
  }
  async close() { this.order.push(['runtime-close']); }
}
