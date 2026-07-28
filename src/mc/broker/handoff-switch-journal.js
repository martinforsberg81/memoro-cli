/**
 * Broker-owned causal record for one provider switch.
 *
 * The journal may contain only the scanner-approved handoff contract and
 * bounded transaction metadata. It is never a home for provider-native IDs,
 * transcript paths/bodies, PTY data, launch arguments, environment values,
 * credentials, or error text.
 */
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  basename, dirname, isAbsolute, join, relative, resolve,
} from 'node:path';

import { buildHandoff } from '../handoff.js';

export const HANDOFF_SWITCH_SCHEMA = 'mc-handoff-switch-journal-v1';
export const HANDOFF_SWITCH_PHASES = Object.freeze([
  'prepared',
  'source_terminal_confirmed',
  'handoff_persisted',
  'target_launch_started',
  'delivery_acknowledged',
  'consumed_committed',
  'complete',
]);

const MAX_BYTES = 32 * 1024;
const MAX_DIAGNOSTICS = 24;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{6,}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TOOLS = new Set(['codex', 'claude-code']);
const DIAGNOSTIC_CODE = /^[a-z][a-z0-9-]{0,79}$/;
const AUTHENTICATION_DOMAIN = 'mc-handoff-switch-journal-authentication-v1';
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
const JOURNAL_KEYS = [
  'schema',
  'transaction_id',
  'coding_session_id',
  'phase',
  'target_tool',
  'controller_root_digest',
  'controller_capability_digest',
  'source_cursor',
  'target_cursor',
  'handoff',
  'persisted',
  'target_latest_sequence',
  'target_message_digest',
  'target_runtime_generation',
  'diagnostics',
  'updated_at',
  'authentication_digest',
];

export function buildHandoffSwitchJournal(input = {}) {
  const unsigned = {
    schema: HANDOFF_SWITCH_SCHEMA,
    transaction_id: input.transactionId,
    coding_session_id: input.codingSessionId,
    phase: input.phase,
    target_tool: input.targetTool,
    controller_root_digest: input.controllerRootDigest,
    controller_capability_digest: input.controllerCapabilityDigest,
    source_cursor: input.sourceCursor,
    target_cursor: input.targetCursor,
    handoff: input.handoff,
    persisted: input.persisted ?? null,
    target_latest_sequence: input.targetLatestSequence ?? null,
    target_message_digest: input.targetMessageDigest ?? null,
    target_runtime_generation: input.targetRuntimeGeneration ?? null,
    diagnostics: input.diagnostics ?? [{
      code: 'transaction-prepared',
      phase: 'prepared',
      at: input.updatedAt,
    }],
    updated_at: input.updatedAt,
  };
  const authenticationDigest = authenticateHandoffSwitchJournal(
    unsigned,
    input.controllerRoot,
  );
  if (!authenticationDigest) {
    throw new TypeError('invalid handoff switch controller root');
  }
  const journal = {
    ...unsigned,
    authentication_digest: authenticationDigest,
  };
  const checked = validateHandoffSwitchJournal(journal);
  if (!checked.ok) throw new TypeError(`invalid handoff switch journal: ${checked.reason}`);
  return checked.journal;
}

