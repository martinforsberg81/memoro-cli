import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readC1InstallGenerationFixture,
  shouldWriteInstalledC1Receipt,
  writeC1InstallReceiptFixture,
} from '../../../src/runtime/broker/c1-install-receipt.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-c1-install-receipt-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('each package installation writes a fresh private generation atomically', (t) => {
  const root = fixture(t);
  const values = [
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
  ];
  const random = () => values.shift();

  assert.equal(writeC1InstallReceiptFixture({ root, random }).ok, true);
  const first = readC1InstallGenerationFixture({ root });
  assert.equal(first, '11'.repeat(32));
  assert.equal(lstatSync(join(root, 'install-receipt.json')).mode & 0o777, 0o600);

  assert.equal(writeC1InstallReceiptFixture({ root, random }).ok, true);
  const second = readC1InstallGenerationFixture({ root });
  assert.equal(second, '22'.repeat(32));
  assert.notEqual(second, first);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(root, 'install-receipt.json'), 'utf8'))).sort(),
    ['generation', 'schema'],
  );
});

test('unsafe receipt roots and files fail closed', (t) => {
  const root = fixture(t);
  chmodSync(root, 0o770);
  assert.equal(writeC1InstallReceiptFixture({
    root,
    random: () => Buffer.alloc(32, 0x33),
  }).ok, false);
  assert.equal(readC1InstallGenerationFixture({ root }), null);
});

test('only a declared global npm installation mints an install receipt', () => {
  assert.equal(shouldWriteInstalledC1Receipt({ npm_config_global: 'true' }), true);
  assert.equal(shouldWriteInstalledC1Receipt({ npm_config_global: '1' }), true);
  assert.equal(shouldWriteInstalledC1Receipt({ npm_config_global: 'false' }), false);
  assert.equal(shouldWriteInstalledC1Receipt({}), false);
});
