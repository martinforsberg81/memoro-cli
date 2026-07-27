import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LOCAL_AUTH_MODES,
  LOCAL_AUTH_STATES,
  LOCAL_MANAGED_UNAVAILABLE_REASON,
  evaluateLocalAuthMode,
  resolveLocalAuthMode,
  resolveLocalAuthModeFromArgv,
} from '../../src/mc/local-auth-mode.js';

describe('local auth mode', () => {
  test('defaults to the existing native unmanaged path', () => {
    assert.equal(resolveLocalAuthMode(), LOCAL_AUTH_MODES.NATIVE);
    assert.deepEqual(evaluateLocalAuthMode(), {
      ok: true,
      mode: LOCAL_AUTH_MODES.NATIVE,
      state: LOCAL_AUTH_STATES.NATIVE_UNMANAGED,
      portable: false,
    });
  });

  test('managed portable is explicit and remains fail closed', () => {
    const mode = resolveLocalAuthMode({ managedPortable: true });
    const result = evaluateLocalAuthMode(mode);

    assert.equal(mode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.equal(result.ok, false);
    assert.equal(result.state, LOCAL_AUTH_STATES.MANAGED_UNAVAILABLE);
    assert.equal(result.portable, false);
    assert.equal(result.reason, LOCAL_MANAGED_UNAVAILABLE_REASON);
    assert.match(result.error, /credential boundary is not certified/);
  });

  test('repo, config, and inherited environment cannot opt in', () => {
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

    assert.equal(mode, LOCAL_AUTH_MODES.NATIVE);
  });

  test('only the explicit lifecycle flag opts in; bare mc and wrap argv stay native', () => {
    assert.equal(
      resolveLocalAuthModeFromArgv(['new', 'work', '--managed-portable']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['open', 'work', '--managed-portable']),
      LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    );
    assert.equal(
      resolveLocalAuthModeFromArgv(['resume', 'work', '--managed-portable']),
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
      LOCAL_AUTH_MODES.NATIVE,
    );
  });

  test('unknown modes fail closed without echoing caller data', () => {
    const canary = 'invalid-mode-secret-canary';
    const result = evaluateLocalAuthMode(canary);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-local-auth-mode');
    assert.equal(result.mode, null);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  });
});
