import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_USAGE_URL, claudeUsageWindows, collectClaudeCapacity, readClaudeCredential } from '../../src/mc/claude-capacity.js';

const valid = JSON.stringify({
  five_hour: { utilization: 37.5, resets_at: '2026-11-06T15:00:00Z' },
  seven_day: { utilization: 82, resets_at: '2026-11-10T00:00:00+00:00' },
});
const response = (body, { status = 200, headers = {} } = {}) => ({
  status, ok: status >= 200 && status < 300, headers,
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }),
});

test('Claude usage normalization requires percentages and strict reset instants', () => {
  assert.deepEqual(claudeUsageWindows(JSON.parse(valid)), {
    five_hour: { fraction_used: 0.375, resets_at: '2026-11-06T15:00:00.000Z' },
    seven_day: { fraction_used: 0.82, resets_at: '2026-11-10T00:00:00.000Z' },
  });
  assert.equal(claudeUsageWindows({ five_hour: { utilization: 0, resets_at: '2026-02-30T00:00:00Z' }, seven_day: JSON.parse(valid).seven_day }), null);
  assert.equal(claudeUsageWindows({ five_hour: { utilization: 101, resets_at: '2026-11-06T15:00:00Z' }, seven_day: JSON.parse(valid).seven_day }), null);
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

test('Claude auth is read-only from the macOS Keychain or standard credentials file', () => {
  const seen = [];
  const keychain = readClaudeCredential({
    platform: 'darwin', home: '/fixture', exists: () => true,
    readKeychain: (service) => { seen.push(service); return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }); },
    readFile: () => { throw new Error('Keychain should take precedence'); },
  });
  assert.equal(keychain, 'keychain-token');
  assert.deepEqual(seen, ['Claude Code-credentials']);
  const file = readClaudeCredential({
    platform: 'linux', home: '/fixture', exists: (path) => path === '/fixture/.claude/.credentials.json',
    readFile: (path) => { seen.push(path); return JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }); },
  });
  assert.equal(file, 'file-token');
  assert.equal(seen.at(-1), '/fixture/.claude/.credentials.json');
  assert.equal(readClaudeCredential({ platform: 'linux', home: '/fixture', exists: () => false }), null);
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
  assert.equal((await collectClaudeCapacity({ credentials: () => 'secret', fetch: async () => response('{}') })).why, 'Claude subscription response had an invalid schema');
});

test('Claude collector bounds response bytes and total request time without leaking failures', async () => {
  const huge = await collectClaudeCapacity({ credentials: () => 'secret', maxBytes: 4, fetch: async () => response('12345') });
  assert.deepEqual(huge, { ok: false, why: 'Claude subscription request unavailable' });
  const timeout = await collectClaudeCapacity({ credentials: () => 'secret', fetch: () => new Promise(() => {}), setTimer: (fn) => { queueMicrotask(fn); return 1; }, clearTimer: () => {} });
  assert.deepEqual(timeout, { ok: false, why: 'Claude subscription request timed out' });
});