export function validateHandoffSwitchJournal(value) {
  if (!plain(value) || !exactKeys(value, JOURNAL_KEYS)) return invalid('unexpected-keys');
  if (value.schema !== HANDOFF_SWITCH_SCHEMA
    || !UUID_V4.test(value.transaction_id || '')
    || !SESSION_ID.test(value.coding_session_id || '')
    || !HANDOFF_SWITCH_PHASES.includes(value.phase)
    || !TOOLS.has(value.target_tool)
    || !DIGEST.test(value.controller_root_digest || '')
    || !DIGEST.test(value.controller_capability_digest || '')
    || !DIGEST.test(value.authentication_digest || '')
    || !sequence(value.source_cursor)
    || !sequence(value.target_cursor)
    || !iso(value.updated_at)) {
    return invalid('invalid-fields');
  }
  const handoff = validateWireHandoff(value.handoff, value.coding_session_id);
  if (!handoff.ok) return invalid(handoff.reason);
  if (handoff.handoff.source.tool === value.target_tool) {
    return invalid('source-target-match');
  }
  const phaseIndex = HANDOFF_SWITCH_PHASES.indexOf(value.phase);
  if (phaseIndex < HANDOFF_SWITCH_PHASES.indexOf('handoff_persisted')) {
    if (value.persisted !== null) return invalid('premature-persisted-result');
  } else if (!plain(value.persisted)
    || !exactKeys(value.persisted, ['sequence', 'digest'])
    || value.persisted.sequence !== value.handoff.sequence
    || !DIGEST.test(value.persisted.digest || '')) {
    return invalid('invalid-persisted-result');
  }
  if (value.target_latest_sequence !== null
    && (!sequence(value.target_latest_sequence)
      || value.target_latest_sequence < value.target_cursor
      || value.target_latest_sequence < value.handoff.sequence)) {
    return invalid('invalid-target-latest-sequence');
  }
  if (value.target_message_digest !== null
    && !DIGEST.test(value.target_message_digest || '')) {
    return invalid('invalid-target-message-digest');
  }
  if (value.target_runtime_generation !== null
    && !UUID_V4.test(value.target_runtime_generation || '')) {
    return invalid('invalid-target-generation');
  }
  if (phaseIndex < HANDOFF_SWITCH_PHASES.indexOf('target_launch_started')
    && value.target_runtime_generation !== null) {
    return invalid('premature-target-generation');
  }
  if (phaseIndex >= HANDOFF_SWITCH_PHASES.indexOf('target_launch_started')
    && value.target_message_digest === null) {
    return invalid('target-message-proof-incomplete');
  }
  if (phaseIndex >= HANDOFF_SWITCH_PHASES.indexOf('delivery_acknowledged')
    && (value.target_runtime_generation === null
      || value.target_latest_sequence === null)) {
    return invalid('delivery-proof-incomplete');
  }
  if (!Array.isArray(value.diagnostics)
    || value.diagnostics.length < 1
    || value.diagnostics.length > MAX_DIAGNOSTICS
    || value.diagnostics.some((item) => !plain(item)
      || !exactKeys(item, ['code', 'phase', 'at'])
      || !DIAGNOSTIC_CODE.test(item.code || '')
      || !HANDOFF_SWITCH_PHASES.includes(item.phase)
      || !iso(item.at))) {
    return invalid('invalid-diagnostics');
  }
  return { ok: true, journal: structuredClone(value) };
}

export function authenticateHandoffSwitchJournal(journal, controllerRoot) {
  if (!DIGEST.test(controllerRoot || '') || !plain(journal)) return null;
  const unsigned = { ...journal };
  delete unsigned.authentication_digest;
  return createHmac('sha256', controllerRoot)
    .update(`${AUTHENTICATION_DOMAIN}\0${canonicalJson(unsigned)}`)
    .digest('hex');
}

