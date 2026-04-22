import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  getAdapter,
  listAdapters,
  listPlanned,
} from '../src/adapters/index.js';

describe('adapter registry', () => {
  test('claude-code is available', () => {
    const a = getAdapter('claude-code');
    assert.equal(a.ID, 'claude-code');
    assert.equal(a.LABEL, 'Claude Code');
    assert.equal(typeof a.writeLens, 'function');
    assert.equal(typeof a.installHooks, 'function');
  });

  test('planned adapters throw with an explanatory note', () => {
    for (const id of ['cursor', 'codex', 'windsurf', 'gemini-cli']) {
      assert.throws(() => getAdapter(id), err => {
        return err.planned === true && /coming/.test(err.message);
      }, `${id} should throw a "planned" error`);
    }
  });

  test('unknown tool throws with the list of known tools', () => {
    assert.throws(() => getAdapter('nethack-cli'), err => {
      return /Known tools/.test(err.message);
    });
  });

  test('listAdapters returns only available adapters', () => {
    const avail = listAdapters();
    assert.equal(avail.length, 1);
    assert.equal(avail[0].id, 'claude-code');
  });

  test('listPlanned lists the pending adapters', () => {
    const planned = listPlanned();
    assert.ok(planned.length >= 4);
    assert.ok(planned.find(p => p.id === 'cursor'));
  });
});
