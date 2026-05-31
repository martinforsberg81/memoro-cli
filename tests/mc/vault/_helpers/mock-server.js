/**
 * In-memory mock of the Memoro vault HTTP API surface used by tests.
 *
 * Exposes a `memoroFetch`-shaped function that handles the same paths
 * the production server does. Stores per-userId vault state in a
 * single object so tests can:
 *
 *   - simulate setup → unlock → CRUD → lock without spinning a Worker
 *   - inspect raw stored ciphertext (the server never sees plaintext)
 *   - assert on calls made (path, method, body) via .calls
 *
 * Mirrors the server behaviour from ~/memoro/src/routes/vault/index.js
 * closely enough for the mc client tests; not 100% reproduction (we
 * skip rate limiting + multi-user concurrency since those aren't part
 * of phase 1's contract).
 */

import { createHash } from 'node:crypto';

export function createMockVaultServer({ userId = 'usr_test' } = {}) {
  let config = null; // { auth_hash, salt, iterations, created_at, updated_at }
  let secrets = []; // [{ id, secret_type, encrypted_label, encrypted_data, iv, label_iv, ... }]
  let unlocked = false;
  let idCounter = 0;
  const calls = [];

  function hashAuthHash(authHash) {
    return createHash('sha256').update(authHash, 'utf8').digest('hex');
  }

  function generateSaltB64() {
    // 32-byte deterministic-ish salt for tests; production uses crypto.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 13 + 7 + secrets.length + (config ? 1 : 0)) & 0xff;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  async function memoroFetch(apiUrl, path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body || null;
    calls.push({ path, method, body });

    if (path === '/api/vault/status' && method === 'GET') {
      return {
        ok: true,
        vault: {
          setup: !!config,
          unlocked,
          salt: config?.salt || null,
          iterations: config?.iterations || null,
          createdAt: config?.created_at || null,
        },
      };
    }

    if (path === '/api/vault/setup' && method === 'POST') {
      if (config) {
        const err = new Error('Memoro 409: Vault already exists');
        err.status = 409; err.data = { ok: false, error: 'Vault already exists' };
        throw err;
      }
      if (!body?.authHash) {
        const err = new Error('Memoro 400: authHash is required');
        err.status = 400;
        throw err;
      }
      const salt = generateSaltB64();
      config = {
        auth_hash: hashAuthHash(body.authHash),
        salt, iterations: 600_000,
        created_at: 't0', updated_at: 't0',
      };
      return { ok: true, salt };
    }

    if (path === '/api/vault/unlock' && method === 'POST') {
      if (!config) {
        const err = new Error('Memoro 404: Vault not set up');
        err.status = 404; err.data = { ok: false, error: 'Vault not set up', code: 'NO_VAULT' };
        throw err;
      }
      if (hashAuthHash(body.authHash) !== config.auth_hash) {
        const err = new Error('Memoro 401: Invalid master password');
        err.status = 401; err.data = { ok: false, error: 'Invalid master password', code: 'INVALID_PASSWORD' };
        throw err;
      }
      unlocked = true;
      return { ok: true, salt: config.salt, iterations: config.iterations };
    }

    if (path === '/api/vault/lock' && method === 'POST') {
      unlocked = false;
      return { ok: true };
    }

    if (path === '/api/vault' && method === 'DELETE') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked');
        err.status = 403;
        throw err;
      }
      config = null;
      secrets = [];
      unlocked = false;
      return { ok: true };
    }

    if (path === '/api/vault/change-password' && method === 'POST') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked'); err.status = 403; throw err;
      }
      if (hashAuthHash(body.currentAuthHash) !== config.auth_hash) {
        const err = new Error('Memoro 401: Invalid current password'); err.status = 401; throw err;
      }
      config.auth_hash = hashAuthHash(body.newAuthHash);
      config.salt = body.newSalt || generateSaltB64();
      config.updated_at = `t${++idCounter}`;
      return { ok: true, salt: config.salt };
    }

    if (path === '/api/vault/secrets' && method === 'GET') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked'); err.status = 403; throw err;
      }
      return { ok: true, secrets };
    }

    if (path === '/api/vault/secrets' && method === 'POST') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked'); err.status = 403; throw err;
      }
      const id = `vid_${++idCounter}`;
      const now = `t${idCounter}`;
      const secret = {
        id,
        secret_type: body.secretType,
        encrypted_label: body.encryptedLabel,
        encrypted_data: body.encryptedData,
        iv: body.iv,
        label_iv: body.labelIv,
        created_at: now,
        updated_at: now,
      };
      secrets.unshift(secret);
      return { ok: true, secret: { id, secret_type: body.secretType, created_at: now, updated_at: now } };
    }

    const putMatch = path.match(/^\/api\/vault\/secrets\/([^/]+)$/);
    if (putMatch && method === 'PUT') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked'); err.status = 403; throw err;
      }
      const id = decodeURIComponent(putMatch[1]);
      const s = secrets.find(x => x.id === id);
      if (!s) {
        const err = new Error('Memoro 404: Secret not found'); err.status = 404; throw err;
      }
      if (body.encryptedLabel) s.encrypted_label = body.encryptedLabel;
      if (body.encryptedData)  s.encrypted_data  = body.encryptedData;
      if (body.iv)             s.iv              = body.iv;
      if (body.labelIv)        s.label_iv        = body.labelIv;
      if (body.secretType)     s.secret_type     = body.secretType;
      s.updated_at = `t${++idCounter}`;
      return { ok: true };
    }
    const delMatch = path.match(/^\/api\/vault\/secrets\/([^/]+)$/);
    if (delMatch && method === 'DELETE') {
      if (!unlocked) {
        const err = new Error('Memoro 403: Vault is locked'); err.status = 403; throw err;
      }
      const id = decodeURIComponent(delMatch[1]);
      const before = secrets.length;
      secrets = secrets.filter(x => x.id !== id);
      if (secrets.length === before) {
        const err = new Error('Memoro 404: Secret not found'); err.status = 404; throw err;
      }
      return { ok: true };
    }

    const err = new Error(`mock-vault: unhandled ${method} ${path}`);
    err.status = 404;
    throw err;
  }

  return {
    memoroFetch,
    calls,
    inspect: () => ({
      config,
      unlocked,
      secrets: secrets.map(s => ({ ...s })),
    }),
    forceLock: () => { unlocked = false; },
    userId,
  };
}

export function makeTestPortal(server) {
  return {
    apiUrl: 'http://test.invalid',
    token: 'mem_test_token',
    memoroFetch: server.memoroFetch,
  };
}
