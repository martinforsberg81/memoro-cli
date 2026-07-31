import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  computeBrokerRuntimeIdentity,
} from '../../../src/mc/broker/runtime-identity.js';

const TEST_RUNTIME = Object.freeze({
  node: 'v24.10.0',
  modules: '137',
  platform: 'darwin',
  arch: 'arm64',
});

describe('broker runtime identity', () => {
  test('is deterministic for an unchanged runtime closure', () => {
    const root = fixture();
    try {
      const first = computeBrokerRuntimeIdentity({
        packageRoot: root,
        runtime: TEST_RUNTIME,
      });
      const second = computeBrokerRuntimeIdentity({
        packageRoot: root,
        runtime: TEST_RUNTIME,
      });
      assert.equal(first, second);
      assert.match(first, /^mc-broker-runtime-identity-v1:[a-f0-9]{64}$/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changes when loaded runtime source or Node runtime changes', () => {
    const root = fixture();
    try {
      const original = computeBrokerRuntimeIdentity({
        packageRoot: root,
        runtime: TEST_RUNTIME,
      });
      writeFileSync(join(root, 'src', 'mc', 'provider.js'), 'export const provider = 2;\n');
      const sourceChanged = computeBrokerRuntimeIdentity({
        packageRoot: root,
        runtime: TEST_RUNTIME,
      });
      const runtimeChanged = computeBrokerRuntimeIdentity({
        packageRoot: root,
        runtime: { ...TEST_RUNTIME, node: 'v24.11.0' },
      });
      assert.notEqual(sourceChanged, original);
      assert.notEqual(runtimeChanged, sourceChanged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-broker-runtime-identity-'));
  mkdirSync(join(root, 'src', 'mc'), { recursive: true });
  writeFileSync(join(root, 'mc-cli.js'), 'import "./src/mc/provider.js";\n');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'src', 'mc', 'provider.js'), 'export const provider = 1;\n');
  return root;
}
