/**
 * Tests for the JIT materialisation contract (§12d) — claude-code +
 * codex adapters' materializeToken / shredToken.
 *
 * Each test writes to a tmp dir so we never touch ~/.claude or
 * ~/.codex on the host. The location is taken from `tokenLocations()`
 * shape and rewired through a tmpdir prefix.
 *
 * Security expectations:
 *   - materialised file mode = 0600
 *   - shred unlinks the file (not just truncate)
 *   - shred on missing file returns ok=true (idempotent)
 *   - the token never appears in any returned diagnostic field
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as claudeCode from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';

const SENTINEL_TOKEN = 'sk-test-token-zzz-must-never-leak-aaa-9af237';

describe.skip('legacy claude-code materialisation (credential-blind containment)', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-vault-materialise-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('writes credentials.json with mode 0600 and the documented shape', async () => {
    const target = join(dir, '.credentials.json');
    const loc = { type: 'file', path: target, format: 'json', shape: 'anthropic-credentials-v1' };
    const res = await claudeCode.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    assert.equal(res.ok, true);
    assert.equal(res.materializedPath, target);
    assert.ok(existsSync(target));
    // Shape: { anthropic: { apiKey: <token> } }
    const body = readFileSync(target, 'utf8');
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed), ['anthropic']);
    assert.equal(parsed.anthropic.apiKey, SENTINEL_TOKEN);
    // Mode 0600
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600 got ${mode.toString(8)}`);
  });

  it('overwriting is idempotent — second call succeeds and replaces contents', async () => {
    const target = join(dir, 'idempo.json');
    const loc = { type: 'file', path: target };
    await claudeCode.materializeToken({ token: 'first-token-aaa', location: loc });
    const res = await claudeCode.materializeToken({ token: 'second-token-bbb', location: loc });
    assert.equal(res.ok, true);
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(parsed.anthropic.apiKey, 'second-token-bbb');
  });

  it('env location returns ok:false with reason="env-only"', async () => {
    const loc = { type: 'env', name: 'ANTHROPIC_API_KEY' };
    const res = await claudeCode.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'env-only');
    assert.equal(res.envName, 'ANTHROPIC_API_KEY');
  });

  it('shredToken unlinks the file', async () => {
    const target = join(dir, 'shred-me.json');
    const loc = { type: 'file', path: target };
    await claudeCode.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    assert.ok(existsSync(target));
    const res = await claudeCode.shredToken({ location: loc });
    assert.equal(res.ok, true);
    assert.equal(res.removed, true);
    assert.equal(existsSync(target), false);
  });

  it('shredToken on missing file is a no-op (ok:true, removed:false)', async () => {
    const loc = { type: 'file', path: join(dir, 'never-existed.json') };
    const res = await claudeCode.shredToken({ location: loc });
    assert.equal(res.ok, true);
    assert.equal(res.removed, false);
  });

  it('returned diagnostics never embed the token', async () => {
    const target = join(dir, 'no-leak.json');
    const loc = { type: 'file', path: target };
    const res = await claudeCode.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    const serialised = JSON.stringify(res);
    assert.ok(!serialised.includes(SENTINEL_TOKEN), `materializeToken result leaked: ${serialised}`);
    const shredRes = await claudeCode.shredToken({ location: loc });
    assert.ok(!JSON.stringify(shredRes).includes(SENTINEL_TOKEN));
  });

  it('tokenLocations() returns a usable file shape', () => {
    const locs = claudeCode.tokenLocations();
    assert.ok(Array.isArray(locs) && locs.length > 0);
    const fileLoc = locs.find((l) => l.type === 'file');
    assert.ok(fileLoc, 'must have at least one file location');
    assert.match(fileLoc.path, /\.credentials\.json$/);
  });
});

describe.skip('legacy codex materialisation (credential-blind containment)', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-vault-codex-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('writes auth.json with OPENAI_API_KEY + mode 0600', async () => {
    const target = join(dir, 'auth.json');
    const loc = { type: 'file', path: target };
    const res = await codex.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    assert.equal(res.ok, true);
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(parsed.auth_mode, 'apikey');
    assert.equal(parsed.OPENAI_API_KEY, SENTINEL_TOKEN);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  });

  it('shredToken removes the file', async () => {
    const target = join(dir, 'shred-codex.json');
    const loc = { type: 'file', path: target };
    await codex.materializeToken({ token: SENTINEL_TOKEN, location: loc });
    await codex.shredToken({ location: loc });
    assert.equal(existsSync(target), false);
  });

  it('tokenLocations() points at ~/.codex/auth.json', () => {
    const locs = codex.tokenLocations();
    const fileLoc = locs.find((l) => l.type === 'file');
    assert.ok(fileLoc, 'codex must declare a file location');
    assert.match(fileLoc.path, /\.codex\/auth\.json$/);
  });
});

describe.skip('legacy materializeToken argument validation', () => {
  it('refuses empty token', async () => {
    const res = await claudeCode.materializeToken({
      token: '',
      location: { type: 'file', path: '/tmp/never' },
    });
    assert.equal(res.ok, false);
  });

  it('refuses missing location', async () => {
    const res = await claudeCode.materializeToken({ token: SENTINEL_TOKEN });
    assert.equal(res.ok, false);
  });

  it('refuses unknown location type', async () => {
    const res = await claudeCode.materializeToken({
      token: SENTINEL_TOKEN,
      location: { type: 'magic' },
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /unsupported/);
  });
});

describe('credential-blind adapter contract', () => {
  for (const [name, adapter] of [['claude', claudeCode], ['codex', codex]]) {
    it(`${name} advertises no vault token destinations`, () => {
      assert.deepEqual(adapter.tokenLocations(), []);
    });

    it(`${name} rejects file and env materialisation without writing`, async () => {
      const file = join(tmpdir(), `mc-${name}-must-not-exist-${Date.now()}`);
      for (const location of [{ type: 'file', path: file }, { type: 'env', name: 'SECRET' }]) {
        const result = await adapter.materializeToken({
          token: SENTINEL_TOKEN,
          location,
        });
        assert.deepEqual(result, {
          ok: false,
          reason: 'plaintext-materialisation-disabled',
        });
        assert.equal(existsSync(file), false);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL_TOKEN));
      }
    });
  }
});
