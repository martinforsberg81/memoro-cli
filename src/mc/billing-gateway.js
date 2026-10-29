/**
 * Narrow, local model transport for API-billed mc sessions.
 *
 * The trusted host supplies provider keys and short-lived session grants in
 * memory. No management or secret-reading endpoint is exposed. The caller is
 * responsible for keeping this process outside model-directed execution and
 * for expiring grants when their sessions end.
 */
import { createServer, STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const ROUTES = Object.freeze({
  '/claude/v1/messages': { provider: 'claude', upstream: '/v1/messages', methods: ['POST'] },
  '/claude/v1/messages/count_tokens': { provider: 'claude', upstream: '/v1/messages/count_tokens', methods: ['POST'] },
  '/codex/v1/responses': { provider: 'codex', upstream: '/v1/responses', methods: ['POST'] },
  '/codex/v1/responses/compact': { provider: 'codex', upstream: '/v1/responses/compact', methods: ['POST'] },
  '/codex/v1/models': { provider: 'codex', upstream: '/v1/models', methods: ['GET'] },
});
const UPSTREAM = Object.freeze({ claude: 'https://api.anthropic.com', codex: 'https://api.openai.com' });
// Codex with websockets upgrades on its HTTP path and then sends only what is
// new since the previous response on the open connection.
const WEBSOCKET_ROUTE = '/codex/v1/responses';
export const UPSTREAM_WEBSOCKET = 'wss://api.openai.com/v1/responses';
const FORWARD_REQUEST_HEADERS = Object.freeze(['content-type', 'anthropic-version', 'anthropic-beta']);
const FORWARD_RESPONSE_HEADERS = Object.freeze(['content-type', 'retry-after', 'request-id', 'x-request-id', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']);
// Codex without websockets sends the whole thread on every request: a
// 205k-token thread measured 8.3 MB on 2026-10-29, so 8 MiB refused the
// sessions that most needed the reserve.
export const MAX_GATEWAY_BODY_BYTES = 64 * 1024 * 1024;

const equal = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function grantFor(req, grants, provider, now) {
  const raw = req.headers.authorization || req.headers['x-api-key'];
  const token = String(raw || '').replace(/^Bearer /iu, '');
  return grants.find((grant) => grant.provider === provider
    && equal(token, grant.token)
    && Number.isFinite(Date.parse(grant.expiresAt))
    && Date.parse(grant.expiresAt) > now()) || null;
}

function modelAllowed(grant, model) {
  if (typeof model !== 'string' || !Array.isArray(grant.models)) return false;
  return grant.models.some((allowed) => allowed === '*' || allowed === model
    || (grant.provider === 'claude' && ['opus', 'sonnet', 'haiku'].includes(allowed)
      && model.startsWith(`claude-${allowed}-`)));
}

// Past the limit the rest is read and dropped rather than the stream torn
// down, so the client hears the 413 instead of a reset mid-upload. A client
// that goes away mid-upload is `undefined`: there is nobody to answer.
function bodyOf(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.once('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.once('error', () => resolve(undefined));
  });
}

function json(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

// An upgrade is refused on the raw socket, before any handshake.
function refuseUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: { message } });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

// 1005, 1006 and 1015 are only ever observed, never sent.
const sendable = (code) => [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code) || (code >= 3000 && code <= 4999);

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

/** Create a loopback-only gateway. Keys and grants are never serialized by it. */
export function createBillingGateway({ keys, grants, fetchImpl = fetch, now = Date.now, maxBodyBytes = MAX_GATEWAY_BODY_BYTES, websocketUpstream = UPSTREAM_WEBSOCKET } = {}) {
  if (!keys || !Array.isArray(grants)) throw new TypeError('gateway keys and grants required');
  const requests = new Map();
  const admit = (grant) => {
    const used = requests.get(grant.token) || 0;
    if (!Number.isSafeInteger(grant.maxRequests) || grant.maxRequests < 1 || used >= grant.maxRequests) return false;
    requests.set(grant.token, used + 1);
    return true;
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const route = ROUTES[path];
    if (!route || !route.methods.includes(req.method)) return json(res, 404, 'route unavailable');
    const grant = grantFor(req, grants, route.provider, now);
    if (!grant) return json(res, 401, 'session grant unavailable');
    const key = keys[route.provider];
    if (typeof key !== 'string' || !key) return json(res, 503, 'provider key unavailable');
    const body = req.method === 'POST' ? await bodyOf(req, maxBodyBytes) : undefined;
    if (req.method === 'POST' && body === undefined) return res.destroy();
    if (req.method === 'POST' && body === null) return json(res, 413, 'request too large');
    if (req.method === 'POST') {
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, 'invalid request body'); }
      if (!modelAllowed(grant, payload?.model)) return json(res, 403, 'model unavailable for session');
      if (!admit(grant)) return json(res, 429, 'session request limit reached');
    }
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      if (req.headers[name]) headers.set(name, String(req.headers[name]));
    }
    if (route.provider === 'claude') headers.set('x-api-key', key);
    else headers.set('authorization', `Bearer ${key}`);
    try {
      const upstream = await fetchImpl(`${UPSTREAM[route.provider]}${route.upstream}`, {
        method: req.method, headers, body,
      });
      const responseHeaders = {};
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) json(res, 502, 'provider unavailable');
      else res.destroy();
    }
  });

  // One upstream socket per session socket, opened with the key here. Session
  // frames are checked like HTTP bodies; provider frames pass through unread.
  const relays = new Set();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes });
  const relay = (client, grant, key, beta) => {
    const headers = { authorization: `Bearer ${key}` };
    if (beta) headers['openai-beta'] = String(beta);
    const upstream = new WebSocket(websocketUpstream, { headers, maxPayload: maxBodyBytes });
    const pending = [];
    let done = false;
    const entry = { client, upstream };
    const shut = (code, reason = '') => {
      if (done) return;
      done = true;
      clearTimeout(expiry);
      relays.delete(entry);
      closeSocket(client, code, reason);
      closeSocket(upstream, code, reason);
    };
    const left = Date.parse(grant.expiresAt) - now();
    const expiry = setTimeout(() => shut(1008, 'session grant expired'), Math.max(0, Math.min(left, 2 ** 31 - 1)));
    expiry.unref?.();
    relays.add(entry);
    client.on('message', (data, isBinary) => {
      if (isBinary) return shut(1003, 'text frames only');
      let frame;
      try { frame = JSON.parse(data.toString('utf8')); } catch { return shut(1007, 'invalid frame'); }
      if (frame?.type === 'response.create') {
        if (!(Date.parse(grant.expiresAt) > now())) return shut(1008, 'session grant expired');
        if (!modelAllowed(grant, frame.model)) return shut(1008, 'model unavailable for session');
        if (!admit(grant)) return shut(1008, 'session request limit reached');
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false });
      else pending.push(data);
    });
    upstream.on('open', () => {
      for (const data of pending.splice(0)) upstream.send(data, { binary: false });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    // A refused handshake upstream is an error; its body is never relayed.
    upstream.on('error', () => shut(1011, 'provider unavailable'));
    upstream.on('close', (code, reason) => shut(sendable(code) ? code : 1011, reason.toString()));
    client.on('error', () => shut(1011));
    client.on('close', (code, reason) => shut(sendable(code) ? code : 1000, reason.toString()));
  };
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path !== WEBSOCKET_ROUTE) return refuseUpgrade(socket, 404, 'route unavailable');
    const grant = grantFor(req, grants, 'codex', now);
    if (!grant) return refuseUpgrade(socket, 401, 'session grant unavailable');
    const key = keys.codex;
    if (typeof key !== 'string' || !key) return refuseUpgrade(socket, 503, 'provider key unavailable');
    sockets.handleUpgrade(req, socket, head, (client) => relay(client, grant, key, req.headers['openai-beta']));
  });
  // An upgraded socket keeps server.close() waiting, so closing the gateway
  // ends every relay.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const { client, upstream } of relays) { client.terminate(); upstream.terminate(); }
    return close(callback);
  };
  return server;
}

/** The listener is intentionally bound to loopback and an OS-assigned port. */
export async function listenBillingGateway(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
