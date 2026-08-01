import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  hydrateToolAuth,
  persistToolAuth,
  publicToolAuthResult,
  resolveToolAuthSpec,
  TOOL_AUTH_MODE,
  toolAuthProfileLabel,
} from '../../src/mc/tool-auth.js';
import {
  bytesToBase64,
  decryptSecretPayload,
  deriveVaultKeys,
  encryptSecretPayload,
} from '../../src/vault/engine/client-crypto.js';
import { cacheVaultKey } from '../../src/vault/engine/key-cache.js';
import { buildSecretPayload, normaliseSecretPayload } from '../../src/vault/engine/types.js';
import { createMockVaultServer, makeTestPortal } from '../vault/engine/_helpers/mock-server.js';

const PW = 'tool-auth-test-master-password';
const SECRET_AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'codex-secret-access-token' },
  last_refresh: '2026-07-13T10:00:00.000Z',
});

function makeMemCacheDeps() {
  const store = new Map();
  return {
    async getSecret(account) { return store.get(account) ?? null; },
    async setSecret(account, value) { store.set(account, value); return 'mem'; },
    async deleteSecret(account) { store.delete(account); return 'mem'; },
    now: () => Date.now(),
  };
}

async function bootstrapVault() {
  const server = createMockVaultServer();
  const portal = makeTestPortal(server);
  const placeholderSalt = bytesToBase64(new Uint8Array(32));
  const { authHash: ph } = await deriveVaultKeys(PW, placeholderSalt);
  const setupRes = await server.memoroFetch('', '/api/vault/setup', { method: 'POST', body: { authHash: ph } });
  const realSalt = setupRes.salt;
  const { authHash, vaultKey, vaultKeyBytes } = await deriveVaultKeys(PW, realSalt);
  await server.memoroFetch('', '/api/vault/unlock', { method: 'POST', body: { authHash: ph } });
  await server.memoroFetch('', '/api/vault/change-password', {
    method: 'POST',
    body: { currentAuthHash: ph, newAuthHash: authHash, newSalt: realSalt },
  });
  await server.memoroFetch('', '/api/vault/unlock', { method: 'POST', body: { authHash } });
  return { server, portal, vaultKey, vaultKeyBytes };
}

async function createToolAuthSecret({ portal, vaultKey, label = 'tool_auth.codex', body = SECRET_AUTH_JSON } = {}) {
  const enc = await encryptSecretPayload(vaultKey, label, buildSecretPayload({
    kind: 'oauth_token',
    token: body,
    provider: 'openai',
    targetTool: 'codex',
    targetAuthMode: TOOL_AUTH_MODE,
    targetLocation: 'codex.auth.json',
    extra: {
      tool_auth_schema: 'mc-tool-auth-v1',
      artifact_format: 'json',
      artifact_shape: 'codex-auth-json-v1',
    },
  }));
  await portal.memoroFetch('', '/api/vault/secrets', {
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

describe('tool auth specs', () => {
  test('normalizes codex profile label and deterministic CODEX_HOME', () => {
    const spec = resolveToolAuthSpec({
      tool: 'codex',
      cloudSessionId: 'cld_runtime1',
      env: { MC_HOME: '/workspace/.memoro/mc' },
    });

    assert.equal(spec.ok, true);
    assert.equal(spec.label, 'tool_auth.codex');
    assert.equal(spec.launchEnv.CODEX_HOME, join('/workspace/.memoro/mc', 'tool-auth', 'codex', 'cld_runtime1'));
    assert.equal(spec.authPath, join(spec.launchEnv.CODEX_HOME, 'auth.json'));
    assert.equal(toolAuthProfileLabel('claude-code'), 'tool_auth.claude');
  });
});

describe.skip('legacy vault-backed hydrateToolAuth', () => {
  test('hydrates codex auth JSON from vault without exposing the artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-tool-auth-hydrate-'));
    const { portal, vaultKey, vaultKeyBytes } = await bootstrapVault();
    await createToolAuthSecret({ portal, vaultKey });
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });

    const res = await hydrateToolAuth({
      tool: 'codex',
      cloudSessionId: 'cld_runtime1',
      portal,
      env: { CODEX_HOME: join(dir, 'codex-home') },
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true);
    assert.equal(res.present, true);
    assert.equal(res.hydrated, true);
    assert.equal(res.repair_required, false);
    assert.equal(res.env.CODEX_HOME, join(dir, 'codex-home'));
    const body = readFileSync(join(dir, 'codex-home', 'auth.json'), 'utf8');
    assert.deepEqual(JSON.parse(body), JSON.parse(SECRET_AUTH_JSON));

    const publicJson = JSON.stringify(publicToolAuthResult(res));
    assert.equal(publicJson.includes('codex-secret-access-token'), false);
    assert.equal(publicJson.includes('CODEX_HOME'), false);
  });

  test('returns repair metadata when vault is locked', async () => {
    const res = await hydrateToolAuth({
      tool: 'codex',
      cloudSessionId: 'cld_runtime1',
      env: {},
      deps: { cacheDeps: makeMemCacheDeps() },
    });

    assert.equal(res.ok, true);
    assert.equal(res.hydrated, false);
    assert.equal(res.repair_required, true);
    assert.equal(res.repair_action, 'unlock_vault');
    assert.equal(JSON.stringify(res).includes('token'), false);
  });
});

