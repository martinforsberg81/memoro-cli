import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingRoute } from '../../src/mc/billing-route.js';
import { normaliseBillingState } from '../../src/mc/billing.js';
import { CLAUDE_USAGE_URL, claudeUsageWindows, collectClaudeCapacity, makeClaudeUsageReader, readClaudeCredential } from '../../src/mc/claude-capacity.js';
import { applyCollectedCapacity, applyObservation, applyRefusal, normaliseCapacity, observeClaudeStream, providerAt } from '../../src/mc/model-capacity.js';

const valid = JSON.stringify({
  five_hour: { utilization: 37.5, resets_at: '2026-11-06T15:00:00Z' },
  seven_day: { utilization: 82, resets_at: '2026-11-10T00:00:00+00:00' },
});
const response = (body, { status = 200, headers = {} } = {}) => ({
  status, ok: status >= 200 && status < 300, headers,
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }),
});

test('Claude usage normalization validates each window alone and names the one it refused', () => {
  const seven = JSON.parse(valid).seven_day;
  const sevenValid = { fraction_used: 0.82, resets_at: '2026-11-10T00:00:00.000Z' };
  const one = (five_hour, unread) => ({ windows: { five_hour: null, seven_day: sevenValid }, unread: { five_hour: unread } });
  assert.deepEqual(claudeUsageWindows({ seven_day: seven }), one(null, 'absent'));
  assert.deepEqual(claudeUsageWindows({ five_hour: null, seven_day: seven }), one(null, 'absent'));
  assert.deepEqual(claudeUsageWindows({ five_hour: { utilization: 0, resets_at: null }, seven_day: seven }), one(null, 'resets_at'));
  assert.deepEqual(claudeUsageWindows({ five_hour: { utilization: 0, resets_at: '2026-02-30T00:00:00Z' }, seven_day: seven }), one(null, 'resets_at'));
  assert.deepEqual(claudeUsageWindows({ five_hour: { utilization: 101, resets_at: '2026-11-06T15:00:00Z' }, seven_day: seven }), one(null, 'utilization'));
  assert.deepEqual(claudeUsageWindows({ five_hour: JSON.parse(valid).five_hour, seven_day: [] }), {
    windows: { five_hour: { fraction_used: 0.375, resets_at: '2026-11-06T15:00:00.000Z' }, seven_day: null },
    unread: { seven_day: 'not an object' },
  });
  assert.deepEqual(claudeUsageWindows([]), { windows: { five_hour: null, seven_day: null }, unread: { five_hour: 'absent', seven_day: 'absent' } });
  assert.deepEqual(claudeUsageWindows(JSON.parse(valid)), {
    windows: {
      five_hour: { fraction_used: 0.375, resets_at: '2026-11-06T15:00:00.000Z' },
      seven_day: sevenValid,
    },
    unread: {},
  });
});

test('Claude collector reads a body with one valid window, and refuses one with none by naming each window and rule, never a value', async () => {
  const seven = JSON.parse(valid).seven_day;
  const one = await collectClaudeCapacity({ credentials: () => 'fixture-login', fetch: async () => response(JSON.stringify({ five_hour: null, seven_day: seven })) });
  assert.equal(one.ok, true);
  assert.equal(one.windows.five_hour, null);
  assert.equal(one.windows.seven_day.fraction_used, 0.82);
  assert.deepEqual(one.unread, { five_hour: 'absent' });
  const none = await collectClaudeCapacity({ credentials: () => 'fixture-login', fetch: async () => response(JSON.stringify({ five_hour: { utilization: 'LEAK-7', resets_at: 'LEAK-8' }, extra: 'LEAK-9' })) });
  assert.deepEqual(none, { ok: false, why: 'Claude subscription response had an invalid schema (five_hour: utilization; seven_day: absent)' });
  const array = await collectClaudeCapacity({ credentials: () => 'fixture-login', fetch: async () => response('[]') });
  assert.deepEqual(array, { ok: false, why: 'Claude subscription response had an invalid schema (five_hour: absent; seven_day: absent)' });
  assert.doesNotMatch(JSON.stringify([one, none, array]), /LEAK|fixture-login/u);
});

