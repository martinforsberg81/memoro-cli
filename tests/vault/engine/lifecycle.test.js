/**
 * Tests for the §12d lifecycle glue — materialiseForSession +
 * shredForSession.
 *
 * Strategy:
 *   - Inject a mock portal (the same one the vault-commands tests use)
 *   - Pre-populate the in-memory vault with encrypted secrets
 *   - Inject a fake set of adapters with stub materializeToken /
 *     shredToken that record calls
 *   - Inject an in-memory cacheDeps so the keychain-cache path doesn't
 *     touch the host
 *   - Drive a fresh MC_HOME via env so the manifest file lives in a
 *     tmpdir
 *
 * Covered:
 *   - vault-locked path → ok:false with hint, no materialisation
 *   - cached-key path → matching secrets land via the adapter
 *   - manifest persisted at the documented location
 *   - shredForSession reads manifest + calls adapter.shredToken
 *   - shred idempotency (running twice doesn't error)
 *   - provider filtering: secrets for adapters NOT installed are skipped
 *   - no-leak invariant: token bytes never appear in returned objects
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  materialiseForSession,
  shredForSession,
  manifestPath,
} from '../../../src/vault/engine/lifecycle.js';
import { materialiseRepoBoundSecrets } from '../../../src/vault/engine/repo-materialise.js';
import {
  deriveVaultKeys,
  encryptSecretPayload,
  bytesToBase64,
} from '../../../src/vault/engine/client-crypto.js';
import { cacheVaultKey } from '../../../src/vault/engine/key-cache.js';
import { createMockVaultServer, makeTestPortal } from './_helpers/mock-server.js';

const PW = 'lifecycle-test-master-password';
const TOKEN_CLAUDE = 'sk-ant-test-token-leakcheck-zzz1';
const TOKEN_CODEX = 'sk-openai-test-token-leakcheck-zzz2';

function makeMemCacheDeps() {
  const store = new Map();
  return {
    async getSecret(account) { return store.get(account) ?? null; },
    async setSecret(account, value) { store.set(account, value); return 'mem'; },
    async deleteSecret(account) { store.delete(account); return 'mem'; },
    now: () => Date.now(),
  };
}

/**
 * Stub adapter with recordable materialize/shred. Stays out of disk —
 * tests for the actual file writes are in tests/adapters/materialise.test.js.
 */
function makeStubAdapter({ toolName, locations }) {
  const calls = { materialise: [], shred: [] };
  return {
    TOOL_NAME: toolName,
    tokenLocations: () => locations,
    async materializeToken({ token, location, sessionId }) {
      calls.materialise.push({ token, location, sessionId });
      return { ok: true, materializedPath: location.path || null };
    },
    async shredToken({ location, sessionId }) {
      calls.shred.push({ location, sessionId });
      return { ok: true, removed: true };
    },
    _calls: calls,
  };
}

/**
 * Set up a mock server, set up the vault, populate with the given
 * secrets (already encrypted via the real client crypto), and return
 * everything tests need to drive lifecycle.materialiseForSession.
 */
async function bootstrapVaultWithSecrets(secrets) {
  const server = createMockVaultServer();
  const portal = makeTestPortal(server);

  // Setup the vault: derive against placeholder salt, POST setup,
  // server returns real salt, re-derive against it.
  const placeholderSalt = bytesToBase64(new Uint8Array(32));
  const { authHash: ph } = await deriveVaultKeys(PW, placeholderSalt);
  const setupRes = await server.memoroFetch('', '/api/vault/setup', { method: 'POST', body: { authHash: ph } });
  const realSalt = setupRes.salt;
  const { authHash, vaultKey, vaultKeyBytes } = await deriveVaultKeys(PW, realSalt);
  // The mock server's "auth_hash" was hashed from the placeholder; to
  // bring it in sync with the real authHash we replicate the
  // change-password call from the setup verb.
  await server.memoroFetch('', '/api/vault/unlock', { method: 'POST', body: { authHash: ph } });
  await server.memoroFetch('', '/api/vault/change-password', {
    method: 'POST', body: { currentAuthHash: ph, newAuthHash: authHash, newSalt: realSalt },
  });
  // Unlock with the real hash so we can POST secrets.
  await server.memoroFetch('', '/api/vault/unlock', { method: 'POST', body: { authHash } });

  for (const s of secrets) {
    const enc = await encryptSecretPayload(vaultKey, s.label, {
      kind: 'api_token',
      token: s.token,
      provider: s.provider,
      account: s.account || null,
      target_tool: s.targetTool || null,
      target_auth_mode: s.targetAuthMode || null,
      target_location: s.targetLocation || null,
    });
    await server.memoroFetch('', '/api/vault/secrets', {
      method: 'POST',
      body: {
        secretType: 'api_key',
        encryptedLabel: enc.encryptedLabel,
        encryptedData: enc.encryptedData,
        iv: enc.iv,
        labelIv: enc.labelIv,
      },
    });
  }

  return { server, portal, vaultKey, vaultKeyBytes, authHash };
}

