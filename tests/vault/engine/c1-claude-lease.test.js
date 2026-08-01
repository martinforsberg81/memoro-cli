import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  C1_CLAUDE_TOOL_AUTH_CLASS,
  C1_CLAUDE_TOOL_AUTH_LABEL,
  createC1CredentialLeakScanner,
  extractExactC1ClaudeToolAuthEnvelopeFixture,
  extractExactC1ClaudeToolAuthPayload,
  parseC1ClaudeChildReport,
} from '../../../src/vault/engine/c1-claude-lease.js';

const CANARY = 'c1-vault-canary/with?encoding=';

function payload(overrides = {}) {
  return {
    kind: 'tool_auth',
    tool: 'claude-code',
    source: 'keychain',
    body: JSON.stringify({
      claudeAiOauth: { accessToken: CANARY },
    }),
    ...overrides,
  };
}

test('C1 accepts only the exact tool-auth payload shape', () => {
  const extracted = extractExactC1ClaudeToolAuthPayload(payload());
  assert.ok(Buffer.isBuffer(extracted));
  assert.equal(extracted.toString('utf8'), CANARY);
  extracted.fill(0);
  assert.equal(extractExactC1ClaudeToolAuthPayload(payload({ tool: 'codex' })), null);
  assert.equal(extractExactC1ClaudeToolAuthPayload(payload({ extra: true })), null);
  assert.equal(extractExactC1ClaudeToolAuthPayload(payload({
    body: JSON.stringify({ claudeAiOauth: { accessToken: CANARY, unknown: true } }),
  })), null);
  const full = extractExactC1ClaudeToolAuthPayload(payload({
    body: JSON.stringify({
      claudeAiOauth: {
        accessToken: CANARY,
        refreshToken: 'fixture-refresh-token',
        expiresAt: '2026-07-28T00:00:00.000Z',
        scopes: ['user:read'],
        subscriptionType: 'pro',
        rateLimitTier: 'tier-1',
      },
    }),
  }));
  assert.equal(full.toString('utf8'), CANARY);
  full.fill(0);
  assert.equal(C1_CLAUDE_TOOL_AUTH_LABEL, 'tool-auth:claude-code');
  assert.equal(C1_CLAUDE_TOOL_AUTH_CLASS, 'tool-auth');
  const wire = { class: C1_CLAUDE_TOOL_AUTH_CLASS };
  const opened = { label: C1_CLAUDE_TOOL_AUTH_LABEL, data: payload() };
  const fromEnvelope = extractExactC1ClaudeToolAuthEnvelopeFixture(wire, opened);
  assert.equal(fromEnvelope.toString('utf8'), CANARY);
  fromEnvelope.fill(0);
  assert.equal(extractExactC1ClaudeToolAuthEnvelopeFixture(
    { class: 'secret' }, opened,
  ), null);
  assert.equal(extractExactC1ClaudeToolAuthEnvelopeFixture(
    wire, { ...opened, label: 'tool-auth:codex' },
  ), null);
});

test('C1 child report accepts only the strict status schema', () => {
  assert.deepEqual(parseC1ClaudeChildReport(Buffer.from('{"schema":1,"status":"passed"}\n')), {
    status: 'passed',
  });
  assert.equal(parseC1ClaudeChildReport(Buffer.from('{"schema":1,"status":"passed","raw":"no"}')), null);
  assert.equal(parseC1ClaudeChildReport(Buffer.from('{"schema":2,"status":"passed"}')), null);
  assert.equal(parseC1ClaudeChildReport(Buffer.from('not-json')), null);
});

test('C1 output scanner fails closed for split raw and encoded credential output', () => {
  const credential = Buffer.from(CANARY, 'utf8');
  const variants = [
    CANARY,
    credential.toString('base64'),
    credential.toString('hex'),
    encodeURIComponent(CANARY),
    JSON.stringify(CANARY).slice(1, -1),
  ];
  for (const variant of variants) {
    const scanner = createC1CredentialLeakScanner(credential);
    const split = Math.max(1, Math.floor(variant.length / 2));
    assert.equal(scanner.push(Buffer.from(variant.slice(0, split))), false);
    assert.equal(scanner.push(Buffer.from(variant.slice(split))), true);
    scanner.clear();
  }
  credential.fill(0);
});

test('C1 lease pins the exact fixed child source', () => {
  const child = readFileSync(new URL('../../../src/runtime/broker/c1-child.js', import.meta.url));
  const lease = readFileSync(new URL('../../../src/vault/engine/c1-claude-lease.js', import.meta.url), 'utf8');
  const pinned = lease.match(/const C1_CHILD_SOURCE_SHA256 = '([a-f0-9]{64})';/)?.[1];
  assert.equal(pinned, createHash('sha256').update(child).digest('hex'));
});