test('a successful Claude read keeps the window the body carried but did not validate, replaces one it does not carry; a Codex null window still replaces', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const later = new Date('2026-11-14T12:15:00Z');
  const window = (fraction_used) => ({ fraction_used, resets_at: '2026-11-20T13:00:00.000Z' });
  const base = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: window(0.2), seven_day: window(0.4) } }, now);
  for (const word of ['utilization', 'resets_at', 'not an object']) {
    const kept = applyCollectedCapacity(base, 'claude', { ok: true, windows: { five_hour: null, seven_day: window(0.43) }, unread: { five_hour: word } }, later).providers.claude;
    assert.deepEqual(kept.windows, { five_hour: window(0.2), seven_day: window(0.43) }, `five_hour ${word} keeps the held window`);
  }
  const claude = applyCollectedCapacity(base, 'claude', { ok: true, windows: { five_hour: null, seven_day: window(0.43) }, unread: { five_hour: 'absent' } }, later).providers.claude;
  assert.deepEqual(claude.windows, { five_hour: null, seven_day: window(0.43) }, 'a window the body does not carry is absent');
  assert.equal(claude.observed_at, later.toISOString());
  assert.equal(claude.failure, null);
  assert.equal('unread' in claude, false);
  const codex = applyObservation(base, 'codex', { windows: { primary: window(0.5), secondary: window(0.6) }, models: [] }, now);
  const replaced = applyCollectedCapacity(codex, 'codex', { ok: true, windows: { primary: window(0.7), secondary: null }, models: [] }, later).providers.codex.windows;
  assert.deepEqual(replaced, { primary: window(0.7), secondary: null });
});

test('Claude collector makes only the fixed bounded read and returns subscription windows', async () => {
  let request;
  const got = await collectClaudeCapacity({
    credentials: () => 'fixture-secret',
    fetch: async (url, options) => { request = { url, options }; return response(valid); },
  });
  assert.equal(got.ok, true);
  assert.equal(got.windows.five_hour.fraction_used, 0.375);
  assert.equal(request.url, CLAUDE_USAGE_URL);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'manual');
  assert.equal(request.options.headers.authorization, 'Bearer fixture-secret');
  assert.equal(JSON.stringify(got).includes('fixture-secret'), false);
});

test('Claude auth is read-only from the macOS Keychain or standard credentials file', async () => {
  const seen = [];
  const keychain = await readClaudeCredential({
    platform: 'darwin', home: '/fixture', exists: () => true,
    readKeychain: (service) => { seen.push(service); return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }); },
    readFile: () => { throw new Error('Keychain should take precedence'); },
  });
  assert.equal(keychain, 'keychain-token');
  assert.deepEqual(seen, ['Claude Code-credentials']);
  const file = await readClaudeCredential({
    platform: 'linux', home: '/fixture', exists: (path) => path === '/fixture/.claude/.credentials.json',
    readFile: (path) => { seen.push(path); return JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }); },
  });
  assert.equal(file, 'file-token');
  assert.equal(seen.at(-1), '/fixture/.claude/.credentials.json');
  assert.equal(await readClaudeCredential({ platform: 'linux', home: '/fixture', exists: () => false }), null);
});

test('a failed collector retains its last snapshot and an older success preserves concurrent provider updates', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const later = new Date('2026-11-06T12:00:01Z');
  const window = (fraction_used) => ({ fraction_used, resets_at: '2026-11-06T15:00:00Z' });
  const base = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: window(0.25), seven_day: window(0.4) } }, now);
  const before = JSON.stringify(base.providers.claude);
  const failed = applyCollectedCapacity(base, 'claude', { ok: false, why: 'login unavailable' }, later, before);
  assert.equal(failed.providers.claude.windows.five_hour.fraction_used, 0.25);
  assert.deepEqual(failed.providers.claude.failure, { at: later.toISOString(), why: 'login unavailable' });

  let concurrent = applyObservation(base, 'claude', { windows: { five_hour: window(0.3), seven_day: window(0.45) } }, later);
  concurrent = applyRefusal(concurrent, 'claude', '2026-11-06T13:00:00Z');
  concurrent = applyObservation(concurrent, 'codex', { windows: { primary: window(0.6) }, models: [{ id: 'gpt-6-luna', efforts: ['high'] }] }, later);
  const wonByNewer = applyCollectedCapacity(concurrent, 'claude', { ok: true, windows: { five_hour: window(0.1), seven_day: window(0.1) } }, now, before);
  assert.equal(wonByNewer.providers.claude.windows.five_hour.fraction_used, 0.3);
  assert.equal(wonByNewer.providers.claude.refusal_until, '2026-11-06T13:00:00Z');
  assert.equal(wonByNewer.providers.codex.windows.primary.fraction_used, 0.6);
});

