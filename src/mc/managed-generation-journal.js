/**
 * Durable transaction journal for managed local provider generations.
 *
 * The journal contains bounded metadata only. It must never contain credential
 * values, environment values, command arguments, transcript content, or PTY
 * output.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { mcHome } from './paths.js';

export const MANAGED_INTENT_SCHEMA = 'mc-managed-generation-intent';
export const MANAGED_RECEIPT_SCHEMA = 'mc-managed-generation-receipt';
export const MANAGED_TRANSACTION_SCHEMA = 'mc-managed-generation-transaction';
export const MANAGED_IDENTITY_SCHEMA = 'mc-managed-session-identity';
export const MANAGED_GENERATION_VERSION = 1;
export const MANAGED_RECEIPT_PHASES = Object.freeze([
  'domain-ready',
  'broker-accepted',
  'live',
  'provider-artifact',
  'exited',
  'provider-absent',
  'custody-persisted',
  'archive-ready',
  'domain-cleaned',
  'ready',
  'aborted',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_FAILURE_REASON = /^[a-z][a-z0-9-]{0,127}$/u;
const CLAIM_FILE = /^([0-9]{12})\.json$/;
const MAX_RECEIPT_BYTES = 4096;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
const TERMINAL_PHASES = new Set(['ready', 'aborted']);
const ABORT_REASONS = new Set([
  'launch-failed-before-provider',
  'launch-not-accepted',
]);
const PHASE_PREREQUISITES = Object.freeze({
  'domain-ready': [],
  'broker-accepted': ['domain-ready'],
  live: ['broker-accepted'],
  'provider-artifact': ['live'],
  exited: ['live'],
  'provider-absent': ['exited'],
  'custody-persisted': ['exited'],
  'archive-ready': ['provider-artifact', 'custody-persisted'],
  'domain-cleaned': ['custody-persisted'],
  ready: ['domain-cleaned'],
  aborted: [],
});

export function managedSessionDirectory({
  mcHomeDir = mcHome(),
  codingSessionId,
} = {}) {
  assertSessionId(codingSessionId);
  const root = normalizedRoot(mcHomeDir);
  return join(root, 'managed-sessions', sessionPart(codingSessionId));
}

export function claimManagedSessionIdentitySync({
  mcHomeDir = mcHome(),
  sessionName,
  registrySessionId = null,
  codingSessionId,
  recordedAt = new Date().toISOString(),
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  validateSessionName(sessionName);
  validateRegistrySessionId(registrySessionId);
  assertSessionId(codingSessionId);
  const root = normalizedRoot(mcHomeDir);
  const directory = join(root, 'managed-session-identities');
  const path = join(directory, `${namePart(registrySessionId || sessionName)}.json`);
  const identity = {
    schema: MANAGED_IDENTITY_SCHEMA,
    version: MANAGED_GENERATION_VERSION,
    session_name: sessionName,
    coding_session_id: codingSessionId,
    recorded_at: validateIso(recordedAt),
  };
  ensurePrivateChain(root, directory, fs);
  const existing = readPrivateJson({
    path,
    trustedRoot: root,
    validate: validateManagedSessionIdentity,
    fs,
  });
  if (existing.kind === 'present') {
    return existing.value.coding_session_id === codingSessionId
      ? { ok: true, duplicate: true, identity: existing.value }
      : {
          ok: false,
          reason: 'managed-session-identity-conflict',
          identity: existing.value,
        };
  }
  if (existing.kind === 'unknown') throw unsafeJournal(existing.reason);
  try {
    publishImmutableJson({ path, value: identity, trustedRoot: root, fs, random });
    return { ok: true, duplicate: false, identity };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = readPrivateJson({
      path,
      trustedRoot: root,
      validate: validateManagedSessionIdentity,
      fs,
    });
    if (raced.kind !== 'present') throw unsafeJournal(raced.reason || raced.kind);
    return raced.value.coding_session_id === codingSessionId
      ? { ok: true, duplicate: true, identity: raced.value }
      : {
          ok: false,
          reason: 'managed-session-identity-conflict',
          identity: raced.value,
        };
  }
}

export function inspectManagedSessionIdentitySync({
  mcHomeDir = mcHome(),
  sessionName,
  registrySessionId = null,
  legacySessionKey = null,
  fs = syncFs,
} = {}) {
  try {
    validateSessionName(sessionName);
    validateRegistrySessionId(registrySessionId);
    const root = normalizedRoot(mcHomeDir);
    const directory = join(root, 'managed-session-identities');
    const path = join(directory, `${namePart(registrySessionId || sessionName)}.json`);
    let read = readPrivateJson({
      path,
      trustedRoot: root,
      validate: validateManagedSessionIdentity,
      fs,
    });
    if (read.kind === 'absent'
      && registrySessionId
      && legacySessionKey) {
      validateSessionName(legacySessionKey);
      read = readPrivateJson({
        path: join(directory, `${namePart(legacySessionKey)}.json`),
        trustedRoot: root,
        validate: validateManagedSessionIdentity,
        fs,
      });
    }
    return read.kind === 'present'
      ? { kind: 'present', identity: read.value }
      : read;
  } catch {
    return unknown('invalid-session-name');
  }
}

export function validateManagedSessionIdentity(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'session_name',
    'coding_session_id',
    'recorded_at',
  ])) return invalid('unexpected-keys');
  try {
    validateSessionName(value.session_name);
  } catch {
    return invalid('invalid-session-name');
  }
  if (value.schema !== MANAGED_IDENTITY_SCHEMA
    || value.version !== MANAGED_GENERATION_VERSION
    || !ID.test(value.coding_session_id || '')
    || !iso(value.recorded_at)) return invalid('invalid-fields');
  return { ok: true, value: { ...value } };
}

export function managedGenerationDirectory({
  mcHomeDir = mcHome(),
  codingSessionId,
  runtimeGeneration,
} = {}) {
  assertRuntimeGeneration(runtimeGeneration);
  return join(
    managedSessionDirectory({ mcHomeDir, codingSessionId }),
    'runtime-generations',
    runtimeGeneration,
  );
}

export function buildManagedGenerationIntent(input = {}) {
  assertExactInputKeys(input, [
    'codingSessionId',
    'runtimeGeneration',
    'sequence',
    'mode',
    'tool',
    'resumeProviderSessionId',
    'recordedAt',
  ]);
  assertSessionId(input.codingSessionId);
  assertRuntimeGeneration(input.runtimeGeneration);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError('invalid managed generation sequence');
  }
  const data = validateIntentData({
    mode: input.mode,
    tool: input.tool,
    resume_provider_session_id: input.resumeProviderSessionId ?? null,
  });
  const intentDigest = managedIntentDigest({
    codingSessionId: input.codingSessionId,
    runtimeGeneration: input.runtimeGeneration,
    data,
  });
  const intent = {
    schema: MANAGED_INTENT_SCHEMA,
    version: MANAGED_GENERATION_VERSION,
    sequence: input.sequence,
    coding_session_id: input.codingSessionId,
    runtime_generation: input.runtimeGeneration,
    intent_digest: intentDigest,
    recorded_at: validateIso(input.recordedAt),
    data,
  };
  const checked = validateManagedGenerationIntent(intent);
  if (!checked.ok) throw new TypeError(`invalid managed generation intent: ${checked.reason}`);
  return checked.value;
}

export function managedIntentDigest({
  codingSessionId,
  runtimeGeneration,
  data,
} = {}) {
  assertSessionId(codingSessionId);
  assertRuntimeGeneration(runtimeGeneration);
  const checkedData = validateIntentData(data);
  return sha256(JSON.stringify({
    coding_session_id: codingSessionId,
    runtime_generation: runtimeGeneration,
    data: checkedData,
  }));
}

export function managedTransactionFromIntent(intent) {
  const checked = validateManagedGenerationIntent(intent);
  if (!checked.ok) throw new TypeError(`invalid managed generation intent: ${checked.reason}`);
  return {
    schema: MANAGED_TRANSACTION_SCHEMA,
    version: MANAGED_GENERATION_VERSION,
    sequence: checked.value.sequence,
    coding_session_id: checked.value.coding_session_id,
    runtime_generation: checked.value.runtime_generation,
    intent_digest: checked.value.intent_digest,
  };
}

export function validateManagedGenerationTransaction(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'sequence',
    'coding_session_id',
    'runtime_generation',
    'intent_digest',
  ])) return invalid('unexpected-keys');
  if (value.schema !== MANAGED_TRANSACTION_SCHEMA
    || value.version !== MANAGED_GENERATION_VERSION
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !ID.test(value.coding_session_id || '')
    || !UUID_V4.test(value.runtime_generation || '')
    || !SHA256.test(value.intent_digest || '')) return invalid('invalid-fields');
  return { ok: true, value: { ...value } };
}

export function validateManagedGenerationIntent(value) {
  if (!plain(value)) return invalid('not-object');
  if (!exactKeys(value, [
    'schema',
    'version',
    'sequence',
    'coding_session_id',
    'runtime_generation',
    'intent_digest',
    'recorded_at',
    'data',
  ])) return invalid('unexpected-keys');
  if (value.schema !== MANAGED_INTENT_SCHEMA
    || value.version !== MANAGED_GENERATION_VERSION
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !ID.test(value.coding_session_id || '')
    || !UUID_V4.test(value.runtime_generation || '')
    || !SHA256.test(value.intent_digest || '')
    || !iso(value.recorded_at)) return invalid('invalid-fields');
  let data;
  try {
    data = validateIntentData(value.data);
  } catch {
    return invalid('invalid-data');
  }
  const expectedDigest = managedIntentDigest({
    codingSessionId: value.coding_session_id,
    runtimeGeneration: value.runtime_generation,
    data,
  });
  if (value.intent_digest !== expectedDigest) return invalid('intent-digest-mismatch');
  return { ok: true, value: { ...value, data } };
}

export function buildManagedGenerationReceipt(input = {}) {
  assertExactInputKeys(input, [
    'phase',
    'codingSessionId',
    'runtimeGeneration',
    'intentDigest',
    'recordedAt',
    'data',
  ]);
  if (!MANAGED_RECEIPT_PHASES.includes(input.phase)) {
    throw new TypeError('invalid managed generation phase');
  }
  assertSessionId(input.codingSessionId);
  assertRuntimeGeneration(input.runtimeGeneration);
  if (!SHA256.test(input.intentDigest || '')) {
    throw new TypeError('invalid managed generation intent digest');
  }
  const receipt = {
    schema: MANAGED_RECEIPT_SCHEMA,
    version: MANAGED_GENERATION_VERSION,
    phase: input.phase,
    coding_session_id: input.codingSessionId,
    runtime_generation: input.runtimeGeneration,
    intent_digest: input.intentDigest,
    recorded_at: validateIso(input.recordedAt),
    data: validatePhaseData(input.phase, input.data),
  };
  const checked = validateManagedGenerationReceipt(receipt);
  if (!checked.ok) throw new TypeError(`invalid managed generation receipt: ${checked.reason}`);
  return checked.value;
}

export function validateManagedGenerationReceipt(value) {
  if (!plain(value)) return invalid('not-object');
  if (!exactKeys(value, [
    'schema',
    'version',
    'phase',
    'coding_session_id',
    'runtime_generation',
    'intent_digest',
    'recorded_at',
    'data',
  ])) return invalid('unexpected-keys');
  if (value.schema !== MANAGED_RECEIPT_SCHEMA
    || value.version !== MANAGED_GENERATION_VERSION
    || !MANAGED_RECEIPT_PHASES.includes(value.phase)
    || !ID.test(value.coding_session_id || '')
    || !UUID_V4.test(value.runtime_generation || '')
    || !SHA256.test(value.intent_digest || '')
    || !iso(value.recorded_at)) return invalid('invalid-fields');
  let data;
  try {
    data = validatePhaseData(value.phase, value.data);
  } catch {
    return invalid('invalid-data');
  }
  return { ok: true, value: { ...value, data } };
}

/**
 * Atomically claim the next sequence number for one logical managed session.
 * A racing different generation contends for the same immutable claim file;
 * one wins and the other fails closed.
 */
