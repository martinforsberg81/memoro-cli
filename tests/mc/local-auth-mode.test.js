import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LOCAL_AUTH_MODES,
  LOCAL_AUTH_STATES,
  evaluateLocalAuthMode,
  resolveLocalAuthMode,
  resolveLocalAuthModeFromArgv,
} from '../../src/mc/local-auth-mode.js';

describe('local auth mode', () => {
  test('defaults named lifecycle intent to managed custody', () => {
    assert.equal(resolveLocalAuthMode(), LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.deepEqual(evaluateLocalAuthMode(), {
      ok: true,
      mode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      state: LOCAL_AUTH_STATES.MANAGED_REQUESTED,
      portable: false,
      certified: false,
    });
  });

  test('managed portable remains uncertified until launch preflight', () => {
    const mode = resolveLocalAuthMode({ managedPortable: true });
    const result = evaluateLocalAuthMode(mode);

    assert.equal(mode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.equal(result.ok, true);
    assert.equal(result.state, LOCAL_AUTH_STATES.MANAGED_REQUESTED);
    assert.equal(result.portable, false);
    assert.equal(result.certified, false);
    assert.equal(result.reason, undefined);
  });

  test('repo, config, and inherited environment cannot select another path', () => {
    const mode = resolveLocalAuthMode({
      managedPortable: false,
      env: {
        MC_MANAGED_PORTABLE: '1',
        MC_VAULT_STARTUP_DONE: '1',
      },
      config: {
        managedPortable: true,
      },
      entry: {
        local_auth_mode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      },
    });

    assert.equal(mode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
  });

  test('named lifecycle commands default managed while bare mc and wrap stay native', () => {
    assert.equal(
      resolveLocalAuthModeFromArgv(['new', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['open', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['resume', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['--managed-portable']),
      LOCAL_AUTH_MODES.NATIVE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['wrap', 'work', '--managed-portable']),
      LOCAL_AUTH_MODES.NATIVE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['new', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['open', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['resume', 'work']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
  });

  // `lifecycle parsers reject removed execution-mode flags` stood here. It
  // asserted that `mc new` and `mc open` refused `--native` and
  // `--managed-portable`; both verbs were cut on 2026-08-30, so there is no
  // parser left to refuse anything. The rule those flags were removed for is
  // still asserted, on the surfaces that exist, in
  // tests/architecture/certified-execution.test.js.

  test('unknown modes fail closed without echoing caller data', () => {
    const canary = 'invalid-mode-secret-canary';
    const result = evaluateLocalAuthMode(canary);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-local-auth-mode');
    assert.equal(result.mode, null);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  });
});
