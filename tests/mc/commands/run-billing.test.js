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
  const deps = {
    stdout: { write: (text) => out.push(text.trimEnd()) },
    stderr: { write: (text) => err.push(text.trimEnd()) },
    now: () => NOW,
    readCapacity: () => normaliseCapacity(null),
    readBillingState: () => ({}),
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