export function beginManagedGenerationSync({
  mcHomeDir = mcHome(),
  codingSessionId,
  runtimeGeneration,
  mode,
  tool,
  resumeProviderSessionId = null,
  recordedAt = new Date().toISOString(),
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  assertSessionId(codingSessionId);
  assertRuntimeGeneration(runtimeGeneration);
  const before = inspectManagedSessionSync({ mcHomeDir, codingSessionId, fs });
  if (before.kind === 'unknown') throw unsafeJournal(before.reason);

  const sameGeneration = before.generations?.find(
    (generation) => generation.runtime_generation === runtimeGeneration,
  );
  if (sameGeneration) {
    const candidate = buildManagedGenerationIntent({
      codingSessionId,
      runtimeGeneration,
      sequence: sameGeneration.sequence,
      mode,
      tool,
      resumeProviderSessionId,
      recordedAt,
    });
    if (!sameSemanticReceipt(sameGeneration.intent, candidate)) {
      throw new Error('managed generation already has a different launch intent');
    }
    return { ok: true, duplicate: true, intent: sameGeneration.intent };
  }
  const active = before.generations?.find((generation) => !generation.terminal);
  if (active) {
    throw new Error(`managed generation ${active.runtime_generation} is still active`);
  }

  const sequence = (before.generations?.at(-1)?.sequence || 0) + 1;
  const intent = buildManagedGenerationIntent({
    codingSessionId,
    runtimeGeneration,
    sequence,
    mode,
    tool,
    resumeProviderSessionId,
    recordedAt,
  });
  const paths = layout({ mcHomeDir, codingSessionId, runtimeGeneration });
  ensurePrivateChain(paths.mcHomeDir, paths.claimsDirectory, fs);
  ensurePrivateChain(paths.mcHomeDir, paths.generationDirectory, fs);
  const claimPath = join(paths.claimsDirectory, claimFile(sequence));

  try {
    publishImmutableJson({ path: claimPath, value: intent, trustedRoot: paths.mcHomeDir, fs, random });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = inspectManagedSessionSync({ mcHomeDir, codingSessionId, fs });
    if (raced.kind === 'unknown') throw unsafeJournal(raced.reason);
    const winner = raced.generations?.find(
      (generation) => generation.runtime_generation === runtimeGeneration,
    );
    if (winner && sameSemanticReceipt(winner.intent, intent)) {
      return { ok: true, duplicate: true, intent: winner.intent };
    }
    throw new Error('another managed generation won the session sequence claim');
  }
  return { ok: true, duplicate: false, intent };
}

export function appendManagedGenerationReceiptSync({
  mcHomeDir = mcHome(),
  phase,
  codingSessionId,
  runtimeGeneration,
  intentDigest,
  recordedAt = new Date().toISOString(),
  data = {},
  fs = syncFs,
  randomBytes: random = randomBytes,
} = {}) {
  const receipt = buildManagedGenerationReceipt({
    phase,
    codingSessionId,
    runtimeGeneration,
    intentDigest,
    recordedAt,
    data,
  });
  const current = inspectManagedGenerationSync({
    mcHomeDir,
    codingSessionId,
    runtimeGeneration,
    fs,
  });
  if (current.kind !== 'present') {
    throw new Error(current.kind === 'unknown'
      ? `managed generation journal is unsafe (${current.reason})`
      : 'managed generation has no durable launch intent');
  }
  if (current.intent.intent_digest !== intentDigest) {
    throw new Error('managed generation intent digest mismatch');
  }
  const existing = current.receipts[phase];
  if (existing) {
    if (sameSemanticReceipt(existing, receipt)) {
      return { ok: true, duplicate: true, receipt: existing };
    }
    throw new Error(`managed generation phase ${phase} already has a different receipt`);
  }
  validateAppendTransition(current, receipt);

  const paths = layout({ mcHomeDir, codingSessionId, runtimeGeneration });
  ensurePrivateChain(paths.mcHomeDir, paths.generationDirectory, fs);
  const path = join(paths.generationDirectory, `${phase}.json`);
  try {
    publishImmutableJson({ path, value: receipt, trustedRoot: paths.mcHomeDir, fs, random });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId,
      runtimeGeneration,
      fs,
    });
    const winner = raced.kind === 'present' ? raced.receipts[phase] : null;
    if (winner && sameSemanticReceipt(winner, receipt)) {
      return { ok: true, duplicate: true, receipt: winner };
    }
    throw new Error(`managed generation phase ${phase} already has a different receipt`);
  }
  return { ok: true, duplicate: false, receipt };
}

