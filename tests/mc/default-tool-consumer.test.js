/**
 * The adapter registry's bridge between user-facing short names and adapter
 * IDs (`resolveToolInput`).
 *
 * This file also covered `resolveToolForNew`, `mc new`'s consumer of
 * `config.defaultTool`. `mc new` was cut on 2026-08-30 and that half went
 * with it. What is left is the registry itself, which every live launch path
 * still goes through.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToolInput } from '../../src/adapters/index.js';

describe('adapters/index — resolveToolInput', () => {
  test('short name → adapter ID and back', () => {
    const r = resolveToolInput('claude');
    assert.equal(r.id, 'claude-code');
    assert.equal(r.shortName, 'claude');
    assert.ok(r.adapter, 'available adapter resolved');
    assert.equal(r.planned, false);
  });

  test('adapter ID is also accepted', () => {
    const r = resolveToolInput('claude-code');
    assert.equal(r.id, 'claude-code');
    assert.equal(r.shortName, 'claude');
  });

  test('codex resolves to same name on both forms (no -cli suffix)', () => {
    const a = resolveToolInput('codex');
    const b = resolveToolInput('codex');
    assert.equal(a.id, 'codex');
    assert.equal(a.shortName, 'codex');
    assert.deepEqual(a, b);
  });

  test('gemini short name maps to planned adapter ID', () => {
    const r = resolveToolInput('gemini');
    assert.equal(r.id, 'gemini-cli');
    assert.equal(r.shortName, 'gemini');
    assert.equal(r.planned, true, 'gemini-cli is planned, not implemented');
    assert.equal(r.adapter, null);
  });

  test('planned adapter ID also accepted directly', () => {
    const r = resolveToolInput('gemini-cli');
    assert.equal(r.id, 'gemini-cli');
    assert.equal(r.shortName, 'gemini');
    assert.equal(r.planned, true);
  });

  test('unknown input returns null so the caller can fail closed', () => {
    assert.equal(resolveToolInput('nonsense'), null);
    assert.equal(resolveToolInput(''), null);
    assert.equal(resolveToolInput(null), null);
    assert.equal(resolveToolInput(undefined), null);
  });
});
