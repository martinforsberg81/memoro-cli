/**
 * The billing answer when a model, not the provider, is refused: the page's
 * line and `mc run --billing` name the model and its reset, and another model
 * of the provider still has the plan. A provider-wide refusal carries its cause
 * and the instant it was first seen, and the line says both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { billingRoute, billingStatus } from '../../src/mc/billing-route.js';
import { applyObservation, applyRefusal, normaliseCapacity, providerAt } from '../../src/mc/model-capacity.js';

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

test('a provider-wide refusal refuses every model, and the status line says until when, why and since when', () => {
  const capacity = applyRefusal(plan, 'agy', UNTIL, null, NOW);
  const route = billingRoute({ provider: 'agy', model: 'gemini-3.8-flash-high', capacity, now: NOW });
  assert.equal(route.why, `plan refused until ${UNTIL}; no API route`);
  assert.match(billingStatus({ capacity, now: NOW }), new RegExp(`agy 57% \\(refused until ${UNTIL.replace(/\./gu, '\\.')} — quota, first seen ${NOW.toISOString().replace(/\./gu, '\\.')}\\) plan`, 'u'));
  const claude = applyRefusal(applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(0.3), seven_day: win(0.3) } }, NOW), 'claude', UNTIL);
  assert.deepEqual(billingRoute({ provider: 'claude', model: 'opus', capacity: claude, now: NOW }), { billing: 'credits', why: `plan refused until ${UNTIL}` });
});

const CLAUDE_UNTIL = '2026-11-24T21:20:00.000Z';
const CLAUDE_SEEN = '2026-11-24T18:59:02.000Z';
const AT = new Date('2026-11-24T19:00:00.000Z');
const claudeAt = (fraction) => applyObservation(applyObservation(normaliseCapacity(null), 'claude', {
  windows: { five_hour: { fraction_used: fraction, resets_at: CLAUDE_UNTIL }, seven_day: { fraction_used: 0.09, resets_at: '2026-11-27T13:00:00.000Z' } },
}, new Date(CLAUDE_SEEN)), 'codex', { windows: { primary: { fraction_used: 0.41, resets_at: '2026-11-24T23:00:00.000Z' }, secondary: null }, models: [] }, new Date(CLAUDE_SEEN));

test('the billing line brackets a held quota refusal with its cause and first instant seen', () => {
  const capacity = applyRefusal(claudeAt(1.01), 'claude', CLAUDE_UNTIL, null, new Date(CLAUDE_SEEN), 'quota');
  const line = billingStatus({ capacity, state: null, api: {}, now: AT });
  assert.match(line, /^claude 101% \(refused until 2026-11-24T21:20:00\.000Z — quota, first seen 2026-11-24T18:59:02\.000Z\) API · codex 41% plan/u);
  for (const cause of ['login', 'host']) {
    const held = applyRefusal(claudeAt(0.3), 'claude', CLAUDE_UNTIL, null, new Date(CLAUDE_SEEN), cause);
    assert.match(billingStatus({ capacity: held, api: {}, now: AT }), new RegExp(`^claude 30% \\(refused until 2026-11-24T21:20:00\\.000Z — ${cause}, first seen`, 'u'));
  }
});

test('a plan refusal in billing-state.json with no capacity refusal beside it reads as a quota, with no first instant', () => {
  const line = billingStatus({ capacity: claudeAt(0.3), state: { plan: { refused_until: CLAUDE_UNTIL } }, api: {}, now: AT });
  assert.match(line, /^claude 30% \(refused until 2026-11-24T21:20:00\.000Z — quota\) API/u);
});

test('a refusal in a file without a cause reads as quota', () => {
  const raw = JSON.parse(JSON.stringify(claudeAt(1.01)));
  raw.providers.claude.refusal_until = CLAUDE_UNTIL;
  const claude = providerAt(raw, 'claude', AT);
  assert.deepEqual([claude.refusal_until, claude.refusal_cause, claude.refusal_since], [CLAUDE_UNTIL, 'quota', null]);
  assert.match(billingStatus({ capacity: raw, api: {}, now: AT }), /\(refused until 2026-11-24T21:20:00\.000Z — quota\) API/u);
});

test('a renewal keeps the cause\'s first instant and the later end; host is never replaced; between quota and login the later end wins', () => {
  const seen = new Date(CLAUDE_SEEN);
  const first = applyRefusal(claudeAt(1.01), 'claude', CLAUDE_UNTIL, null, seen, 'quota');
  const of = (state) => { const c = normaliseCapacity(state).providers.claude; return [c.refusal_until, c.refusal_cause, c.refusal_since]; };
  const later = '2026-11-24T22:00:00.000Z';
  const earlier = '2026-11-24T20:00:00.000Z';
  assert.deepEqual(of(applyRefusal(first, 'claude', later, null, AT, 'quota')), [later, 'quota', CLAUDE_SEEN], 'renewed later: the first instant stays');
  assert.deepEqual(of(applyRefusal(first, 'claude', earlier, null, AT, 'quota')), [CLAUDE_UNTIL, 'quota', CLAUDE_SEEN], 'renewed earlier: the later end stays');
  assert.deepEqual(of(applyRefusal(first, 'claude', later, null, AT, 'login')), [later, 'login', AT.toISOString()], 'a later login takes over');
  assert.deepEqual(of(applyRefusal(first, 'claude', earlier, null, AT, 'login')), [CLAUDE_UNTIL, 'quota', CLAUDE_SEEN], 'an earlier login does not');
  const host = applyRefusal(claudeAt(0.3), 'claude', earlier, null, seen, 'host');
  assert.deepEqual(of(applyRefusal(host, 'claude', later, null, AT, 'quota')), [earlier, 'host', CLAUDE_SEEN], 'a quota over a held host leaves host');
  assert.deepEqual(of(applyRefusal(host, 'claude', later, null, AT, 'login')), [earlier, 'host', CLAUDE_SEEN], 'a login over a held host leaves host');
  assert.deepEqual(of(applyRefusal(first, 'claude', later, null, AT, 'host')), [later, 'host', AT.toISOString()], 'a later host over a quota takes over');
  const hostOverQuota = applyRefusal(first, 'claude', earlier, null, AT, 'host');
  assert.deepEqual(of(hostOverQuota), [earlier, 'host', AT.toISOString()], 'an earlier host over a quota takes over too');
  assert.deepEqual(of(applyRefusal(hostOverQuota, 'claude', null, null, AT)), [CLAUDE_UNTIL, 'quota', CLAUDE_SEEN], 'clearing the host brings the quota under it back');
  const lapsed = providerAt(hostOverQuota, 'claude', new Date('2026-11-24T20:30:00.000Z'));
  assert.deepEqual([lapsed.refusal_until, lapsed.refusal_cause, lapsed.refusal_since], [CLAUDE_UNTIL, 'quota', CLAUDE_SEEN], 'a host refusal that has passed leaves the quota under it in force');
  assert.deepEqual(of(applyRefusal(applyRefusal(hostOverQuota, 'claude', later, null, AT, 'login'), 'claude', null, null, AT)), [later, 'login', AT.toISOString()], 'under a host, between quota and login the later end wins');
  const passed = new Date('2026-11-24T21:30:00.000Z');
  assert.deepEqual(of(applyRefusal(first, 'claude', later, null, passed, 'quota')), [later, 'quota', passed.toISOString()], 'over a passed refusal it is first seen now');
  assert.deepEqual(of(applyRefusal(first, 'claude', null)), [null, null, null]);
});

test('API first puts a runner session on the key while the plan has room, and back on the plan while the credit is unusable', () => {
  const capacity = claudeAt(0.3);
  const api = { claude: 'first', codex: false };
  assert.deepEqual(billingRoute({ provider: 'claude', capacity, api, now: AT, runner: true }), { billing: 'credits', why: 'API first' });
  assert.equal(billingRoute({ provider: 'claude', capacity, api, now: AT }).billing, 'plan', 'an interactive session keeps plan first');
  assert.equal(billingRoute({ provider: 'codex', capacity, api: { codex: 'first' }, now: AT, runner: true }).billing, 'credits');
  const state = { credits: { unusable_until: CLAUDE_UNTIL, why: 'credit balance too low' } };
  assert.deepEqual(billingRoute({ provider: 'claude', capacity, state, api, now: AT, runner: true }),
    { billing: 'plan', why: `API first, but the API is unusable until ${CLAUDE_UNTIL} (credit balance too low)` });
  assert.match(billingStatus({ capacity, api, now: AT }), /^claude 30% plan \(API first for runner sessions\)/u);
});
