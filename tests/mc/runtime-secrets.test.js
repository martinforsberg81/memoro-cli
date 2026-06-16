import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  scrubRuntimeSecretsFromEnv,
  scrubRuntimeSecretsInPlace,
} from '../../src/mc/runtime-secrets.js';

describe('runtime secret env scrubber', () => {
  test('removes raw Memoro tokens while preserving non-secret env', () => {
    const env = { MEMORO_TOKEN: 'mem_secret', PATH: '/bin', TERM: 'xterm' };
    const scrubbed = scrubRuntimeSecretsFromEnv(env);

    assert.equal(scrubbed.MEMORO_TOKEN, undefined);
    assert.equal(scrubbed.PATH, '/bin');
    assert.equal(env.MEMORO_TOKEN, 'mem_secret');
  });

  test('can scrub launch env objects in place', () => {
    const env = { MEMORO_TOKEN: 'mem_secret', TERM: 'xterm' };

    assert.equal(scrubRuntimeSecretsInPlace(env), env);
    assert.deepEqual(env, { TERM: 'xterm' });
  });
});
