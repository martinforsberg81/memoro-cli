/** Billing status is read-only and follows the plan-first route for both providers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyObservation, applyRefusal, normaliseCapacity, writeCapacity } from '../../../src/mc/model-capacity.js';
import { parseRunArgs, run } from '../../../src/mc/commands/run.js';
import { capacityReaders } from '../../../src/mc/run.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const reset = '2026-10-11T15:00:00Z';

function cli() {
  const root = mkdtempSync(join(tmpdir(), 'mc-billing-verb-'));
  const out = [];
  const err = [];
  const api = { claude: true, codex: true };
  const deps = {
    stdout: { write: (text) => out.push(text.trimEnd()) },
    stderr: { write: (text) => err.push(text.trimEnd()) },
    now: () => NOW,
    readCapacity: () => normaliseCapacity(null),
    readBillingState: () => ({}),
    readBillingApi: () => ({ ...api }),
    writeBillingApi: (provider, enabled) => {
      if (!['claude', 'codex'].includes(provider)) return { ok: false, reason: `API is switched per provider — claude or codex, not "${provider}"` };
      api[provider] = enabled;
      return { ok: true, api: { ...api } };
    },
  };
  return {
    root, deps,
    async billing(...argv) {
      out.length = 0;
      err.length = 0;
      const code = await run(['--billing', ...argv], deps);
      return { code, out: [...out], err: [...err] };
    },
  };
}

test('billing command reads both providers in one status line', async () => {
  const mc = cli();
  const read = await mc.billing();
  assert.equal(read.code, 0);
  assert.deepEqual(read.out, [
    'billing claude ? plan · codex ? plan · agy ? plan',
    'next claude session: plan — plan status unknown',
    'next codex session: plan — plan status unknown',
    'next agy session: plan — plan status unknown',
  ]);
});

test('billing command shows the provider on API at 100 %', async () => {
  const mc = cli();
  const full = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: { fraction_used: 1, resets_at: reset } } }, NOW);
  mc.deps.readCapacity = () => full;
  const read = await mc.billing();
  assert.equal(read.out[0], 'billing claude 100% API · codex ? plan · agy ? plan');
  assert.equal(read.out[1], 'next claude session: API — plan reached 100 %');
});

test('old manual modes are refused because routing is automatic', async () => {
  const mc = cli();
  const read = await mc.billing('credits');
  assert.equal(read.code, 2);
  assert.deepEqual(read.out, []);
  assert.match(read.err[0], /billing mode is automatic/u);
  assert.deepEqual(parseRunArgs(['--billing']), { verb: 'billing', mode: null });
  assert.match(parseRunArgs(['--billing', '--once']).error, /one order on its own/u);
});

test('billing switches one provider\'s API off and on, and says what the next session gets', async () => {
  const mc = cli();
  const full = applyObservation(normaliseCapacity(null), 'codex', { windows: { primary: { fraction_used: 1, resets_at: reset } } }, NOW);
  mc.deps.readCapacity = () => full;
  const off = await mc.billing('codex', 'off');
  assert.equal(off.code, 0);
  assert.deepEqual(off.out, [
    'codex API off — applies from the next session; a running one keeps its billing',
    'billing claude ? plan · codex 100% plan (API off) · agy ? plan',
    'next claude session: plan — plan status unknown',
    'next codex session: plan — plan reached 100 %; API off',
    'next agy session: plan — plan status unknown',
  ]);
  const on = await mc.billing('codex', 'on');
  assert.equal(on.out[1], 'billing claude ? plan · codex 100% API · agy ? plan');
  assert.deepEqual(parseRunArgs(['--billing', 'claude', 'off']), { verb: 'billing', mode: null, api: { provider: 'claude', enabled: false } });
  const wrong = await mc.billing('gemini', 'off');
  assert.equal(wrong.code, 2);
  assert.match(wrong.err[0], /claude or codex/u);
});

const UNTIL = '2026-10-11T15:20:00.000Z';
const SEEN = '2026-10-11T11:59:02.000Z';
const spent = () => applyRefusal(applyObservation(normaliseCapacity(null), 'claude', {
  windows: { five_hour: { fraction_used: 1.01, resets_at: UNTIL }, seven_day: { fraction_used: 0.09, resets_at: '2026-10-14T13:00:00.000Z' } },
}, new Date(SEEN)), 'claude', UNTIL, null, new Date(SEEN), 'quota');

test('billing brackets a held quota refusal with its cause and the instant it was first seen', async () => {
  const mc = cli();
  mc.deps.readCapacity = () => spent();
  const read = await mc.billing();
  assert.equal(read.out[0], `billing claude 101% (refused until ${UNTIL} — quota, first seen ${SEEN}) API · codex ? plan · agy ? plan`);
  assert.equal(read.out[1], `next claude session: API — plan refused until ${UNTIL}`);
});

test('--refresh runs every provider\'s reader once, says each, then prints the line the reads left', async () => {
  const mc = cli();
  let capacity = spent();
  const calls = [];
  mc.deps.readCapacity = () => capacity;
  mc.deps.readers = {
    claude: async () => {
      calls.push('claude');
      capacity = applyRefusal(applyObservation(capacity, 'claude', { windows: { five_hour: null, seven_day: { fraction_used: 0.76, resets_at: '2026-10-14T13:00:00.000Z' } } }, NOW), 'claude', null);
      return { ok: true };
    },
    codex: async () => { calls.push('codex'); return { ok: false, why: 'codex app-server ended before it answered (exit 1)' }; },
  };
  const read = await mc.billing('--refresh');
  assert.equal(read.code, 0, 'one read succeeded');
  assert.deepEqual(calls, ['claude', 'codex']);
  assert.deepEqual(read.err, []);
  assert.deepEqual(read.out.slice(0, 3), [
    'mc: claude read — ok',
    'mc: codex read failed — codex app-server ended before it answered (exit 1)',
    'billing claude 76% plan · codex ? plan · agy ? plan',
  ]);
  assert.deepEqual(parseRunArgs(['--billing', '--refresh']), { verb: 'billing', mode: null, refresh: true });
  assert.deepEqual(parseRunArgs(['billing', '--refresh']), { verb: 'billing', mode: null, refresh: true });
});

test('--refresh exits 1 when every read failed, a thrown read among them', async () => {
  const mc = cli();
  mc.deps.readers = {
    claude: async () => ({ ok: false, why: 'Claude subscription request timed out' }),
    codex: async () => { throw new Error('codex did not run: ENOENT'); },
  };
  const read = await mc.billing('--refresh');
  assert.equal(read.code, 1);
  assert.deepEqual(read.out.slice(0, 3), [
    'mc: claude read failed — Claude subscription request timed out',
    'mc: codex read failed — codex did not run: ENOENT',
    'billing claude ? plan · codex ? plan · agy ? plan',
  ]);
});

test('--refresh takes no provider', async () => {
  const mc = cli();
  let called = false;
  mc.deps.readers = { claude: async () => { called = true; return { ok: true }; } };
  const read = await mc.billing('--refresh', 'codex', 'on');
  assert.equal(read.code, 2);
  assert.equal(read.err[0], 'mc: --refresh takes no provider — mc run --billing --refresh');
  assert.equal(called, false);
  assert.deepEqual(read.out, []);
});

test('--refresh reads with every provider\'s reader, the ones the runner polls with', () => {
  assert.deepEqual(Object.keys(capacityReaders({})), ['claude', 'codex', 'agy']);
});