test('Claude collector sanitizes absent login, auth errors, redirects and malformed schema', async () => {
  assert.deepEqual(await collectClaudeCapacity({ credentials: () => null }), { ok: false, why: 'Claude subscription login unavailable' });
  for (const status of [401, 403, 429]) {
    const got = await collectClaudeCapacity({ credentials: () => 'secret', fetch: async () => response('raw-auth-secret', { status }) });
    assert.equal(got.why, `Claude subscription request failed (HTTP ${status})`);
    assert.doesNotMatch(JSON.stringify(got), /secret|raw-auth/u);
  }
  assert.equal((await collectClaudeCapacity({ credentials: () => 'secret', fetch: async () => response('', { status: 302 }) })).why, 'Claude subscription request redirected');
  assert.equal((await collectClaudeCapacity({ credentials: () => 'secret', fetch: async () => response('{') })).why, 'Claude subscription response was not valid JSON');
  assert.equal((await collectClaudeCapacity({ credentials: () => 'secret', fetch: async () => response('{}') })).why, 'Claude subscription response had an invalid schema (five_hour: absent; seven_day: absent)');
});

test('Claude collector bounds response bytes and total request time without leaking failures', async () => {
  const huge = await collectClaudeCapacity({ credentials: () => 'secret', maxBytes: 4, fetch: async () => response('12345') });
  assert.deepEqual(huge, { ok: false, why: 'Claude subscription request unavailable' });
  const timeout = await collectClaudeCapacity({ credentials: () => 'secret', fetch: () => new Promise(() => {}), setTimer: (fn) => { queueMicrotask(fn); return 1; }, clearTimer: () => {} });
  assert.deepEqual(timeout, { ok: false, why: 'Claude subscription request timed out' });
});

/*
 * 2026-11-24: claude refused at 18:58:49 with its five-hour window at 101 %
 * until 21:20 (the recorded stream, tests/fixtures/claude/README), and its usage
 * read at 19:30 carried no five-hour window and a seven-day one at 76 %. The
 * refusal and billing-state.json's plan refusal held until 21:20 regardless.
 */
const STREAM = readFileSync(new URL('../fixtures/claude/five-hour-rejected-20261124T184900Z.jsonl', import.meta.url), 'utf8');
const SEEN = new Date('2026-11-24T18:59:02.000Z');
const REFUSED_UNTIL = '2026-11-24T21:20:00.000Z';
const READ_AT = new Date('2026-11-24T19:30:00.000Z');
const SEVEN_DAY = { utilization: 76, resets_at: '2026-11-27T13:00:00Z' };
const usage = (body) => () => collectClaudeCapacity({ credentials: () => 'fixture-login', fetch: async () => response(JSON.stringify(body)) });

/** The capacity file and billing-state.json in memory, as the runner's deps hold them. */
function stores() {
  let capacity = applyRefusal(observeClaudeStream(null, STREAM, SEEN), 'claude', REFUSED_UNTIL, null, SEEN, 'quota');
  let state = normaliseBillingState({ plan: { refused_until: REFUSED_UNTIL } });
  return {
    capacity: { read: () => capacity, write: (next) => { capacity = normaliseCapacity(next); return capacity; } },
    billing: { readState: () => state, patchState: (patch) => { state = normaliseBillingState({ plan: { ...state.plan, ...patch.plan }, credits: state.credits }); return state; } },
    get state() { return state; },
  };
}
const reader = (held, collect) => makeClaudeUsageReader({ env: {}, now: () => READ_AT, collect, lock: (_root, fn) => fn(), capacity: held.capacity, billing: held.billing });

test('the recorded five-hour rejection holds claude at 101 % until 21:20 under a quota refusal', () => {
  const held = stores();
  const claude = providerAt(held.capacity.read(), 'claude', READ_AT);
  assert.deepEqual(claude.windows.five_hour, { status: 'known', fraction_used: 1.01, resets_at: REFUSED_UNTIL });
  assert.deepEqual([claude.refusal_until, claude.refusal_cause, claude.refusal_since], [REFUSED_UNTIL, 'quota', SEEN.toISOString()]);
  assert.equal(billingRoute({ provider: 'claude', capacity: held.capacity.read(), state: held.state, api: { claude: false }, now: READ_AT }).why, `plan refused until ${REFUSED_UNTIL}; API off`);
});

