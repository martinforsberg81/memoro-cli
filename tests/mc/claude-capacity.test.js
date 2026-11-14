import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_USAGE_URL, claudeUsageWindows, collectClaudeCapacity, readClaudeCredential } from '../../src/mc/claude-capacity.js';
import { applyCollectedCapacity, applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';

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

test('a successful Claude read keeps the window it did not validate; a Codex null window still replaces', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const later = new Date('2026-11-14T12:15:00Z');
  const window = (fraction_used) => ({ fraction_used, resets_at: '2026-11-20T13:00:00.000Z' });
  const base = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: window(0.2), seven_day: window(0.4) } }, now);
  const claude = applyCollectedCapacity(base, 'claude', { ok: true, windows: { five_hour: null, seven_day: window(0.43) }, unread: { five_hour: 'absent' } }, later).providers.claude;
  assert.deepEqual(claude.windows, { five_hour: window(0.2), seven_day: window(0.43) });
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
