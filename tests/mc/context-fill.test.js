/**
 * Context fill, seen by something other than the session itself
 * (2026-08-24). The transcript carries it for every Claude session, pane or
 * not; the board shows it from the early level; the guard knocks at the
 * late one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTEXT_LEVELS, contextUsage, contextWindowFor } from '../../src/mc/conversations.js';
import { renderLines } from '../../src/mc/status-render.js';
import { scanSessions } from '../../src/mc/watch-sessions-scan.js';

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

describe('the early level is on the board, the late level knocks', () => {
  const page = (percent) => ({
    areas: [{
      name: 'msr-track-1', path: '/x', running: [], worktrees: [], waiting: true, working: false,
      conversations: [{ id: 'c1', tool: 'claude-code', model: 'claude-opus-5', said: 'hm', state: 'waiting', updated_ms: 1000, bytes: 2048, live: true, context: { used: percent * 10000, window: 1_000_000, percent, model: 'claude-opus-5', window_assumed: true } }],
    }],
    summary: { areas: 1, waiting: 1, working: 0 },
  });

  it('shows the fill from the early level, and not below it', () => {
    assert.ok(renderLines(page(CONTEXT_LEVELS.show), { columns: 120, now: 61000 }).some((line) => /70% context/u.test(line)));
    assert.ok(!renderLines(page(CONTEXT_LEVELS.show - 1), { columns: 120, now: 61000 }).some((line) => /context/u.test(line)));
    assert.ok(renderLines(page(100), { columns: 120, now: 61000 }).some((line) => /100% context/u.test(line)));
  });

  it('flags a live session at the late level with the numbers and the way out — and never a dead one', () => {
    const board = (percent, live = true) => ({
      at: 'now',
      areas: [{ name: 'msr-track-1', path: '/x', conversations: [{ id: 'c1', tool: 'claude-code', path: '/p', bytes: 1, updated_ms: 0, live, state: 'waiting', turn: 'waiting', context: { used: 977484, window: 1_000_000, percent, model: 'claude-opus-5' } }] }],
    });
    const flags = (report) => scanSessions({ now: 1000, report, tasks: () => [] }).sessions[0].patterns.filter((p) => p.pattern === 'context');
    const [flag] = flags(board(CONTEXT_LEVELS.knock));
    assert.ok(flag, 'the late level flags');
    assert.match(flag.detail, /90% of its context used \(977k of 1000k tokens, window assumed from claude-opus-5\) — \/compact or \/clear/u);
    assert.deepEqual(flags(board(CONTEXT_LEVELS.knock - 1)), [], 'below it, the board is enough');
    assert.deepEqual(flags(board(100, false)), [], 'a session that is not running has no turns to stall');
  });
});
