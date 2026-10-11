/**
 * `mc run --billing [plan|credits|auto]` — the mode, printed or set.
 *
 * The files are real, in a temp root, so the write clearing the credit mark
 * is measured on the file the runner reads rather than on a stub of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchBillingState, readBillingFile, readBillingMode, readBillingState, writeBillingMode } from '../../../src/mc/billing.js';
import { parseRunArgs, run } from '../../../src/mc/commands/run.js';

const NOW = new Date('2026-10-11T12:00:00Z');

function cli({ root = mkdtempSync(join(tmpdir(), 'mc-billing-verb-')) } = {}) {
  const out = [];
  const err = [];
  const deps = {
    stdout: { write: (text) => out.push(text.trimEnd()) },
    stderr: { write: (text) => err.push(text.trimEnd()) },
    now: () => NOW,
    readBilling: () => readBillingFile({ root }),
    readBillingState: () => readBillingState({ root }),
    writeBilling: (value, opts = {}) => writeBillingMode(value, { ...opts, root }),
  };
  return {
    root,
    async billing(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await run(['--billing', ...argv], deps);
      return { code, out: [...out], err: [...err] };
    },
  };
}

test('parseRunArgs: --billing and billing, with or without a mode, and nothing else beside it', () => {
  assert.deepEqual(parseRunArgs(['--billing']), { verb: 'billing', mode: null });
  assert.deepEqual(parseRunArgs(['--billing', 'auto']), { verb: 'billing', mode: 'auto' });
  assert.deepEqual(parseRunArgs(['billing']), { verb: 'billing', mode: null });
  assert.deepEqual(parseRunArgs(['billing', 'credits']), { verb: 'billing', mode: 'credits' });
  assert.match(parseRunArgs(['--billing', '--once']).error, /one order on its own/u);
  assert.match(parseRunArgs(['--once', '--billing']).error, /one order on its own/u);
  assert.match(parseRunArgs(['--billing', 'auto', 'plan']).error, /one order on its own/u);
});

test('billing: nothing set prints plan, no window, and the next session on the plan', async () => {
  const mc = cli();
  const read = await mc.billing();
  assert.equal(read.code, 0);
  assert.deepEqual(read.out, [
    'billing plan',
    'plan: no window seen yet',
    'next claude step session: plan — mode plan',
  ]);
});

test('billing: auto at 83 % of the seven-day window says the next session runs on credits', async () => {
  const mc = cli();
  writeBillingMode('auto', { root: mc.root, now: NOW });
  patchBillingState({ plan: {
    five_hour: { utilization: 0.08, resets_at: '2026-10-11T15:00:00Z' },
    seven_day: { utilization: 0.83, resets_at: '2026-10-14T08:00:00Z' },
    seen: '2026-10-11T11:20:00Z',
  } }, { root: mc.root });
  const read = await mc.billing();
  assert.equal(read.out[0], 'billing auto');
  assert.match(read.out[1], /^plan: 5-hour 8 % \(resets \d{4}-\d\d-\d\d \d\d:\d\d\) · seven-day 83 % \(resets \d{4}-\d\d-\d\d \d\d:\d\d\) · seen 40m ago$/u);
  assert.equal(read.out.at(-1), 'next claude step session: credits — seven-day 83 %, resets 2026-10-14T08:00:00Z');
});

test('billing: a refusal and a credit mark in the future are printed', async () => {
  const mc = cli();
  patchBillingState({ plan: { refused_until: '2026-10-11T15:00:00Z' }, credits: { unusable_until: '2026-10-12T12:00:00Z', why: 'balance too low' } }, { root: mc.root });
  const read = await mc.billing();
  assert.match(read.out.find((l) => l.startsWith('plan refused')), /^plan refused until \d{4}-\d\d-\d\d \d\d:\d\d$/u);
  assert.match(read.out.find((l) => l.startsWith('credits')), /^credits unusable until \d{4}-\d\d-\d\d \d\d:\d\d — balance too low$/u);
});

test('billing <mode>: writes, clears the credit mark, and says no restart is needed', async () => {
  const mc = cli();
  patchBillingState({ credits: { unusable_until: '2026-10-12T12:00:00Z', why: 'key rejected' } }, { root: mc.root });
  const set = await mc.billing('credits');
  assert.equal(set.code, 0);
  assert.equal(set.out[0], 'billing credits — set 2026-10-11T12:00:00.000Z');
  assert.equal(set.out.at(-2), 'next claude step session: credits — mode credits');
  assert.equal(set.out.at(-1), 'read at the next session — no restart needed');
  assert.equal(readBillingMode({ root: mc.root }), 'credits');
  assert.deepEqual(readBillingState({ root: mc.root }).credits, { unusable_until: null, why: null });
});

test('billing <unknown>: refused with exit 2, naming the three, and nothing written', async () => {
  const mc = cli();
  const bad = await mc.billing('free');
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.out, []);
  assert.match(bad.err[0], /^mc: billing is plan, credits, auto, not "free"$/u);
  assert.equal(readBillingMode({ root: mc.root }), 'plan');
});
