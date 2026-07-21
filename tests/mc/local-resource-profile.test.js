import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  buildLocalResourceProfile,
  recommendLocalResourceProfile,
  resolveLocalResourceProfile,
  withLocalResourceProfile,
} from '../../src/mc/local-resource-profile.js';

describe('local heavy-job resource profiles', () => {
  test('defaults to unlimited with no limits enabled', () => {
    assert.deepEqual(resolveLocalResourceProfile({}), {
      profile: 'unlimited',
      enabled: false,
    });
  });

  test('resolves named profiles from global config', () => {
    const profile = resolveLocalResourceProfile({
      resources: { localHeavyJobs: { profile: 'conservative' } },
    });
    assert.equal(profile.enabled, true);
    assert.equal(profile.maxConcurrent, 1);
    assert.equal(profile.maxThreads, 2);
    assert.equal(profile.maxRssMb, 2560);
  });

  test('validates every custom limit', () => {
    const profile = buildLocalResourceProfile('custom', {
      maxConcurrent: 2,
      maxThreads: 3,
      maxRssMb: 3072,
      maxSwapMb: 768,
      minFreeDiskGb: 12,
    });
    assert.deepEqual(profile, {
      profile: 'custom',
      enabled: true,
      maxConcurrent: 2,
      maxThreads: 3,
      maxRssMb: 3072,
      maxSwapMb: 768,
      minFreeDiskGb: 12,
    });
    assert.throws(() => buildLocalResourceProfile('custom', {
      maxConcurrent: 0,
      maxThreads: 3,
      maxRssMb: 3072,
      maxSwapMb: 768,
      minFreeDiskGb: 12,
    }), /maxConcurrent/);
  });

  test('stores the profile without overwriting unrelated config', () => {
    const config = withLocalResourceProfile({ apiUrl: 'https://example.test', resources: { other: true } }, {
      profile: 'balanced',
    });
    assert.equal(config.apiUrl, 'https://example.test');
    assert.equal(config.resources.other, true);
    assert.deepEqual(config.resources.localHeavyJobs, { profile: 'balanced' });
  });

  test('recommends without selecting based on physical memory', () => {
    assert.equal(recommendLocalResourceProfile({ totalMemoryBytes: 8 * 1024 ** 3 }), 'conservative');
    assert.equal(recommendLocalResourceProfile({ totalMemoryBytes: 16 * 1024 ** 3 }), 'balanced');
    assert.equal(recommendLocalResourceProfile({ totalMemoryBytes: 64 * 1024 ** 3 }), 'unlimited');
  });
});
