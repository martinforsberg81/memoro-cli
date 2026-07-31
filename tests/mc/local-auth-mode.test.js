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

  test('named lifecycle commands default managed while bare mc and wrap stay native', () => {
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

  test('--native is the only route to native custody on new and open', async () => {
    const { parseArgs: newArgs } = await import('../../src/mc/commands/new.js');
    const { parseArgs: openArgs } = await import('../../src/mc/commands/resume.js');

    // Absent the explicit flag, both verbs stay on managed custody.
    for (const argv of [['s'], ['s', '--claude'], ['s', '--managed-portable']]) {
      assert.equal(openArgs(argv).managedPortable, true);
      assert.equal(newArgs(argv).managedPortable, true);
    }
    // The flag opts out, and only for the invocation that carries it.
    assert.equal(openArgs(['s', '--claude', '--native']).managedPortable, false);
    assert.equal(newArgs(['s', '--claude', '--native']).managedPortable, false);
    assert.equal(
      resolveLocalAuthMode({ managedPortable: openArgs(['s', '--native']).managedPortable }),
      LOCAL_AUTH_MODES.NATIVE,
    );
    // Native is a valid, non-portable container — never a certified one.
    const evaluated = evaluateLocalAuthMode(LOCAL_AUTH_MODES.NATIVE);
    assert.equal(evaluated.ok, true);
    assert.equal(evaluated.state, LOCAL_AUTH_STATES.NATIVE_UNMANAGED);
    assert.equal(evaluated.portable, false);
    assert.notEqual(evaluated.certified, true);
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
