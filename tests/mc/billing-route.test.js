import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { billingRoute, billingStatus, gatewayLaunch } from '../../src/mc/billing-route.js';

const now = new Date('2026-10-29T12:00:00Z');
const reset = '2026-10-29T15:00:00Z';
const win = (fraction_used) => ({ fraction_used, resets_at: reset });
const route = (provider, capacity, state = {}, api) => billingRoute({ provider, capacity, state, api, now });

test('each provider uses its plan through 99 % and selects API at 100 %', () => {
  for (const provider of ['claude', 'codex']) {
    const window = provider === 'claude' ? 'five_hour' : 'primary';
    const below = applyObservation(normaliseCapacity(null), provider, { windows: { [window]: win(0.99) } }, now);
    assert.equal(route(provider, below).billing, 'plan');
    const full = applyObservation(normaliseCapacity(null), provider, { windows: { [window]: win(1) } }, now);
    assert.deepEqual(route(provider, full), { billing: 'credits', why: 'plan reached 100 %' });
  }
});

test('a refusal switches to API, while an unknown reading stays on plan', () => {
  const empty = normaliseCapacity(null);
  assert.equal(route('claude', empty).billing, 'plan');
  assert.equal(route('codex', applyRefusal(empty, 'codex', reset)).billing, 'credits');
  assert.equal(route('claude', empty, { plan: { refused_until: reset } }).billing, 'credits');
});

test('API launch wraps a tool without putting a key in args', () => {
  const direct = gatewayLaunch({ provider: 'claude', model: 'opus', bin: '/bin/claude', args: ['-p'], billing: 'plan' });
  assert.deepEqual(direct, { bin: '/bin/claude', args: ['-p'] });
  const api = gatewayLaunch({ provider: 'codex', model: 'gpt-6.1-sol', bin: '/bin/codex', args: ['exec'], billing: 'credits' });
  assert.equal(api.bin, process.execPath);
  assert.deepEqual(api.args.slice(-4), ['codex', 'gpt-6.1-sol', '/bin/codex', 'exec']);
});

test('a provider with API off stays on its plan when the plan is spent; the other is untouched', () => {
  const full = applyObservation(normaliseCapacity(null), 'codex', { windows: { primary: win(1) } }, now);
  const refused = applyRefusal(full, 'claude', reset);
  const api = { claude: true, codex: false };
  assert.deepEqual(route('codex', refused, {}, api), { billing: 'plan', why: 'plan reached 100 %; API off' });
  assert.equal(route('claude', refused, {}, api).billing, 'credits');
  assert.equal(route('codex', refused, {}, {}).billing, 'credits', 'absent is on');
  assert.equal(billingStatus({ capacity: refused, state: {}, api, now }), 'claude ? API · codex 100% plan (API off)');
});
