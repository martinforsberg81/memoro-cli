import { randomBytes } from 'node:crypto';

import { mcHome } from '../../mc/paths.js';
import {
  ensurePrivateDirectoryChainSync,
  inspectPrivateDirectoryChainSync,
  readPrivateJsonSync,
  replacePrivateJsonSync,
} from '../../mc/private-state.js';
import { sessionHomePaths } from '../../mc/session-home-paths.js';
import { validateIso } from '../../mc/session-home-schema.js';
import {
  GENERATION_ID_RE,
} from '../../mc/session-record-ids.js';
import { MC_SESSION_ID_RE } from '../../mc/session-home-schema.js';

export const RUNTIME_HOST_MANIFEST_SCHEMA = 'mc-session-runtime-host';
export const RUNTIME_HOST_MANIFEST_VERSION = 1;

const HOST_STATES = new Set(['starting', 'live', 'exited', 'failed']);
const SIGNAL_RE = /^[A-Z][A-Z0-9]{0,31}$/u;
const REASON_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/u;

export function writeRuntimeHostManifestSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  generationId,
  state,
  hostPid = process.pid,
  processPid = null,
  cols,
  rows,
  startedAt,
  updatedAt = new Date().toISOString(),
  exit = null,
  failureReason = null,
  random = randomBytes,
} = {}) {
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const value = {
    schema: RUNTIME_HOST_MANIFEST_SCHEMA,
    version: RUNTIME_HOST_MANIFEST_VERSION,
    mc_session_id: mcSessionId,
    generation_id: generationId,
    state,
    host_pid: hostPid,
    process_pid: processPid,
    socket_path: paths.runtimeHostSocketPath,
    cols,
    rows,
    started_at: validateIso(startedAt),
    updated_at: validateIso(updatedAt),
    exit,
    failure_reason: failureReason,
  };
  const checked = validateRuntimeHostManifest(value);
  if (!checked.ok) throw runtimeHostStateError(checked.reason);
  ensurePrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.ephemeralRunPath,
  });
  replacePrivateJsonSync({
    path: paths.runtimeHostManifestPath,
    value,
    trustedRoot: paths.mcHomeDir,
    random,
  });
  return value;
}

export function readRuntimeHostManifestSync({
  mcHomeDir = mcHome(),
  mcSessionId,
} = {}) {
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir, mcSessionId }); } catch {
    return unknown('invalid-runtime-host-identity');
  }
  const safe = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.ephemeralRunPath,
  });
  if (!safe.ok) return safe.missing ? { kind: 'absent' } : unknown(safe.reason);
  const read = readPrivateJsonSync({
    path: paths.runtimeHostManifestPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateRuntimeHostManifest,
  });
  if (read.kind !== 'present') return read;
  if (read.value.mc_session_id !== mcSessionId
    || read.value.socket_path !== paths.runtimeHostSocketPath) {
    return unknown('runtime-host-binding-mismatch');
  }
  return read;
}

export function validateRuntimeHostManifest(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'mc_session_id',
    'generation_id',
    'state',
    'host_pid',
    'process_pid',
    'socket_path',
    'cols',
    'rows',
    'started_at',
    'updated_at',
    'exit',
    'failure_reason',
  ])) return invalid('runtime-host-unexpected-keys');
  if (value.schema !== RUNTIME_HOST_MANIFEST_SCHEMA
    || value.version !== RUNTIME_HOST_MANIFEST_VERSION
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !GENERATION_ID_RE.test(value.generation_id || '')
    || !HOST_STATES.has(value.state)
    || !positivePid(value.host_pid)
    || (value.process_pid !== null && !positivePid(value.process_pid))
    || typeof value.socket_path !== 'string'
    || value.socket_path.length < 1
    || value.socket_path.length > 4096
    || !terminalSize(value.cols, value.rows)
    || !iso(value.started_at)
    || !iso(value.updated_at)
    || Date.parse(value.updated_at) < Date.parse(value.started_at)) {
    return invalid('runtime-host-invalid-fields');
  }
  if (value.state === 'starting') {
    if (value.process_pid !== null || value.exit !== null || value.failure_reason !== null) {
      return invalid('runtime-host-invalid-starting-state');
    }
  } else if (value.state === 'live') {
    if (value.process_pid === null || value.exit !== null || value.failure_reason !== null) {
      return invalid('runtime-host-invalid-live-state');
    }
  } else if (value.state === 'exited') {
    if (value.process_pid === null || !validExit(value.exit) || value.failure_reason !== null) {
      return invalid('runtime-host-invalid-exited-state');
    }
  } else if (value.exit !== null
    || !REASON_CODE_RE.test(value.failure_reason || '')) {
    return invalid('runtime-host-invalid-failed-state');
  }
  return { ok: true, value: structuredClone(value) };
}

export function runtimeHostStateError(reason) {
  const error = new Error(`mc runtime host state error (${reason})`);
  error.code = 'MC_RUNTIME_HOST_STATE_ERROR';
  error.reason = reason;
  return error;
}

function validExit(value) {
  return plain(value)
    && exactKeys(value, ['exit_code', 'signal', 'recorded_at'])
    && (value.exit_code === null
      || (Number.isSafeInteger(value.exit_code) && value.exit_code >= 0))
    && (value.signal === null || SIGNAL_RE.test(value.signal || ''))
    && (value.exit_code !== null || value.signal !== null)
    && iso(value.recorded_at);
}

function terminalSize(cols, rows) {
  return Number.isSafeInteger(cols) && cols >= 20 && cols <= 500
    && Number.isSafeInteger(rows) && rows >= 5 && rows <= 200;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function iso(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
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

function unknown(reason) {
  return { kind: 'unknown', reason };
}
