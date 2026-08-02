/**
 * THE canonical tool-name mapping. Local copies of the
 * claude↔claude-code map are forbidden — every normalization and
 * comparison goes through these helpers.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { canonicalToolId, isSameTool, toolShortName } from '../../src/adapters/index.js';

describe('canonical tool names', () => {
  test('canonicalToolId accepts every official and historical name form', () => {
    for (const [input, expected] of [
      ['claude', 'claude-code'],
      ['claude-code', 'claude-code'],
      ['codex', 'codex'],
      ['codex-cli', 'codex'],
      ['gemini', 'gemini-cli'],
      ['gemini-cli', 'gemini-cli'],
      ['  Claude  ', 'claude-code'],
      ['CODEX', 'codex'],
    ]) {
      assert.equal(canonicalToolId(input), expected, input);
    }
  });

  test('unknown values normalize to null, never a guess', () => {
    for (const input of ['cursor-pro', 'gpt', '', '   ', null, undefined, 7, {}]) {
      assert.equal(canonicalToolId(input), null, String(input));
    }
  });

  test('toolShortName inverts to the user-facing form', () => {
    assert.equal(toolShortName('claude-code'), 'claude');
    assert.equal(toolShortName('claude'), 'claude');
    assert.equal(toolShortName('gemini-cli'), 'gemini');
    assert.equal(toolShortName('codex-cli'), 'codex');
    assert.equal(toolShortName('unknown-tool'), null);
  });

  test('isSameTool compares across name forms and rejects unknowns', () => {
    assert.equal(isSameTool('claude', 'claude-code'), true);
    assert.equal(isSameTool('codex-cli', 'codex'), true);
    assert.equal(isSameTool('gemini', 'gemini-cli'), true);
    assert.equal(isSameTool('claude', 'codex'), false);
    assert.equal(isSameTool('unknown', 'unknown'), false);
    assert.equal(isSameTool(null, null), false);
  });
});

describe('transcript contract', () => {
  test('both implemented adapters expose a full dialect and discovery', async () => {
    const { transcriptDialectFor, transcriptDiscoveryFor } = await import('../../src/adapters/index.js');
    for (const tool of ['claude-code', 'codex']) {
      const dialect = transcriptDialectFor(tool);
      assert.equal(typeof dialect.meta, 'function', tool);
      assert.equal(typeof dialect.message, 'function', tool);
      assert.equal(typeof dialect.toolCalls, 'function', tool);
      assert.ok(['anthropic', 'openai'].includes(dialect.provider), tool);
      const discovery = transcriptDiscoveryFor(tool);
      assert.equal(typeof discovery.findLatest, 'function', tool);
      assert.equal(typeof discovery.findById, 'function', tool);
    }
  });

  test('unknown tools get the generic dialect without a provider label and no discovery', async () => {
    const { transcriptDialectFor, transcriptDiscoveryFor } = await import('../../src/adapters/index.js');
    const dialect = transcriptDialectFor('mystery-tool');
    assert.equal(dialect.provider, null);
    assert.equal(typeof dialect.message, 'function');
    assert.equal(transcriptDiscoveryFor('mystery-tool'), null);
  });
});
