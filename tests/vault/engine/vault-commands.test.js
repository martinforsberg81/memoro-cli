/**
 * In-process tests for `mc vault` verbs against an in-memory mock server.
 *
 * Why in-process (not subprocess): keeps PBKDF2 (~150 ms) out of every
 * subprocess boot, lets us share a single mock-server instance across
 * verbs, and lets us pass a portal stub via the `run(argv, opts)` second
 * argument (injectable dep-portal pattern).
 *
 * Subprocess test coverage lives in `vault-cli.test.js` — that one
 * verifies argv parsing, exit codes, stderr routing, and (crucially)
 * the secret-bytes-never-leak invariant from end to end.
 *
 * All tests use MC_VAULT_PASSPHRASE so we never block on the hidden
 * prompt. Tests must restore the env after themselves.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { memoroFetch } from '../../../src/lib/api.js';
import { run as vaultRunRaw } from '../../../src/cli/vault.js';
import { PBKDF2_ITERATIONS, bytesToBase64, deriveVaultKeys, encryptSecretPayload } from '../../../src/vault/engine/client-crypto.js';
import { decryptEnvelopeSecret, mintCustodyRoot, unwrapCustodyRoot } from '../../../src/vault/engine/custody-crypto.js';
import { createMockVaultServer, makeTestPortal } from './_helpers/mock-server.js';

const PW = 'this-is-a-long-test-master-password';
const WRONG_PW = 'wrong-password';
const NEW_PW = 'a-new-master-password-12345';

/**
 * The verbs' key derivation, shared across the file: the real
 * 600k-iteration `deriveVaultKeys`, computed once per (password, salt,
 * iterations) and then answered from the memo. Each derivation costs
 * 150 ms on an idle machine and several times that under load, and a
 * test runs up to five of them; the result is a pure function of its
 * inputs, so the memo changes nothing a test reads. New salts come from
 * a fixed source so the memo can be filled before the tests run, all
 * four derivations in parallel (`warmKeys`).
 */
const keys = (() => {
  const memo = new Map();
  return {
    deriveVaultKeys(password, salt, iterations = PBKDF2_ITERATIONS) {
      const key = `${password}\0${salt}\0${iterations}`;
      if (!memo.has(key)) memo.set(key, deriveVaultKeys(password, salt, iterations));
      return memo.get(key);
    },
    getRandomValues(bytes) {
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 3) & 0xff;
      return bytes;
    },
  };
})();

async function warmKeys() {
  // The salt the mock server hands out at setup; setup derives against
  // it and against the fixed placeholder salt, change-password against
  // the fixed salt too.
  const probe = createMockVaultServer();
  const { salt: serverSalt } = await probe.memoroFetch('x', '/api/vault/setup', { method: 'POST', body: { authHash: 'probe' } });
  const fixedSalt = bytesToBase64(keys.getRandomValues(new Uint8Array(32)));
  await Promise.all([
    keys.deriveVaultKeys(PW, fixedSalt),
    keys.deriveVaultKeys(PW, serverSalt),
    keys.deriveVaultKeys(WRONG_PW, serverSalt),
    keys.deriveVaultKeys(NEW_PW, fixedSalt),
  ]);
}

// Filled once as the file loads, outside any test or hook: the four
// derivations are the file's one fixed cost, and under load they take
// near a second together, which no single test should be charged.
await warmKeys();

/**
 * In-memory keychain stand-in for the §12f cache. Without this, tests
 * accidentally read/write the host's real OS keychain and pollute
 * across runs. Each test gets its own store via beforeEach.
 */
function makeMemCacheDeps() {
  const store = new Map();
  return {
    async getSecret(account) { return store.get(account) ?? null; },
    async setSecret(account, value) { store.set(account, value); return 'mem'; },
    async deleteSecret(account) { store.delete(account); return 'mem'; },
    now: () => Date.now(),
    snapshot: () => [...store.entries()],
  };
}

// Each test gets its own cacheDeps assigned in beforeEach; the wrapper
// below threads it through opts so every vault verb runs against the
// in-memory cache.
let activeCacheDeps = null;
function vaultRun(argv, opts = {}) {
  return vaultRunRaw(argv, { cacheDeps: activeCacheDeps, keyDeps: keys, ...opts });
}

// Capture console output per test so we can assert on it without
// polluting test runner output. Returns a restore fn.
function captureConsole() {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { out.push(args.map(String).join(' ')); };
  console.error = (...args) => { err.push(args.map(String).join(' ')); };
  return {
    out, err,
    restore: () => { console.log = origLog; console.error = origErr; },
  };
}

async function portalWithCustody(server, portal) {
  const config = server.inspect().config;
  const { vaultKey } = await keys.deriveVaultKeys(PW, config.salt, config.iterations);
  const custody = await mintCustodyRoot(vaultKey);
  let current = custody;
  return {
    ...portal,
    memoroFetch: async (apiUrl, path, opts) => {
      const result = await portal.memoroFetch(apiUrl, path, opts);
      if (path === '/api/vault/change-password' && result?.ok) {
        current = { wrapped_crk: opts.body.wrappedCrk, crk_iv: opts.body.crkIv };
      }
      const withCustody = (info) => ({ ...info, wrapped_crk: current.wrapped_crk, crk_iv: current.crk_iv });
      if (path === '/api/vault/status') return { ...result, vault: withCustody(result.vault) };
      if (path === '/api/vault/unlock') return withCustody(result);
      return result;
    },
  };
}

