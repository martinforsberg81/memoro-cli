import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deskCost } from '../../src/mc/desk-cost.js';

const NOW = new Date('2026-11-09T18:00:00Z');
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
// One claude message, written once per content block; only the last block carries the final output.
const claudeMessage = (id, hoursAgo, output, model = 'claude-opus-5-5') => line({
  type: 'assistant', timestamp: at(hoursAgo), message: { id, model, usage: { input_tokens: 0, output_tokens: output } },
});

function homes() {
  const root = mkdtempSync(join(tmpdir(), 'mc-desk-cost-'));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  mkdirSync(join(claude, 'projects', 'plan'), { recursive: true });
  mkdirSync(join(claude, 'projects', 'goal'), { recursive: true });
  mkdirSync(join(codex, 'sessions', '2026', '11', '09'), { recursive: true });
  return { root, claude, codex };
}

describe('the interactive sessions\' cost', () => {
  it('prices interactive claude messages once each at their last reading, and skips the runner\'s', () => {
    const { claude } = homes();
    const plan = join(claude, 'projects', 'plan', 'a.jsonl');
    writeFileSync(plan, line({ type: 'user', entrypoint: 'cli', timestamp: at(2) })
      + claudeMessage('m1', 2, 10) + claudeMessage('m1', 2, 1_000_000)
      // Before the window: not today's.
      + claudeMessage('m0', 30, 1_000_000));
    writeFileSync(join(claude, 'projects', 'goal', 'b.jsonl'), line({ type: 'user', entrypoint: 'sdk-cli', timestamp: at(1) }) + claudeMessage('r1', 1, 1_000_000));
    const first = deskCost({ claudeDir: claude, now: NOW });
    // A million Opus 5.5 output tokens: $20.
    assert.deepEqual([first.cost, first.sessions, first.partial], [20, 1, false]);
    // Appended later: only the new bytes are read, and the open message still rises.
    appendFileSync(plan, claudeMessage('m2', 0.5, 500_000));
    const later = deskCost({ claudeDir: claude, cache: { ...first.cache, at: '2000-01-01T00:00:00Z' }, now: NOW });
    assert.equal(later.cost, 30);
    assert.equal(later.cache.files[join(claude, 'projects', 'goal', 'b.jsonl')].interactive, false);
  });

  it('takes a codex session\'s running total less its last reading before the window', () => {
    const { codex } = homes();
    const reading = (hoursAgo, input, cached, output) => line({ type: 'event_msg', timestamp: at(hoursAgo), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    writeFileSync(join(codex, 'sessions', '2026', '11', '09', 'tui.jsonl'),
      line({ type: 'session_meta', payload: { originator: 'codex-tui' } })
      + line({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })
      + reading(30, 0, 0, 100_000) + reading(1, 0, 0, 300_000));
    writeFileSync(join(codex, 'sessions', '2026', '11', '09', 'exec.jsonl'),
      line({ type: 'session_meta', payload: { originator: 'codex_exec' } }) + reading(1, 0, 0, 900_000));
    // 200k output in the window at $10 per million.
    assert.equal(deskCost({ codexDir: codex, now: NOW }).cost, 2);
  });

  it('spreads a large first reading over collects and says it is partial', () => {
    const { claude } = homes();
    const plan = join(claude, 'projects', 'plan', 'big.jsonl');
    writeFileSync(plan, line({ type: 'user', entrypoint: 'cli', timestamp: at(2) }) + Array.from({ length: 40 }, (_, i) => claudeMessage(`m${i}`, 2, 100_000)).join(''));
    let cache = null;
    const first = deskCost({ claudeDir: claude, now: NOW, budget: 1024 });
    assert.equal(first.partial, true);
    cache = first.cache;
    let answer = first;
    for (let i = 0; i < 40 && answer.partial; i += 1) { answer = deskCost({ claudeDir: claude, cache, now: NOW, budget: 1024 }); cache = answer.cache; }
    assert.equal(answer.partial, false);
    assert.equal(answer.cost, 80);
    // A finished reading is the answer for a minute.
    assert.equal(deskCost({ claudeDir: claude, cache, now: new Date(NOW.getTime() + 30_000) }).cost, 80);
  });
});