export function matchesHandoffSwitchJournalAuthentication(
  journal,
  controllerRoot,
) {
  const actual = authenticateHandoffSwitchJournal(journal, controllerRoot);
  const expected = journal?.authentication_digest;
  return DIGEST.test(actual || '') && DIGEST.test(expected || '')
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function readHandoffSwitchJournalSync({
  path,
  trustedRoot,
  fs = syncFs,
} = {}) {
  if (typeof path !== 'string' || !path) return unknown('invalid-path');
  let fd = null;
  try {
    const directory = dirname(path);
    const chain = privateDirectoryChainSafety({ trustedRoot, directory, fs });
    if (!chain.ok) return chain.missing ? { kind: 'absent' } : unknown(chain.reason);
    const stat = fs.lstatSync(path);
    if (!privateRegularFile(stat)) return unknown('unsafe-file');
    fd = fs.openSync(path, READ_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!sameNode(stat, opened) || !privateRegularFile(opened)) return unknown('unsafe-file');
    const reopened = privateDirectoryChainSafety({ trustedRoot, directory, fs });
    if (!reopened.ok) return unknown(reopened.reason);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) return unknown('too-large');
    const checked = validateHandoffSwitchJournal(JSON.parse(
      buffer.subarray(0, count).toString('utf8'),
    ));
    return checked.ok
      ? { kind: 'present', journal: checked.journal }
      : unknown(checked.reason);
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'absent' } : unknown('unreadable');
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

export function beginHandoffSwitchJournalSync({
  path,
  journal,
  trustedRoot,
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  const checked = validateHandoffSwitchJournal(journal);
  if (!checked.ok || checked.journal.phase !== 'prepared') {
    throw new TypeError(`invalid handoff switch journal: ${checked.reason || 'not-prepared'}`);
  }
  const existing = readHandoffSwitchJournalSync({ path, trustedRoot, fs });
  if (existing.kind === 'unknown') {
    throw new Error(`handoff switch journal is unsafe (${existing.reason})`);
  }
  if (existing.kind === 'present') {
    if (existing.journal.transaction_id === checked.journal.transaction_id
      && sameJournal(existing.journal, checked.journal)) {
      return { ok: true, duplicate: true, journal: existing.journal };
    }
    if (existing.journal.phase !== 'complete') {
      throw new Error('handoff switch transaction already active');
    }
  }
  writeJournal({ path, journal: checked.journal, trustedRoot, fs, random });
  return { ok: true, duplicate: false, journal: checked.journal };
}

export function advanceHandoffSwitchJournalSync({
  path,
  trustedRoot,
  transactionId,
  expectedPhase,
  nextPhase,
  patch = {},
  updatedAt,
  controllerRoot,
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  const current = readHandoffSwitchJournalSync({ path, trustedRoot, fs });
  if (current.kind !== 'present') {
    throw new Error(`handoff switch journal unavailable (${current.reason || current.kind})`);
  }
  if (current.journal.transaction_id !== transactionId) {
    throw new Error('handoff switch transaction mismatch');
  }
  if (current.journal.phase !== expectedPhase) {
    if (current.journal.phase === nextPhase) {
      return { ok: true, duplicate: true, journal: current.journal };
    }
    throw new Error('handoff switch phase mismatch');
  }
  const currentIndex = HANDOFF_SWITCH_PHASES.indexOf(expectedPhase);
  const nextIndex = HANDOFF_SWITCH_PHASES.indexOf(nextPhase);
  if (nextIndex !== currentIndex && nextIndex !== currentIndex + 1) {
    throw new Error('invalid handoff switch phase transition');
  }
  const allowedPatch = new Set([
    'persisted',
    'target_latest_sequence',
    'target_message_digest',
    'target_runtime_generation',
  ]);
  if (!plain(patch) || Object.keys(patch).some((key) => !allowedPatch.has(key))) {
    throw new TypeError('invalid handoff switch journal patch');
  }
  const unsigned = {
    ...current.journal,
    ...patch,
    phase: nextPhase,
    diagnostics: nextPhase === expectedPhase
      ? current.journal.diagnostics
      : appendDiagnostic(current.journal.diagnostics, {
          code: `phase-${nextPhase.replaceAll('_', '-')}`,
          phase: nextPhase,
          at: updatedAt,
        }),
    updated_at: updatedAt,
  };
  delete unsigned.authentication_digest;
  const candidate = {
    ...unsigned,
    authentication_digest: authenticateHandoffSwitchJournal(
      unsigned,
      controllerRoot,
    ),
  };
  const checked = validateHandoffSwitchJournal(candidate);
  if (!checked.ok) throw new TypeError(`invalid handoff switch journal: ${checked.reason}`);
  writeJournal({ path, journal: checked.journal, trustedRoot, fs, random });
  return { ok: true, duplicate: false, journal: checked.journal };
}

export function recordHandoffSwitchDiagnosticSync({
  path,
  trustedRoot,
  transactionId,
  code,
  observedAt,
  controllerRoot,
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  const current = readHandoffSwitchJournalSync({ path, trustedRoot, fs });
  if (current.kind !== 'present') {
    throw new Error(`handoff switch journal unavailable (${current.reason || current.kind})`);
  }
  if (current.journal.transaction_id !== transactionId) {
    throw new Error('handoff switch transaction mismatch');
  }
  if (!DIAGNOSTIC_CODE.test(code || '') || !iso(observedAt)) {
    throw new TypeError('invalid handoff switch diagnostic');
  }
  const event = {
    code,
    phase: current.journal.phase,
    at: observedAt,
  };
  const last = current.journal.diagnostics.at(-1);
  if (last?.code === event.code && last.phase === event.phase) {
    return { ok: true, duplicate: true, journal: current.journal };
  }
  const unsigned = {
    ...current.journal,
    diagnostics: appendDiagnostic(current.journal.diagnostics, event),
    updated_at: observedAt,
  };
  delete unsigned.authentication_digest;
  const candidate = {
    ...unsigned,
    authentication_digest: authenticateHandoffSwitchJournal(
      unsigned,
      controllerRoot,
    ),
  };
  const checked = validateHandoffSwitchJournal(candidate);
  if (!checked.ok) throw new TypeError(`invalid handoff switch journal: ${checked.reason}`);
  writeJournal({ path, journal: checked.journal, trustedRoot, fs, random });
  return { ok: true, duplicate: false, journal: checked.journal };
}

function validateWireHandoff(value, codingSessionId) {
  if (!plain(value) || value.coding_session_id !== codingSessionId
    || !plain(value.source) || !plain(value.workspace)
    || !plain(value.workspace.anchor) || !plain(value.content)) {
    return invalid('invalid-handoff');
  }
  const rebuilt = buildHandoff({
    codingSessionId: value.coding_session_id,
    sequence: value.sequence,
    parentDigest: value.parent_digest,
    source: {
      kind: value.source.kind,
      id: value.source.id,
      tool: value.source.tool,
      runtimeGeneration: value.source.runtime_generation,
    },
    workspace: {
      anchor: {
        repoId: value.workspace.anchor.repo_id,
        ...(value.workspace.anchor.ref ? { ref: value.workspace.anchor.ref } : {}),
        ...(value.workspace.anchor.branch ? { branch: value.workspace.anchor.branch } : {}),
      },
      digest: value.workspace.digest,
    },
    content: {
      ...(value.content.goal ? { goal: value.content.goal } : {}),
      ...(value.content.state ? { state: value.content.state } : {}),
      ...(value.content.decisions ? { decisions: value.content.decisions } : {}),
      ...(value.content.next_actions ? { nextActions: value.content.next_actions } : {}),
      ...(value.content.risks ? { risks: value.content.risks } : {}),
      ...(value.content.changed_paths ? { changedPaths: value.content.changed_paths } : {}),
    },
  });
  if (!rebuilt.ok || JSON.stringify(rebuilt.handoff) !== JSON.stringify(value)) {
    return invalid('invalid-handoff');
  }
  return { ok: true, handoff: rebuilt.handoff };
}

function writeJournal({ path, journal, trustedRoot, fs, random }) {
  const directory = dirname(path);
  ensurePrivateDirectoryChain({ trustedRoot, directory, fs });
  const temporary = join(directory, `.${basename(path)}.${random(16).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, path);
    const verified = readHandoffSwitchJournalSync({ path, trustedRoot, fs });
    if (verified.kind !== 'present' || !sameJournal(verified.journal, journal)) {
      throw new Error('handoff switch journal verification failed');
    }
    fsyncDirectory(directory, fs);
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function appendDiagnostic(items, event) {
  return [...items, event].slice(-MAX_DIAGNOSTICS);
}

function ensurePrivateDirectoryChain({ trustedRoot, directory, fs }) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) throw new Error(`handoff journal directory chain is unsafe (${chain.reason})`);
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (safety.ok) continue;
    if (!safety.missing) {
      throw new Error(`handoff journal directory chain is unsafe (${safety.reason})`);
    }
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const created = privateDirectorySafety(path, fs);
    if (!created.ok) {
      throw new Error(`handoff journal directory chain is unsafe (${created.reason})`);
    }
  }
}

function privateDirectoryChainSafety({ trustedRoot, directory, fs }) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) return chain;
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (!safety.ok) return safety;
  }
  return { ok: true };
}

function resolveTrustedChain(trustedRoot, directory) {
  if (typeof trustedRoot !== 'string' || typeof directory !== 'string'
    || !isAbsolute(trustedRoot) || !isAbsolute(directory)
    || resolve(trustedRoot) !== trustedRoot || resolve(directory) !== directory) {
    return { ok: false, reason: 'invalid-directory-chain' };
  }
  const rel = relative(trustedRoot, directory);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'directory-outside-trusted-root' };
  }
  const paths = [trustedRoot];
  if (rel) {
    let current = trustedRoot;
    for (const segment of rel.split('/')) {
      current = join(current, segment);
      paths.push(current);
    }
  }
  return { ok: true, paths };
}

function privateDirectorySafety(path, fs) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
      return { ok: false, reason: 'unsafe-directory' };
    }
    if (typeof process.getuid === 'function' && Number.isInteger(stat.uid)
      && stat.uid !== process.getuid()) {
      return { ok: false, reason: 'unsafe-directory-owner' };
    }
    return { ok: true };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, missing: true, reason: 'missing-directory' }
      : { ok: false, reason: 'unreadable-directory' };
  }
}

function privateRegularFile(stat) {
  return stat.isFile?.() && !stat.isSymbolicLink?.() && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || !Number.isInteger(stat.uid)
      || stat.uid === process.getuid());
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(path, fs) {
  let fd = null;
  try {
    fd = fs.openSync(path, constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sameJournal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sequence(value) { return Number.isSafeInteger(value) && value >= 0; }
function iso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}
function invalid(reason) { return { ok: false, reason }; }
function unknown(reason) { return { kind: 'unknown', reason }; }

const syncFs = {
  chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, renameSync, rmSync, writeFileSync,
};
