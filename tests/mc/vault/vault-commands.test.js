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

import { run as vaultRun } from '../../../src/mc/commands/vault.js';
import { createMockVaultServer, makeTestPortal } from './_helpers/mock-server.js';

const PW = 'this-is-a-long-test-master-password';

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

  it('set + list + get round-trip with --no-confirm', async () => {
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
});
