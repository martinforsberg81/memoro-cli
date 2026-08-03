import { join } from 'node:path';

import { mcHome } from './paths.js';
import {
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
} from './private-state.js';
import { sessionHomePaths } from './session-home-paths.js';
import { MC_SESSION_ID_RE } from './session-home-schema.js';

export const SESSION_LEGACY_REFERENCE_SCHEMA = 'mc-session-legacy-reference';
export const SESSION_LEGACY_REFERENCE_VERSION = 1;

const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_REFERENCES = 4096;

export function writeSessionLegacyReferenceSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  value,
  random,
} = {}) {
  const checked = validateSessionLegacyReference(value);
  if (!checked.ok || checked.value.mc_session_id !== mcSessionId) {
    throw new TypeError(checked.reason || 'legacy-reference-session-mismatch');
  }
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  publishImmutablePrivateJsonSync({
    path: legacyReferencePath(paths),
    value: checked.value,
    trustedRoot: paths.mcHomeDir,
    ...(random ? { random } : {}),
  });
  return checked.value;
}

export function readSessionLegacyReferenceSync({
  mcHomeDir = mcHome(),
  mcSessionId,
} = {}) {
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir, mcSessionId }); } catch {
    return { kind: 'unknown', reason: 'invalid-legacy-reference-identity' };
  }
  const read = readPrivateJsonSync({
    path: legacyReferencePath(paths),
    trustedRoot: paths.mcHomeDir,
    validate: validateSessionLegacyReference,
    maxBytes: 256 * 1024,
  });
  if (read.kind !== 'present') return read;
  return read.value.mc_session_id === mcSessionId
    ? read
    : { kind: 'unknown', reason: 'legacy-reference-session-mismatch' };
}

export function validateSessionLegacyReference(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'mc_session_id',
    'migration_plan_sha256',
    'registry',
    'identities',
    'managed_generations',
    'runtime_hosts',
    'projections',
  ])) return invalid('legacy-reference-unexpected-keys');
  if (value.schema !== SESSION_LEGACY_REFERENCE_SCHEMA
    || value.version !== SESSION_LEGACY_REFERENCE_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !SHA256.test(value.migration_plan_sha256 || '')
    || !validRegistryReference(value.registry)
    || !referenceArray(value.identities)
    || !referenceArray(value.managed_generations)
    || !referenceArray(value.runtime_hosts)
    || !referenceArray(value.projections)) {
    return invalid('legacy-reference-invalid-fields');
  }
  return { ok: true, value: structuredClone(value) };
}

function validRegistryReference(value) {
  return plain(value)
    && exactKeys(value, ['entry_index', 'source_sha256', 'legacy_session_id', 'coding_session_id'])
    && Number.isSafeInteger(value.entry_index)
    && value.entry_index >= 0
    && SHA256.test(value.source_sha256 || '')
    && nullableId(value.legacy_session_id)
    && nullableId(value.coding_session_id);
}

function referenceArray(value) {
  return Array.isArray(value)
    && value.length <= MAX_REFERENCES
    && value.every((item) => (
      plain(item)
      && exactKeys(item, ['kind', 'legacy_id', 'target_id', 'state', 'source_sha256'])
      && ID.test(item.kind || '')
      && nullableId(item.legacy_id)
      && nullableId(item.target_id)
      && nullableId(item.state)
      && SHA256.test(item.source_sha256 || '')
    ));
}

function nullableId(value) {
  return value === null || ID.test(value || '');
}

function legacyReferencePath(paths) {
  return join(paths.home, 'legacy-references.json');
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

function invalid(reason) {
  return { ok: false, reason };
}
