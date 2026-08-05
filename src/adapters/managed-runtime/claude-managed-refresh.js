/**
 * Provider-owned OAuth refresh contract for the pinned Claude adapter.
 *
 * This module contains no vault, filesystem, environment, or launch authority.
 * The trusted runtime owns those concerns and supplies one already-decrypted
 * tool-auth payload. Keeping parsing and refresh response validation here
 * makes the provider-specific protocol independently testable.
 */

export const MANAGED_CLAUDE_OAUTH_TOKEN_URL =
  'https://platform.claude.com/v1/oauth/token';
export const MANAGED_CLAUDE_OAUTH_CLIENT_ID =
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const MAX_TOKEN_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 5 * 60_000;
const MAX_REFRESH_DELAY_MS = 15 * 60_000;
const MIN_REFRESH_DELAY_MS = 1_000;
// Claude Code's stored grant, as `claude login` writes it. The list is an
// allowlist: an unknown key rejects the whole grant, which is the right
// default for a credential record but makes it a maintenance surface —
// `refreshTokenExpiresAt` appeared in a Claude release and refused every
// managed launch with `managed-claude-refresh-grant-required`, on a sign-in
// that was completely valid.
const KNOWN_OAUTH_KEYS = Object.freeze([
  'accessToken',
  'refreshToken',
  'expiresAt',
  'refreshTokenExpiresAt',
  'scopes',
  'subscriptionType',
  'rateLimitTier',
]);

export function parseManagedClaudeToolAuth(data, {
  requireRefresh = true,
} = {}) {
  if (!exactRecord(data, ['body', 'kind', 'source', 'tool'])
    || data.kind !== 'tool_auth'
    || data.tool !== 'claude-code'
    || !['file', 'keychain'].includes(data.source)
    || typeof data.body !== 'string'
    || Buffer.byteLength(data.body, 'utf8') === 0
    || Buffer.byteLength(data.body, 'utf8') > MAX_BODY_BYTES) {
    return failure('managed-claude-auth-invalid');
  }
  let body;
  try { body = JSON.parse(data.body); } catch {
    return failure('managed-claude-auth-invalid');
  }
  if (!exactRecord(body, ['claudeAiOauth'])
    || !validOauthGrant(body.claudeAiOauth, { requireRefresh })) {
    return failure(requireRefresh
      ? 'managed-claude-refresh-grant-required'
      : 'managed-claude-auth-invalid');
  }
  return {
    ok: true,
    grant: Object.freeze(structuredClone(body.claudeAiOauth)),
  };
}

export function replaceManagedClaudeToolAuthGrant(data, grant) {
  const current = parseManagedClaudeToolAuth(data, { requireRefresh: false });
  if (!current.ok || !validOauthGrant(grant, { requireRefresh: true })) return null;
  return {
    ...data,
    body: JSON.stringify({
      claudeAiOauth: orderedGrant(grant),
    }),
  };
}

export async function refreshManagedClaudeOauthGrant(grant, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  signal = null,
} = {}) {
  if (!validOauthGrant(grant, { requireRefresh: true })
    || typeof fetchImpl !== 'function') {
    return failure('managed-claude-refresh-input-invalid');
  }
  const body = {
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
    client_id: MANAGED_CLAUDE_OAUTH_CLIENT_ID,
    scope: grant.scopes.join(' '),
  };
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    response = await fetchImpl(MANAGED_CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: requestSignal,
    });
  } catch {
    return failure('managed-claude-refresh-request-failed');
  }
  if (response?.status !== 200) {
    return failure('managed-claude-refresh-rejected');
  }
  let value;
  try { value = await response.json(); } catch {
    return failure('managed-claude-refresh-response-invalid');
  }
  const checked = validateRefreshResponse(value);
  if (!checked.ok) return checked;
  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) return failure('managed-claude-refresh-clock-invalid');
  const next = orderedGrant({
    ...grant,
    accessToken: checked.accessToken,
    refreshToken: checked.refreshToken || grant.refreshToken,
    expiresAt: timestamp + checked.expiresIn * 1_000,
    scopes: checked.scopes || grant.scopes,
  });
  return validOauthGrant(next, { requireRefresh: true })
    ? { ok: true, grant: Object.freeze(next) }
    : failure('managed-claude-refresh-response-invalid');
}

