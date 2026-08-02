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