test('a usage read with no five-hour window and the seven-day at 76 % lifts claude\'s quota refusal and the plan refusal', async () => {
  const held = stores();
  const got = await reader(held, usage({ seven_day: SEVEN_DAY }))();
  assert.equal(got.ok, true);
  assert.deepEqual(got.lifted, { cause: 'quota', until: REFUSED_UNTIL });
  const claude = held.capacity.read().providers.claude;
  assert.equal(claude.windows.five_hour, null, 'the window the body does not carry is absent');
  assert.equal(claude.windows.seven_day.fraction_used, 0.76);
  assert.deepEqual([claude.refusal_until, claude.refusal_cause, claude.refusal_since], [null, null, null]);
  assert.equal(held.state.plan.refused_until, null);
  assert.deepEqual(billingRoute({ provider: 'claude', capacity: held.capacity.read(), state: held.state, api: { claude: false }, now: READ_AT }).billing, 'plan');
  assert.equal(billingRoute({ provider: 'claude', capacity: held.capacity.read(), state: held.state, now: READ_AT }).billing, 'plan', 'not the API: the plan is usable');
});

test('a plan refusal alone in billing-state.json is a quota\'s, and a clean read lifts it', async () => {
  const held = stores();
  held.capacity.write(applyRefusal(held.capacity.read(), 'claude', null));
  const got = await reader(held, usage({ seven_day: SEVEN_DAY }))();
  assert.deepEqual(got.lifted, { cause: 'quota', until: REFUSED_UNTIL });
  assert.equal(held.state.plan.refused_until, null);
});

test('a usage read that still shows the five-hour window spent, or carries it invalid, keeps both refusals', async () => {
  const spent = { ok: true, windows: { five_hour: { fraction_used: 1.01, resets_at: REFUSED_UNTIL }, seven_day: { fraction_used: 0.76, resets_at: '2026-11-27T13:00:00.000Z' } }, unread: {} };
  for (const [name, collect] of [['at 1.01', async () => spent], ['invalid', usage({ five_hour: { utilization: 'none', resets_at: null }, seven_day: SEVEN_DAY })]]) {
    const held = stores();
    const got = await reader(held, collect)();
    assert.equal(got.ok, true, name);
    assert.equal(got.lifted, null, name);
    const claude = held.capacity.read().providers.claude;
    assert.equal(claude.windows.five_hour.fraction_used, 1.01, `${name}: the five-hour window is spent`);
    assert.deepEqual([claude.refusal_until, claude.refusal_cause], [REFUSED_UNTIL, 'quota'], name);
    assert.equal(held.state.plan.refused_until, REFUSED_UNTIL, name);
  }
});

test('a stream with no five-hour window keeps the held one, and the refusal with it', () => {
  const held = stores();
  const sevenOnly = `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 1795784400 } } } })}\n`;
  const after = observeClaudeStream(held.capacity.read(), sevenOnly, READ_AT).providers.claude;
  assert.equal(after.windows.five_hour.fraction_used, 1.01);
  assert.equal(after.refusal_until, REFUSED_UNTIL);
});

test('a failed or stale usage read lifts nothing', async () => {
  const held = stores();
  const failed = await reader(held, async () => ({ ok: false, why: 'Claude subscription request timed out' }))();
  assert.equal(failed.lifted, null);
  assert.equal(held.capacity.read().providers.claude.refusal_until, REFUSED_UNTIL);
  const stale = makeClaudeUsageReader({
    env: {}, now: () => READ_AT, lock: (_root, fn) => fn(), capacity: held.capacity, billing: held.billing,
    // A stream observation lands while the read is in flight: the read is dropped by its baseline.
    collect: async () => { held.capacity.write(observeClaudeStream(held.capacity.read(), STREAM, READ_AT)); return usage({ seven_day: SEVEN_DAY })(); },
  });
  assert.equal((await stale()).lifted, null);
  assert.equal(held.capacity.read().providers.claude.refusal_until, REFUSED_UNTIL);
  assert.equal(held.state.plan.refused_until, REFUSED_UNTIL);
});

test('a clean read leaves a host refusal to its check and leaves model refusals alone', async () => {
  const held = stores();
  const host = new Date(READ_AT.getTime() + 60_000).toISOString();
  let capacity = applyRefusal(held.capacity.read(), 'claude', null);
  capacity = applyRefusal(capacity, 'claude', host, null, READ_AT, 'host');
  capacity = applyRefusal(capacity, 'claude', REFUSED_UNTIL, 'opus', READ_AT);
  held.capacity.write(capacity);
  const got = await reader(held, usage({ seven_day: SEVEN_DAY }))();
  const claude = held.capacity.read().providers.claude;
  assert.deepEqual([claude.refusal_until, claude.refusal_cause], [host, 'host']);
  assert.deepEqual(claude.model_refusals, { opus: REFUSED_UNTIL });
  assert.equal(got.lifted?.cause ?? null, 'quota', 'the plan refusal in billing-state.json is still a quota\'s, and lifts');
});