export function managedClaudeRefreshDelay(grant, {
  now = Date.now(),
} = {}) {
  if (!validOauthGrant(grant, { requireRefresh: true })) return null;
  const current = Number(now);
  const expiresAt = numericTimestamp(grant.expiresAt);
  if (!Number.isFinite(current) || !Number.isFinite(expiresAt)) return null;
  const desired = expiresAt - current - REFRESH_SKEW_MS;
  if (desired <= 0) return 0;
  return Math.max(
    MIN_REFRESH_DELAY_MS,
    Math.min(desired, MAX_REFRESH_DELAY_MS),
  );
}

function validateRefreshResponse(value) {
  if (!plain(value)
    || typeof value.access_token !== 'string'
    || !safeToken(value.access_token)
    || !Number.isSafeInteger(value.expires_in)
    || value.expires_in <= 0
    || value.expires_in > 366 * 24 * 60 * 60
    || (value.refresh_token != null
      && (typeof value.refresh_token !== 'string' || !safeToken(value.refresh_token)))) {
    return failure('managed-claude-refresh-response-invalid');
  }
  let scopes = null;
  if (value.scope != null) {
    if (typeof value.scope !== 'string') {
      return failure('managed-claude-refresh-response-invalid');
    }
    scopes = value.scope.split(/\s+/u).filter(Boolean);
    if (!validScopes(scopes)) return failure('managed-claude-refresh-response-invalid');
  }
  return {
    ok: true,
    accessToken: value.access_token,
    refreshToken: value.refresh_token || null,
    expiresIn: value.expires_in,
    scopes,
  };
}

function validOauthGrant(value, { requireRefresh }) {
  if (!plain(value)
    || Object.keys(value).some((key) => !KNOWN_OAUTH_KEYS.includes(key))
    || !safeToken(value.accessToken)
    || ('refreshToken' in value && !safeToken(value.refreshToken))
    || ('expiresAt' in value && numericTimestamp(value.expiresAt) === null)
    || ('refreshTokenExpiresAt' in value
      && numericTimestamp(value.refreshTokenExpiresAt) === null)
    || ('scopes' in value && !validScopes(value.scopes))
    || ('subscriptionType' in value && typeof value.subscriptionType !== 'string')
    || ('rateLimitTier' in value && typeof value.rateLimitTier !== 'string')) {
    return false;
  }
  return !requireRefresh || (
    safeToken(value.refreshToken)
    && numericTimestamp(value.expiresAt) !== null
    && validScopes(value.scopes)
  );
}

function orderedGrant(value) {
  const out = {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: numericTimestamp(value.expiresAt),
    scopes: [...value.scopes],
  };
  if (numericTimestamp(value.refreshTokenExpiresAt) !== null) {
    out.refreshTokenExpiresAt = numericTimestamp(value.refreshTokenExpiresAt);
  }
  if (typeof value.subscriptionType === 'string') {
    out.subscriptionType = value.subscriptionType;
  }
  if (typeof value.rateLimitTier === 'string') {
    out.rateLimitTier = value.rateLimitTier;
  }
  return out;
}

function validScopes(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 64
    && value.every((scope) => typeof scope === 'string'
      && /^[A-Za-z0-9:_-]{1,128}$/u.test(scope));
}

function safeToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
    && !/[\u0000\r\n]/u.test(value);
}

function numericTimestamp(value) {
  const number = typeof value === 'string' && value.trim()
    ? Number(value)
    : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function failure(reason) {
  return { ok: false, reason, error: reason };
}

function exactRecord(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}
