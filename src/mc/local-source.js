import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import {
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
} from './private-state.js';
import { assertSourceId } from './session-home-schema.js';
import { listSessionHomesSync } from './session-home.js';
import { readSessionCutoverCompletionSync } from './session-cutover-interlock.js';
import { readCutoverPlanSync } from './session-cutover.js';

export const LOCAL_SOURCE_SCHEMA = 'mc-local-source';
export const LOCAL_SOURCE_VERSION = 1;

export function resolveLocalSourceSync({
  mcHomeDir = mcHome(),
  random = randomBytes,
  now = () => new Date().toISOString(),
} = {}) {
  const path = localSourcePath(mcHomeDir);
  const current = readPrivateJsonSync({
    path,
    trustedRoot: mcHomeDir,
    maxBytes: 4096,
    validate: validateLocalSource,
  });
  if (current.kind === 'present') {
    assertCompatibleSource(mcHomeDir, current.value.source_id);
    return current.value;
  }
  if (current.kind === 'unknown') throw localSourceError(current.reason);

  const sourceId = discoverExistingSourceId(mcHomeDir)
    || `machine_${random(12).toString('hex')}`;
  assertSourceId(sourceId);
  const value = {
    schema: LOCAL_SOURCE_SCHEMA,
    version: LOCAL_SOURCE_VERSION,
    source_id: sourceId,
    created_at: exactIso(now()),
  };
  publishImmutablePrivateJsonSync({
    path,
    value,
    trustedRoot: mcHomeDir,
    random,
  });
  assertCompatibleSource(mcHomeDir, sourceId);
  return value;
}

export function readLocalSourceSync({ mcHomeDir = mcHome() } = {}) {
  return readPrivateJsonSync({
    path: localSourcePath(mcHomeDir),
    trustedRoot: mcHomeDir,
    maxBytes: 4096,
    validate: validateLocalSource,
  });
}

export function localSourcePath(mcHomeDir = mcHome()) {
  return join(mcHomeDir, 'local-source.json');
}

export function validateLocalSource(value) {
  try {
    if (!plain(value)
      || !exactKeys(value, ['schema', 'version', 'source_id', 'created_at'])
      || value.schema !== LOCAL_SOURCE_SCHEMA
      || value.version !== LOCAL_SOURCE_VERSION) return invalid('invalid-local-source');
    assertSourceId(value.source_id);
    exactIso(value.created_at);
    return { ok: true, value: structuredClone(value) };
  } catch {
    return invalid('invalid-local-source');
  }
}

function discoverExistingSourceId(mcHomeDir) {
  const completion = readSessionCutoverCompletionSync({ mcHomeDir });
  if (completion.kind === 'present') return completion.value.source_id;
  if (completion.kind === 'unknown') throw localSourceError(completion.reason);

  const plan = readCutoverPlanSync({ mcHomeDir });
  if (plan.kind === 'present') return plan.value.source_id;
  if (plan.kind === 'unknown') throw localSourceError(plan.reason);

  const listed = listSessionHomesSync({ mcHomeDir });
  const ids = new Set(listed.sessions.map((session) => session.identity.owner.source_id));
  if (ids.size > 1) throw localSourceError('multiple-machine-sources');
  return [...ids][0] || null;
}

function assertCompatibleSource(mcHomeDir, sourceId) {
  const completion = readSessionCutoverCompletionSync({ mcHomeDir });
  if (completion.kind === 'unknown') throw localSourceError(completion.reason);
  if (completion.kind === 'present' && completion.value.source_id !== sourceId) {
    throw localSourceError('cutover-source-conflict');
  }
  const listed = listSessionHomesSync({ mcHomeDir });
  if (listed.sessions.some((session) => session.identity.owner.source_id !== sourceId)) {
    throw localSourceError('session-source-conflict');
  }
}

function exactIso(value) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('invalid source timestamp');
  }
  return new Date(value).toISOString();
}

function localSourceError(reason) {
  const error = new Error(`mc local source error (${reason})`);
  error.code = 'MC_LOCAL_SOURCE_ERROR';
  error.reason = reason;
  return error;
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