export function inspectManagedGenerationSync({
  mcHomeDir = mcHome(),
  codingSessionId,
  runtimeGeneration,
  fs = syncFs,
} = {}) {
  const session = inspectManagedSessionSync({ mcHomeDir, codingSessionId, fs });
  if (session.kind === 'unknown') return session;
  const generation = session.generations?.find(
    (candidate) => candidate.runtime_generation === runtimeGeneration,
  );
  return generation ? { kind: 'present', ...generation } : { kind: 'absent' };
}

export function inspectManagedSessionSync({
  mcHomeDir = mcHome(),
  codingSessionId,
  fs = syncFs,
} = {}) {
  try {
    assertSessionId(codingSessionId);
  } catch {
    return unknown('invalid-session-id');
  }
  let paths;
  try {
    paths = layout({ mcHomeDir, codingSessionId });
  } catch {
    return unknown('invalid-root');
  }
  const sessionSafety = privateChainSafety(paths.mcHomeDir, paths.sessionDirectory, fs);
  if (!sessionSafety.ok) {
    return sessionSafety.missing
      ? { kind: 'absent', generations: [] }
      : unknown(sessionSafety.reason);
  }
  const claimsSafety = privateChainSafety(paths.mcHomeDir, paths.claimsDirectory, fs);
  if (!claimsSafety.ok) {
    return claimsSafety.missing
      ? { kind: 'absent', generations: [] }
      : unknown(claimsSafety.reason);
  }

  let names;
  try {
    names = fs.readdirSync(paths.claimsDirectory);
  } catch {
    return unknown('unreadable-claims-directory');
  }
  const claimNames = names.filter((name) => !temporaryName(name)).sort();
  if (claimNames.some((name) => !CLAIM_FILE.test(name))) return unknown('unexpected-claim-entry');

  const generations = [];
  const seenRuntimeGenerations = new Set();
  for (let index = 0; index < claimNames.length; index += 1) {
    const name = claimNames[index];
    const sequence = Number(CLAIM_FILE.exec(name)[1]);
    if (sequence !== index + 1) return unknown('non-contiguous-generation-sequence');
    const read = readPrivateJson({
      path: join(paths.claimsDirectory, name),
      trustedRoot: paths.mcHomeDir,
      validate: validateManagedGenerationIntent,
      fs,
    });
    if (read.kind !== 'present') {
      return unknown(`claim-${sequence}-${read.reason || read.kind}`);
    }
    const intent = read.value;
    if (intent.sequence !== sequence || intent.coding_session_id !== codingSessionId) {
      return unknown('generation-claim-mismatch');
    }
    if (seenRuntimeGenerations.has(intent.runtime_generation)) {
      return unknown('duplicate-runtime-generation');
    }
    seenRuntimeGenerations.add(intent.runtime_generation);
    const receiptResult = readGenerationReceipts({ paths, intent, fs });
    if (receiptResult.kind === 'unknown') return receiptResult;
    generations.push({
      sequence,
      coding_session_id: codingSessionId,
      runtime_generation: intent.runtime_generation,
      intent,
      receipts: receiptResult.receipts,
      phase: receiptResult.phase,
      terminal: receiptResult.terminal,
    });
  }
  const nonterminal = generations.filter((generation) => !generation.terminal);
  if (nonterminal.length > 1) return unknown('multiple-nonterminal-generations');
  for (let index = 0; index < generations.length - 1; index += 1) {
    if (!generations[index].terminal) return unknown('generation-after-nonterminal');
  }
  return {
    kind: generations.length ? 'present' : 'absent',
    generations,
    active: nonterminal[0] || null,
  };
}

