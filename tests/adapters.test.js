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

  test('codex is available', () => {
    const a = getAdapter('codex');
    assert.equal(a.ID, 'codex');
    assert.equal(a.LABEL, 'Codex CLI');
    assert.equal(typeof a.writeLens, 'function');
    assert.equal(typeof a.installHooks, 'function');
  });

  test('planned adapters throw with an explanatory note', () => {
    for (const id of ['cursor', 'windsurf', 'gemini-cli']) {
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
    assert.equal(avail.length, 2);
    assert.ok(avail.find(a => a.id === 'claude-code'));
    assert.ok(avail.find(a => a.id === 'codex'));
  });

  test('listPlanned lists the pending adapters', () => {
    const planned = listPlanned();
    assert.ok(planned.length >= 3);
    assert.ok(planned.find(p => p.id === 'cursor'));
  });
});
