import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CERTIFIED_TOOL_ADAPTER_SCHEMA,
  certifiedToolRegistry,
  createCertifiedToolRegistry,
} from '../../../src/adapters/certified/registry.js';

test('Codex and Claude expose one shared certified adapter contract', () => {
  assert.deepEqual(certifiedToolRegistry.list(), [
    {
      schema: CERTIFIED_TOOL_ADAPTER_SCHEMA,
      tool: 'codex',
      provider_tool: 'codex',
    },
    {
      schema: CERTIFIED_TOOL_ADAPTER_SCHEMA,
      tool: 'claude',
      provider_tool: 'claude-code',
    },
  ]);
  assert.equal(certifiedToolRegistry.forTool('claude-code').tool, 'claude');
  assert.equal(certifiedToolRegistry.forTool('gemini'), null);
});

test('resume renders only the exact recorded conversation handle', () => {
  const adapter = certifiedToolRegistry.forTool('codex');
  const calls = [];
  const launch = {
    ok: true,
    id: 'codex',
    adapter: {
      resumeArgs({ sessionId }) {
        calls.push(sessionId);
        return ['resume', sessionId];
      },
    },
  };
  assert.deepEqual(adapter.resolve_argv({
    launch,
    action: 'resume',
    conversationHandle: '019bd567-a57a-7b70-86fd-bb1782ca12c0',
  }), {
    ok: true,
    argv: ['resume', '019bd567-a57a-7b70-86fd-bb1782ca12c0'],
    expected_handle: '019bd567-a57a-7b70-86fd-bb1782ca12c0',
  });
  assert.deepEqual(calls, ['019bd567-a57a-7b70-86fd-bb1782ca12c0']);
  assert.equal(adapter.resolve_argv({ launch, action: 'resume' }).reason,
    'certified-resume-handle-missing');
  assert.equal(calls.length, 1);
});

test('process resolution rejects the credential-free inherited environment path', () => {
  const adapter = certifiedToolRegistry.forTool('codex');
  const boundary = { descriptor: { session_id: 'mcs_000000000000000000000001' } };
  const launch = {
    ok: true,
    id: 'codex',
    shortName: 'codex',
    spec: { spawn: () => ({ bin: '/tool', args: [] }) },
  };
  const result = adapter.resolve_process({
    boundary,
    argv: [],
    env: {},
    launch,
    deps: {
      resolveBoundaryLaunch: () => ({
        ok: true,
        launch,
        environmentMode: 'inherit',
        env: {},
        descriptor: boundary.descriptor,
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'certified-process-plan-invalid');
});

test('registry rejects optional fallback methods and malformed adapters', () => {
  const valid = {
    schema: CERTIFIED_TOOL_ADAPTER_SCHEMA,
    tool: 'test',
    provider_tool: 'test',
    inspect_readiness() {},
    prepare_boundary() {},
    resolve_argv() {},
    resolve_process() {},
    abort_boundary() {},
    close_boundary() {},
  };
  assert.equal(createCertifiedToolRegistry([valid]).forTool('test').tool, 'test');
  assert.throws(() => createCertifiedToolRegistry([{ ...valid, fallback: () => {} }]),
    /invalid certified tool adapter/u);
  assert.throws(() => createCertifiedToolRegistry([{ ...valid, resolve_process: null }]),
    /invalid certified tool adapter/u);
});
