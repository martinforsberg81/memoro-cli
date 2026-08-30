/**
 * Context fill, seen by something other than the session itself
 * (2026-08-24). The transcript carries it for every Claude session, pane or
 * not, from the early level up. The late level used to knock through the
 * session guard; the guard went with the PM (decision mc-1), the board that
 * drew the number went with `mc status` (decision mc-3), and the reading is
 * what remains.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contextUsage, contextWindowFor } from '../../src/mc/conversations.js';

const assistant = (usage, model = 'claude-opus-5') => ({ type: 'assistant', message: { model, usage } });

describe('reading the fill from the transcript', () => {
  it('sums the whole input side of the latest assistant message, against a window assumed from the model', () => {
    // msr-track-1, measured: its pane said 100 % at these numbers.
    const entries = [
      { type: 'user' },
      assistant({ input_tokens: 2, cache_creation_input_tokens: 359, cache_read_input_tokens: 977123, output_tokens: 126 }),
      { type: 'user' },
    ];
    const fill = contextUsage('claude-code', entries);
    assert.equal(fill.used, 977484);
    assert.equal(fill.window, 1_000_000);
    assert.equal(fill.percent, 98);
    assert.equal(fill.window_assumed, true, 'the transcript carries no window; the answer says so');
  });

  it('knows the windows it has measured, and assumes the small one for the rest', () => {
    assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-fable-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
    assert.equal(contextWindowFor('claude-opus-4-1'), 200_000);
    assert.equal(contextWindowFor(null), 200_000);
  });

  it('is null for codex, for a transcript with no usage, and for a synthetic-only tail', () => {
    assert.equal(contextUsage('codex', [assistant({ input_tokens: 5 })]), null);
    assert.equal(contextUsage('claude-code', [{ type: 'user' }]), null);
    assert.equal(contextUsage('claude-code', [assistant({ output_tokens: 3 })]), null);
  });
});
