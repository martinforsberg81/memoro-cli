/**
 * The billing mode and the plan's windows (billing.js).
 *
 * The default has to hold against every file that is not a good one: nothing
 * in step-credits may change what a runner does until Martin picks a mode, so
 * absent, broken and unknown all read as `plan`. `billingFor` is pure and is
 * the one answer the runner and the verb both ask, so its order is pinned case
 * by case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BILLING_MODES, CREDITS_RETRY_MS, DEFAULT_BILLING, billingFor, billingPath, billingStatePath,
  patchBillingState, planWindows, readBillingApi, readBillingMode, readBillingState, writeBillingApi, writeBillingMode,
} from '../../src/mc/billing.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'mc-billing-'));
const NOW = new Date('2026-10-11T12:00:00Z');

/** The event as it stood in `~/mc/runner/log/*.jsonl` on 2026-10-11. */
const EVENT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning', resetsAt: 1792155600, rateLimitType: 'seven_day', utilization: 0.59,
    unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791721200 }, seven_day: { utilization: 0.59, resetsAt: 1792155600 } },
  },
});

test('constants: two modes, plan the default, a day', () => {
  assert.deepEqual(BILLING_MODES, ['plan', 'credits']);
  assert.equal(DEFAULT_BILLING, 'plan');
  assert.equal(CREDITS_RETRY_MS, 24 * 60 * 60 * 1000);
});

test('readBillingMode: absent, broken and unknown files read plan', () => {
  const root = fresh();
  assert.equal(readBillingMode({ root }), 'plan', 'absent');
  writeFileSync(billingPath(root), '{ not json');
  assert.equal(readBillingMode({ root }), 'plan', 'broken');
  writeFileSync(billingPath(root), JSON.stringify({ mode: 'free' }));
  assert.equal(readBillingMode({ root }), 'plan', 'unknown');
  writeFileSync(billingPath(root), JSON.stringify([]));
  assert.equal(readBillingMode({ root }), 'plan', 'not an object');
});

test('writeBillingMode: each mode round-trips, 0600, and an unknown one is refused naming both', () => {
  const root = fresh();
  for (const mode of BILLING_MODES) {
    assert.deepEqual(writeBillingMode(mode, { root, now: NOW }), { ok: true, mode, set: NOW.toISOString() });
    assert.equal(readBillingMode({ root }), mode);
  }
  assert.equal(statSync(billingPath(root)).mode & 0o777, 0o600);
  const refused = writeBillingMode('free', { root, now: NOW });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /plan, credits, not "free"/u);
  assert.equal(readBillingMode({ root }), 'credits', 'the refusal wrote nothing');
});

test('writeBillingMode: a write clears the credit mark and leaves the plan windows', () => {
  const root = fresh();
  const week = { utilization: 0.5, resets_at: '2026-10-14T08:00:00.000Z' };
  patchBillingState({ plan: { seven_day: week }, credits: { unusable_until: '2026-10-12T12:00:00Z', why: 'balance too low' } }, { root });
  writeBillingMode('credits', { root, now: NOW });
  const state = readBillingState({ root });
  assert.deepEqual(state.credits, { unusable_until: null, why: null });
  assert.deepEqual(state.plan.seven_day, week);
});

test('readBillingState: absent or broken is empty, any bad field is null', () => {
  const root = fresh();
  const empty = { plan: { five_hour: null, seven_day: null, seen: null, refused_until: null }, credits: { unusable_until: null, why: null } };
  assert.deepEqual(readBillingState({ root }), empty);
  writeFileSync(billingStatePath(root), 'nope');
  assert.deepEqual(readBillingState({ root }), empty);
  writeFileSync(billingStatePath(root), JSON.stringify({
    plan: { five_hour: { utilization: 'x', resets_at: '2026-10-12T00:00:00Z' }, seven_day: { utilization: 0.4, resets_at: 'soon' }, seen: 7, refused_until: '2026-10-12T00:00:00Z' },
    credits: { unusable_until: null, why: 3 },
  }));
  assert.deepEqual(readBillingState({ root }), {
    plan: { five_hour: null, seven_day: null, seen: null, refused_until: '2026-10-12T00:00:00Z' },
    credits: { unusable_until: null, why: null },
  });
});

