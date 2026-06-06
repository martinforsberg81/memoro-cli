/**
 * mc vault secret-type conventions.
 *
 * --- Server-vs-client discrepancy (important context) ---
 *
 * The Memoro server's vault route hardcodes a 5-entry whitelist for
 * `secret_type`: ['password','card','note','api_key','identity']
 * (see ~/memoro/src/routes/vault/index.js). The brief asks mc to ship
 * two new types — `api_token` and `oauth_token` — without modifying
 * the server.
 *
 * Resolution: mc stores BOTH on the wire as `secret_type='api_key'`
 * (the closest existing slot), and encodes the *real* mc-side type as
 * `kind: 'api_token' | 'oauth_token'` inside the encrypted JSON
 * payload. The payload also carries structured metadata (provider,
 * account, scopes, expires_at). This:
 *
 *   - keeps the server schema untouched (per brief)
 *   - means the discriminator is encrypted at rest (defence in depth)
 *   - lets the web app keep treating api_key-typed entries as opaque
 *     until it grows mc-aware affordances
 *
 * The trade-off: `mc vault list --type api_token` filters CLIENT-SIDE
 * after decrypting payloads, since the wire type doesn't tell us
 * apart. That's fine — phase 1 list sizes are small (humans manage
 * their own secrets) and a future Memoro server update can add the
 * type to the wire if/when it matters.
 */

// The canonical mc-side type set. Phase 1 ships these two; future
// phases may add more (e.g. for SSH keys, certificates, etc.).
export const MC_SECRET_KINDS = Object.freeze(['api_token', 'oauth_token']);

// The server-side wire type both mc kinds map to. See header.
export const WIRE_SECRET_TYPE = 'api_key';

/**
 * Build the *encrypted-data* JSON shape for a new secret. Returned object
 * gets JSON.stringify'd and encrypted client-side; the server never sees
 * the un-encrypted form.
 *
 * Pure for tests.
 *
 * @param {object} opts
 * @param {'api_token'|'oauth_token'} opts.kind
 * @param {string} opts.token        - the secret value
 * @param {string} [opts.provider]   - provider id, e.g. 'anthropic'
 * @param {string} [opts.account]    - account discriminator, e.g. 'work'
 * @param {string[]} [opts.scopes]   - OAuth scopes (oauth_token only)
 * @param {string} [opts.expiresAt]  - ISO timestamp (oauth_token only)
 * @param {string} [opts.targetTool] - explicit native-tool target, e.g. 'codex'
 * @param {string} [opts.targetAuthMode] - explicit auth mode, e.g. 'api_key'
 * @param {string} [opts.targetLocation] - optional target location id/path
 * @param {object} [opts.extra]      - arbitrary additional fields
 */
export function buildSecretPayload({
  kind,
  token,
  provider = null,
  account = null,
  scopes = null,
  expiresAt = null,
  targetTool = null,
  targetAuthMode = null,
  targetLocation = null,
  extra = null,
}) {
  if (!MC_SECRET_KINDS.includes(kind)) {
    throw new Error(`unsupported mc secret kind: ${JSON.stringify(kind)} (allowed: ${MC_SECRET_KINDS.join(', ')})`);
  }
  if (typeof token !== 'string' || !token) {
    throw new Error('token (string) is required');
  }
  if (kind === 'oauth_token') {
    if (scopes != null && !Array.isArray(scopes)) {
      throw new Error('scopes must be an array of strings');
    }
    if (expiresAt != null && typeof expiresAt !== 'string') {
      throw new Error('expiresAt must be an ISO-8601 string');
    }
  }
  const payload = { kind, token };
  if (provider) payload.provider = provider;
  if (account) payload.account = account;
  if (kind === 'oauth_token' && scopes) payload.scopes = scopes;
  if (kind === 'oauth_token' && expiresAt) payload.expires_at = expiresAt;
  if (targetTool) payload.target_tool = targetTool;
  if (targetAuthMode) payload.target_auth_mode = targetAuthMode;
  if (targetLocation) payload.target_location = targetLocation;
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  return payload;
}

/**
 * Inverse of buildSecretPayload — normalises a decrypted payload into a
 * predictable shape, defaulting `kind` to `'api_token'` so old entries
 * (pre-mc, or browser-created 'api_key') don't blow up `mc vault list`.
 *
 * Pure for tests.
 */
export function normaliseSecretPayload(decrypted) {
  if (!decrypted || typeof decrypted !== 'object') return null;
  const kind = MC_SECRET_KINDS.includes(decrypted.kind) ? decrypted.kind : 'api_token';
  return {
    kind,
    token: typeof decrypted.token === 'string' ? decrypted.token : null,
    provider: decrypted.provider || null,
    account: decrypted.account || null,
    scopes: Array.isArray(decrypted.scopes) ? decrypted.scopes : null,
    expires_at: decrypted.expires_at || null,
    target_tool: decrypted.target_tool || null,
    target_auth_mode: decrypted.target_auth_mode || null,
    target_location: decrypted.target_location || null,
    extra: stripKnown(decrypted),
  };
}

function stripKnown(obj) {
  const known = new Set([
    'kind',
    'token',
    'provider',
    'account',
    'scopes',
    'expires_at',
    'target_tool',
    'target_auth_mode',
    'target_location',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate a `--type` flag value. Returns the canonical kind or throws.
 * Pure for tests.
 */
export function parseTypeFlag(value) {
  if (!value) return null;
  if (!MC_SECRET_KINDS.includes(value)) {
    throw new Error(`unknown --type ${JSON.stringify(value)} (allowed: ${MC_SECRET_KINDS.join(', ')})`);
  }
  return value;
}

/**
 * Build the JSON object emitted by `mc vault <verb> --json`. Values
 * are intentionally NEVER included for list output — only labels +
 * metadata. Pure for tests; lets us unit-test the shape without touching
 * stdout.
 */
export function formatListJson({ secrets }) {
  return {
    ok: true,
    secrets: (secrets || []).map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      provider: s.provider,
      account: s.account,
      target_tool: s.target_tool ?? null,
      target_auth_mode: s.target_auth_mode ?? null,
      target_location: s.target_location ?? null,
      created_at: s.created_at,
      updated_at: s.updated_at,
    })),
  };
}

function listTag(secret) {
  return secret.provider
    ? `${secret.kind}:${secret.provider}${secret.account ? `/${secret.account}` : ''}`
    : secret.kind;
}

export function formatListWidths(secrets = []) {
  const rows = Array.isArray(secrets) ? secrets : [];
  return {
    label: Math.max('label'.length, ...rows.map((s) => String(s.label || '').length)),
    kind: Math.max('kind'.length, ...rows.map((s) => listTag(s).length)),
  };
}

export function formatListHeader(widths = formatListWidths([])) {
  return `  ${'label'.padEnd(widths.label)}  ${'kind'.padEnd(widths.kind)}  id`;
}

/**
 * Pretty (non-JSON) one-line summary of a secret for `mc vault list`.
 * No secret values. Pure for tests.
 */
export function formatListLine(secret, widths = formatListWidths([secret])) {
  const tag = listTag(secret);
  return `  ${String(secret.label || '').padEnd(widths.label)}  ${tag.padEnd(widths.kind)}  ${secret.id}`;
}
