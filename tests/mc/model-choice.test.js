/**
 * The choice of a fast, large or review candidate (model-choice.js). Pure, so
 * the catalog and the capacity snapshot are built here and `now` is fixed:
 * every answer is pinned, not read from a clock or a file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyFailure, applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { PLAN_LIMIT_UTILIZATION, chooseCandidate } from '../../src/mc/model-choice.js';

const NOW = new Date('2026-10-27T12:00:00Z');
const AHEAD = '2026-10-27T15:00:00.000Z';
const PAST = '2026-10-27T09:00:00.000Z';
const LATER = '2026-10-30T00:00:00.000Z';
const FOUR_HOURS_AGO = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
const LISTED = [{ id: 'gpt-6-luna', efforts: ['high'] }, { id: 'gpt-6.1-sol', efforts: ['high'] }];

const empty = () => normaliseCapacity(null);
const win = (fraction_used, resets_at = AHEAD) => ({ fraction_used, resets_at });
/** Claude's five-hour and seven-day windows, read at `at`. */
const claude = (state, five, seven = five, at = NOW) => applyObservation(state, 'claude', { windows: { five_hour: five, seven_day: seven } }, at);
/** Codex's primary and secondary windows and its model list, read at `at`. */
const codex = (state, primary, secondary = null, { models = LISTED, at = NOW } = {}) => applyObservation(state, 'codex', { windows: { primary, secondary }, models }, at);
const choose = (capacity, cls = 'fast', catalog = DEFAULT_CATALOG) => chooseCandidate({ cls, catalog, capacity, now: NOW });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('the automatic plan limit is the full window', () => {
  assert.equal(PLAN_LIMIT_UTILIZATION, 1);
});

test('fast: either provider is chosen, the one with more headroom', () => {
  const first = choose(codex(claude(empty(), win(0.2), win(0.2)), win(0.5), win(0.4)));
  assert.equal(first.ok, true);
  assert.equal(first.spec, 'claude:haiku:high');
  assert.equal(first.basis, 'known');
  near(first.headroom, 0.8);

  const second = choose(codex(claude(empty(), win(0.7), win(0.2)), win(0.1), win(0.2)));
  assert.equal(second.spec, 'codex:gpt-6-luna:high');
  assert.equal(second.basis, 'known');
  near(second.headroom, 0.8);
});

test('a codex candidate is scored by its most restrictive window', () => {
  const won = choose(codex(claude(empty(), win(0.5), win(0.5)), win(0.1), win(0.75)));
  assert.equal(won.spec, 'claude:haiku:high', 'codex is 0.25 by its secondary, claude 0.5');
  near(won.headroom, 0.5);
});

test('large chooses from the large list', () => {
  const won = choose(codex(claude(empty(), win(0.5), win(0.5)), win(0.1), win(0.1)), 'large');
  assert.equal(won.class, 'large');
  assert.equal(won.spec, 'codex:gpt-6.1-sol:high');
});

test('a retired manual credits flag cannot override plan-first routing', () => {
  const capacity = codex(claude(empty(), win(0.95), win(0.95)), win(0.1));
  for (const cls of ['fast', 'large']) {
    const result = chooseCandidate({ cls, catalog: DEFAULT_CATALOG, capacity, now: NOW, credits: true });
    assert.equal(result.candidate.tool, 'codex');
    assert.equal(result.basis, 'known');
  }
});

test('review is pinned to the catalog review, whatever the usage says', () => {
  const unread = choose(empty(), 'review');
  assert.equal(unread.ok, true);
  assert.equal(unread.spec, 'claude:opus:high');
  assert.equal(unread.basis, 'pinned');
  const nearLimit = choose(codex(claude(empty(), win(0.9), win(0.9)), win(0.1)), 'review');
  assert.equal(nearLimit.spec, 'claude:opus:high', 'not outscored by the codex headroom');
  assert.equal(choose(applyRefusal(empty(), 'codex', AHEAD), 'review').spec, 'claude:opus:high', 'the other provider\'s refusal is not review\'s');
});

test('review uses its pinned plan through 99 % and API reserve at 100 %', () => {
  const nearLimit = choose(claude(empty(), win(0.99)), 'review');
  assert.equal(nearLimit.spec, 'claude:opus:high');
  const full = choose(claude(empty(), win(1)), 'review');
  assert.equal(full.ok, true);
  assert.equal(full.spec, 'claude:opus:high');
  assert.equal(full.billing, 'credits');
});

test('review uses its own provider API reserve on a plan refusal', () => {
  const held = choose(codex(applyRefusal(empty(), 'claude', AHEAD), win(0.1)), 'review');
  assert.equal(held.ok, true);
  assert.equal(held.class, 'review');
  assert.equal(held.spec, 'claude:opus:high');
  assert.equal(held.billing, 'credits');
  assert.equal(choose(applyRefusal(empty(), 'claude', PAST), 'review').spec, 'claude:opus:high', 'a passed refusal holds nothing');
});

