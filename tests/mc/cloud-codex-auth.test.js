import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';

import {
  CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE,
  codexAuthPath,
  prepareCloudCodexAuth,
} from '../../src/mc/cloud-codex-auth.js';

describe('cloud Codex auth preflight', () => {
  test('fails closed when no isolated credential domain exists', async () => {
    const env = {};
    const res = await prepareCloudCodexAuth({
      codingSessionId: 'sess_cloud',
      env,
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE);
    assert.match(res.error, /disabled until provider credentials are isolated/);
  });

  test('does not trust an auth file inside the cloud runtime', async () => {
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

    assert.equal(res.ok, false);
    assert.equal(res.reason, CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE);
    assert.equal(materialized, false);
  });

  test('scrubs raw auth env without invoking materialisation', async () => {
    const canary = 'sk-cloud-canary';
    let materialized = false;
    const env = {
      MC_CODEX_API_KEY: canary,
      OPENAI_API_KEY: 'sk-ambient-canary',
    };

    const res = await prepareCloudCodexAuth({
      codingSessionId: 'sess_cloud',
      env,
      deps: {
        materializeToken: async () => {
          materialized = true;
          return { ok: true };
        },
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE);
    assert.equal(env.MC_CODEX_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(materialized, false);
    assert.equal(JSON.stringify(res).includes(canary), false);
  });

  test('keeps auth path calculation as metadata-only compatibility', () => {
    assert.equal(codexAuthPath('/runtime/codex'), join('/runtime/codex', 'auth.json'));
  });
});