describe.skip('legacy vault-backed persistToolAuth', () => {
  test('creates tool_auth.codex from a runtime Codex auth file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-tool-auth-persist-'));
    const codexHome = join(dir, 'codex-home');
    const authPath = join(codexHome, 'auth.json');
    const { server, portal, vaultKey, vaultKeyBytes } = await bootstrapVault();
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(authPath, SECRET_AUTH_JSON, { mode: 0o600, flag: 'w' });

    const res = await persistToolAuth({
      tool: 'codex',
      cloudSessionId: 'cld_runtime1',
      portal,
      env: { CODEX_HOME: codexHome },
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true);
    assert.equal(res.persisted, true);
    assert.equal(res.changed, true);
    assert.equal(res.action, 'created');
    assert.equal(JSON.stringify(publicToolAuthResult(res)).includes('codex-secret-access-token'), false);

    const stored = server.inspect().secrets[0];
    const decrypted = await decryptSecretPayload(vaultKey, stored);
    assert.equal(decrypted.label, 'tool_auth.codex');
    const payload = normaliseSecretPayload(decrypted.data);
    assert.equal(payload.target_tool, 'codex');
    assert.equal(payload.target_auth_mode, TOOL_AUTH_MODE);
    assert.deepEqual(JSON.parse(payload.token), JSON.parse(SECRET_AUTH_JSON));
  });

  test('reports unchanged when the vault profile already matches the auth file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-tool-auth-unchanged-'));
    const codexHome = join(dir, 'codex-home');
    const authPath = join(codexHome, 'auth.json');
    const { portal, vaultKey, vaultKeyBytes } = await bootstrapVault();
    await createToolAuthSecret({ portal, vaultKey });
    const cacheDeps = makeMemCacheDeps();
    await cacheVaultKey(vaultKeyBytes, { deps: cacheDeps });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(authPath, SECRET_AUTH_JSON, { mode: 0o600, flag: 'w' });

    const res = await persistToolAuth({
      tool: 'codex',
      cloudSessionId: 'cld_runtime1',
      portal,
      env: { CODEX_HOME: codexHome },
      deps: { cacheDeps },
    });

    assert.equal(res.ok, true);
    assert.equal(res.persisted, true);
    assert.equal(res.changed, false);
    assert.equal(res.reason, 'unchanged');
  });
});

describe('credential-blind tool auth containment', () => {
  for (const [verb, invoke] of [
    ['hydrate', hydrateToolAuth],
    ['persist', persistToolAuth],
  ]) {
    test(`${verb} never reads vault or native auth files`, async () => {
      const forbidden = () => {
        throw new Error('credential-bearing dependency must not be called');
      };
      const result = await invoke({
        tool: 'codex',
        cloudSessionId: 'cld_runtime1',
        env: { MC_HOME: '/runtime/mc' },
        portal: new Proxy({}, { get: forbidden }),
        deps: {
          readAuthFile: forbidden,
          writeAuthFile: forbidden,
          cacheDeps: new Proxy({}, { get: forbidden }),
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.reason, 'vault-tool-auth-disabled');
      assert.equal(result.repair_action, 'complete_tool_login');
      assert.equal(result.repair_required, true);
      assert.equal(result.hydrated || false, false);
      assert.equal(result.persisted || false, false);
      assert.doesNotMatch(JSON.stringify(publicToolAuthResult(result)), /token|authPath/i);
    });
  }
});
