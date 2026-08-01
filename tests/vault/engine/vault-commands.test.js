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

import { run as vaultRunRaw } from '../../../src/cli/vault.js';
import { createMockVaultServer, makeTestPortal } from './_helpers/mock-server.js';

const PW = 'this-is-a-long-test-master-password';

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
  };
}

// Each test gets its own cacheDeps assigned in beforeEach; the wrapper
// below threads it through opts so every vault verb runs against the
// in-memory cache.
let activeCacheDeps = null;
function vaultRun(argv, opts = {}) {
  return vaultRunRaw(argv, { cacheDeps: activeCacheDeps, ...opts });
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
    process.env.MC_VAULT_PASSPHRASE = 'wrong-password';
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

  it('change-password rotates the auth hash and re-encrypts all secrets', async () => {
    // Initial setup at PW
    await vaultRun(['setup', '--json'], { portal });
    // Store a secret (the value will be PW because of env-passphrase)
    await vaultRun(['set', 'k1', '--no-confirm', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    // For change-password we need three distinct prompt answers.
    // MC_VAULT_PASSPHRASE returns the same value for all prompts, so
    // we use the promptStub opts hook to script them.
    delete process.env.MC_VAULT_PASSPHRASE;
    const NEW_PW = 'a-new-master-password-12345';
    const promptStub = (prompt) => {
      if (prompt.toLowerCase().startsWith('current')) return Promise.resolve(PW);
      if (prompt.toLowerCase().startsWith('new')) return Promise.resolve(NEW_PW);
      if (prompt.toLowerCase().startsWith('confirm')) return Promise.resolve(NEW_PW);
      return Promise.resolve(PW);
    };
    const rc = await vaultRun(['change-password', '--json'], { portal, promptStub });
    cap.restore();
    process.env.MC_VAULT_PASSPHRASE = PW; // restore for any teardown
    assert.equal(rc, 0, `change-password failed: ${JSON.stringify({ out: cap.out, err: cap.err })}`);

    // Verify: a new unlock with PW (old) must fail; unlock with NEW_PW must succeed
    server.forceLock();
    process.env.MC_VAULT_PASSPHRASE = PW;
    cap = captureConsole();
    let unlockOldRc = await vaultRun(['unlock', '--json'], { portal });
    cap.restore();
    assert.equal(unlockOldRc, 1, 'unlock with old password should fail after change-password');

    server.forceLock();
    process.env.MC_VAULT_PASSPHRASE = NEW_PW;
    cap = captureConsole();
    const unlockNewRc = await vaultRun(['unlock', '--json'], { portal });
    cap.restore();
    assert.equal(unlockNewRc, 0, 'unlock with new password must succeed');

    // And the stored secret must still be readable under the new password
    cap = captureConsole();
    const listRc = await vaultRun(['list', '--json'], { portal });
    cap.restore();
    assert.equal(listRc, 0);
    const listJson = JSON.parse(cap.out.join('\n'));
    assert.equal(listJson.secrets.length, 1);
    assert.equal(listJson.secrets[0].label, 'k1', 'secret label must survive re-encryption');

    process.env.MC_VAULT_PASSPHRASE = PW;
  });

  it('change-password refuses when current password is wrong', async () => {
    await vaultRun(['setup', '--json'], { portal });
    cap.restore(); cap = captureConsole();

    delete process.env.MC_VAULT_PASSPHRASE;
    const promptStub = (prompt) => {
      if (prompt.toLowerCase().startsWith('current')) return Promise.resolve('wrong-current-password');
      return Promise.resolve('the-new-password-yo-12345');
    };
    const rc = await vaultRun(['change-password', '--json'], { portal, promptStub });
    cap.restore();
    process.env.MC_VAULT_PASSPHRASE = PW;
    assert.equal(rc, 1);
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
