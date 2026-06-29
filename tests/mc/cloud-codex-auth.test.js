import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';

import {
  CLOUD_CODEX_AUTH_INTERACTIVE_LOGIN,
  codexAuthPath,
  prepareCloudCodexAuth,
} from '../../src/mc/cloud-codex-auth.js';

describe('cloud Codex auth preflight', () => {
  test('falls back to interactive login when no headless cloud auth exists', async () => {
    const env = {};
    const res = await prepareCloudCodexAuth({
      codingSessionId: 'sess_cloud',
      env,
      deps: {
        existsSync: () => false,
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.source, 'interactive-login');
    assert.equal(res.reason, CLOUD_CODEX_AUTH_INTERACTIVE_LOGIN);
    assert.equal(res.interactiveLogin, true);
    assert.equal(res.startupMessageSafe, false);
    assert.match(res.hint, /login URL/);
  });

  test('accepts an existing Codex auth file without materialising a token', async () => {
    let materialized = false;
    const env = { CODEX_HOME: '/workspace/codex-home' };
    const res = await prepareCloudCodexAuth({
      codingSessionId: 'sess_cloud',
      env,
      deps: {
        existsSync: (path) => path === '/workspace/codex-home/auth.json',
        materializeToken: async () => {
          materialized = true;
          return { ok: true };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.source, 'existing-auth-file');
    assert.equal(res.codexHome, '/workspace/codex-home');
    assert.equal(materialized, false);
  });

  test('materialises MC_CODEX_API_KEY into an isolated CODEX_HOME and scrubs auth env', async () => {
    const previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = '/tmp/mc-test-home';
    try {
      const calls = [];
      const env = {
        MC_CODEX_API_KEY: 'sk-cloud',
        OPENAI_API_KEY: 'sk-ambient',
      };

      const res = await prepareCloudCodexAuth({
        codingSessionId: 'sess_cloud',
        env,
        deps: {
          existsSync: () => false,
          materializeToken: async (call) => {
            calls.push(call);
            return { ok: true, materializedPath: call.location.path };
          },
        },
      });

      assert.equal(res.ok, true);
      assert.equal(res.source, 'MC_CODEX_API_KEY');
      assert.equal(env.MC_CODEX_API_KEY, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_HOME, join('/tmp/mc-test-home', 'codex', 'sess_cloud'));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].token, 'sk-cloud');
      assert.equal(calls[0].location.path, codexAuthPath(env.CODEX_HOME));
    } finally {
      if (previousMcHome === undefined) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
    }
  });
});