function readGenerationReceipts({ paths, intent, fs }) {
  const generationDirectory = join(paths.runtimeGenerationsDirectory, intent.runtime_generation);
  const safety = privateChainSafety(paths.mcHomeDir, generationDirectory, fs);
  if (!safety.ok && !safety.missing) return unknown(safety.reason);
  const receipts = {};
  if (safety.ok) {
    let names;
    try {
      names = fs.readdirSync(generationDirectory);
    } catch {
      return unknown('unreadable-generation-directory');
    }
    const receiptNames = names.filter((name) => !temporaryName(name));
    const allowedNames = new Set(MANAGED_RECEIPT_PHASES.map((phase) => `${phase}.json`));
    if (receiptNames.some((name) => !allowedNames.has(name))) {
      return unknown('unexpected-generation-entry');
    }
    for (const phase of MANAGED_RECEIPT_PHASES) {
      const name = `${phase}.json`;
      if (!receiptNames.includes(name)) continue;
      const read = readPrivateJson({
        path: join(generationDirectory, name),
        trustedRoot: paths.mcHomeDir,
        validate: validateManagedGenerationReceipt,
        fs,
      });
      if (read.kind !== 'present') return unknown(`${phase}-${read.reason || read.kind}`);
      const receipt = read.value;
      if (receipt.phase !== phase
        || receipt.coding_session_id !== intent.coding_session_id
        || receipt.runtime_generation !== intent.runtime_generation
        || receipt.intent_digest !== intent.intent_digest) {
        return unknown(`${phase}-binding-mismatch`);
      }
      receipts[phase] = receipt;
    }
  }
  const chain = validateReceiptChain(receipts);
  if (!chain.ok) return unknown(chain.reason);
  if (receipts['provider-artifact']?.data?.tool !== undefined
    && receipts['provider-artifact'].data.tool !== intent.data.tool) {
    return unknown('provider-artifact-tool-mismatch');
  }
  if (receipts['provider-absent']?.data?.tool !== undefined
    && receipts['provider-absent'].data.tool !== intent.data.tool) {
    return unknown('provider-absent-tool-mismatch');
  }
  return {
    kind: 'present',
    receipts,
    phase: chain.phase,
    terminal: TERMINAL_PHASES.has(chain.phase),
  };
}

