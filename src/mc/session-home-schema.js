import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const MC_SESSION_ID_RE = /^mcs_[a-f0-9]{24}$/u;
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
export const SESSION_IDENTITY_SCHEMA = 'mc-session-identity';
export const SESSION_METADATA_SCHEMA = 'mc-session-metadata';
export const SESSION_PROJECTION_SCHEMA = 'mc-session-projection';
export const SESSION_NAME_CLAIM_SCHEMA = 'mc-session-name-claim';
export const SESSION_LOCK_OWNER_SCHEMA = 'mc-session-lock-owner';
export const SESSION_HOME_VERSION = 1;

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECTION_LIFECYCLES = new Set(['open', 'archived']);
const PROJECTION_RUNTIME_STATES = new Set(['none', 'starting', 'running', 'exited', 'failed']);

export function mintMcSessionId(random = randomBytes) {
  return `mcs_${random(12).toString('hex')}`;
}

export function normalizeSessionName(name) {
  if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) {
    throw new TypeError(`session name must match ${SESSION_NAME_RE}`);
  }
  return name.toLowerCase();
}

export function sessionNameDigest(normalizedName) {
  return createHash('sha256').update(normalizeSessionName(normalizedName)).digest('hex');
}

export function nameClaimFromMetadata(metadata, claimedAt) {
  return {
    schema: SESSION_NAME_CLAIM_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: metadata.mc_session_id,
    name: metadata.name,
    normalized_name: metadata.normalized_name,
    name_revision: metadata.name_revision,
    claimed_at: claimedAt,
  };
}

export function validateSessionIdentity(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'mc_session_id', 'owner', 'created_at',
  ])) return invalid('identity-unexpected-keys');
  if (value.schema !== SESSION_IDENTITY_SCHEMA
    || value.version !== SESSION_HOME_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !plain(value.owner)
    || !exactKeys(value.owner, ['kind', 'source_id'])
    || value.owner.kind !== 'machine'
    || !SOURCE_ID_RE.test(value.owner.source_id || '')
    || !iso(value.created_at)) return invalid('identity-invalid-fields');
  return validCopy(value);
}

export function validateSessionMetadata(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'mc_session_id', 'revision', 'name_revision', 'name',
    'normalized_name', 'objective', 'preferred_launch_cwd', 'created_at', 'updated_at',
  ])) return invalid('metadata-unexpected-keys');
  let normalized;
  try { normalized = normalizeSessionName(value.name); } catch { return invalid('metadata-invalid-name'); }
  if (value.schema !== SESSION_METADATA_SCHEMA
    || value.version !== SESSION_HOME_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !positiveRevision(value.revision)
    || !positiveRevision(value.name_revision)
    || value.name_revision > value.revision
    || value.normalized_name !== normalized
    || !validObjective(value.objective)
    || !validOptionalAbsolutePath(value.preferred_launch_cwd)
    || !iso(value.created_at)
    || !iso(value.updated_at)
    || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    return invalid('metadata-invalid-fields');
  }
  return validCopy(value);
}

export function validateSessionProjection(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'mc_session_id', 'revision', 'lifecycle', 'runtime_state',
    'active_runtime_generation', 'tool', 'updated_at',
  ])) return invalid('projection-unexpected-keys');
  const hasRuntime = value.runtime_state !== 'none';
  if (value.schema !== SESSION_PROJECTION_SCHEMA
    || value.version !== SESSION_HOME_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !positiveRevision(value.revision)
    || !PROJECTION_LIFECYCLES.has(value.lifecycle)
    || !PROJECTION_RUNTIME_STATES.has(value.runtime_state)
    || (hasRuntime
      ? !GENERATION_RE.test(value.active_runtime_generation || '') || !TOOL_RE.test(value.tool || '')
      : value.active_runtime_generation !== null || value.tool !== null)
    || !iso(value.updated_at)) return invalid('projection-invalid-fields');
  return validCopy(value);
}

export function validateSessionNameClaim(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'mc_session_id', 'name', 'normalized_name',
    'name_revision', 'claimed_at',
  ])) return invalid('name-claim-unexpected-keys');
  let normalized;
  try { normalized = normalizeSessionName(value.name); } catch { return invalid('name-claim-invalid-name'); }
  if (value.schema !== SESSION_NAME_CLAIM_SCHEMA
    || value.version !== SESSION_HOME_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || value.normalized_name !== normalized
    || !positiveRevision(value.name_revision)
    || !iso(value.claimed_at)) return invalid('name-claim-invalid-fields');
  return validCopy(value);
}

export function validateObjective(value) {
  if (!validObjective(value)) throw new TypeError('objective must be null or bounded text');
}

export function validateOptionalAbsolutePath(value, label) {
  if (!validOptionalAbsolutePath(value)) throw new TypeError(`${label} must be an absolute path or null`);
}

export function validateIso(value) {
  if (!iso(value)) throw new TypeError('invalid ISO timestamp');
  return value;
}

export function assertSourceId(value) {
  if (!SOURCE_ID_RE.test(value || '')) throw new TypeError('invalid source id');
}

export function assertMcSessionId(value) {
  if (!MC_SESSION_ID_RE.test(value || '')) throw new TypeError('invalid mc session id');
}

export function assertExpectedRevision(value) {
  if (!positiveRevision(value)) throw new TypeError('expected revision must be a positive integer');
}

export function assertValid(result) {
  if (!result?.ok) throw new TypeError(result?.reason || 'invalid session state');
}

export function unknown(reason, extra = {}) {
  return { kind: 'unknown', reason, ...extra };
}

export function sessionHomeError(reason) {
  const error = new Error(`mc session home error (${reason})`);
  error.code = 'MC_SESSION_HOME_ERROR';
  error.reason = reason;
  return error;
}

function validObjective(value) {
  return value === null || (typeof value === 'string'
    && value.length <= 2048
    && !value.includes('\u0000'));
}

function validOptionalAbsolutePath(value) {
  return value === null || (typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\u0000')
    && isAbsolute(value)
    && resolve(value) === value);
}

function iso(value) {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function positiveRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validCopy(value) {
  return { ok: true, value: structuredClone(value) };
}

function invalid(reason) {
  return { ok: false, reason };
}