describe('mc vault — full lifecycle (in-process)', () => {
  let server, portal, cap;

  before(() => { process.env.MC_VAULT_PASSPHRASE = PW; });
  after(() => { delete process.env.MC_VAULT_PASSPHRASE; });

  beforeEach(() => {
    server = createMockVaultServer();
    portal = makeTestPortal(server);
    activeCacheDeps = makeMemCacheDeps();
    cap = captureConsole();
  });

  it('status on a fresh account reports setup=no', async () => {
    const rc = await vaultRun(['status', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.vault.setup, false);
    assert.equal(out.vault.unlocked, false);
  });

  it('setup creates the vault end to end', async () => {
    const rc = await vaultRun(['setup', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0, cap.err.join('\n'));
    const inspect = server.inspect();
    assert.ok(inspect.config, 'config should exist');
    assert.equal(inspect.unlocked, false, 'setup should leave vault locked at the end');
  });

  it('setup refuses a second setup on the same account', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['setup', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 1);
  });

  it('unlock with the correct password succeeds; wrong password fails', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    let rc = await vaultRun(['unlock', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0, 'unlock with correct password should succeed');
    assert.equal(server.inspect().unlocked, true);

    // Bad password
    server.forceLock();
    process.env.MC_VAULT_PASSPHRASE = WRONG_PW;
    cap = captureConsole();
    rc = await vaultRun(['unlock', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 1);
    assert.equal(server.inspect().unlocked, false);
    process.env.MC_VAULT_PASSPHRASE = PW;
  });

  it('unlock reports when the local key cache cannot be written', async () => {
    await vaultRun(['setup', '--json'], { portal });
    activeCacheDeps = {
      async getSecret() { return null; },
      async setSecret() { throw new Error('keychain unavailable'); },
      async deleteSecret() {},
      now: () => Date.now(),
    };
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(['unlock', '--json'], { portal });
    cap.restore();

    assert.equal(rc, 0);
    assert.equal(server.inspect().unlocked, true);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.ok, true);
    assert.equal(out.cache.stored, false);
  });

  it('lock zeroes the server-side unlock flag', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['unlock', '--json'], { portal });
    assert.equal(server.inspect().unlocked, true);
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(['lock', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0);
    assert.equal(server.inspect().unlocked, false);
  });

  it.skip('legacy set + list + get plaintext round-trip', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    // set
    let rc = await vaultRun(
      ['set', 'anthropic-work', '--type', 'api_token', '--provider', 'anthropic', '--account', 'work', '--no-confirm'],
      { portal },
    );
    cap.restore();
    assert.equal(rc, 0, `set failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);

    // The wire ciphertext must not contain the plaintext value (PW is
    // also used as the secret-value via MC_VAULT_PASSPHRASE). Stronger
    // check: the secret_type on the wire is the WIRE_SECRET_TYPE map.
    const inspect = server.inspect();
    assert.equal(inspect.secrets.length, 1);
    assert.equal(inspect.secrets[0].secret_type, 'api_key',
      'wire secret_type should be the server-accepted alias');
    assert.ok(!inspect.secrets[0].encrypted_data.includes(PW),
      'plaintext should never appear in ciphertext');

    // list --json
    cap = captureConsole();
    rc = await vaultRun(['list', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0);
    const listJson = JSON.parse(cap.out.join('\n'));
    assert.equal(listJson.secrets.length, 1);
    assert.equal(listJson.secrets[0].label, 'anthropic-work');
    assert.equal(listJson.secrets[0].kind, 'api_token');
    assert.equal(listJson.secrets[0].provider, 'anthropic');
    assert.equal(listJson.secrets[0].account, 'work');

    // get --json (auto-skips confirm because --json)
    cap = captureConsole();
    rc = await vaultRun(['get', 'anthropic-work', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0);
    const getJson = JSON.parse(cap.out.join('\n'));
    assert.equal(getJson.secret.label, 'anthropic-work');
    assert.equal(getJson.secret.value, PW, 'get --json should round-trip the value');
  });

  it('set leaves a secret global unless --bind is explicit', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-set-global-'));
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(
      ['set', 'global-openai-test', '--type', 'api_token', '--provider', 'openai', '--account', 'personal', '--json', '--no-confirm'],
      { portal, cwd: dir },
    );
    cap.restore();

    assert.equal(rc, 0, `set failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);
    const out = JSON.parse(cap.out.join('\n'));
    assert.deepEqual(out.writes, []);
    assert.equal(out.binding, null);
    assert.equal(existsSync(join(dir, '.mc', 'secrets.json')), false);
  });

  it.skip('legacy set --bind repo-file binding', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-set-bind-'));
    const label = 'env:manual-repo:OPENAI_API_KEY';
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(
      ['set', label, '--type', 'api_token', '--provider', 'env', '--account', 'manual-repo', '--bind', 'OPENAI_API_KEY', '--json', '--no-confirm'],
      { portal, cwd: dir },
    );
    cap.restore();

    assert.equal(rc, 0, `set failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);
    const out = JSON.parse(cap.out.join('\n'));
    assert.deepEqual(out.writes, [{ path: '.mc/secrets.json', action: 'created' }]);
    assert.equal(out.binding.sources[0].keys.OPENAI_API_KEY, label);

    const bindingsBody = readFileSync(join(dir, '.mc', 'secrets.json'), 'utf8');
    assert.ok(!bindingsBody.includes(PW), 'binding file must not contain the secret value');
    assert.deepEqual(JSON.parse(bindingsBody), {
      version: 1,
      sources: [
        {
          file: '.env',
          format: 'dotenv',
          keys: {
            OPENAI_API_KEY: label,
          },
          materialise: 'file',
        },
      ],
    });

    cap = captureConsole();
    const listRc = await vaultRun(['list', '--json'], { portal });
    cap.restore();
    assert.equal(listRc, 0);
    const list = JSON.parse(cap.out.join('\n'));
    assert.equal(list.secrets[0].label, label);
    assert.equal(list.secrets[0].provider, 'env');
    assert.equal(list.secrets[0].account, 'manual-repo');
  });

  it.skip('legacy bind attaches an existing secret to a repo file', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bind-existing-'));
    const label = 'wrangler:memoro:OPENAI_API_KEY';
    cap.restore(); cap = captureConsole();
    await vaultRun(
      ['set', label, '--type', 'api_token', '--provider', 'wrangler', '--account', 'memoro', '--json', '--no-confirm'],
      { portal, cwd: dir },
    );
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(
      ['bind', label, 'OPENAI_API_KEY', '--bind-file', '.dev.vars', '--json'],
      { portal, cwd: dir },
    );
    cap.restore();

    assert.equal(rc, 0, `bind failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.label, label);
    assert.equal(out.key, 'OPENAI_API_KEY');
    assert.equal(out.file, '.dev.vars');
    assert.deepEqual(out.writes, [{ path: '.mc/secrets.json', action: 'created' }]);
    assert.ok(!JSON.stringify(out).includes(PW), 'bind JSON must not leak the secret value');

    const bindingsBody = readFileSync(join(dir, '.mc', 'secrets.json'), 'utf8');
    assert.ok(!bindingsBody.includes(PW), 'binding file must not contain the secret value');
    assert.deepEqual(JSON.parse(bindingsBody), {
      version: 1,
      sources: [
        {
          file: '.dev.vars',
          format: 'dotenv',
          keys: {
            OPENAI_API_KEY: label,
          },
          materialise: 'file',
        },
      ],
    });
  });

  it.skip('legacy bind dry-run plans a repo-file binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bind-dry-run-'));
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(
      ['bind', 'BRAVE_SEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY', '--file', '.dev.vars', '--dry-run', '--json'],
      { cwd: dir },
    );
    cap.restore();

    assert.equal(rc, 0, `bind dry-run failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.dry_run, true);
    assert.equal(out.binding.sources[0].file, '.dev.vars');
    assert.equal(out.binding.sources[0].keys.BRAVE_SEARCH_API_KEY, 'BRAVE_SEARCH_API_KEY');
    assert.deepEqual(out.writes, [{ path: '.mc/secrets.json', action: 'created' }]);
    assert.equal(existsSync(join(dir, '.mc', 'secrets.json')), false);
  });

  it.skip('legacy bindings lists repo-local file bindings', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bindings-list-'));
    const label = 'wrangler:memoro:ADMIN_TOKEN';
    await vaultRun(
      ['set', label, '--type', 'api_token', '--provider', 'wrangler', '--account', 'memoro', '--json', '--no-confirm'],
      { portal, cwd: dir },
    );
    await vaultRun(
      ['bind', label, 'ADMIN_TOKEN', '--bind-file', '.dev.vars', '--json'],
      { portal, cwd: dir },
    );
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(['bindings', '--json'], { portal, cwd: dir });
    cap.restore();

    assert.equal(rc, 0);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.exists, true);
    assert.equal(out.count, 1);
    assert.equal(out.sources[0].keys.ADMIN_TOKEN, label);
    assert.ok(!JSON.stringify(out).includes(PW), 'bindings JSON must not leak the secret value');
  });

  it.skip('legacy bind missing-label validation', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bind-missing-'));
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(
      ['bind', 'missing-label', 'OPENAI_API_KEY', '--json'],
      { portal, cwd: dir },
    );
    cap.restore();

    assert.equal(rc, 1);
    const out = JSON.parse(cap.out.join('\n'));
    assert.match(out.error, /no secret with label/);
    assert.equal(existsSync(join(dir, '.mc', 'secrets.json')), false);
  });

  it('set refuses duplicate labels with a pointer at rotate', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    await vaultRun(['set', 'mylabel', '--no-confirm'], { portal });
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['set', 'mylabel', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 1);
    const out = JSON.parse(cap.out.join('\n'));
    assert.match(out.error, /already exists/);
    assert.match(out.error, /rotate/);
  });

  it('import stores encrypted secrets without creating a plaintext binding', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-live-'));
    const label = `env:${basename(dir).toLowerCase()}:OPENAI_API_KEY`;
    const secret = 'import-secret-value-123';
    writeFileSync(join(dir, '.env'), [
      `OPENAI_API_KEY=${secret}`,
      'PUBLIC_API_URL=http://localhost:8787',
      '',
    ].join('\n'));

    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['import', '.env', '--json', '--no-confirm'], { portal, cwd: dir });
    cap.restore();
    assert.equal(rc, 0, `import failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(out.imported.length, 1);
    assert.equal(out.imported[0].label, label);
    assert.equal(out.skipped.some((s) => s.name === 'PUBLIC_API_URL'), true);
    assert.deepEqual(out.writes, []);
    assert.equal(out.binding, null);
    assert.equal(out.binding_file, null);
    assert.ok(!JSON.stringify(out).includes(secret), 'import JSON must not leak secret value');

    const bindingsPath = join(dir, '.mc', 'secrets.json');
    assert.equal(existsSync(bindingsPath), false, 'import must not persist a file/env binding');

    cap = captureConsole();
    const listRc = await vaultRun(['list', '--json'], { portal });
    cap.restore();
    assert.equal(listRc, 0);
    const list = JSON.parse(cap.out.join('\n'));
    assert.equal(list.secrets.length, 1);
    assert.equal(list.secrets[0].label, label);
    assert.equal(list.secrets[0].provider, 'env');
    assert.equal(list.secrets[0].account, basename(dir).toLowerCase());

    cap = captureConsole();
    const getRc = await vaultRun(['get', label, '--json'], { portal });
    cap.restore();
    assert.equal(getRc, 1);
    const got = JSON.parse(cap.out.join('\n'));
    assert.equal(got.code, 'plaintext_export_disabled');
    assert.ok(!JSON.stringify(got).includes(secret));
  });

  it.skip('legacy repeated import preserves a repo-file binding', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-exists-'));
    const label = `env:${basename(dir).toLowerCase()}:OPENAI_API_KEY`;
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=first\n');

    cap.restore(); cap = captureConsole();
    await vaultRun(['import', '.env', '--json', '--no-confirm'], { portal, cwd: dir });
    cap.restore(); cap = captureConsole();
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=second\n');
    const rc = await vaultRun(['import', '.env', '--json', '--no-confirm'], { portal, cwd: dir });
    cap.restore();
    assert.equal(rc, 0);
    const out = JSON.parse(cap.out.join('\n'));
    assert.deepEqual(out.imported, []);
    assert.equal(out.skipped.some((s) => s.label === label && s.reason === 'label already exists'), true);
    assert.deepEqual(out.writes, []);
    assert.equal(out.binding_file.action, 'unchanged');
    assert.equal(server.inspect().secrets.length, 1, 'existing label should not be overwritten or duplicated');
  });

  it.skip('legacy import binds an existing label to a repo file', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-bind-existing-'));
    const label = `env:${basename(dir).toLowerCase()}:OPENAI_API_KEY`;
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=local-secret-that-should-not-print\n');

    cap.restore(); cap = captureConsole();
    await vaultRun(['set', label, '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    const rc = await vaultRun(['import', '.env', '--json', '--no-confirm'], { portal, cwd: dir });
    cap.restore();

    assert.equal(rc, 0);
    const out = JSON.parse(cap.out.join('\n'));
    assert.deepEqual(out.imported, []);
    assert.equal(out.skipped.some((s) => s.label === label && s.reason === 'label already exists'), true);
    assert.deepEqual(out.writes, [{ path: '.mc/secrets.json', action: 'created' }]);

    const bindingsBody = readFileSync(join(dir, '.mc', 'secrets.json'), 'utf8');
    assert.ok(!bindingsBody.includes('local-secret-that-should-not-print'), 'binding file must not leak local value');
    assert.equal(JSON.parse(bindingsBody).sources[0].keys.OPENAI_API_KEY, label);
    assert.equal(server.inspect().secrets.length, 1, 'existing label should not be overwritten or duplicated');
  });

  it('import --json refuses mutation unless --no-confirm is explicit', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-confirm-'));
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=secret\n');

    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['import', '.env', '--json'], { portal, cwd: dir });
    cap.restore();
    assert.equal(rc, 2);
    const out = JSON.parse(cap.out.join('\n'));
    assert.match(out.error, /requires --no-confirm/);
    assert.equal(server.inspect().secrets.length, 0);
  });

  it('import --json --no-confirm fails cleanly when vault is locked and no cache/passphrase is available', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-locked-json-'));
    const secret = 'locked-import-secret-123';
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${secret}\n`);

    const oldPassphrase = process.env.MC_VAULT_PASSPHRASE;
    delete process.env.MC_VAULT_PASSPHRASE;
    cap.restore(); cap = captureConsole();
    try {
      const rc = await vaultRun(['import', '.env', '--json', '--no-confirm'], { portal, cwd: dir });
      cap.restore();
      assert.equal(rc, 1);
      assert.equal(cap.err.join('\n'), '');
      assert.doesNotMatch(cap.out.join('\n'), /Master password/);
      assert.ok(!cap.out.join('\n').includes(secret), 'locked import JSON must not leak secret value');
      const out = JSON.parse(cap.out.join('\n'));
      assert.equal(out.ok, false);
      assert.match(out.error, /vault locked/);
      assert.match(out.error, /mc vault unlock/);
      assert.equal(server.inspect().secrets.length, 0);
    } finally {
      process.env.MC_VAULT_PASSPHRASE = oldPassphrase;
    }
  });

  it.skip('legacy plaintext get cache diagnostics', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['unlock', '--json'], { portal });
    assert.equal(server.inspect().unlocked, true);

    const oldPassphrase = process.env.MC_VAULT_PASSPHRASE;
    delete process.env.MC_VAULT_PASSPHRASE;
    activeCacheDeps = makeMemCacheDeps();
    cap.restore(); cap = captureConsole();
    try {
      const rc = await vaultRun(['get', 'anything', '--json'], { portal });
      cap.restore();
      assert.equal(rc, 1);
      const out = JSON.parse(cap.out.join('\n'));
      assert.equal(out.ok, false);
      assert.match(out.error, /vault key not cached locally/);
      assert.match(out.error, /mc vault unlock/);
    } finally {
      process.env.MC_VAULT_PASSPHRASE = oldPassphrase;
    }
  });

  it('rm deletes a secret (with --no-confirm)', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'doomed', '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rm', 'doomed', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0);
    assert.equal(server.inspect().secrets.length, 0);
    const deletion = server.calls.find((call) => call.method === 'DELETE');
    assert.equal(deletion.body.expectedRevision, 1);
  });

  it('rm refuses a stale row without deleting it', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'stale-rm', '--no-confirm', '--json'], { portal });
    server.forceNextWriteConflict();
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rm', 'stale-rm', '--no-confirm', '--json'], { portal });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.match(out.error, /changed since it was read/);
    assert.match(out.error, /nothing was written to that entry/);
    assert.equal(server.inspect().secrets.length, 1);
    assert.equal(server.calls.find((call) => call.method === 'DELETE').body.expectedRevision, 1);
  });

  it('rm omits the revision when the server has not deployed row revisions', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'legacy-server', '--no-confirm', '--json'], { portal });
    const legacyPortal = {
      ...portal,
      memoroFetch: async (apiUrl, path, opts) => {
        const result = await portal.memoroFetch(apiUrl, path, opts);
        if (path === '/api/vault/secrets' && opts?.method !== 'POST') {
          return { ...result, secrets: result.secrets.map(({ row_revision, ...secret }) => secret) };
        }
        return result;
      },
    };
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rm', 'legacy-server', '--no-confirm', '--json'], { portal: legacyPortal });
    cap.restore();
    assert.equal(rc, 0);
    assert.equal(server.calls.find((call) => call.method === 'DELETE').body?.expectedRevision, undefined);
  });

  it('rm of unknown label returns 1 with helpful error', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rm', 'nothing-here', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 1);
  });

  it('rotate preserves the old value as <label>-prev', async () => {
    // MC_VAULT_PASSPHRASE is global per-process, so both the "secret
    // value" prompt AND the "master password" prompt return the same
    // string. That's fine — the test asserts on the rotate side effect
    // (entry doubled, -prev label exists), not on the literal value.
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'mykey', '--no-confirm', '--json'], { portal });

    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rotate', 'mykey', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0, `rotate failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);

    const inspect = server.inspect();
    assert.equal(inspect.secrets.length, 2,
      'rotate should leave the original entry + a -prev copy');

    // Verify by listing.
    cap = captureConsole();
    await vaultRun(['list', '--json'], { portal });
    cap.restore();
    const listJson = JSON.parse(cap.out.join('\n'));
    const labels = listJson.secrets.map(s => s.label).sort();
    assert.deepEqual(labels, ['mykey', 'mykey-prev']);
    const update = server.calls.find((call) => call.method === 'PUT');
    assert.equal(update.body.expectedRevision, 1);
  });

  it('rotate reports a revision conflict and does not overwrite the row', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'stale-rotate', '--no-confirm', '--json'], { portal });
    const before = server.inspect().secrets;
    server.forceNextWriteConflict();
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rotate', 'stale-rotate', '--no-confirm', '--json'], { portal });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.conflict, true);
    assert.match(out.error, /changed since it was read/);
    const after = server.inspect().secrets;
    assert.deepEqual(after.map((row) => [row.id, row.encrypted_data]),
      before.map((row) => [row.id, row.encrypted_data]),
      'a conflict leaves no -prev behind and the row as it was');
    assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 1, 'nothing is retried');
    const update = server.calls.find((call) => call.method === 'PUT');
    assert.equal(update.body.expectedRevision, 1);
  });

  it('rotate keeps an earlier -prev when the update conflicts', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'kept-prev', '--no-confirm', '--json'], { portal });
    await vaultRun(['rotate', 'kept-prev', '--no-confirm', '--json'], { portal });
    const before = server.inspect().secrets;
    assert.equal(before.length, 2);
    server.forceNextWriteConflict();
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rotate', 'kept-prev', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 1);
    assert.match(JSON.parse(cap.out.join('\n')).error, /changed since it was read/);
    assert.deepEqual(server.inspect().secrets.map((row) => [row.id, row.encrypted_data]),
      before.map((row) => [row.id, row.encrypted_data]));
  });

  it('rotate says so when a conflict stash cannot be taken back out', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'stuck-stash', '--no-confirm', '--json'], { portal });
    server.forceNextWriteConflict();
    const refusingDelete = {
      ...portal,
      memoroFetch: async (apiUrl, path, opts) => {
        if (opts?.method === 'DELETE') throw new Error('Memoro 500: down');
        return portal.memoroFetch(apiUrl, path, opts);
      },
    };
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rotate', 'stuck-stash', '--no-confirm', '--json'], { portal: refusingDelete });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.match(out.error, /was not overwritten/);
    assert.match(out.error, /mc vault rm stuck-stash-prev/);
  });

  it('rotate keeps a changed earlier -prev and reports the rotation that landed', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'changed-prev', '--no-confirm', '--json'], { portal });
    await vaultRun(['rotate', 'changed-prev', '--no-confirm', '--json'], { portal });
    const earlierPrev = server.inspect().secrets.find((row) => row.revision === 1);
    const bumpingPortal = {
      ...portal,
      memoroFetch: async (apiUrl, path, opts) => {
        const result = await portal.memoroFetch(apiUrl, path, opts);
        if (opts?.method === 'PUT') server.bumpRevision(earlierPrev.id);
        return result;
      },
    };
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['rotate', 'changed-prev', '--no-confirm', '--json'], { portal: bumpingPortal });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.rotated.label, 'changed-prev');
    assert.match(out.error, /changed since it was read and was kept/);
    const after = server.inspect().secrets;
    assert.equal(after.length, 3);
    assert.ok(after.some((row) => row.id === earlierPrev.id), 'the changed row is not removed');
  });

  it('rotate twice replaces the stale -prev rather than erroring', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['set', 'k', '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    let rc = await vaultRun(['rotate', 'k', '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    assert.equal(rc, 0);

    rc = await vaultRun(['rotate', 'k', '--no-confirm', '--json'], { portal });
    cap.restore();
    assert.equal(rc, 0, 'second rotate should succeed by superseding the stale -prev');
    assert.equal(server.inspect().secrets.length, 2);
  });

  const passwordPrompt = (current = PW) => (prompt) => Promise.resolve(
    prompt.toLowerCase().startsWith('current') ? current : NEW_PW,
  );

  it('change-password refuses legacy rows before auth, ciphertext or cache mutation', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    await vaultRun(['unlock', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'envelope', '--no-confirm', '--json'], { portal: custodyPortal });
    await vaultRun(['set', 'legacy', '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    const before = server.inspect();
    before.config = { ...before.config };
    const cpCallsBefore = server.calls.filter((c) => c.path === '/api/vault/change-password').length;
    const cacheBefore = activeCacheDeps.snapshot();
    const callsBefore = server.calls.length;
    assert.notEqual(cacheBefore.length, 0, 'the refusal case starts with an existing cached key');
    const rc = await vaultRun(['change-password', '--json'], { portal, promptStub: passwordPrompt() });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    const after = server.inspect();
    assert.equal(after.config.auth_hash, before.config.auth_hash);
    assert.equal(after.config.salt, before.config.salt);
    assert.deepEqual(after.secrets, before.secrets);
    assert.deepEqual(activeCacheDeps.snapshot(), cacheBefore);
    assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, cpCallsBefore);
    assert.deepEqual(server.calls.slice(callsBefore).filter((c) => c.path.startsWith('/api/vault/secrets') && ['POST', 'PUT', 'DELETE'].includes(c.method)), []);
    assert.equal(rc, 1);
    assert.equal(out.code, 'VAULT_LEGACY_SECRETS_REMAIN');
    assert.equal(out.changed_password, false);
    assert.match(out.error, /mc vault migrate.*separately/);
  });

  it('change-password accepts complete envelopes and rewraps the same decryptable root only', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'enveloped-one', '--no-confirm', '--json'], { portal: custodyPortal });
    await vaultRun(['set', 'enveloped-two', '--no-confirm', '--json'], { portal: custodyPortal });
    cap.restore(); cap = captureConsole();
    const before = server.inspect();
    before.config = { ...before.config };
    const cpCallsBefore = server.calls.filter((c) => c.path === '/api/vault/change-password').length;
    const beforeStatus = await custodyPortal.memoroFetch('x', '/api/vault/status');
    const rowsBefore = before.secrets.map(({ encrypted_label, label_iv, encrypted_data, iv, wrapped_dek, dek_iv }) =>
      ({ encrypted_label, label_iv, encrypted_data, iv, wrapped_dek, dek_iv }));
    delete process.env.MC_VAULT_PASSPHRASE;
    const badCache = { ...activeCacheDeps, setSecret: async () => { throw new Error('keychain unavailable'); } };
    const rc = await vaultRun(['change-password', '--json'], { portal: custodyPortal, cacheDeps: badCache, promptStub: passwordPrompt() });
    cap.restore(); process.env.MC_VAULT_PASSPHRASE = PW;
    assert.equal(rc, 0, cap.out.join('\n'));
    const success = JSON.parse(cap.out.join('\n'));
    assert.equal(success.changed_password, true);
    assert.equal(success.cache_refreshed, false);
    assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, cpCallsBefore + 1);
    assert.equal(server.calls.filter((c) => c.method === 'PUT').length, 0);
    const after = server.inspect();
    assert.notEqual(after.config.auth_hash, before.config.auth_hash);
    assert.notEqual(after.config.salt, before.config.salt);
    assert.deepEqual(after.secrets.map(({ encrypted_label, label_iv, encrypted_data, iv, wrapped_dek, dek_iv }) =>
      ({ encrypted_label, label_iv, encrypted_data, iv, wrapped_dek, dek_iv })), rowsBefore);
    const { vaultKey: newKey } = await keys.deriveVaultKeys(NEW_PW, after.config.salt, after.config.iterations);
    const newStatus = await custodyPortal.memoroFetch('x', '/api/vault/status');
    const newRoot = await unwrapCustodyRoot(newKey, newStatus.vault.wrapped_crk, newStatus.vault.crk_iv);
    const clear = await decryptEnvelopeSecret(newRoot, after.secrets[0]);
    assert.equal(clear.label, 'enveloped-two');
    assert.ok(clear.data);
    await assert.rejects(() => unwrapCustodyRoot(newKey, beforeStatus.vault.wrapped_crk, beforeStatus.vault.crk_iv));

    server.forceLock();
    cap = captureConsole();
    const oldRc = await vaultRun(['unlock', '--json'], { portal: custodyPortal, promptStub: () => Promise.resolve(PW) });
    cap.restore();
    assert.equal(oldRc, 1);
    server.forceLock();
    cap = captureConsole();
    const newRc = await vaultRun(['unlock', '--json'], { portal: custodyPortal, promptStub: () => Promise.resolve(NEW_PW) });
    cap.restore();
    assert.equal(newRc, 0);
    process.env.MC_VAULT_PASSPHRASE = PW;
  });

  it('change-password refuses an empty vault without an existing custody root', async () => {
    await vaultRun(['setup', '--json'], { portal });
    await vaultRun(['unlock', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    const before = structuredClone(server.inspect());
    const cacheBefore = activeCacheDeps.snapshot();
    assert.notEqual(cacheBefore.length, 0);
    const callsBefore = server.calls.length;
    const rc = await vaultRun(['change-password', '--json'], { portal, promptStub: passwordPrompt() });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.code, 'VAULT_CUSTODY_ROOT_MISSING');
    assert.equal(out.changed_password, false);
    assert.equal(server.inspect().config.auth_hash, before.config.auth_hash);
    assert.equal(server.inspect().config.salt, before.config.salt);
    assert.deepEqual(server.inspect().secrets, before.secrets);
    assert.deepEqual(activeCacheDeps.snapshot(), cacheBefore);
    assert.deepEqual(server.calls.slice(callsBefore).filter((c) =>
      c.path === '/api/vault/change-password' || (c.path.startsWith('/api/vault/secrets') && ['POST', 'PUT', 'DELETE'].includes(c.method))), []);
  });

  it('change-password rewraps an existing root for a valid empty snapshot', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    cap.restore(); cap = captureConsole();
    const before = server.inspect();
    before.config = { ...before.config };
    const cpCallsBefore = server.calls.filter((c) => c.path === '/api/vault/change-password').length;
    const rc = await vaultRun(['change-password', '--json'], { portal: custodyPortal, promptStub: passwordPrompt() });
    cap.restore();
    assert.equal(rc, 0, cap.out.join('\n'));
    assert.equal(server.inspect().secrets.length, 0);
    assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, cpCallsBefore + 1);
    const status = await custodyPortal.memoroFetch('x', '/api/vault/status');
    const { vaultKey } = await keys.deriveVaultKeys(NEW_PW, server.inspect().config.salt, server.inspect().config.iterations);
    await unwrapCustodyRoot(vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
    assert.notEqual(server.inspect().config.salt, before.config.salt);
  });

  it('change-password refuses an existing but unopenable custody root before rotation', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    await vaultRun(['unlock', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'preserved-envelope', '--no-confirm', '--json'], { portal: custodyPortal });
    const brokenPortal = { ...custodyPortal, memoroFetch: async (url, path, opts) => {
      const result = await custodyPortal.memoroFetch(url, path, opts);
      if (path === '/api/vault/status') return { ...result, vault: { ...result.vault, wrapped_crk: 'not-a-real-wrap' } };
      if (path === '/api/vault/unlock') return { ...result, wrapped_crk: 'not-a-real-wrap' };
      return result;
    } };
    cap.restore(); cap = captureConsole();
    const before = structuredClone(server.inspect());
    const cacheBefore = activeCacheDeps.snapshot();
    const callsBefore = server.calls.length;
    const rc = await vaultRun(['change-password', '--json'], { portal: brokenPortal, promptStub: passwordPrompt() });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.code, 'VAULT_CUSTODY_ROOT_UNOPENABLE');
    assert.equal(server.inspect().config.auth_hash, before.config.auth_hash);
    assert.equal(server.inspect().config.salt, before.config.salt);
    assert.deepEqual(server.inspect().secrets, before.secrets);
    assert.deepEqual(activeCacheDeps.snapshot(), cacheBefore);
    assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, 1);
    assert.deepEqual(server.calls.slice(callsBefore).filter((c) => c.path.startsWith('/api/vault/secrets') && ['POST', 'PUT', 'DELETE'].includes(c.method)), []);
  });

  it('change-password refuses missing and malformed list snapshots before rotation', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    await vaultRun(['unlock', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'preserved-envelope', '--no-confirm', '--json'], { portal: custodyPortal });
    const complete = { id: 'row-1', schema_version: 2, wrapped_dek: 'wrap', dek_iv: 'iv', class: 'secret', encrypted_label: 'x', label_iv: 'x', encrypted_data: 'x', iv: 'x' };
    const badRows = [
      null, {},
      { ...complete, schema_version: 1 },
      { ...complete, wrapped_dek: '' },
      { ...complete, dek_iv: '' },
      { ...complete, class: 'unknown' },
      { ...complete, iv: '' },
      { ...complete, encrypted_data: '' },
    ];
    const badSnapshots = badRows.map((row) => ({ ok: true, secrets: [row] }));
    for (const result of [null, new Error('list transport failed'), { ok: false, secrets: [] }, { ok: 'true', secrets: [] }, { ok: true }, { ok: true, secrets: null }, { ok: true, secrets: {} }, ...badSnapshots]) {
      const brokenPortal = { ...custodyPortal, memoroFetch: async (url, path, opts) => {
        if (path === '/api/vault/secrets' && (!opts?.method || opts.method === 'GET')) {
          if (result instanceof Error) throw result;
          return result;
        }
        return custodyPortal.memoroFetch(url, path, opts);
      } };
      cap.restore(); cap = captureConsole();
      const before = structuredClone(server.inspect());
      const cacheBefore = activeCacheDeps.snapshot();
      const callsBefore = server.calls.length;
      const cpCallsBefore = server.calls.filter((c) => c.path === '/api/vault/change-password').length;
      const rc = await vaultRun(['change-password', '--json'], { portal: brokenPortal, promptStub: passwordPrompt() });
      cap.restore();
      const out = JSON.parse(cap.out.join('\n'));
      assert.equal(rc, 1);
      assert.equal(out.changed_password, false);
      assert.equal(server.inspect().config.auth_hash, before.config.auth_hash);
      assert.equal(server.inspect().config.salt, before.config.salt);
      assert.deepEqual(server.inspect().secrets, before.secrets);
      assert.deepEqual(activeCacheDeps.snapshot(), cacheBefore);
      assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, cpCallsBefore);
      assert.deepEqual(server.calls.slice(callsBefore).filter((c) => c.path.startsWith('/api/vault/secrets') && ['POST', 'PUT', 'DELETE'].includes(c.method)), []);
    }
  });

  it('change-password refuses when current password is wrong', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    delete process.env.MC_VAULT_PASSPHRASE;
    const promptStub = (prompt) => {
      if (prompt.toLowerCase().startsWith('current')) return Promise.resolve(WRONG_PW);
      return Promise.resolve(NEW_PW);
    };
    const rc = await vaultRun(['change-password', '--json'], { portal, promptStub });
    cap.restore();
    process.env.MC_VAULT_PASSPHRASE = PW;
    assert.equal(rc, 1);
  });

  it('change-password preserves the cache on explicit safe server refusal', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();
    await vaultRun(['unlock', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    const refusingPortal = { ...custodyPortal, memoroFetch: async (url, path, opts) => {
      if (path === '/api/vault/change-password') {
        return memoroFetch(url, path, { curlFallback: true, ...opts,
          fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: 'VAULT_LEGACY_SECRETS_REMAIN', error: 'legacy rows remain' }), { status: 409 }),
          curlImpl: async () => { assert.fail('an explicit HTTP refusal must not replay'); },
        });
      }
      return custodyPortal.memoroFetch(url, path, opts);
    } };
    const cacheBefore = activeCacheDeps.snapshot();
    assert.notEqual(cacheBefore.length, 0);
    const cpCallsBefore = server.calls.filter((c) => c.path === '/api/vault/change-password').length;
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['change-password', '--json'], { portal: refusingPortal, promptStub: passwordPrompt() });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.code, 'VAULT_LEGACY_SECRETS_REMAIN');
    assert.equal(out.changed_password, false);
    assert.deepEqual(activeCacheDeps.snapshot(), cacheBefore);
    assert.equal(server.calls.filter((c) => c.path === '/api/vault/change-password').length, cpCallsBefore);
  });

  it('change-password reports unknown without replay through the real transport after ambiguous commits', async () => {
    // Use the real API wrapper, parser and fallback decision; only external
    // fetch/curl are replaced. A replay would refuse with a stale verifier.
    for (const confirmation of ['fetch-loss', '', 'not-json', '{}', '{"ok":"true"}']) {
      server = createMockVaultServer();
      portal = makeTestPortal(server);
      activeCacheDeps = makeMemCacheDeps();
      cap.restore(); cap = captureConsole();
      await vaultRun(['setup', '--json'], { portal });
      await vaultRun(['unlock', '--json'], { portal });
      const custodyPortal = await portalWithCustody(server, portal);
      await vaultRun(['set', 'preserved-envelope', '--no-confirm', '--json'], { portal: custodyPortal });
      let fetchCalls = 0;
      let curlCalls = 0;
      const uncertainPortal = { ...custodyPortal, memoroFetch: async (url, path, opts) => {
        if (path !== '/api/vault/change-password') return custodyPortal.memoroFetch(url, path, opts);
        return memoroFetch(url, path, { curlFallback: true, ...opts,
          fetchImpl: async (_url, request) => {
            fetchCalls++;
            await custodyPortal.memoroFetch(url, path, { method: request.method, body: JSON.parse(request.body) });
            if (confirmation === 'fetch-loss') throw new Error('response lost after commit');
            return new Response(confirmation, { status: 200 });
          },
          curlImpl: async () => {
            curlCalls++;
            return { status: 409, text: JSON.stringify({ ok: false, code: 'VAULT_CONFIG_CONFLICT', error: 'stale verifier on replay' }) };
          },
        });
      } };
      const before = structuredClone(server.inspect());
      const callsBefore = server.calls.length;
      assert.notEqual(activeCacheDeps.snapshot().length, 0);
      cap.restore(); cap = captureConsole();
      const rc = await vaultRun(['change-password', '--json'], { portal: uncertainPortal, promptStub: passwordPrompt() });
      cap.restore();
      const out = JSON.parse(cap.out.join('\n'));
      assert.equal(rc, 1, confirmation);
      assert.equal(out.changed_password, 'unknown', confirmation);
      assert.equal(out.code, 'VAULT_PASSWORD_CHANGE_OUTCOME_UNKNOWN');
      assert.match(out.error, /check by unlocking/);
      assert.notEqual(server.inspect().config.auth_hash, before.config.auth_hash);
      assert.deepEqual(server.inspect().secrets, before.secrets);
      assert.deepEqual(activeCacheDeps.snapshot(), []);
      assert.equal(fetchCalls, 1);
      assert.equal(curlCalls, 0, 'a lost confirmation must not replay the mutation');
      assert.deepEqual(server.calls.slice(callsBefore).filter((c) => c.path === '/api/vault/change-password').map((c) => c.method), ['POST']);
      assert.deepEqual(server.calls.slice(callsBefore).filter((c) => c.path.startsWith('/api/vault/secrets') && ['POST', 'PUT', 'DELETE'].includes(c.method)), []);
    }
  });

  it('migrate sends the revision from the legacy row it read', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'custody-seed', '--no-confirm', '--json'], { portal: custodyPortal });
    const config = server.inspect().config;
    const { vaultKey } = await keys.deriveVaultKeys(PW, config.salt, config.iterations);
    const encrypted = await encryptSecretPayload(vaultKey, 'legacy-entry', { value: 'opaque' });
    await server.memoroFetch('x', '/api/vault/secrets', {
      method: 'POST',
      body: { secretType: 'api_key', ...encrypted },
    });
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['migrate', '--json'], { portal: custodyPortal });
    cap.restore();
    assert.equal(rc, 0, cap.out.join('\n'));
    const update = server.calls.find((call) => call.method === 'PUT');
    assert.equal(update.body.expectedRevision, 1);
  });

  it('migrate stops at a revision conflict, says so, and writes nothing to that row', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    await vaultRun(['set', 'custody-seed', '--no-confirm', '--json'], { portal: custodyPortal });
    const config = server.inspect().config;
    const { vaultKey } = await keys.deriveVaultKeys(PW, config.salt, config.iterations);
    for (const label of ['legacy-one', 'legacy-two']) {
      const encrypted = await encryptSecretPayload(vaultKey, label, { value: 'opaque' });
      await server.memoroFetch('x', '/api/vault/secrets', {
        method: 'POST',
        body: { secretType: 'api_key', ...encrypted },
      });
    }
    const before = server.inspect().secrets;
    server.forceNextWriteConflict();
    cap.restore(); cap = captureConsole();
    const rc = await vaultRun(['migrate', '--json'], { portal: custodyPortal });
    cap.restore();
    const out = JSON.parse(cap.out.join('\n'));
    assert.equal(rc, 1);
    assert.equal(out.ok, false);
    assert.equal(out.conflict, true);
    assert.equal(out.migrated, 0);
    assert.match(out.error, /changed since it was read; its write was not applied/);
    assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 1, 'nothing is retried or attempted after it');
    assert.deepEqual(server.inspect().secrets.map((row) => row.encrypted_data),
      before.map((row) => row.encrypted_data));
  });

  it('adopt sends the revision from the existing custody row and refuses a stale write', async () => {
    await vaultRun(['setup', '--json'], { portal });
    const custodyPortal = await portalWithCustody(server, portal);
    const toolAuthDeps = {
      platform: 'linux',
      exists: () => true,
      readFile: () => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'token' } }),
    };
    let rc = await vaultRun(['adopt', 'codex', '--no-confirm', '--json'], { portal: custodyPortal, toolAuthDeps });
    assert.equal(rc, 0);
    server.forceNextWriteConflict();
    cap.restore(); cap = captureConsole();
    rc = await vaultRun(['adopt', 'codex', '--no-confirm', '--json'], { portal: custodyPortal, toolAuthDeps });
    cap.restore();
    assert.equal(rc, 1);
    assert.match(JSON.parse(cap.out.join('\n')).error, /changed since it was read/);
    const update = server.calls.find((call) => call.method === 'PUT');
    assert.equal(update.body.expectedRevision, 1);
    assert.equal(server.inspect().secrets.length, 1);
  });
});