function validateReceiptChain(receipts) {
  if (receipts.ready && receipts.aborted) return invalid('conflicting-terminal-receipts');
  if (receipts['provider-artifact'] && receipts['provider-absent']) {
    return invalid('conflicting-provider-outcome-receipts');
  }
  if (receipts.aborted && (
    receipts['broker-accepted']
    || receipts.live
    || receipts['provider-artifact']
    || receipts.exited
    || receipts['provider-absent']
    || receipts['custody-persisted']
    || receipts['archive-ready']
    || receipts['domain-cleaned']
    || receipts.ready
  )) return invalid('abort-after-broker-acceptance');
  for (const phase of MANAGED_RECEIPT_PHASES) {
    if (!receipts[phase]) continue;
    const missing = PHASE_PREREQUISITES[phase].find((required) => !receipts[required]);
    if (missing) return invalid(`${phase}-without-${missing}`);
  }
  const providerOutcome = receipts['provider-artifact'] || receipts['provider-absent'];
  if (receipts['custody-persisted'] && !providerOutcome) {
    return invalid('custody-persisted-without-provider-outcome');
  }
  if (receipts['archive-ready'] && !receipts['provider-artifact']) {
    return invalid('archive-ready-without-provider-artifact');
  }
  if (receipts['domain-cleaned']
    && !receipts['archive-ready']
    && !receipts['provider-absent']) {
    return invalid('domain-cleaned-without-provider-outcome');
  }
  if (receipts.ready) {
    const archived = receipts['provider-artifact'] && receipts['archive-ready'];
    if (!archived && !receipts['provider-absent']) {
      return invalid('ready-without-provider-outcome');
    }
    const readyHasProvider = receipts.ready.data.provider_session_id !== null;
    if (readyHasProvider !== !!archived) {
      return invalid('ready-provider-outcome-mismatch');
    }
  }
  const phase = [...MANAGED_RECEIPT_PHASES]
    .reverse()
    .find((candidate) => receipts[candidate]) || 'intent';
  return { ok: true, phase };
}