test('a refusal in force makes its provider ineligible, and a passed one does not', () => {
  const refused = applyRefusal(claude(empty(), win(0.1), win(0.1)), 'claude', AHEAD);
  assert.equal(choose(codex(refused, win(0.5))).spec, 'codex:gpt-6-luna:high');

  const passed = applyRefusal(claude(empty(), win(0.1), win(0.1)), 'claude', PAST);
  assert.equal(choose(codex(passed, win(0.5))).spec, 'claude:haiku:high');
});

test('a refused claude is never the bootstrap and selects API reserve', () => {
  const result = choose(applyRefusal(empty(), 'claude', AHEAD));
  assert.equal(result.ok, true);
  assert.equal(result.class, 'fast');
  assert.equal(result.billing, 'credits');
  assert.equal(result.spec, 'claude:haiku:high');
});

test('a plan stays eligible below 100 % and is exhausted at 100 %', () => {
  const full = choose(codex(empty(), win(1, LATER)));
  assert.equal(full.ok, true);
  assert.equal(full.spec, 'claude:haiku:high');
  assert.equal(full.basis, 'bootstrap');

  const under = choose(codex(empty(), win(0.99)));
  assert.equal(under.spec, 'codex:gpt-6-luna:high');
  assert.equal(under.basis, 'known');
  near(under.headroom, 0.01);
});

test('an expired claude window is not free capacity: it bootstraps, and a known candidate beats it', () => {
  const expired = claude(empty(), win(0.1, PAST), win(0.1, PAST));
  const bootstrap = choose(expired);
  assert.equal(bootstrap.basis, 'bootstrap');
  assert.equal(bootstrap.spec, 'claude:haiku:high');
  assert.equal(choose(codex(expired, win(0.5))).spec, 'codex:gpt-6-luna:high');
});

test('a claude read older than three hours is not current unless it reached 100 %', () => {
  const old = claude(empty(), win(0.1), win(0.1), FOUR_HOURS_AGO);
  assert.equal(choose(old).basis, 'bootstrap');
  assert.equal(choose(codex(old, win(0.5))).spec, 'codex:gpt-6-luna:high');

  const high = claude(empty(), win(0.9), win(0.1), FOUR_HOURS_AGO);
  assert.equal(choose(high).basis, 'bootstrap');
  const full = claude(empty(), win(1), win(0.1), FOUR_HOURS_AGO);
  const held = choose(full);
  assert.equal(held.ok, true);
  assert.equal(held.billing, 'credits');
});

test('codex needs a fresh successful rate-limit read, a model listed at the effort, and no failure', () => {
  assert.equal(choose(empty()).spec, 'claude:haiku:high', 'an unread codex is never chosen; claude bootstraps');

  const failed = applyFailure(empty(), 'codex', { why: 'account/rateLimits/read failed: ChatGPT login required' }, NOW);
  const noEntitlement = choose(applyRefusal(failed, 'claude', AHEAD));
  assert.equal(noEntitlement.billing, 'credits');

  const stale = choose(applyRefusal(codex(empty(), win(0.1), null, { at: FOUR_HOURS_AGO }), 'claude', AHEAD));
  assert.equal(stale.billing, 'credits');

  const unlisted = choose(applyRefusal(codex(empty(), win(0.1), null, { models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }] }), 'claude', AHEAD));
  assert.equal(unlisted.billing, 'credits');

  const lowEffort = choose(applyRefusal(codex(empty(), win(0.1), null, { models: [{ id: 'gpt-6-luna', efforts: ['medium'] }] }), 'claude', AHEAD));
  assert.equal(lowEffort.billing, 'credits');

  const reset = choose(applyRefusal(codex(empty(), win(0.1, PAST), win(0.1, PAST)), 'claude', AHEAD));
  assert.equal(reset.billing, 'credits');
});

test('a tie on headroom keeps catalog order', () => {
  const tied = codex(claude(empty(), win(0.5), win(0.5)), win(0.5), win(0.5));
  const reversed = { ...DEFAULT_CATALOG, fast: [...DEFAULT_CATALOG.fast].reverse() };
  assert.equal(choose(tied, 'fast', reversed).spec, 'codex:gpt-6-luna:high');
  assert.equal(choose(tied, 'fast', DEFAULT_CATALOG).spec, 'claude:haiku:high');
});

test('no plan capacity selects the first catalog API reserve', () => {
  const none = choose(codex(applyRefusal(empty(), 'claude', AHEAD), win(1, LATER)));
  assert.equal(none.ok, true);
  assert.equal(none.spec, 'claude:haiku:high');
  assert.equal(none.billing, 'credits');
});

test('an unavailable plan may still use the provider API reserve', () => {
  const codexOnly = { ...DEFAULT_CATALOG, fast: [DEFAULT_CATALOG.fast[1]] };
  const none = choose(applyFailure(empty(), 'codex', { why: 'codex did not start: spawn codex ENOENT' }, NOW), 'fast', codexOnly);
  assert.equal(none.ok, true);
  assert.equal(none.billing, 'credits');
});

test('a class is fast, large or review', () => {
  assert.throws(() => choose(empty(), 'credits'), /"credits" is not a class — fast, large or review/u);
});