function writeRepoBindings(worktree, keys, file = '.env') {
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  writeFileSync(join(worktree, '.mc', 'secrets.json'), JSON.stringify({
    version: 1,
    sources: [
      {
        file,
        format: 'dotenv',
        materialise: 'file',
        keys,
      },
    ],
  }, null, 2));
}

describe.skip('legacy materialiseForSession behavior (credential-blind containment)', () => {
  let mcHomeDir;
  before(() => {
    mcHomeDir = mkdtempSync(join(tmpdir(), 'mc-vault-lifecycle-'));
    process.env.MC_HOME = mcHomeDir;
  });
  after(() => {
    delete process.env.MC_HOME;
    try { rmSync(mcHomeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns ok:false with hint when vault is locked (no cache, no env)', async () => {
    const { portal } = await bootstrapVaultWithSecrets([
      { label: 'a', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'fake-claude.json') }],
    });
    delete process.env.MC_VAULT_PASSPHRASE;
    const res = await materialiseForSession({
      sessionId: 'sess-locked',
      portal,
      adapters: [claudeStub],
      deps: { cacheDeps },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'vault-locked');
    assert.ok(res.hint.includes('mc vault unlock'));
    assert.equal(claudeStub._calls.materialise.length, 0);
  });

  it('does not ask for vault unlock when the selected adapter has no provider mapping', async () => {
    const { portal } = await bootstrapVaultWithSecrets([
      { label: 'openai-default', token: TOKEN_CODEX, provider: 'openai' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    const codexStub = makeStubAdapter({
      toolName: 'codex',
      locations: [{ type: 'file', path: join(mcHomeDir, 'codex-should-not-write.json') }],
    });
    delete process.env.MC_VAULT_PASSPHRASE;
    const res = await materialiseForSession({
      sessionId: 'sess-codex-no-vault',
      portal,
      adapters: [codexStub],
      deps: { cacheDeps },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.materialised.length, 0);
    assert.equal(codexStub._calls.materialise.length, 0);
    assert.ok(res.skipped.some((s) => s.tool === 'codex' && s.reason === 'no-provider-mapping'));
  });

  it('with cached key: materialises matching secret + writes manifest', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'anthropic-default', token: TOKEN_CLAUDE, provider: 'anthropic' },
      { label: 'openai-default', token: TOKEN_CODEX, provider: 'openai' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const claudeLoc = { type: 'file', path: join(mcHomeDir, 'claude-materialised.json') };
    const codexLoc = { type: 'file', path: join(mcHomeDir, 'codex-materialised.json') };
    const claudeStub = makeStubAdapter({ toolName: 'claude', locations: [claudeLoc] });
    const codexStub = makeStubAdapter({ toolName: 'codex', locations: [codexLoc] });

    const res = await materialiseForSession({
      sessionId: 'sess-ok',
      portal,
      adapters: [claudeStub, codexStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.materialised.length, 1);
    // Claude gets the matching Anthropic token. Codex must not receive a generic
    // OpenAI token; Codex may be using ChatGPT/Pro auth in its own auth file.
    assert.equal(claudeStub._calls.materialise.length, 1);
    assert.equal(claudeStub._calls.materialise[0].token, TOKEN_CLAUDE);
    assert.equal(codexStub._calls.materialise.length, 0);
    assert.ok(res.skipped.some((s) => s.tool === 'codex' && s.reason === 'no-provider-mapping'));

    // Manifest persisted at the documented location.
    const path = manifestPath('sess-ok');
    assert.ok(existsSync(path), 'manifest file must exist');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.sessionId, 'sess-ok');
    assert.equal(manifest.materialised.length, 1);
    // Manifest must NEVER contain the token.
    const body = readFileSync(path, 'utf8');
    assert.ok(!body.includes(TOKEN_CLAUDE), 'manifest leaked anthropic token');
    assert.ok(!body.includes(TOKEN_CODEX), 'manifest leaked openai token');
  });

  it('with repo bindings: materialises the repo-bound secret instead of another provider match', async () => {
    const projectToken = 'sk-ant-project-bound-token';
    const globalToken = 'sk-ant-global-token';
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'anthropic-global', token: globalToken, provider: 'anthropic' },
      { label: 'anthropic-project', token: projectToken, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-repo-bound-wt');
    writeRepoBindings(worktree, { ANTHROPIC_API_KEY: 'anthropic-project' });
    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'repo-bound-claude.json') }],
    });

    const res = await materialiseForSession({
      sessionId: 'sess-repo-bound',
      worktreePath: worktree,
      portal,
      adapters: [claudeStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.materialised.length >= 1);
    assert.equal(res.materialised.find((m) => m.tool === 'claude')?.label, 'anthropic-project');
    assert.equal(claudeStub._calls.materialise.length, 1);
    assert.equal(claudeStub._calls.materialise[0].token, projectToken);
    assert.notEqual(claudeStub._calls.materialise[0].token, globalToken);
  });

  it('with repo bindings: never falls back to an unbound global secret', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'anthropic-global', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-no-fallback-wt');
    writeRepoBindings(worktree, { ANTHROPIC_API_KEY: 'anthropic-other-project' });
    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'no-fallback-claude.json') }],
    });

    const res = await materialiseForSession({
      sessionId: 'sess-no-fallback',
      worktreePath: worktree,
      portal,
      adapters: [claudeStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.materialised.length, 0);
    assert.equal(claudeStub._calls.materialise.length, 0);
    assert.ok(res.skipped.some((s) => s.tool === 'claude' && s.reason === 'no-repo-bound-secret'));
  });

  it('with repo bindings: materialises dotenv secrets and shreds them on session end', async () => {
    const token = 'repo-openai-secret-value-123';
    const label = 'wrangler:memoro:OPENAI_API_KEY';
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label, token, provider: 'wrangler', account: 'memoro' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-repo-dotenv-wt');
    writeRepoBindings(worktree, { OPENAI_API_KEY: label }, '.dev.vars');
    const codexStub = makeStubAdapter({
      toolName: 'codex',
      locations: [{ type: 'file', path: join(mcHomeDir, 'codex-no-auth-write.json') }],
    });

    const res = await materialiseForSession({
      sessionId: 'sess-repo-dotenv',
      worktreePath: worktree,
      portal,
      adapters: [codexStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(codexStub._calls.materialise.length, 0, 'repo app secret must not become Codex native auth');
    assert.ok(res.materialised.some((m) => m.tool === 'repo' && m.location.source === '.dev.vars'));
    const body = readFileSync(join(worktree, '.dev.vars'), 'utf8');
    assert.match(body, /mc vault materialised begin/);
    assert.match(body, /OPENAI_API_KEY=repo-openai-secret-value-123/);

    const returned = JSON.stringify(res);
    assert.ok(!returned.includes(token), `materialise result leaked token: ${returned}`);
    const manifest = readFileSync(manifestPath('sess-repo-dotenv'), 'utf8');
    assert.ok(!manifest.includes(token), 'manifest must not contain the token value');

    const shred = await shredForSession({
      sessionId: 'sess-repo-dotenv',
      worktreePath: worktree,
      adapters: [codexStub],
      deps: { cacheDeps },
    });
    assert.equal(shred.ok, true, JSON.stringify(shred));
    assert.equal(existsSync(join(worktree, '.dev.vars')), false, 'created runtime secret file should be removed');
  });

  it('with repo bindings: refuses to overwrite an existing dotenv key', async () => {
    const token = 'repo-openai-secret-value-456';
    const label = 'wrangler:memoro:OPENAI_API_KEY';
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label, token, provider: 'wrangler', account: 'memoro' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-repo-dotenv-conflict-wt');
    writeRepoBindings(worktree, { OPENAI_API_KEY: label }, '.dev.vars');
    writeFileSync(join(worktree, '.dev.vars'), 'OPENAI_API_KEY=already-here\n');
    const codexStub = makeStubAdapter({
      toolName: 'codex',
      locations: [{ type: 'file', path: join(mcHomeDir, 'codex-conflict.json') }],
    });

    const res = await materialiseForSession({
      sessionId: 'sess-repo-dotenv-conflict',
      worktreePath: worktree,
      portal,
      adapters: [codexStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.materialised.some((m) => m.tool === 'repo'), false);
    assert.ok(res.skipped.some((s) => s.tool === 'repo' && s.key === 'OPENAI_API_KEY' && s.reason === 'key-already-present'));
    assert.equal(readFileSync(join(worktree, '.dev.vars'), 'utf8'), 'OPENAI_API_KEY=already-here\n');
  });

  it('with cached key: explicit target_tool=codex is the only Codex materialisation path', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'openai-provider-only', token: 'sk-openai-provider-only', provider: 'openai' },
      {
        label: 'openai-codex-explicit',
        token: TOKEN_CODEX,
        provider: 'openai',
        targetTool: 'codex',
        targetAuthMode: 'api_key',
        targetLocation: 'native-auth',
      },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const codexLoc = { type: 'file', path: join(mcHomeDir, 'codex-explicit.json') };
    const codexStub = makeStubAdapter({ toolName: 'codex', locations: [codexLoc] });
    const res = await materialiseForSession({
      sessionId: 'sess-codex-explicit',
      portal,
      adapters: [codexStub],
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.materialised.length, 1);
    assert.equal(res.materialised[0].tool, 'codex');
    assert.equal(res.materialised[0].label, 'openai-codex-explicit');
    assert.equal(codexStub._calls.materialise.length, 1);
    assert.equal(codexStub._calls.materialise[0].token, TOKEN_CODEX);
    assert.notEqual(codexStub._calls.materialise[0].token, 'sk-openai-provider-only');
  });

  it('skips adapters without a matching secret', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      // ONLY anthropic — codex should be skipped.
      { label: 'a', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'c.json') }],
    });
    const codexStub = makeStubAdapter({
      toolName: 'codex',
      locations: [{ type: 'file', path: join(mcHomeDir, 'cx.json') }],
    });

    const res = await materialiseForSession({
      sessionId: 'sess-partial',
      portal,
      adapters: [claudeStub, codexStub],
      deps: { cacheDeps },
    });
    assert.equal(res.ok, true);
    assert.equal(res.materialised.length, 1);
    assert.equal(res.materialised[0].tool, 'claude');
    assert.equal(codexStub._calls.materialise.length, 0);
    assert.ok(res.skipped.some((s) => s.tool === 'codex' && s.reason === 'no-provider-mapping'));
  });

  it('CI path: MC_VAULT_PASSPHRASE unlocks without cache', async () => {
    const { portal } = await bootstrapVaultWithSecrets([
      { label: 'a', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps(); // empty
    process.env.MC_VAULT_PASSPHRASE = PW;
    try {
      const claudeStub = makeStubAdapter({
        toolName: 'claude',
        locations: [{ type: 'file', path: join(mcHomeDir, 'ci.json') }],
      });
      const res = await materialiseForSession({
        sessionId: 'sess-ci',
        portal,
        adapters: [claudeStub],
        deps: { cacheDeps },
      });
      assert.equal(res.ok, true);
      assert.equal(res.materialised.length, 1);
      assert.equal(claudeStub._calls.materialise[0].token, TOKEN_CLAUDE);
    } finally {
      delete process.env.MC_VAULT_PASSPHRASE;
    }
  });

  it('installs the PreToolUse hook when worktreePath is provided', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'a', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-with-hook-wt');
    mkdirSync(worktree, { recursive: true });

    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'hook-claude.json') }],
    });
    const res = await materialiseForSession({
      sessionId: 'sess-with-hook',
      worktreePath: worktree,
      portal,
      adapters: [claudeStub],
      deps: { cacheDeps },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.hook, 'res.hook must be populated');
    assert.equal(typeof res.hook.installedSettingsPath, 'string');
    assert.equal(res.hook.settingsCreated, true);
    // settings.json + script both exist.
    assert.ok(existsSync(res.hook.installedSettingsPath));
    assert.ok(existsSync(res.hook.hookScriptPath));
    // Manifest carries the hook block.
    const manifest = JSON.parse(readFileSync(manifestPath('sess-with-hook'), 'utf8'));
    assert.ok(manifest.hooks, 'manifest.hooks must be present');
    assert.equal(manifest.hooks.settingsCreated, true);
  });

  it('skips hook install when nothing materialised', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      // Vault has no matching secret for our installed adapter.
      { label: 'a', token: 'sk-other-zzz3', provider: 'unknown-provider' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const worktree = join(mcHomeDir, 'sess-empty-wt');
    mkdirSync(worktree, { recursive: true });
    const claudeStub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'empty-claude.json') }],
    });
    const res = await materialiseForSession({
      sessionId: 'sess-empty-hook',
      worktreePath: worktree,
      portal,
      adapters: [claudeStub],
      deps: { cacheDeps },
    });
    assert.equal(res.ok, true);
    assert.equal(res.materialised.length, 0);
    assert.equal(res.hook, null);
    // No hook script was written.
    assert.equal(existsSync(join(worktree, '.claude')), false);
  });

  it('returned object never embeds the token value', async () => {
    const { portal, vaultKeyBytes } = await bootstrapVaultWithSecrets([
      { label: 'a', token: TOKEN_CLAUDE, provider: 'anthropic' },
    ]);
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });
    const stub = makeStubAdapter({
      toolName: 'claude',
      locations: [{ type: 'file', path: join(mcHomeDir, 'noleak.json') }],
    });
    const res = await materialiseForSession({
      sessionId: 'sess-noleak',
      portal,
      adapters: [stub],
      deps: { cacheDeps },
    });
    const serialised = JSON.stringify(res);
    assert.ok(!serialised.includes(TOKEN_CLAUDE),
      `materialiseForSession return leaked: ${serialised}`);
  });
});

