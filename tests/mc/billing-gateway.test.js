import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
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

test('a Claude grant on a family alias admits that family\'s model ids, fable among them', async (t) => {
  const calls = [];
  const gateway = createBillingGateway({
    keys: { claude: 'anthropic-secret-canary' },
    grants: [{ provider: 'claude', token: 'fable-grant', models: ['fable'], maxRequests: 5, expiresAt: '2026-10-29T13:00:00Z' }],
    now: () => NOW,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}', { status: 200 }); },
  });
  const base = await listenBillingGateway(gateway);
  t.after(() => gateway.close());
  const send = (model) => fetch(`${base}/claude/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer fable-grant', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [] }),
  });
  assert.equal((await send('claude-fable-5-1')).status, 200);
  assert.equal((await send('claude-opus-5-5')).status, 403);
  assert.equal((await send('fable-claude-5')).status, 403);
  assert.equal(calls.length, 1);
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

// A local server stands in for wss://api.openai.com/v1/responses.
async function socketFixture(t, { maxRequests = 2 } = {}) {
  const provider = { headers: null, frames: [], sockets: [] };
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => fake.once('listening', resolve));
  fake.on('connection', (socket, req) => {
    provider.headers = req.headers;
    provider.sockets.push(socket);
    socket.on('message', (data) => {
      provider.frames.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `resp_${provider.frames.length}` } }));
    });
  });
  const gateway = createBillingGateway({
    keys: { codex: 'openai-secret-canary' },
    grants: [{ provider: 'codex', token: 'codex-session-grant', models: ['gpt-6.1-sol'], maxRequests, expiresAt: '2026-10-29T13:00:00Z' }],
    now: () => NOW,
    fetchImpl: async () => new Response('{}'),
    websocketUpstream: `ws://127.0.0.1:${fake.address().port}/v1/responses`,
  });
  const base = await listenBillingGateway(gateway);
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  });
  const connect = (path = '/codex/v1/responses', grant = 'codex-session-grant') => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, {
      headers: { authorization: `Bearer ${grant}`, 'openai-beta': 'responses_websockets=2026-02-06' },
    });
    const received = [];
    socket.on('message', (data) => received.push(data.toString()));
    socket.on('error', () => {});
    return {
      socket,
      received,
      opened: new Promise((resolve) => socket.once('open', resolve)),
      closed: new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
      refused: new Promise((resolve) => socket.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); })),
    };
  };
  return { provider, connect };
}

const create = (model) => JSON.stringify({ type: 'response.create', model, input: [] });
const until = async (check) => { while (!check()) await new Promise((resolve) => setTimeout(resolve, 5)); };

test('a Codex websocket is carried to the provider with the key, which never comes back', async (t) => {
  const { provider, connect } = await socketFixture(t);
  const session = connect();
  await session.opened;
  session.socket.send(create('gpt-6.1-sol'));
  await until(() => session.received.length === 1);
  assert.equal(provider.headers.authorization, 'Bearer openai-secret-canary');
  assert.equal(provider.headers['openai-beta'], 'responses_websockets=2026-02-06');
  assert.equal(provider.frames[0].type, 'response.create');
  assert.equal(JSON.parse(session.received[0]).type, 'response.completed');
  assert.doesNotMatch(session.received.join(''), /secret-canary/u);
});

test('an upgrade without a grant, or on another path, is refused before the handshake', async (t) => {
  const { provider, connect } = await socketFixture(t);
  assert.equal(await connect('/codex/v1/responses', 'wrong-grant').refused, 401);
  assert.equal(await connect('/codex/v1/models').refused, 404);
  assert.equal(await connect('/claude/v1/messages').refused, 404);
  assert.equal(provider.sockets.length, 0, 'nothing reached the provider');
});

test('a response.create for another model closes the socket with 1008 and is not forwarded', async (t) => {
  const { provider, connect } = await socketFixture(t);
  const session = connect();
  await session.opened;
  session.socket.send(create('gpt-6.1-luna'));
  assert.deepEqual(await session.closed, { code: 1008, reason: 'model unavailable for session' });
  assert.equal(provider.frames.length, 0);
});

test('each response.create counts against the session request limit, across sockets', async (t) => {
  const { provider, connect } = await socketFixture(t, { maxRequests: 2 });
  const first = connect();
  await first.opened;
  first.socket.send(create('gpt-6.1-sol'));
  first.socket.send(JSON.stringify({ type: 'other.event' }));
  await until(() => first.received.length === 2);
  const second = connect();
  await second.opened;
  second.socket.send(create('gpt-6.1-sol'));
  await until(() => second.received.length === 1);
  second.socket.send(create('gpt-6.1-sol'));
  assert.deepEqual(await second.closed, { code: 1008, reason: 'session request limit reached' });
  assert.equal(provider.frames.filter((frame) => frame.type === 'response.create').length, 2);
  assert.equal(provider.frames.length, 3, 'other session frames are forwarded unchanged');
});

test('closing either side closes the other', async (t) => {
  const { provider, connect } = await socketFixture(t);
  const session = connect();
  await session.opened;
  await until(() => provider.sockets.length === 1);
  const providerClosed = new Promise((resolve) => provider.sockets[0].once('close', (code) => resolve(code)));
  session.socket.close(1000, 'done');
  assert.equal(await providerClosed, 1000);

  const again = connect();
  await again.opened;
  await until(() => provider.sockets.length === 2);
  provider.sockets[1].close(4000, 'provider closed');
  assert.deepEqual(await again.closed, { code: 4000, reason: 'provider closed' });
});

test('a provider that refuses the upstream handshake closes the session with 1011, relaying nothing', async (t) => {
  const refusing = createServer((req, res) => { res.writeHead(401); res.end('{"error":"openai-secret-canary"}'); });
  await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
  const gateway = createBillingGateway({
    keys: { codex: 'openai-secret-canary' },
    grants: [{ provider: 'codex', token: 'g', models: ['gpt-6.1-sol'], maxRequests: 5, expiresAt: '2026-10-29T13:00:00Z' }],
    now: () => NOW,
    websocketUpstream: `ws://127.0.0.1:${refusing.address().port}/v1/responses`,
  });
  const base = await listenBillingGateway(gateway);
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => refusing.close(resolve));
  });
  const socket = new WebSocket(`${base.replace('http', 'ws')}/codex/v1/responses`, { headers: { authorization: 'Bearer g' } });
  const received = [];
  socket.on('message', (data) => received.push(data.toString()));
  const closed = await new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.deepEqual(closed, { code: 1011, reason: 'provider unavailable' });
  assert.deepEqual(received, []);
});
