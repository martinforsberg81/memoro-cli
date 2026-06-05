/**
 * Pure-helper tests for src/mc/vault/types.js.
 *
 * Covers the validators + JSON-shape formatters that the vault commands
 * delegate to. Keeping these pure lets the subprocess CLI tests stay
 * on deterministic red branches (no real keychain / server needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MC_SECRET_KINDS,
  WIRE_SECRET_TYPE,
  buildSecretPayload,
  normaliseSecretPayload,
  parseTypeFlag,
  formatListJson,
  formatListLine,
} from '../../../src/mc/vault/types.js';

describe('vault types — constants', () => {
  it('MC_SECRET_KINDS is the two phase-1 kinds, in order', () => {
    assert.deepEqual(MC_SECRET_KINDS, ['api_token', 'oauth_token']);
  });
  it('WIRE_SECRET_TYPE is "api_key" (matches server whitelist)', () => {
    assert.equal(WIRE_SECRET_TYPE, 'api_key');
  });
});

describe('buildSecretPayload', () => {
  it('builds a minimal api_token payload', () => {
    const p = buildSecretPayload({ kind: 'api_token', token: 'sk-abc' });
    assert.deepEqual(p, { kind: 'api_token', token: 'sk-abc' });
  });
  it('includes provider + account when provided', () => {
    const p = buildSecretPayload({ kind: 'api_token', token: 'sk-abc', provider: 'anthropic', account: 'work' });
    assert.deepEqual(p, { kind: 'api_token', token: 'sk-abc', provider: 'anthropic', account: 'work' });
  });
  it('includes explicit native auth target metadata when provided', () => {
    const p = buildSecretPayload({
      kind: 'api_token',
      token: 'sk-abc',
      provider: 'openai',
      targetTool: 'codex',
      targetAuthMode: 'api_key',
      targetLocation: 'native-auth',
    });
    assert.deepEqual(p, {
      kind: 'api_token',
      token: 'sk-abc',
      provider: 'openai',
      target_tool: 'codex',
      target_auth_mode: 'api_key',
      target_location: 'native-auth',
    });
  });
  it('includes scopes + expires_at on oauth_token', () => {
    const p = buildSecretPayload({
      kind: 'oauth_token', token: 'ya29.x', provider: 'google',
      scopes: ['drive.readonly'], expiresAt: '2026-12-31T00:00:00Z',
    });
    assert.deepEqual(p, {
      kind: 'oauth_token', token: 'ya29.x', provider: 'google',
      scopes: ['drive.readonly'], expires_at: '2026-12-31T00:00:00Z',
    });
  });
  it('drops scopes + expires_at on api_token (oauth-only fields)', () => {
    const p = buildSecretPayload({ kind: 'api_token', token: 't', scopes: ['x'], expiresAt: '2026-01-01T00:00:00Z' });
    assert.equal(p.scopes, undefined);
    assert.equal(p.expires_at, undefined);
  });
  it('merges extra fields', () => {
    const p = buildSecretPayload({ kind: 'api_token', token: 't', extra: { region: 'eu' } });
    assert.equal(p.region, 'eu');
  });
  it('throws on unknown kind', () => {
    assert.throws(() => buildSecretPayload({ kind: 'password', token: 't' }), /unsupported mc secret kind/);
  });
  it('throws on missing token', () => {
    assert.throws(() => buildSecretPayload({ kind: 'api_token', token: '' }), /token .* required/);
  });
  it('throws if scopes is not an array (oauth)', () => {
    assert.throws(() => buildSecretPayload({ kind: 'oauth_token', token: 't', scopes: 'drive' }), /scopes must be an array/);
  });
});

describe('normaliseSecretPayload', () => {
  it('returns null on bad input', () => {
    assert.equal(normaliseSecretPayload(null), null);
    assert.equal(normaliseSecretPayload('x'), null);
  });
  it('defaults kind to api_token for legacy payloads with no kind', () => {
    const n = normaliseSecretPayload({ token: 't', provider: 'p' });
    assert.equal(n.kind, 'api_token');
    assert.equal(n.provider, 'p');
  });
  it('preserves known mc kinds', () => {
    const n = normaliseSecretPayload({ kind: 'oauth_token', token: 't' });
    assert.equal(n.kind, 'oauth_token');
  });
  it('rejects unknown kinds (defaults to api_token, doesn\'t throw)', () => {
    const n = normaliseSecretPayload({ kind: 'mystery', token: 't' });
    assert.equal(n.kind, 'api_token');
  });
  it('captures unknown fields in extra', () => {
    const n = normaliseSecretPayload({ kind: 'api_token', token: 't', custom: 1 });
    assert.deepEqual(n.extra, { custom: 1 });
  });
  it('normalises explicit target fields as first-class metadata', () => {
    const n = normaliseSecretPayload({
      kind: 'api_token',
      token: 't',
      provider: 'openai',
      target_tool: 'codex',
      target_auth_mode: 'api_key',
      target_location: 'native-auth',
      custom: 1,
    });
    assert.equal(n.target_tool, 'codex');
    assert.equal(n.target_auth_mode, 'api_key');
    assert.equal(n.target_location, 'native-auth');
    assert.deepEqual(n.extra, { custom: 1 });
  });
  it('returns null extra when no unknown fields', () => {
    const n = normaliseSecretPayload({ kind: 'api_token', token: 't', provider: 'p' });
    assert.equal(n.extra, null);
  });
});

describe('parseTypeFlag', () => {
  it('returns null for no flag', () => {
    assert.equal(parseTypeFlag(null), null);
    assert.equal(parseTypeFlag(undefined), null);
  });
  it('returns kind for valid', () => {
    assert.equal(parseTypeFlag('api_token'), 'api_token');
    assert.equal(parseTypeFlag('oauth_token'), 'oauth_token');
  });
  it('throws for unknown', () => {
    assert.throws(() => parseTypeFlag('password'), /unknown --type/);
  });
});

describe('formatListJson — never includes secret values', () => {
  it('emits id + kind + label + provider + account + timestamps, no token', () => {
    const out = formatListJson({
      secrets: [{
        id: 'vid_1', kind: 'api_token', label: 'anthropic',
        provider: 'anthropic', account: 'work',
        token: 'SHOULD-NOT-APPEAR',
        created_at: 't1', updated_at: 't2',
      }],
    });
    const json = JSON.stringify(out);
    assert.ok(!json.includes('SHOULD-NOT-APPEAR'), 'token value leaked into list JSON');
    // The literal `"token"` field key must never appear in list output
    // (the substring "token" appears legitimately inside "api_token" /
    // "oauth_token" — we check for the JSON key form specifically).
    assert.ok(!/"token"\s*:/.test(json), 'token key leaked into list JSON');
    assert.equal(out.secrets[0].id, 'vid_1');
    assert.equal(out.secrets[0].label, 'anthropic');
    assert.equal(out.secrets[0].provider, 'anthropic');
    assert.equal(out.secrets[0].target_tool, null);
  });
  it('handles empty list', () => {
    assert.deepEqual(formatListJson({ secrets: [] }), { ok: true, secrets: [] });
    assert.deepEqual(formatListJson({}), { ok: true, secrets: [] });
  });
});

describe('formatListLine — no secret values', () => {
  it('includes label + kind:provider/account + id', () => {
    const line = formatListLine({
      id: 'vid_1', kind: 'api_token', label: 'work',
      provider: 'anthropic', account: 'company',
      token: 'sk-LEAK',
    });
    assert.ok(line.includes('work'));
    assert.ok(line.includes('api_token:anthropic/company'));
    assert.ok(line.includes('vid_1'));
    assert.ok(!line.includes('sk-LEAK'));
  });
  it('omits account separator when absent', () => {
    const line = formatListLine({
      id: 'vid_2', kind: 'oauth_token', label: 'gdrive',
      provider: 'google', account: null,
    });
    assert.ok(line.includes('oauth_token:google'));
    assert.ok(!line.includes('/'));
  });
  it('falls back to bare kind when no provider', () => {
    const line = formatListLine({ id: 'v', kind: 'api_token', label: 'l', provider: null, account: null });
    assert.ok(line.includes('api_token'));
  });
});
