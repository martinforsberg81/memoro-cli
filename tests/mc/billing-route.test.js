/**
 * The billing answer when a model, not the provider, is refused: the page's
 * line and `mc run --billing` name the model and its reset, and another model
 * of the provider still has the plan. A provider-wide refusal reads as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { billingRoute, billingStatus } from '../../src/mc/billing-route.js';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';

const NOW = new Date('2026-11-16T13:31:00Z');
const UNTIL = '2026-11-22T17:27:21.000Z';
const win = (fraction_used) => ({ fraction_used, resets_at: '2026-11-20T00:00:00.000Z' });
const plan = applyObservation(normaliseCapacity(null), 'agy', { windows: { five_hour: win(0.57), weekly: win(0.16) } }, NOW);

test('billingStatus names a refused model and its reset beside the provider\'s usage', () => {
  const line = billingStatus({ capacity: applyRefusal(plan, 'agy', UNTIL, 'gemini-4-argon-high', NOW), now: NOW });
  assert.match(line, /agy 57% \(gemini-4-argon-high refused until 2026-11-22T17:27:21\.000Z\) plan/u);
  assert.doesNotMatch(billingStatus({ capacity: plan, now: NOW }), /refused/u, 'no refusal, no mention');
});

test('a model\'s refusal spends the plan for that model only', () => {
  const capacity = applyRefusal(plan, 'agy', UNTIL, 'gemini-4-argon-high', NOW);
  assert.equal(billingRoute({ provider: 'agy', model: 'gemini-3.8-flash-high', capacity, now: NOW }).why, 'plan available');
  assert.equal(billingRoute({ provider: 'agy', capacity, now: NOW }).why, 'plan available', 'a route that names no model is not refused by one');
  const spent = billingRoute({ provider: 'agy', model: 'gemini-4-argon-high', capacity, now: NOW });
  assert.equal(spent.billing, 'plan', 'agy has no API route, so a spent model stays on the plan route');
  assert.equal(spent.why, `plan refused until ${UNTIL}; no API route`);
});

test('a provider-wide refusal reads as before, for every model', () => {
  const capacity = applyRefusal(plan, 'agy', UNTIL);
  const route = billingRoute({ provider: 'agy', model: 'gemini-3.8-flash-high', capacity, now: NOW });
  assert.equal(route.why, `plan refused until ${UNTIL}; no API route`);
  assert.doesNotMatch(billingStatus({ capacity, now: NOW }), /refused until/u, 'the status line reads as it did');
  const claude = applyRefusal(applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(0.3), seven_day: win(0.3) } }, NOW), 'claude', UNTIL);
  assert.deepEqual(billingRoute({ provider: 'claude', model: 'opus', capacity: claude, now: NOW }), { billing: 'credits', why: `plan refused until ${UNTIL}` });
});