describe('credential-blind materialiseForSession', () => {
  it('returns before vault, adapter, repo, manifest, or hook side effects', async () => {
    const forbidden = () => {
      throw new Error('credential-bearing dependency must not be called');
    };
    const adapter = {
      TOOL_NAME: 'generic',
      tokenLocations: forbidden,
      materializeToken: forbidden,
    };
    const result = await materialiseForSession({
      sessionId: 'credential-blind',
      worktreePath: '/must-not-be-read',
      portal: new Proxy({}, { get: forbidden }),
      adapters: [adapter],
      deps: {
        mkdir: forbidden,
        writeFile: forbidden,
        readFile: forbidden,
        cacheDeps: new Proxy({}, { get: forbidden }),
      },
    });

    assert.deepEqual(result, {
      ok: true,
      policy: 'credential-blind-v1',
      materialised: [],
      skipped: [{ reason: 'plaintext-materialisation-disabled' }],
    });
  });

  it('repo dotenv materialisation refuses a decrypted value without filesystem access', async () => {
    const forbidden = () => {
      throw new Error('filesystem dependency must not be called');
    };
    const result = await materialiseRepoBoundSecrets({
      bindings: {
        version: 1,
        sources: [{
          file: '.env',
          format: 'dotenv',
          materialise: 'file',
          keys: { API_TOKEN: 'provider-secret' },
        }],
      },
      matches: [{
        label: 'provider-secret',
        payload: { token: 'sentinel-must-not-be-written' },
      }],
      worktreePath: '/must-not-be-written',
      sessionId: 'credential-blind',
      deps: {
        existsSync: forbidden,
        readFile: forbidden,
        writeFile: forbidden,
        mkdir: forbidden,
      },
    });

    assert.deepEqual(result, {
      materialised: [],
      skipped: [{ tool: 'repo', reason: 'plaintext-materialisation-disabled' }],
    });
    assert.doesNotMatch(JSON.stringify(result), /sentinel-must-not-be-written/);
  });
});

