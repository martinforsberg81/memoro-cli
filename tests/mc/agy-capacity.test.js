/**
 * The agy-usage reader (agy-capacity.js): the `/usage` text parsed as D7 says,
 * what is stored of it, and the choice judged on what was kept. The text is
 * synthesised from the documentation (tests/fixtures/agy/README), no live agy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGY_USAGE_ARGS, collectAgyCapacity, makeAgyUsageReader, parseAgyUsage } from '../../src/mc/agy-capacity.js';
import { readCapacity } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { chooseCandidate } from '../../src/mc/model-choice.js';
import { QUOTA_SLEEP_MS } from '../../src/mc/run-plan.js';
import { runnerDir } from '../../src/mc/paths.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const FIVE = '2026-11-15T16:00:00.000Z';
const WEEK = '2026-11-20T00:00:00.000Z';

const group = (name, five, weekly) => `${name}\n  Five Hour Limit Remaining: ${five}\n  Weekly Limit Remaining: ${weekly}\n`;
const WITH_RESETS = `${group('Gemini 4 Argon', '72% (resets 2026-11-15T16:00:00Z)', '40% (resets 2026-11-20T00:00:00Z)')}\n${group('Gemini 4 Hydrogen', '90% (resets 2026-11-15T17:00:00Z)', '85% (resets 2026-11-20T00:00:00Z)')}`;

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-capacity-'));
  const env = { MC_WORK_ROOT: root };
  mkdirSync(runnerDir(env), { recursive: true });
  return { env, done: () => rmSync(root, { recursive: true, force: true }) };
};
const answering = (...outputs) => { const seen = []; return { seen, collect: async (options) => { seen.push(options); return collectAgyCapacity({ ...options, launch: () => ({ ok: true, id: 'antigravity-cli', spec: { bin: '/bin/agy' } }), run: async () => ({ error: null, stdout: outputs.shift() ?? '' }) }); } }; };
const REVIEW = { ...DEFAULT_CATALOG, review: [{ tool: 'agy', model: 'gemini-4-argon-high', effort: 'high' }, { tool: 'claude', model: 'opus', effort: 'medium' }] };
const review = (capacity, now = NOW) => chooseCandidate({ cls: 'review', catalog: REVIEW, capacity, now });

test('a window with a printed reset is stored, the tightest group per window; a relative reset counts from the read', () => {
  const read = parseAgyUsage(WITH_RESETS, NOW);
  assert.deepEqual(read, { windows: { five_hour: { fraction_used: 0.28, resets_at: FIVE }, weekly: { fraction_used: 0.6, resets_at: WEEK } }, full: false });
  const relative = parseAgyUsage(group('Gemini 4 Argon', '50% (resets in 2h 30m)', '50% (resets in 5d)'), NOW);
  assert.equal(relative.windows.five_hour.resets_at, '2026-11-15T14:30:00.000Z');
  assert.equal(relative.windows.weekly.resets_at, '2026-11-20T12:00:00.000Z');
});

test('a window without a printed reset is not stored, so it reads unknown and the tool still runs; one at its limit without a reset is a refusal', async () => {
  const none = parseAgyUsage(group('Gemini 4 Argon', '60%', '30%'), NOW);
  assert.deepEqual(none, { windows: { five_hour: null, weekly: null }, full: false });
  const full = parseAgyUsage(group('Gemini 4 Argon', '0%', '30% (resets 2026-11-20T00:00:00Z)'), NOW);
  assert.deepEqual(full, { windows: { five_hour: null, weekly: { fraction_used: 0.7, resets_at: WEEK } }, full: true });

  const w = workspace();
  try {
    const { collect } = answering(group('Gemini 4 Argon', '60%', '30%'), group('Gemini 4 Argon', '0%', '30%'), group('Gemini 4 Argon', '0%', '30%'));
    const reader = makeAgyUsageReader({ provider: 'agy', env: w.env, now: () => NOW, collect });
    await reader();
    let state = readCapacity({ root: runnerDir(w.env) }).providers.agy;
    assert.deepEqual(state.windows, { five_hour: null, weekly: null });
    assert.equal(state.refusal_until, null, 'nothing invented, nothing refused');
    assert.equal(review(readCapacity({ root: runnerDir(w.env) })).spec, 'agy:gemini-4-argon-high:high', 'an unknown plan bootstraps');

    await reader();
    state = readCapacity({ root: runnerDir(w.env) }).providers.agy;
    const until = new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString();
    assert.equal(state.refusal_until, until, 'a full window with no reset refuses for the quota sleep');
    assert.equal(review(readCapacity({ root: runnerDir(w.env) })).spec, 'claude:opus:medium', 'review falls through while agy is refused');

    const later = new Date(NOW.getTime() + 15 * 60_000);
    const again = makeAgyUsageReader({ provider: 'agy', env: w.env, now: () => later, collect });
    await again();
    assert.equal(readCapacity({ root: runnerDir(w.env) }).providers.agy.refusal_until, new Date(later.getTime() + QUOTA_SLEEP_MS).toISOString(), 'the next read renews it while the window stays full');
  } finally { w.done(); }
});

test('a valid read then an unparsed one keeps the snapshot marked failed, judges the choice on it, and stops the reader after one try', async () => {
  const w = workspace();
  try {
    const { collect, seen } = answering(group('Gemini 4 Argon', '0% (resets 2026-11-15T16:00:00Z)', '50% (resets 2026-11-20T00:00:00Z)'), 'I do not know that command', 'never read');
    const reader = makeAgyUsageReader({ provider: 'agy', env: w.env, now: () => NOW, collect });
    assert.equal((await reader()).ok, true);
    const got = await reader();
    assert.deepEqual([got.ok, got.stop], [false, true]);
    const state = readCapacity({ root: runnerDir(w.env) });
    assert.equal(state.providers.agy.windows.five_hour.fraction_used, 1, 'the last valid snapshot is kept');
    assert.match(state.providers.agy.failure.why, /no five-hour or weekly limit line/u);
    assert.equal(review(state).spec, 'claude:opus:medium', 'the kept full window still excludes agy');
    const stopped = await reader();
    assert.deepEqual([stopped.ok, stopped.stop], [false, true]);
    assert.equal(seen.length, 2, 'agy was not run a third time');
  } finally { w.done(); }
});

test('a kept snapshot older than STALE_MS: a full window with a printed reset is still exhausted, an under-limit one reads unknown', async () => {
  const w = workspace();
  try {
    const { collect } = answering(group('Gemini 4 Argon', '0% (resets 2026-11-16T00:00:00Z)', '50% (resets 2026-11-20T00:00:00Z)'));
    await makeAgyUsageReader({ provider: 'agy', env: w.env, now: () => NOW, collect })();
    const kept = readCapacity({ root: runnerDir(w.env) });
    const old = new Date(NOW.getTime() + 4 * 60 * 60_000);
    assert.equal(review(kept, old).spec, 'claude:opus:medium', 'exhausted until its printed reset however old the read');

    const w2 = workspace();
    try {
      const again = answering(group('Gemini 4 Argon', '40% (resets 2026-11-16T00:00:00Z)', '50% (resets 2026-11-20T00:00:00Z)'));
      await makeAgyUsageReader({ provider: 'agy', env: w2.env, now: () => NOW, collect: again.collect })();
      const kept2 = readCapacity({ root: runnerDir(w2.env) });
      const fresh = chooseCandidate({ cls: 'review', catalog: REVIEW, capacity: kept2, now: NOW, priority: 'claude' });
      assert.deepEqual([fresh.spec, fresh.basis, fresh.headroom], ['agy:gemini-4-argon-high:high', 'preferred', 0.4]);
      const stale = chooseCandidate({ cls: 'review', catalog: REVIEW, capacity: kept2, now: old, priority: 'claude' });
      assert.deepEqual([stale.spec, stale.basis, stale.headroom], ['agy:gemini-4-argon-high:high', 'bootstrap', null], 'an under-limit snapshot older than STALE_MS proves nothing: unknown');
    } finally { w2.done(); }
  } finally { w.done(); }
});

test('the read runs agy -p /usage in text mode without the provider keys or the tool\'s dropped variables, and reports a missing binary or a timeout as a failed read', async () => {
  let ran = null;
  const launch = () => ({ ok: true, id: 'antigravity-cli', spec: { bin: '/bin/agy' } });
  const got = await collectAgyCapacity({
    env: { PATH: '/bin', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', AGY_ADC_AUTH: 'x', KEEP: '1' }, now: NOW, launch,
    run: async (bin, args, options) => { ran = { bin, args, env: options.env }; return { error: null, stdout: WITH_RESETS }; },
  });
  assert.equal(got.ok, true);
  assert.deepEqual([ran.bin, ran.args], ['/bin/agy', [...AGY_USAGE_ARGS]]);
  assert.deepEqual(Object.keys(ran.env).sort(), ['KEEP', 'PATH']);

  const missing = await collectAgyCapacity({ launch: () => ({ ok: false, hint: 'agy was not found on PATH' }), run: async () => assert.fail('not run') });
  assert.deepEqual([missing.ok, missing.unparsed, missing.why], [false, false, 'agy was not found on PATH']);
  const slow = await collectAgyCapacity({ launch, timeoutMs: 5, run: async () => ({ error: Object.assign(new Error('timed out'), { killed: true }), stdout: '' }) });
  assert.deepEqual([slow.ok, slow.unparsed, slow.why], [false, false, 'agy /usage did not answer within 5 ms']);
});