function validateAppendTransition(current, receipt) {
  if (current.terminal) throw new Error('managed generation is already terminal');
  const projected = { ...current.receipts, [receipt.phase]: receipt };
  const validation = validateReceiptChain(projected);
  if (!validation.ok) {
    throw new Error(`invalid managed generation transition (${validation.reason})`);
  }
}

function validateIntentData(value) {
  if (!plain(value) || !exactKeys(value, ['mode', 'tool', 'resume_provider_session_id'])) {
    throw new TypeError('invalid managed launch intent data');
  }
  if (!['fresh', 'resume'].includes(value.mode)
    || !ID.test(value.tool || '')) {
    throw new TypeError('invalid managed launch intent data');
  }
  if (value.mode === 'fresh' && value.resume_provider_session_id !== null) {
    throw new TypeError('fresh managed launch cannot resume a provider session');
  }
  if (value.mode === 'resume' && !ID.test(value.resume_provider_session_id || '')) {
    throw new TypeError('managed resume requires a provider session');
  }
  return {
    mode: value.mode,
    tool: value.tool,
    resume_provider_session_id: value.resume_provider_session_id,
  };
}

function validatePhaseData(phase, value) {
  if (!plain(value)) throw new TypeError('managed generation receipt data must be an object');
  if (phase === 'domain-ready') {
    exactData(value, ['domain_generation', 'manifest_digest']);
    requireId(value.domain_generation);
    requireDigest(value.manifest_digest);
  } else if (['broker-accepted', 'live'].includes(phase)) {
    exactData(value, []);
  } else if (phase === 'provider-artifact') {
    exactData(value, [
      'provider_session_id',
      'artifact_digest',
      'tool',
      'transcript_path',
      'captured_at',
    ]);
    requireId(value.provider_session_id);
    requireDigest(value.artifact_digest);
    if (!ID.test(value.tool || '')
      || !absolutePath(value.transcript_path)
      || !iso(value.captured_at)) {
      throw new TypeError('invalid managed provider artifact metadata');
    }
  } else if (phase === 'exited') {
    exactData(value, ['exit_code', 'signal']);
    const hasCode = Number.isInteger(value.exit_code) && value.exit_code >= 0 && value.exit_code <= 255;
    const hasSignal = typeof value.signal === 'string' && /^[A-Z0-9]{1,32}$/.test(value.signal);
    if ((hasCode && hasSignal)
      || (!hasCode && value.exit_code !== null)
      || (!hasSignal && value.signal !== null)) {
      throw new TypeError('managed exit accepts at most one exit code or signal');
    }
  } else if (phase === 'provider-absent') {
    exactData(value, ['evidence_digest', 'tool']);
    requireDigest(value.evidence_digest);
    if (!ID.test(value.tool || '')) {
      throw new TypeError('invalid managed provider absence metadata');
    }
  } else if (phase === 'custody-persisted') {
    exactData(value, ['record_digest']);
    requireDigest(value.record_digest);
  } else if (phase === 'archive-ready') {
    exactData(value, ['provider_session_id', 'archive_digest']);
    requireId(value.provider_session_id);
    requireDigest(value.archive_digest);
  } else if (phase === 'domain-cleaned') {
    exactData(value, ['domain_generation']);
    requireId(value.domain_generation);
  } else if (phase === 'ready') {
    exactData(value, ['provider_session_id', 'archive_digest']);
    if (value.provider_session_id === null || value.archive_digest === null) {
      if (value.provider_session_id !== null || value.archive_digest !== null) {
        throw new TypeError('managed ready provider outcome must be paired');
      }
    } else {
      requireId(value.provider_session_id);
      requireDigest(value.archive_digest);
    }
  } else if (phase === 'aborted') {
    const keys = Object.keys(value).sort();
    const expected = value.failure_reason == null
      ? ['reason']
      : ['failure_reason', 'reason'];
    if (keys.length !== expected.length
      || !keys.every((key, index) => key === expected[index])) {
      throw new TypeError('invalid managed abort metadata');
    }
    if (!ABORT_REASONS.has(value.reason)) throw new TypeError('invalid managed abort reason');
    if (value.failure_reason != null
      && !STABLE_FAILURE_REASON.test(value.failure_reason)) {
      throw new TypeError('invalid managed abort failure reason');
    }
  } else {
    throw new TypeError('invalid managed generation phase');
  }
  return { ...value };
}