describe('mc vault — pure error paths (no portal needed)', () => {
  it('unknown verb returns 2', async () => {
    const cap = captureConsole();
    const rc = await vaultRun(['bogus-verb'], { portal: { apiUrl: 'x', token: 'y', memoroFetch: async () => ({ ok: true }) } });
    cap.restore();
    assert.equal(rc, 2);
  });

  it('no verb prints help, returns 0', async () => {
    const cap = captureConsole();
    const rc = await vaultRun([]);
    cap.restore();
    assert.equal(rc, 0);
    assert.match(cap.out.join('\n'), /mc vault/);
  });

  it('--help returns 0', async () => {
    const cap = captureConsole();
    const rc = await vaultRun(['--help']);
    cap.restore();
    assert.equal(rc, 0);
  });

  it('list throws on unknown --type, surfaces friendly error', async () => {
    const cap = captureConsole();
    const rc = await vaultRun(['list', '--type', 'password', '--json'], {
      portal: { apiUrl: 'x', token: 'y', memoroFetch: async () => ({ ok: true, vault: { setup: true, salt: 'AAA=', iterations: 1 } }) },
    });
    cap.restore();
    assert.equal(rc, 1);
    const out = JSON.parse(cap.out.join('\n'));
    assert.match(out.error, /unknown --type/);
  });

  it('setup with too-short password prints error to stderr in non-JSON mode (regression)', async () => {
    // Earlier, emit() silently swallowed { ok: false } whenever the
    // caller did not pass a humanLine — which is exactly what setup's
    // validation paths do. The user saw two blank lines, no error,
    // and `mc vault status` still said "setup: no" with no clue why.
    // This test locks the fix: errors always print to stderr regardless
    // of --json / humanLine.
    delete process.env.MC_VAULT_PASSPHRASE;
    const promptStub = () => Promise.resolve('short'); // 5 chars < 12 min
    const cap = captureConsole();
    const rc = await vaultRun(['setup'], {
      portal: {
        apiUrl: 'x',
        token: 'y',
        memoroFetch: async () => ({ ok: true, vault: { setup: false } }),
      },
      promptStub,
    });
    cap.restore();
    assert.equal(rc, 1);
    assert.equal(cap.out.length, 0, 'stdout should be empty when setup fails validation');
    const stderr = cap.err.join('\n');
    assert.match(stderr, /master password must be at least 12 characters/i,
      `expected error on stderr, got:\nstdout: ${cap.out.join('\n')}\nstderr: ${stderr}`);
    assert.match(stderr, /^mc vault: /,
      `error should be prefixed with "mc vault: ", got: ${stderr}`);
  });
});

