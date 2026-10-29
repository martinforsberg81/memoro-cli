import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingGateway, listenBillingGateway } from '../../src/mc/billing-gateway.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

async function fixture(t) {
  const calls = [];
  const gateway = createBillingGateway({
    keys: { claude: 'anthropic-secret-canary', codex: 'openai-secret-canary' },
    grants: [
      { provider: 'claude', token: 'claude-session-grant', models: ['claude-opus-4-6'], maxRequests: 1, expiresAt: '2026-10-29T13:00:00Z' },
      { provider: 'codex', token: 'codex-session-grant', models: ['gpt-6.1-sol'], maxRequests: 1, expiresAt: '2026-10-29T13:00:00Z' },
    ],
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('data: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const base = await listenBillingGateway(gateway);
  t.after(() => gateway.close());
  const send = (path, grant, model, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
  return { calls, base, send };
}

test('Claude and Codex requests use only their own upstream key and stream the answer', async (t) => {
  const { calls, send } = await fixture(t);
  const claude = await send('/claude/v1/messages', 'claude-session-grant', 'claude-opus-4-6', { 'x-api-key': 'attacker-value' });
  assert.equal(claude.status, 200);
  assert.equal(claude.headers.get('content-type'), 'text/event-stream');
  assert.match(await claude.text(), /message_stop/u);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers.get('x-api-key'), 'anthropic-secret-canary');
  assert.equal(calls[0].options.headers.get('authorization'), null);

  const codex = await send('/codex/v1/responses', 'codex-session-grant', 'gpt-6.1-sol');
  assert.equal(codex.status, 200);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[1].options.headers.get('authorization'), 'Bearer openai-secret-canary');
  assert.equal(calls[1].options.headers.get('x-api-key'), null);
});

test('gateway refuses cross-provider grants, unknown paths, model changes and extra requests', async (t) => {
  const { calls, send } = await fixture(t);
  assert.equal((await send('/claude/v1/messages', 'codex-session-grant', 'claude-opus-4-6')).status, 401);
  assert.equal((await send('/claude/v1/organizations', 'claude-session-grant', 'claude-opus-4-6')).status, 404);
  assert.equal((await send('/codex/v1/responses', 'codex-session-grant', 'gpt-6.1-luna')).status, 403);
  assert.equal((await send('/claude/v1/messages', 'claude-session-grant', 'claude-opus-4-6')).status, 200);
  assert.equal((await send('/claude/v1/messages', 'claude-session-grant', 'claude-opus-4-6')).status, 429);
  assert.equal(calls.length, 1, 'refused requests never reach a provider');
});

test('gateway never sends upstream credentials back to a session', async (t) => {
  const { calls, base } = await fixture(t);
  const response = await fetch(`${base}/codex/v1/models`, { headers: { authorization: 'Bearer codex-session-grant' } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /secret-canary/u);
  assert.equal(calls.at(-1).options.headers.get('authorization'), 'Bearer openai-secret-canary');
});

test('an oversized body is answered 413 after it is read, and nothing reaches the provider', async (t) => {
  const calls = [];
  const gateway = createBillingGateway({
    keys: { codex: 'openai-secret-canary' },
    grants: [{ provider: 'codex', token: 'g', models: ['gpt-6-astra'], maxRequests: 5, expiresAt: '2026-10-29T13:00:00Z' }],
    now: () => NOW, maxBodyBytes: 1024,
    fetchImpl: async (url) => { calls.push(url); return new Response('{}'); },
  });
  const base = await listenBillingGateway(gateway);
  t.after(() => gateway.close());
  const send = (body) => fetch(`${base}/codex/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer g', 'content-type': 'application/json' }, body });
  const big = await send(JSON.stringify({ model: 'gpt-6-astra', input: 'x'.repeat(256 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0);
  const small = await send(JSON.stringify({ model: 'gpt-6-astra', input: [] }));
  assert.equal(small.status, 200, 'the gateway still answers after a refusal');
});

test('codex remote compaction is a route of its own', async (t) => {
  const { calls, send } = await fixture(t);
  assert.equal((await send('/codex/v1/responses/compact', 'codex-session-grant', 'gpt-6.1-sol')).status, 200);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses/compact');
});
