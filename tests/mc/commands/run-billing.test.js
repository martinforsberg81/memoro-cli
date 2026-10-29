/** Billing status is read-only and follows the plan-first route for both providers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyObservation, normaliseCapacity, writeCapacity } from '../../../src/mc/model-capacity.js';
import { parseRunArgs, run } from '../../../src/mc/commands/run.js';

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
    'billing claude ? plan · codex ? plan',
    'next claude session: plan — plan status unknown',
    'next codex session: plan — plan status unknown',
  ]);
});

test('billing command shows the provider on API at 100 %', async () => {
  const mc = cli();
  const full = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: { fraction_used: 1, resets_at: reset } } }, NOW);
  mc.deps.readCapacity = () => full;
  const read = await mc.billing();
  assert.equal(read.out[0], 'billing claude 100% API · codex ? plan');
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
    'billing claude ? plan · codex 100% plan (API off)',
    'next claude session: plan — plan status unknown',
    'next codex session: plan — plan reached 100 %; API off',
  ]);
  const on = await mc.billing('codex', 'on');
  assert.equal(on.out[1], 'billing claude ? plan · codex 100% API');
  assert.deepEqual(parseRunArgs(['--billing', 'claude', 'off']), { verb: 'billing', mode: null, api: { provider: 'claude', enabled: false } });
  const wrong = await mc.billing('gemini', 'off');
  assert.equal(wrong.code, 2);
  assert.match(wrong.err[0], /claude or codex/u);
});