describe('mc vault — a token Memoro rejects', () => {
  function rejectingPortal() {
    return {
      apiUrl: 'https://memoro.test',
      token: 'dead',
      memoroFetch: async () => {
        const err = new Error('Memoro 401: Not logged in or session has expired.');
        err.status = 401;
        err.code = 'MEMORO_TOKEN_REJECTED';
        throw err;
      },
    };
  }
  function seams() {
    const calls = { deleted: [], flows: [] };
    return {
      calls,
      deleteToken: async (account) => { calls.deleted.push(account); },
      deviceFlow: async (deps) => { calls.flows.push(deps); return 0; },
    };
  }

  it('at a terminal deletes the token and runs the device flow', async () => {
    const s = seams();
    const cap = captureConsole();
    const rc = await vaultRun(['status'], {
      portal: rejectingPortal(), isTty: true, env: {},
      deleteToken: s.deleteToken, deviceFlow: s.deviceFlow,
    });
    cap.restore();
    assert.equal(rc, 1);
    assert.deepEqual(s.calls.deleted, ['memoro-api-token']);
    assert.equal(s.calls.flows.length, 1);
    assert.equal(s.calls.flows[0].apiUrl, 'https://memoro.test');
    assert.match(s.calls.flows[0].nextMessage, /`mc vault status`/);
    assert.match(cap.err.join('\n'), /Memoro rejected the stored sign-in/);
  });

  for (const [name, argv, extra] of [
    ['not a terminal', ['status'], { isTty: false, env: {} }],
    ['--json', ['status', '--json'], { isTty: true, env: {} }],
    ['MEMORO_TOKEN set', ['status'], { isTty: true, env: { MEMORO_TOKEN: 'x' } }],
  ]) {
    it(`${name}: keeps the token and names mc vault status`, async () => {
      const s = seams();
      const cap = captureConsole();
      const rc = await vaultRun(argv, {
        portal: rejectingPortal(), ...extra,
        deleteToken: s.deleteToken, deviceFlow: s.deviceFlow,
      });
      cap.restore();
      assert.equal(rc, 1);
      assert.equal(s.calls.deleted.length, 0);
      assert.equal(s.calls.flows.length, 0);
      if (argv.includes('--json')) {
        const out = JSON.parse(cap.out.join('\n'));
        assert.equal(out.ok, false);
        assert.equal(out.code, 'MEMORO_TOKEN_REJECTED');
      } else {
        assert.match(cap.err.join('\n'), /`mc vault status`/);
      }
    });
  }
});
