/**
 * `mc new` consumer of `config.defaultTool` + adapter ID/short-name
 * reconciliation. Drev CW.
 *
 * Pure-helper tests for `resolveToolForNew` (with injected config loader)
 * and `resolveToolInput` (the adapter-registry bridge between user-facing
 * short names and adapter IDs). The end-to-end CLI behaviour of `mc new`
 * is already covered by `tests/mc/lifecycle/new.test.js`; this file
 * targets the consumer wiring in isolation.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToolForNew } from '../../src/cli/new.js';
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

describe('mc new — resolveToolForNew', () => {
  test('explicit --tool flag wins over config', async () => {
    const configLoader = async () => ({ defaultTool: 'codex' });
    const r = await resolveToolForNew({ flagValue: 'claude', configLoader });
    assert.equal(r.tool, 'claude');
    assert.equal(r.source, 'flag');
  });

  test('flag accepts adapter ID too (claude-code)', async () => {
    const configLoader = async () => ({ defaultTool: null });
    const r = await resolveToolForNew({ flagValue: 'claude-code', configLoader });
    assert.equal(r.tool, 'claude');
    assert.equal(r.source, 'flag');
  });

  test('unknown flag value returns error (does not silently fall back)', async () => {
    const configLoader = async () => ({ defaultTool: null });
    const r = await resolveToolForNew({ flagValue: 'nope', configLoader });
    assert.ok(r.error, 'error string set');
    assert.match(r.error, /unknown or uncertified tool: nope/);
  });

  test('uses config.defaultTool when the flag is missing', async () => {
    const configLoader = async () => ({ defaultTool: 'codex' });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.equal(r.tool, 'codex');
    assert.equal(r.source, 'config');
  });

  test('uses effective config defaultTool values with their source', async () => {
    const configLoader = async () => ({
      defaultTool: { value: 'codex', source: '.mc/local.json' },
    });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.equal(r.tool, 'codex');
    assert.equal(r.source, '.mc/local.json');
  });

  test('config-stored adapter ID resolves to short name', async () => {
    // Drev G's `mc tool-switch` stores adapter IDs in defaultTool.
    // Consumer must translate to the short name used in the registry.
    const configLoader = async () => ({ defaultTool: 'claude-code' });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.equal(r.tool, 'claude');
    assert.equal(r.source, 'config');
  });

  test('uses the built-in codex default when config is unset', async () => {
    const configLoader = async () => ({ defaultTool: null });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.equal(r.tool, 'codex');
    assert.equal(r.source, 'built-in-default');
  });

  test('rejects an unresolvable configured tool instead of substituting another', async () => {
    const configLoader = async () => ({ defaultTool: 'totally-made-up' });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.match(r.error, /configured tool is not certified: totally-made-up/iu);
  });

  test('rejects an uncertified configured adapter', async () => {
    const configLoader = async () => ({ defaultTool: 'cursor' });
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.match(r.error, /configured tool is not certified: cursor/iu);
  });

  test('fails closed when the tool configuration cannot be read', async () => {
    const configLoader = async () => { throw new Error('disk gone'); };
    const r = await resolveToolForNew({ flagValue: null, configLoader });
    assert.equal(r.error, 'could not read the default tool configuration');
  });
});
