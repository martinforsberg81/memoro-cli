import { join } from 'node:path';

import { mcHome } from './paths.js';
import { readPrivateJsonSync } from './private-state.js';

export const SESSION_CUTOVER_COMPLETE_SCHEMA = 'mc-session-cutover-complete';
export const SESSION_CUTOVER_STARTED_SCHEMA = 'mc-session-cutover-started';
export const SESSION_CUTOVER_ROLLBACK_SCHEMA = 'mc-session-cutover-rollback';
export const SESSION_CUTOVER_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;

export function sessionCutoverRoot(mcHomeDir = mcHome()) {
  return join(mcHomeDir, 'session-cutover-v1');
}

export function sessionCutoverCompletionPath(mcHomeDir = mcHome()) {
  return join(sessionCutoverRoot(mcHomeDir), 'complete.json');
}

export function sessionCutoverStartedPath(mcHomeDir = mcHome()) {
  return join(sessionCutoverRoot(mcHomeDir), 'started.json');
}

export function sessionCutoverRollbackPath(mcHomeDir = mcHome()) {
  return join(sessionCutoverRoot(mcHomeDir), 'rollback.json');
}

export function readSessionCutoverCompletionSync({ mcHomeDir = mcHome() } = {}) {
  return readCutoverReceipt({
    path: sessionCutoverCompletionPath(mcHomeDir),
    mcHomeDir,
    validate(value) {
      return validateSessionCutoverCompletion(value)
        ? { ok: true, value: structuredClone(value) }
        : { ok: false, reason: 'invalid-cutover-completion' };
    },
  });
}

export function readSessionCutoverStartedSync({ mcHomeDir = mcHome() } = {}) {
  return readCutoverReceipt({
    path: sessionCutoverStartedPath(mcHomeDir),
    mcHomeDir,
    validate(value) {
      return plain(value)
        && exactKeys(value, ['schema', 'version', 'plan_sha256', 'started_at'])
        && value.schema === SESSION_CUTOVER_STARTED_SCHEMA
        && value.version === SESSION_CUTOVER_VERSION
        && SHA256.test(value.plan_sha256 || '')
        && iso(value.started_at);
    },
  });
}

export function readSessionCutoverRollbackSync({ mcHomeDir = mcHome() } = {}) {
  return readCutoverReceipt({
    path: sessionCutoverRollbackPath(mcHomeDir),
    mcHomeDir,
    validate(value) {
      return plain(value)
        && exactKeys(value, ['schema', 'version', 'plan_sha256', 'rolled_back_at'])
        && value.schema === SESSION_CUTOVER_ROLLBACK_SCHEMA
        && value.version === SESSION_CUTOVER_VERSION
        && SHA256.test(value.plan_sha256 || '')
        && iso(value.rolled_back_at);
    },
  });
}

export function assertLegacySessionStorageReadableSync(options = {}) {
  const completion = readSessionCutoverCompletionSync(options);
  if (completion.kind !== 'absent') {
    throw interlockError(completion.kind === 'present'
      ? 'MC_V1_CUTOVER_COMPLETE'
      : 'MC_V1_CUTOVER_UNSAFE');
  }
  const rollback = readSessionCutoverRollbackSync(options);
  if (rollback.kind === 'present') return;
  if (rollback.kind === 'unknown') throw interlockError('MC_V1_CUTOVER_UNSAFE');
  const started = readSessionCutoverStartedSync(options);
  if (started.kind === 'absent') return;
  const error = interlockError(started.kind === 'present'
    ? 'MC_V1_CUTOVER_IN_PROGRESS'
    : 'MC_V1_CUTOVER_UNSAFE');
  throw error;
}

export function validateSessionCutoverCompletion(value) {
  return plain(value)
    && exactKeys(value, [
      'schema', 'version', 'plan_sha256', 'source_id', 'completed_at', 'session_count',
    ])
    && value.schema === SESSION_CUTOVER_COMPLETE_SCHEMA
    && value.version === SESSION_CUTOVER_VERSION
    && SHA256.test(value.plan_sha256 || '')
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.source_id || '')
    && iso(value.completed_at)
    && Number.isSafeInteger(value.session_count)
    && value.session_count >= 0;
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

function iso(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function readCutoverReceipt({ path, mcHomeDir, validate }) {
  return readPrivateJsonSync({
    path,
    trustedRoot: mcHomeDir,
    maxBytes: 4096,
    validate(value) {
      return validate(value)
        ? { ok: true, value: structuredClone(value) }
        : { ok: false, reason: 'invalid-cutover-receipt' };
    },
  });
}

function interlockError(code) {
  const messages = {
    MC_V1_CUTOVER_COMPLETE: 'legacy session storage is disabled after V1 cutover',
    MC_V1_CUTOVER_IN_PROGRESS: 'legacy session storage is disabled while V1 cutover is in progress',
    MC_V1_CUTOVER_UNSAFE: 'legacy session storage is unavailable because V1 cutover state is unsafe',
  };
  const error = new Error(messages[code]);
  error.code = code;
  return error;
}
