/**
 * Minimal, local lifecycle evidence for a broker-owned coding session.
 *
 * This file intentionally serializes only the fields in buildLifecycleJournal.
 * In particular, it is never a place for PTY output, environment variables,
 * credentials, launch arguments, or error text.
 */
import { constants } from 'node:os';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { lstat as lstatAsync, mkdir, open, readFile as readFileAsync, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const LIFECYCLE_JOURNAL_SCHEMA = 'mc-broker-lifecycle-journal';
export const LIFECYCLE_JOURNAL_VERSION = 1;
export const LIFECYCLE_JOURNAL_MAX_BYTES = 2048;

const STATES = new Set(['live', 'exited', 'launch_failed']);
// launch-client binds every broker launch to a canonical UUID v4 generation.
const RUNTIME_GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNALS = new Set(Object.keys(constants.signals));
const REQUIRED_KEYS = new Set([
  'schema',
  'version',
  'coding_session_id',
  'runtime_generation',
  'state',
  'observed_at',
]);
const OPTIONAL_KEYS = new Set(['exit_code', 'signal']);

/**
 * Create the exact metadata shape persisted by writeLifecycleJournal.
 * The camelCase inputs keep the call site natural for BrokerRuntime and resume.
 */
export function buildLifecycleJournal(input = {}) {
  assertAllowedInput(input);
  const {
    codingSessionId,
    runtimeGeneration,
    state,
    observedAt,
    exitCode,
    signal,
  } = input;
  const journal = {
    schema: LIFECYCLE_JOURNAL_SCHEMA,
    version: LIFECYCLE_JOURNAL_VERSION,
    coding_session_id: codingSessionId,
    runtime_generation: runtimeGeneration,
    state,
    observed_at: observedAt,
    ...(exitCode === undefined || exitCode === null ? {} : { exit_code: exitCode }),
    ...(signal === undefined || signal === null ? {} : { signal }),
  };
  const validation = validateJournal(journal);
  if (!validation.ok) throw new TypeError(`invalid lifecycle journal: ${validation.reason}`);
  return journal;
}

/**
 * Atomically replace the journal at journalPath with a mode-0600 JSON file.
 * fs and randomBytes are injectable so runtime and resume callers can supply
 * their own dependency portals in tests.
 */
export async function writeLifecycleJournal(journalPath, input, {
  fs = defaultFs,
  randomBytes: randomBytesImpl = randomBytes,
} = {}) {
  const journal = buildLifecycleJournal(input);
  const path = requiredPath(journalPath);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomBytesImpl(16).toString('hex')}.tmp`,
  );
  let handle = null;

  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, path);
    return journal;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * BrokerRuntime-facing adapter. It takes one injectable object rather than
 * binding the runtime to the storage implementation or journal representation.
 */
export async function writeSessionLifecycle({
  path,
  codingSessionId,
  runtimeGeneration,
  state,
  observedAt,
  exitCode,
  signal,
  fs,
  randomBytes: randomBytesImpl,
} = {}) {
  return writeLifecycleJournal(path, {
    codingSessionId,
    runtimeGeneration,
    state,
    observedAt,
    exitCode,
    signal,
  }, { fs: fs || defaultFs, ...(randomBytesImpl ? { randomBytes: randomBytesImpl } : {}) });
}

/**
 * Synchronous exit-path equivalent of writeSessionLifecycle. BrokerRuntime
 * uses this when an exit event must be durable before its socket is closed.
 */
export function writeSessionLifecycleSync({
  path,
  codingSessionId,
  runtimeGeneration,
  state,
  observedAt,
  exitCode,
  signal,
  fs = defaultSyncFs,
  randomBytes: randomBytesImpl = randomBytes,
} = {}) {
  const journal = buildLifecycleJournal({
    codingSessionId,
    runtimeGeneration,
    state,
    observedAt,
    exitCode,
    signal,
  });
  const targetPath = requiredPath(path);
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomBytesImpl(16).toString('hex')}.tmp`,
  );
  let fd = null;

  try {
    fs.mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, targetPath);
    return journal;
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Read lifecycle evidence without ever trusting it by default.
 *
 * Result kinds are deliberately tri-state:
 * - present: a strictly valid journal for the expected session/generation
 * - absent: no journal exists
 * - unknown: unreadable, corrupt, insecure, or mismatched evidence
 *
 * Callers that need a fail-closed decision must treat anything but `present`
 * as unknown; this function never returns parsed raw JSON on a failure path.
 */
