/**
 * Narrow, local model transport for API-billed mc sessions.
 *
 * The trusted host supplies provider keys and short-lived session grants in
 * memory. No management or secret-reading endpoint is exposed. The caller is
 * responsible for keeping this process outside model-directed execution and
 * for expiring grants when their sessions end.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

const ROUTES = Object.freeze({
  '/claude/v1/messages': { provider: 'claude', upstream: '/v1/messages', methods: ['POST'] },
  '/claude/v1/messages/count_tokens': { provider: 'claude', upstream: '/v1/messages/count_tokens', methods: ['POST'] },
  '/codex/v1/responses': { provider: 'codex', upstream: '/v1/responses', methods: ['POST'] },
  '/codex/v1/models': { provider: 'codex', upstream: '/v1/models', methods: ['GET'] },
});
const UPSTREAM = Object.freeze({ claude: 'https://api.anthropic.com', codex: 'https://api.openai.com' });
const FORWARD_REQUEST_HEADERS = Object.freeze(['content-type', 'anthropic-version', 'anthropic-beta']);
const FORWARD_RESPONSE_HEADERS = Object.freeze(['content-type', 'retry-after', 'request-id', 'x-request-id', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']);
export const MAX_GATEWAY_BODY_BYTES = 8 * 1024 * 1024;

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

async function bodyOf(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/** Create a loopback-only gateway. Keys and grants are never serialized by it. */
export function createBillingGateway({ keys, grants, fetchImpl = fetch, now = Date.now, maxBodyBytes = MAX_GATEWAY_BODY_BYTES } = {}) {
  if (!keys || !Array.isArray(grants)) throw new TypeError('gateway keys and grants required');
  const requests = new Map();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const route = ROUTES[path];
    if (!route || !route.methods.includes(req.method)) return json(res, 404, 'route unavailable');
    const grant = grantFor(req, grants, route.provider, now);
    if (!grant) return json(res, 401, 'session grant unavailable');
    const key = keys[route.provider];
    if (typeof key !== 'string' || !key) return json(res, 503, 'provider key unavailable');
    const body = req.method === 'POST' ? await bodyOf(req, maxBodyBytes) : undefined;
    if (req.method === 'POST' && body === null) return json(res, 413, 'request too large');
    if (req.method === 'POST') {
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, 'invalid request body'); }
      if (!modelAllowed(grant, payload?.model)) return json(res, 403, 'model unavailable for session');
      const used = requests.get(grant.token) || 0;
      if (!Number.isSafeInteger(grant.maxRequests) || grant.maxRequests < 1 || used >= grant.maxRequests) return json(res, 429, 'session request limit reached');
      requests.set(grant.token, used + 1);
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
