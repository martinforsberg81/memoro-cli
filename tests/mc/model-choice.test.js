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
import { billingStatus, billingRoute } from '../../src/mc/billing-route.js';

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

test('explicit Claude priority bootstraps unknown or stale usage ahead of known Codex', () => {
  let unknown = codex(empty(), win(0.1));
  for (const cls of ['fast', 'large', 'review']) {
    const chosen = chooseCandidate({ cls, catalog: DEFAULT_CATALOG, capacity: unknown, now: NOW, priority: 'claude' });
    assert.equal(chosen.candidate.tool, 'claude', `${cls} honors the saved priority`);
    assert.equal(chosen.basis, 'bootstrap');
  }
  const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
  unknown = codex(claude(empty(), win(0.1), win(0.1), old), win(0.1));
  for (const cls of ['fast', 'large', 'review']) {
    assert.equal(chooseCandidate({ cls, catalog: DEFAULT_CATALOG, capacity: unknown, now: NOW, priority: 'claude' }).candidate.tool, 'claude');
  }
  const reset = codex(claude(empty(), win(0.9, PAST), win(0.95, PAST)), win(0.1));
  for (const cls of ['fast', 'large', 'review']) {
    const chosen = chooseCandidate({ cls, catalog: DEFAULT_CATALOG, capacity: reset, now: NOW, priority: 'claude' });
    assert.equal(chosen.candidate.tool, 'claude', `${cls} treats reset windows as unknown, not zero or Codex preference`);
    assert.equal(chosen.basis, 'bootstrap');
  }
});

