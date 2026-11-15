import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adapterFor, canonicalToolId } from '../../src/adapters/index.js';
import { deskCost } from '../../src/mc/desk-cost.js';
import { agyStore } from './_helpers/agy-store.js';

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

describe('agy: only the conversations mc started are the desk\'s', () => {
  const MARKED = '0a0b0c0d-1111-4222-8333-444455556666';
  const ID = (n) => `${String(n).repeat(8)}-aaaa-bbbb-cccc-dddddddddddd`;
  // A planner step as agy writes it: its own tokens, fresh input and cache reads apart. gemini-4-argon-high is $2 / $0.10 / $10 per million.
  const step = (index, hoursAgo, { output = 0, input = 0, cache = 0, model = 'gemini-4-argon-high' } = {}) => ({
    type: 'PLANNER_RESPONSE', step_index: index, model, content: 'ok', created_at: at(hoursAgo),
    input_tokens: input, cache_read_tokens: cache, output_tokens: output });
  const conversation = (store, id, { marked = true, steps }) => store.addConversation({ id, workspace: '/work/plan/x',
    steps: [{ type: 'USER_INPUT', content: store.opening({ launch: marked ? MARKED : null }) }, ...steps] });

  it('counts a marked conversation from its own steps, leaves unmarked ones out, and says how many', () => {
    const store = agyStore();
    conversation(store, ID(1), { steps: [step(1, 2, { output: 500_000 }), step(2, 1, { input: 1_000_000, cache: 1_000_000 })] });
    conversation(store, ID(2), { marked: false, steps: [step(1, 2, { output: 9_000_000 })] });
    conversation(store, ID(3), { marked: false, steps: [step(1, 2, { output: 9_000_000 })] });
    const answer = deskCost({ agyDir: store.brain, now: NOW });
    // 500k output $5 + 1M input $2 + 1M cache read $0.10.
    assert.deepEqual([answer.cost, answer.sessions, answer.partial, answer.unpriced], [7.1, 1, false, 0]);
    assert.deepEqual(answer.left_out, { agy: 2 });
    assert.equal('failed' in answer, false);
  });

  it('a marker that is only quoted later in the opening message is not the mark', () => {
    const store = agyStore();
    store.addConversation({ id: ID(4), workspace: '/work/plan/x', steps: [
      { type: 'USER_INPUT', content: `<USER_REQUEST>\nsee ${store.opening({ launch: MARKED })}\n</USER_REQUEST>` }, step(1, 1, { output: 1_000_000 })] });
    const answer = deskCost({ agyDir: store.brain, now: NOW });
    assert.deepEqual([answer.cost, answer.sessions, answer.left_out], [0, 0, { agy: 1 }]);
  });

  it('a step before the window and a step with no known model are not today\'s cost; the unknown one is counted as unpriced', () => {
    const store = agyStore();
    conversation(store, ID(5), { steps: [step(1, 30, { output: 1_000_000 }), step(2, 1, { output: 1_000_000, model: 'no-such-model' }), step(3, 1, { output: 100_000 })] });
    const answer = deskCost({ agyDir: store.brain, now: NOW });
    assert.deepEqual([answer.cost, answer.sessions, answer.unpriced], [1, 1, 1]);
  });

  it('a running conversation counts, and a later collect reads only the bytes appended since', () => {
    const store = agyStore();
    const { path } = conversation(store, ID(6), { steps: [step(1, 2, { output: 500_000 })] });
    const first = deskCost({ agyDir: store.brain, now: NOW });
    assert.deepEqual([first.cost, first.sessions], [5, 1]);
    const entry = first.cache.files[path];
    assert.equal(entry.offset, statSync(path).size);
    // Same length, but a larger reading: were the head read again, the cost would rise.
    writeFileSync(path, readFileSync(path, 'utf8').replace('"output_tokens":500000', '"output_tokens":999999'));
    appendFileSync(path, `${JSON.stringify(step(2, 0.5, { output: 100_000 }))}\n`);
    const later = deskCost({ agyDir: store.brain, cache: { ...first.cache, at: '2000-01-01T00:00:00Z' }, now: NOW });
    assert.deepEqual([later.cost, later.sessions], [6, 1]);
    assert.equal(later.cache.files[path].offset, statSync(path).size);
  });

  it('a conversation not yet marked at its first read is read again once its opening message is there', () => {
    const store = agyStore();
    const dir = join(store.brain, ID(7), '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, '');
    const first = deskCost({ agyDir: store.brain, now: NOW });
    assert.deepEqual([first.cost, first.sessions, first.left_out], [0, 0, undefined]);
    writeFileSync(path, `${JSON.stringify({ type: 'USER_INPUT', content: store.opening({ launch: MARKED }) })}\n${JSON.stringify(step(1, 1, { output: 100_000 }))}\n`);
    const later = deskCost({ agyDir: store.brain, cache: { ...first.cache, at: '2000-01-01T00:00:00Z' }, now: NOW });
    assert.deepEqual([later.cost, later.sessions], [1, 1]);
  });

  it('a cost mechanism mc does not know reads nothing and is named in the failure', () => {
    const store = agyStore();
    conversation(store, ID(8), { steps: [step(1, 1, { output: 1_000_000 })] });
    const answer = deskCost({ agyDir: store.brain, now: NOW,
      sourceOf: (tool) => (canonicalToolId(tool) === 'antigravity-cli' ? { files: 'agy-brain', reader: 'agy-steps-v2', option: 'agyDir' } : adapterFor(tool).COST_SOURCE) });
    assert.deepEqual([answer.cost, answer.sessions], [0, 0]);
    assert.deepEqual(answer.failed, ['agy: no cost reader for agy-brain/agy-steps-v2']);
    assert.deepEqual(Object.keys(answer.cache.files), []);
  });

  it('with no agy directory given, nothing of agy is read and nothing is reported', () => {
    const answer = deskCost({ now: NOW });
    assert.deepEqual([answer.cost, answer.sessions, 'left_out' in answer, 'failed' in answer], [0, 0, false, false]);
  });
});