test('patchBillingState: merges per top-level key and writes the whole file', () => {
  const root = fresh();
  patchBillingState({ credits: { unusable_until: '2026-10-12T12:00:00Z', why: 'key rejected' } }, { root });
  patchBillingState({ plan: { refused_until: '2026-10-11T15:00:00Z' } }, { root });
  const onDisk = JSON.parse(readFileSync(billingStatePath(root), 'utf8'));
  assert.equal(onDisk.credits.why, 'key rejected');
  assert.equal(onDisk.plan.refused_until, '2026-10-11T15:00:00Z');
  assert.equal(onDisk.plan.seven_day, null);
});

test('planWindows: the last event carrying unifiedWindows, resets made ISO', () => {
  const later = EVENT.replace('"utilization":0.59,"resetsAt":1792155600}', '"utilization":0.61,"resetsAt":1792155600}');
  const stream = ['{"type":"system"}', EVENT, '{"type":"assistant"}', later, '{"type":"result"}'].join('\n');
  assert.deepEqual(planWindows(stream), {
    five_hour: { utilization: 0.08, resets_at: new Date(1791721200 * 1000).toISOString() },
    seven_day: { utilization: 0.61, resets_at: new Date(1792155600 * 1000).toISOString() },
  });
});

test('planWindows: a stream without unifiedWindows is null, a broken line is passed over, a bad window is null', () => {
  const bare = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792155600 } });
  assert.equal(planWindows(`{"type":"system"}\n${bare}\n`), null);
  assert.equal(planWindows(''), null);
  assert.equal(planWindows(`{"type":"rate_limit_event", broken\n${EVENT}`).seven_day.utilization, 0.59);
  const half = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x', resetsAt: 1 }, seven_day: { utilization: 0.2, resetsAt: 1792155600 } } } });
  assert.equal(planWindows(half).five_hour, null);
  assert.equal(planWindows(half).seven_day.utilization, 0.2);
});

const week = (utilization, resets_at = '2026-10-14T08:00:00Z') => ({ plan: { seven_day: { utilization, resets_at } } });
const ask = (mode, state, toolId = 'claude-code') => billingFor({ mode, state, toolId, now: NOW });

test('billingFor retired auto reads as plan', () => {
  assert.equal(ask('auto', week(0.99)).billing, 'plan');
  assert.equal(ask('auto', {}).why, 'mode plan');
});

test('billingFor credits: the credit only when Martin set the mode, whatever the windows say', () => {
  assert.equal(ask('credits', week(0.1)).billing, 'credits');
  assert.equal(ask('credits', { plan: { refused_until: '2026-10-11T11:00:00Z' } }).billing, 'credits');
});

test('billingFor: a credit marked unusable is plan in every mode', () => {
  const marked = { ...week(0.95), plan: { ...week(0.95).plan, refused_until: '2026-10-11T15:00:00Z' }, credits: { unusable_until: '2026-10-12T12:00:00Z', why: 'balance too low' } };
  for (const mode of BILLING_MODES) {
    const answer = ask(mode, marked);
    assert.equal(answer.billing, 'plan', mode);
    assert.match(answer.why, /credits unusable until 2026-10-12T12:00:00Z — balance too low/u);
  }
  assert.equal(ask('credits', { credits: { unusable_until: '2026-10-11T11:00:00Z' } }).billing, 'credits', 'a mark that has passed');
});

test('billingFor: plan and credits are themselves, an unknown mode is plan, codex is plan', () => {
  assert.equal(ask('plan', week(0.99)).billing, 'plan');
  assert.equal(ask('credits', week(0.1)).billing, 'credits');
  assert.equal(ask('free', week(0.99)).billing, 'plan');
  const codex = ask('credits', week(0.99), 'codex');
  assert.equal(codex.billing, 'plan');
  assert.match(codex.why, /codex/u);
});

test('readBillingApi/writeBillingApi: both on by default, one switched, the mode kept and kept by a mode write', () => {
  const root = fresh();
  assert.deepEqual(readBillingApi({ root }), { claude: true, codex: true });
  writeBillingMode('plan', { root, now: NOW });
  assert.deepEqual(writeBillingApi('codex', false, { root }), { ok: true, api: { claude: true, codex: false } });
  assert.equal(readBillingMode({ root }), 'plan');
  writeBillingMode('plan', { root, now: NOW });
  assert.deepEqual(readBillingApi({ root }), { claude: true, codex: false });
  assert.equal(statSync(billingPath(root)).mode & 0o777, 0o600);
  assert.equal(writeBillingApi('gemini', false, { root }).ok, false);
  writeFileSync(billingPath(root), '{broken');
  assert.deepEqual(readBillingApi({ root }), { claude: true, codex: true });
});