export async function readLifecycleJournal(journalPath, {
  codingSessionId,
  runtimeGeneration,
  fs = defaultFs,
} = {}) {
  const path = requiredPathOrUnknown(journalPath);
  if (!path) return unknown('invalid-path');
  if (!validSessionId(codingSessionId)) return unknown('invalid-expected-session-id');
  if (runtimeGeneration !== undefined && !validRuntimeGeneration(runtimeGeneration)) {
    return unknown('invalid-expected-runtime-generation');
  }

  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    return isMissing(error) ? absent() : unknown('unreadable');
  }
  if (!stat.isFile?.() || (stat.mode & 0o077) !== 0) return unknown('unsafe-file');

  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return unknown('unreadable');
  }
  if (Buffer.byteLength(raw, 'utf8') > LIFECYCLE_JOURNAL_MAX_BYTES) return unknown('too-large');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknown('corrupt');
  }
  const validation = validateJournal(parsed);
  if (!validation.ok) return unknown(validation.reason);
  if (parsed.coding_session_id !== codingSessionId) return unknown('session-mismatch');
  if (runtimeGeneration !== undefined && parsed.runtime_generation !== runtimeGeneration) return unknown('generation-mismatch');

  return { kind: 'present', journal: parsed };
}

/**
 * Resume-facing adapter. Missing, malformed, mismatched, or otherwise
 * untrusted evidence never becomes a positive lifecycle decision.
 */
export async function readSessionLifecycle({ path, codingSessionId, fs } = {}) {
  const result = await readLifecycleJournal(path, { codingSessionId, fs: fs || defaultFs });
  if (result.kind !== 'present') {
    return { verdict: 'unknown', record: null, reason: result.reason || result.kind };
  }
  return {
    verdict: result.journal.state === 'live' ? 'live' : 'exited',
    record: result.journal,
  };
}

/** Strict validation is exported for callers that receive journal JSON over a port. */
export function validateJournal(value) {
  if (!isObject(value)) return invalid('not-an-object');
  const keys = Object.keys(value);
  if (keys.length < REQUIRED_KEYS.size || keys.some((key) => !REQUIRED_KEYS.has(key) && !OPTIONAL_KEYS.has(key))) {
    return invalid('unexpected-keys');
  }
  if ([...REQUIRED_KEYS].some((key) => !(key in value))) return invalid('missing-keys');
  if (value.schema !== LIFECYCLE_JOURNAL_SCHEMA || value.version !== LIFECYCLE_JOURNAL_VERSION) {
    return invalid('unsupported-schema');
  }
  if (!validSessionId(value.coding_session_id)) return invalid('invalid-session-id');
  if (!validRuntimeGeneration(value.runtime_generation)) return invalid('invalid-runtime-generation');
  if (!STATES.has(value.state)) return invalid('invalid-state');
  if (!validObservedAt(value.observed_at)) return invalid('invalid-observed-at');
  if ('exit_code' in value && !validExitCode(value.exit_code)) return invalid('invalid-exit-code');
  if ('signal' in value && !validSignal(value.signal)) return invalid('invalid-signal');
  if ('exit_code' in value && 'signal' in value) return invalid('ambiguous-exit');
  if (value.state === 'live' && ('exit_code' in value || 'signal' in value)) return invalid('live-has-exit');
  return { ok: true };
}

const defaultFs = { lstat: lstatAsync, mkdir, open, readFile: readFileAsync, rename, rm };
const defaultSyncFs = {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
};

function requiredPath(value) {
  const path = requiredPathOrUnknown(value);
  if (!path) throw new TypeError('journal path is required');
  return path;
}

function requiredPathOrUnknown(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function validRuntimeGeneration(value) {
  return typeof value === 'string' && RUNTIME_GENERATION_RE.test(value);
}

function validObservedAt(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function validSignal(value) {
  return typeof value === 'string' && SIGNALS.has(value);
}

function assertAllowedInput(value) {
  if (!isObject(value)) throw new TypeError('invalid lifecycle journal: not-an-object');
  const allowed = new Set([
    'codingSessionId',
    'runtimeGeneration',
    'state',
    'observedAt',
    'exitCode',
    'signal',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('invalid lifecycle journal: unexpected-keys');
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function absent() {
  return { kind: 'absent', journal: null };
}

function unknown(reason) {
  return { kind: 'unknown', journal: null, reason };
}

function invalid(reason) {
  return { ok: false, reason };
}
