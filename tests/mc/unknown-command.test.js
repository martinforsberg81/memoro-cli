/**
 * An unknown bare word must never start a session — `mc devices` (meaning
 * `mc vault devices`) or `mc load` falling through to the wrap launcher was
 * a surprising, expensive typo. Flags still fall through to wrap.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { runMc } from './_helpers/cli.js';

describe('unknown top-level commands', () => {
  test('a typo errors with help guidance instead of launching a session', () => {
    const r = runMc(['load'], { env: { MC_TEST_MODE: '1' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command "load"/);
    assert.match(r.stderr, /mc --help/);
  });

  test('a vault verb typed at the top level suggests the vault form', () => {
    const r = runMc(['devices'], { env: { MC_TEST_MODE: '1' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mc vault devices/);
  });
});