function layout({ mcHomeDir, codingSessionId, runtimeGeneration = null }) {
  const home = normalizedRoot(mcHomeDir);
  const sessionDirectory = join(home, 'managed-sessions', sessionPart(codingSessionId));
  const runtimeGenerationsDirectory = join(sessionDirectory, 'runtime-generations');
  return {
    mcHomeDir: home,
    sessionDirectory,
    claimsDirectory: join(sessionDirectory, 'generation-claims'),
    runtimeGenerationsDirectory,
    ...(runtimeGeneration
      ? { generationDirectory: join(runtimeGenerationsDirectory, runtimeGeneration) }
      : {}),
  };
}

function publishImmutableJson({ path, value, trustedRoot, fs, random }) {
  ensurePrivateChain(trustedRoot, dirname(path), fs);
  const temporary = join(dirname(path), `.${basename(path)}.${random(16).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(temporary, path);
    fs.unlinkSync(temporary);
    fsyncDirectory(dirname(path), fs);
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function readPrivateJson({ path, trustedRoot, validate, fs }) {
  const chain = privateChainSafety(trustedRoot, dirname(path), fs);
  if (!chain.ok) return chain.missing ? { kind: 'absent' } : unknown(chain.reason);
  let fd = null;
  try {
    const before = fs.lstatSync(path);
    if (!privateRegularFile(before)) return unknown('unsafe-file');
    fd = fs.openSync(path, READ_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!sameNode(before, opened) || !privateRegularFile(opened)) return unknown('unsafe-file');
    const reopened = privateChainSafety(trustedRoot, dirname(path), fs);
    if (!reopened.ok) return unknown(reopened.reason);
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_RECEIPT_BYTES) return unknown('too-large');
    let parsed;
    try {
      parsed = JSON.parse(buffer.subarray(0, count).toString('utf8'));
    } catch {
      return unknown('corrupt');
    }
    const checked = validate(parsed);
    return checked.ok ? { kind: 'present', value: checked.value } : unknown(checked.reason);
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'absent' } : unknown('unreadable');
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

function ensurePrivateChain(trustedRoot, directory, fs) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) throw unsafeJournal(chain.reason);
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (safety.ok) continue;
    if (!safety.missing) throw unsafeJournal(safety.reason);
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    try { fs.chmodSync(path, 0o700); } catch {}
    const created = privateDirectorySafety(path, fs);
    if (!created.ok) throw unsafeJournal(created.reason);
  }
}

function privateChainSafety(trustedRoot, directory, fs) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) return chain;
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (!safety.ok) return safety;
  }
  return { ok: true };
}

function resolveTrustedChain(trustedRoot, directory) {
  if (!isAbsolute(trustedRoot) || !isAbsolute(directory)
    || resolve(trustedRoot) !== trustedRoot
    || resolve(directory) !== directory) return invalid('invalid-directory-chain');
  const rel = relative(trustedRoot, directory);
  if (rel.startsWith('..') || isAbsolute(rel)) return invalid('directory-outside-trusted-root');
  const paths = [trustedRoot];
  if (rel) {
    let current = trustedRoot;
    for (const part of rel.split('/')) {
      current = join(current, part);
      paths.push(current);
    }
  }
  return { ok: true, paths };
}

function privateDirectorySafety(path, fs) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
      return invalid('unsafe-directory');
    }
    if (typeof process.getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) {
      return invalid('unsafe-directory-owner');
    }
    return { ok: true };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, missing: true, reason: 'missing-directory' }
      : invalid('unreadable-directory');
  }
}

function privateRegularFile(stat) {
  return stat.isFile?.()
    && !stat.isSymbolicLink?.()
    && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function'
      || !Number.isInteger(stat.uid)
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

function exactData(value, keys) {
  if (!exactKeys(value, keys)) throw new TypeError('unexpected managed receipt data');
}

function requireId(value) {
  if (!ID.test(value || '')) throw new TypeError('invalid managed receipt id');
}

function requireDigest(value) {
  if (!SHA256.test(value || '')) throw new TypeError('invalid managed receipt digest');
}

function assertExactInputKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('unexpected managed generation input');
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sameSemanticReceipt(left, right) {
  const withoutTime = (value) => {
    const { recorded_at: ignored, ...rest } = value;
    return rest;
  };
  return JSON.stringify(withoutTime(left)) === JSON.stringify(withoutTime(right));
}

function validateIso(value) {
  if (!iso(value)) throw new TypeError('invalid managed generation timestamp');
  return value;
}

function iso(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function absolutePath(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && Buffer.byteLength(value) <= 2048
    && !/[\0-\x1f\x7f]/u.test(value);
}

function normalizedRoot(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('MC_HOME is required');
  return resolve(value);
}

function assertSessionId(value) {
  if (!ID.test(value || '')) throw new TypeError('invalid managed coding session id');
}

function assertRuntimeGeneration(value) {
  if (!UUID_V4.test(value || '')) throw new TypeError('invalid managed runtime generation');
}

function sessionPart(value) {
  const safe = String(value).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 80) || 'session';
  return `${safe}-${sha256(value).slice(0, 12)}`;
}

function namePart(value) {
  const safe = String(value).replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 80) || 'session';
  return `${safe}-${sha256(value).slice(0, 12)}`;
}

function validateSessionName(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 256
    || /[\0-\x1f\x7f]/u.test(value)) {
    throw new TypeError('invalid managed session name');
  }
}

function validateRegistrySessionId(value) {
  if (value == null) return;
  if (typeof value !== 'string' || !/^mcs_[a-f0-9]{24}$/u.test(value)) {
    throw new TypeError('invalid registry session id');
  }
}

function claimFile(sequence) {
  return `${String(sequence).padStart(12, '0')}.json`;
}

function temporaryName(name) {
  return /^\..+\.tmp$/.test(name);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function invalid(reason) {
  return { ok: false, reason };
}

function unknown(reason) {
  return { kind: 'unknown', reason };
}

function unsafeJournal(reason) {
  return new Error(`managed generation journal is unsafe (${reason})`);
}

const syncFs = {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
};