describe('shredForSession', () => {
  let mcHomeDir;
  before(() => {
    mcHomeDir = mkdtempSync(join(tmpdir(), 'mc-vault-shred-'));
    process.env.MC_HOME = mcHomeDir;
  });
  after(() => {
    delete process.env.MC_HOME;
    try { rmSync(mcHomeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('reads manifest + calls adapter.shredToken for each entry', async () => {
    // Write a manifest by hand so we don't need to materialise first.
    const stateDir = join(mcHomeDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const manifest = {
      schema: 1,
      sessionId: 'sess-end',
      createdAt: new Date().toISOString(),
      materialised: [
        { tool: 'claude', label: 'a', location: { type: 'file', path: '/tmp/never' } },
        { tool: 'codex',  label: 'b', location: { type: 'file', path: '/tmp/never2' } },
      ],
    };
    writeFileSync(manifestPath('sess-end'), JSON.stringify(manifest));

    const claudeStub = makeStubAdapter({ toolName: 'claude', locations: [] });
    const codexStub = makeStubAdapter({ toolName: 'codex', locations: [] });
    const res = await shredForSession({
      sessionId: 'sess-end',
      adapters: [claudeStub, codexStub],
    });
    assert.equal(res.ok, true);
    assert.equal(res.shredded.length, 2);
    assert.equal(claudeStub._calls.shred.length, 1);
    assert.equal(codexStub._calls.shred.length, 1);
    // Manifest removed.
    assert.equal(existsSync(manifestPath('sess-end')), false);
  });

  it('retains a readable manifest on shred failure when repair mode is enabled', async () => {
    const sessionId = 'sess-repairable-failure';
    mkdirSync(join(mcHomeDir, 'state'), { recursive: true });
    writeFileSync(manifestPath(sessionId), JSON.stringify({
      schema: 1,
      sessionId,
      materialised: [
        { tool: 'claude', location: { type: 'file', path: '/tmp/repairable-secret' } },
      ],
    }));
    const failingAdapter = {
      TOOL_NAME: 'claude',
      async shredToken() {
        return { ok: false, reason: 'permission-denied' };
      },
    };

    const res = await shredForSession({
      sessionId,
      adapters: [failingAdapter],
      retainManifestOnFailure: true,
    });

    assert.equal(res.ok, false);
    assert.equal(res.failures[0].reason, 'permission-denied');
    assert.equal(existsSync(manifestPath(sessionId)), true);
  });

  it('retains the manifest when an adapter reports success but leaves its file behind', async () => {
    const sessionId = 'sess-verification-leftover';
    const materialisedPath = join(mcHomeDir, 'leftover-token.json');
    mkdirSync(join(mcHomeDir, 'state'), { recursive: true });
    writeFileSync(materialisedPath, 'secret');
    writeFileSync(manifestPath(sessionId), JSON.stringify({
      schema: 1,
      sessionId,
      materialised: [
        { tool: 'claude', location: { type: 'file', path: materialisedPath } },
      ],
    }));
    const lyingAdapter = {
      TOOL_NAME: 'claude',
      async shredToken() {
        return { ok: true, removed: true };
      },
    };

    const res = await shredForSession({
      sessionId,
      adapters: [lyingAdapter],
      retainManifestOnFailure: true,
    });

    assert.equal(res.ok, false);
    assert.equal(res.failures[0].reason, 'materialised-file-leftover');
    assert.equal(res.verification.manifest_absent, false);
    assert.equal(res.verification.leftovers[0].location.path, materialisedPath);
    assert.equal(existsSync(manifestPath(sessionId)), true);
  });

  it('retains an unreadable manifest when repair mode is enabled', async () => {
    const sessionId = 'sess-repairable-unreadable';
    mkdirSync(join(mcHomeDir, 'state'), { recursive: true });
    writeFileSync(manifestPath(sessionId), '{not-json');

    const res = await shredForSession({
      sessionId,
      adapters: [],
      retainManifestOnFailure: true,
    });

    assert.equal(res.ok, false);
    assert.match(res.reason, /manifest-unreadable/);
    assert.equal(existsSync(manifestPath(sessionId)), true);
  });

  it('keeps legacy manifest cleanup on failure unless repair mode is requested', async () => {
    const sessionId = 'sess-legacy-failure-cleanup';
    mkdirSync(join(mcHomeDir, 'state'), { recursive: true });
    writeFileSync(manifestPath(sessionId), JSON.stringify({
      schema: 1,
      sessionId,
      materialised: [
        { tool: 'missing-adapter', location: { type: 'file', path: '/tmp/legacy-secret' } },
      ],
    }));

    const res = await shredForSession({ sessionId, adapters: [] });

    assert.equal(res.ok, false);
    assert.equal(existsSync(manifestPath(sessionId)), false);
  });

  it('removes the manifest after full success even when repair mode is enabled', async () => {
    const sessionId = 'sess-repairable-success';
    mkdirSync(join(mcHomeDir, 'state'), { recursive: true });
    writeFileSync(manifestPath(sessionId), JSON.stringify({
      schema: 1,
      sessionId,
      materialised: [],
    }));

    const res = await shredForSession({
      sessionId,
      adapters: [],
      retainManifestOnFailure: true,
    });

    assert.equal(res.ok, true);
    assert.equal(existsSync(manifestPath(sessionId)), false);
  });

  it('no-manifest is a no-op with ok:true', async () => {
    const res = await shredForSession({
      sessionId: 'never-existed',
      adapters: [],
    });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'no-manifest');
  });

  it('uninstalls the PreToolUse hook when manifest.hooks is present', async () => {
    const stateDir = join(mcHomeDir, 'state');
    mkdirSync(stateDir, { recursive: true });

    // Build a worktree with an mc-installed hook so shred can unwind it.
    const worktree = join(mcHomeDir, 'sess-shred-hook-wt');
    mkdirSync(worktree, { recursive: true });
    const { installHook } = await import('../../../src/vault/engine/hook.js');
    const sessionId = 'sess-shred-hook';
    const installRes = await installHook({
      worktreePath: worktree,
      sessionId,
      manifestPath: manifestPath(sessionId),
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.settingsCreated, true);
    assert.ok(existsSync(installRes.installedSettingsPath));
    assert.ok(existsSync(installRes.hookScriptPath));

    // Write a manifest that references the hook.
    writeFileSync(manifestPath(sessionId), JSON.stringify({
      schema: 1,
      sessionId,
      materialised: [],
      hooks: {
        installedSettingsPath: installRes.installedSettingsPath,
        hookScriptPath: installRes.hookScriptPath,
        settingsCreated: true,
      },
    }));

    const res = await shredForSession({
      sessionId, worktreePath: worktree, adapters: [],
    });
    assert.equal(res.ok, true);
    // settings.json removed (mc created it, only mc entries inside).
    assert.equal(existsSync(installRes.installedSettingsPath), false);
    // hook script also gone.
    assert.equal(existsSync(installRes.hookScriptPath), false);
  });

  it('is idempotent — running twice doesn\'t error', async () => {
    const stateDir = join(mcHomeDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(manifestPath('sess-twice'), JSON.stringify({
      schema: 1, sessionId: 'sess-twice', materialised: [],
    }));
    const r1 = await shredForSession({ sessionId: 'sess-twice', adapters: [] });
    assert.equal(r1.ok, true);
    const r2 = await shredForSession({ sessionId: 'sess-twice', adapters: [] });
    assert.equal(r2.ok, true);
  });
});