test('billing status names stale and failed usage without claiming plan availability', () => {
  const old = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const stale = codex(claude(empty(), win(0.2), win(0.2), old), win(0.1));
  const text = billingStatus({ capacity: stale, state: {}, api: {}, now: NOW });
  assert.match(text, /claude 20% \(stale\) plan/u);
  assert.match(billingRoute({ provider: 'claude', capacity: stale, state: {}, api: {}, now: NOW }).why, /stale/u);
  const failed = applyFailure(empty(), 'claude', { why: 'login unavailable' }, NOW);
  assert.match(billingStatus({ capacity: failed, state: {}, api: {}, now: NOW }), /claude \? \(read failed\) plan/u);
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

test('review takes its first candidate whatever the usage says', () => {
  const unread = choose(empty(), 'review');
  assert.equal(unread.ok, true);
  assert.equal(unread.spec, 'claude:opus:high');
  assert.equal(unread.basis, 'preferred');
  const nearLimit = choose(codex(claude(empty(), win(0.9), win(0.9)), win(0.1)), 'review');
  assert.equal(nearLimit.spec, 'claude:opus:high', 'not outscored by the codex headroom');
  assert.equal(choose(applyRefusal(empty(), 'codex', AHEAD), 'review').spec, 'claude:opus:high', 'the other provider\'s refusal is not review\'s');
});

test('review uses its one candidate\'s plan through 99 % and API reserve at 100 %', () => {
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

const SOL = Object.freeze({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
const OPUS = Object.freeze({ tool: 'claude', model: 'opus', effort: 'high' });
const REVIEWS = { ...DEFAULT_CATALOG, review: [SOL, OPUS] };
const review = (capacity, avoid = null) => chooseCandidate({ cls: 'review', catalog: REVIEWS, capacity, now: NOW, avoid });

test('review passes a candidate whose plan is spent for the next one on plan', () => {
  const spent = review(codex(claude(empty(), win(0.5)), win(1, LATER)));
  assert.equal(spent.ok, true);
  assert.equal(spent.spec, 'claude:opus:high');
  assert.equal(spent.basis, 'preferred');
  assert.equal(spent.billing, undefined, 'on the plan, not credits');
  assert.match(spent.why, /^review candidate 2 — codex:gpt-6.1-sol:high: codex is at 100 % of its plan limit$/u);
  const refused = review(applyRefusal(codex(empty(), win(0.1)), 'codex', AHEAD));
  assert.equal(refused.spec, 'claude:opus:high', 'a refused plan is passed too');
});

test('review passes the model the goal was built on, when both plans have room', () => {
  const both = codex(claude(empty(), win(0.5)), win(0.5));
  const built = review(both, { tool: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(built.spec, 'claude:opus:high');
  assert.match(built.why, /codex gpt-6.1-sol built it/u);
  assert.equal(review(both).spec, 'codex:gpt-6.1-sol:high', 'unbuilt, the first is taken');
});

test('review chooses the roomier plan before catalog order or build-model avoidance', () => {
  const roomier = codex(claude(empty(), win(0.05)), win(0.9));
  const chosen = review(roomier, { tool: 'claude', model: 'opus' });
  assert.equal(chosen.spec, 'claude:opus:high', 'codex has 10 % headroom, claude 95 %, even though Claude built it');
  assert.match(chosen.why, /review candidate 2/u);
});

test('review with no candidate on plan goes to the first one\'s API reserve', () => {
  const none = review(applyRefusal(codex(empty(), win(1, LATER)), 'claude', AHEAD));
  assert.equal(none.ok, true);
  assert.equal(none.spec, 'codex:gpt-6.1-sol:high');
  assert.equal(none.basis, 'api');
  assert.equal(none.billing, 'credits');
  const past = review(applyRefusal(codex(empty(), win(1, LATER)), 'claude', AHEAD), { tool: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(past.spec, 'claude:opus:high', 'never the build model\'s reserve');
  assert.equal(past.billing, 'credits');
});

test('review runs on the build model when every candidate is it, rather than waiting', () => {
  const only = { ...DEFAULT_CATALOG, review: [SOL] };
  const result = chooseCandidate({ cls: 'review', catalog: only, capacity: codex(empty(), win(0.1)), now: NOW, avoid: { tool: 'codex', model: 'gpt-6.1-sol' } });
  assert.equal(result.ok, true);
  assert.equal(result.spec, 'codex:gpt-6.1-sol:high');
  assert.equal(result.basis, 'preferred');
  assert.equal(result.billing, undefined, 'on the plan, not credits');
  assert.equal(result.why, 'review candidate 1 — codex gpt-6.1-sol built it, and no other candidate can run on its plan');
});

test('review takes the build model on its plan when every other candidate\'s plan is spent, before any API reserve', () => {
  const spentCodex = codex(claude(empty(), win(0.5)), win(1, LATER));
  const result = review(spentCodex, { tool: 'claude', model: 'opus' });
  assert.equal(result.ok, true);
  assert.equal(result.spec, 'claude:opus:high');
  assert.equal(result.basis, 'preferred');
  assert.equal(result.billing, undefined, 'the build model\'s plan comes before another\'s reserve');
  assert.equal(result.why, 'review candidate 2 — codex:gpt-6.1-sol:high: codex is at 100 % of its plan limit; claude opus built it, and no other candidate can run on its plan');
  const roomy = review(codex(claude(empty(), win(0.5)), win(0.5)), { tool: 'claude', model: 'opus' });
  assert.equal(roomy.spec, 'codex:gpt-6.1-sol:high', 'another model on its plan is still taken first');
});

test('review with only the build model\'s candidates and none on plan goes to its API reserve', () => {
  const only = { ...DEFAULT_CATALOG, review: [SOL] };
  const result = chooseCandidate({ cls: 'review', catalog: only, capacity: codex(empty(), win(1, LATER)), now: NOW, avoid: { tool: 'codex', model: 'gpt-6.1-sol' } });
  assert.equal(result.ok, true);
  assert.equal(result.spec, 'codex:gpt-6.1-sol:high');
  assert.equal(result.basis, 'api');
  assert.equal(result.billing, 'credits');
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

test('provider preference outranks headroom, is symmetric, and auto keeps capacity ranking', () => {
  const roomierClaude = codex(claude(empty(), win(0.1)), win(0.9));
  assert.equal(chooseCandidate({ cls: 'fast', catalog: DEFAULT_CATALOG, capacity: roomierClaude, now: NOW, priority: 'codex' }).spec, 'codex:gpt-6-luna:high');
  const roomierCodex = codex(claude(empty(), win(0.9)), win(0.1));
  assert.equal(chooseCandidate({ cls: 'fast', catalog: DEFAULT_CATALOG, capacity: roomierCodex, now: NOW, priority: 'claude' }).spec, 'claude:haiku:high');
  assert.equal(choose(roomierClaude).spec, 'claude:haiku:high');
});

test('priority prefers a subscription before any API reserve and falls back for exhausted or refused providers', () => {
  const mixed = { ...DEFAULT_CATALOG, fast: [DEFAULT_CATALOG.fast[1], DEFAULT_CATALOG.fast[0]] };
  const availableClaude = codex(claude(empty(), win(0.9)), win(1, LATER));
  const fallback = chooseCandidate({ cls: 'fast', catalog: mixed, capacity: availableClaude, now: NOW, priority: 'codex' });
  assert.equal(fallback.spec, 'claude:haiku:high');
  assert.equal(fallback.billing, undefined);
  assert.match(fallback.why, /codex unavailable on subscription, claude subscription fallback/u);
  const refused = applyRefusal(codex(claude(empty(), win(0.1)), win(0.1)), 'codex', AHEAD);
  assert.equal(chooseCandidate({ cls: 'fast', catalog: mixed, capacity: refused, now: NOW, priority: 'codex' }).spec, 'claude:haiku:high');
  const noSubscription = chooseCandidate({ cls: 'fast', catalog: mixed, capacity: codex(applyRefusal(empty(), 'claude', AHEAD), win(1, LATER)), now: NOW, priority: 'codex' });
  assert.equal(noSubscription.candidate.tool, 'codex');
  assert.equal(noSubscription.billing, 'credits');
});

test('review priority wins over build-model avoidance and review headroom, but unavailable preference falls back to a subscription', () => {
  const candidates = { ...DEFAULT_CATALOG, review: [OPUS, SOL] };
  const capacity = codex(claude(empty(), win(0.1)), win(0.9));
  const preferred = chooseCandidate({ cls: 'review', catalog: candidates, capacity, now: NOW, priority: 'codex', avoid: { tool: 'codex', model: 'gpt-6.1-sol' } });
  assert.equal(preferred.spec, 'codex:gpt-6.1-sol:high');
  assert.equal(preferred.billing, undefined);
  assert.match(preferred.why, /priority overrides a roomier alternative/u);
  assert.doesNotMatch(preferred.why, /most headroom/u);
  const unavailable = codex(claude(empty(), win(0.9)), win(0.1), null, { models: [] });
  assert.equal(chooseCandidate({ cls: 'review', catalog: candidates, capacity: unavailable, now: NOW, priority: 'codex' }).spec, 'claude:opus:high');
});
