import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  CONVERSATION_ID_RE,
  GENERATION_ID_RE,
  WORKSPACE_ID_RE,
} from './session-record-ids.js';
import { MC_SESSION_ID_RE } from './session-home-schema.js';

export const SESSION_CONVERSATION_SCHEMA = 'mc-session-conversation';
export const SESSION_GENERATION_INTENT_SCHEMA = 'mc-session-generation-intent';
export const SESSION_GENERATION_RECEIPT_SCHEMA = 'mc-session-generation-receipt';
export const SESSION_RUNTIME_VERSION = 1;

export const RUNTIME_ACTIONS = Object.freeze(['start', 'resume', 'replace', 'switch']);
export const RUNTIME_RECEIPT_PHASES = Object.freeze([
  'accepted',
  'live',
  'exited',
  'completed',
  'imported',
  'failed',
  'aborted',
]);

const ACTIONS = new Set(RUNTIME_ACTIONS);
const RECEIPT_PHASES = new Set(RUNTIME_RECEIPT_PHASES);
const TERMINAL_PHASES = new Set(['completed', 'imported', 'failed', 'aborted']);
const TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const CONVERSATION_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SIGNAL_RE = /^[A-Z][A-Z0-9]{0,31}$/u;
const REASON_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/u;

const INTENT_KEYS = Object.freeze([
  'schema',
  'version',
  'generation_id',
  'mc_session_id',
  'sequence',
  'action',
  'tool',
  'workspace_id',
  'launch_cwd',
  'resume_conversation_id',
  'previous_conversation_id',
  'previous_generation_id',
  'replacement_reason',
  'handoff_sha256',
  'recorded_at',
  'intent_sha256',
]);

export function buildGenerationIntent({
  generationId,
  mcSessionId,
  sequence,
  action,
  tool,
  workspaceId = null,
  launchCwd,
  resumeConversationId = null,
  previousConversationId = null,
  previousGenerationId = null,
  replacementReason = null,
  handoffSha256 = null,
  recordedAt,
}) {
  const unsigned = {
    schema: SESSION_GENERATION_INTENT_SCHEMA,
    version: SESSION_RUNTIME_VERSION,
    generation_id: generationId,
    mc_session_id: mcSessionId,
    sequence,
    action,
    tool,
    workspace_id: workspaceId,
    launch_cwd: launchCwd,
    resume_conversation_id: resumeConversationId,
    previous_conversation_id: previousConversationId,
    previous_generation_id: previousGenerationId,
    replacement_reason: replacementReason,
    handoff_sha256: handoffSha256,
    recorded_at: recordedAt,
  };
  const intent = { ...unsigned, intent_sha256: sha256(unsigned) };
  assertRuntimeValid(validateGenerationIntent(intent));
  return intent;
}

export function buildConversationRecord({
  conversationId,
  mcSessionId,
  tool,
  handle,
  originGenerationId,
  relation,
  recordedAt,
}) {
  const record = {
    schema: SESSION_CONVERSATION_SCHEMA,
    version: SESSION_RUNTIME_VERSION,
    conversation_id: conversationId,
    mc_session_id: mcSessionId,
    tool,
    handle,
    origin_generation_id: originGenerationId,
    relation: structuredClone(relation),
    recorded_at: recordedAt,
  };
  assertRuntimeValid(validateConversationRecord(record));
  return record;
}

export function buildGenerationReceipt({
  ordinal,
  phase,
  generationId,
  mcSessionId,
  intentSha256,
  recordedAt,
  data = {},
}) {
  const receipt = {
    schema: SESSION_GENERATION_RECEIPT_SCHEMA,
    version: SESSION_RUNTIME_VERSION,
    ordinal,
    phase,
    generation_id: generationId,
    mc_session_id: mcSessionId,
    intent_sha256: intentSha256,
    recorded_at: recordedAt,
    data: structuredClone(data),
  };
  assertRuntimeValid(validateGenerationReceipt(receipt));
  return receipt;
}

export function relationForIntent(intent) {
  if (intent.action === 'start') {
    return {
      kind: 'fresh',
      previous_conversation_id: null,
      previous_generation_id: null,
      handoff_sha256: null,
    };
  }
  if (intent.action === 'replace') {
    return {
      kind: 'replace',
      previous_conversation_id: intent.previous_conversation_id,
      previous_generation_id: intent.previous_generation_id,
      handoff_sha256: null,
    };
  }
  if (intent.action === 'switch') {
    return {
      kind: 'switch',
      previous_conversation_id: intent.previous_conversation_id,
      previous_generation_id: null,
      handoff_sha256: intent.handoff_sha256,
    };
  }
  throw sessionRuntimeError('resume-cannot-create-conversation');
}

export function generationIntentDigest(intent) {
  const unsigned = {};
  for (const key of INTENT_KEYS) {
    if (key !== 'intent_sha256') unsigned[key] = intent[key];
  }
  return sha256(unsigned);
}

export function validateGenerationIntent(value) {
  if (!plain(value) || !exactKeys(value, INTENT_KEYS)) {
    return invalid('generation-intent-unexpected-keys');
  }
  if (value.schema !== SESSION_GENERATION_INTENT_SCHEMA
    || value.version !== SESSION_RUNTIME_VERSION
    || !GENERATION_ID_RE.test(value.generation_id || '')
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !positiveInteger(value.sequence)
    || !ACTIONS.has(value.action)
    || !validTool(value.tool)
    || !nullableMatch(value.workspace_id, WORKSPACE_ID_RE)
    || !validAbsolutePath(value.launch_cwd)
    || !nullableMatch(value.resume_conversation_id, CONVERSATION_ID_RE)
    || !nullableMatch(value.previous_conversation_id, CONVERSATION_ID_RE)
    || !nullableMatch(value.previous_generation_id, GENERATION_ID_RE)
    || !validOptionalReason(value.replacement_reason)
    || !nullableMatch(value.handoff_sha256, SHA256_RE)
    || !iso(value.recorded_at)
    || !SHA256_RE.test(value.intent_sha256 || '')) {
    return invalid('generation-intent-invalid-fields');
  }
  if (!validIntentRelationship(value)) return invalid('generation-intent-invalid-relationship');
  if (generationIntentDigest(value) !== value.intent_sha256) {
    return invalid('generation-intent-digest-mismatch');
  }
  return validCopy(value);
}

export function validateConversationRecord(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'conversation_id',
    'mc_session_id',
    'tool',
    'handle',
    'origin_generation_id',
    'relation',
    'recorded_at',
  ])) return invalid('conversation-unexpected-keys');
  if (value.schema !== SESSION_CONVERSATION_SCHEMA
    || value.version !== SESSION_RUNTIME_VERSION
    || !CONVERSATION_ID_RE.test(value.conversation_id || '')
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !validTool(value.tool)
    || !CONVERSATION_HANDLE_RE.test(value.handle || '')
    || !GENERATION_ID_RE.test(value.origin_generation_id || '')
    || !iso(value.recorded_at)
    || !validRelation(value.relation)) return invalid('conversation-invalid-fields');
  return validCopy(value);
}

export function validateGenerationReceipt(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema',
    'version',
    'ordinal',
    'phase',
    'generation_id',
    'mc_session_id',
    'intent_sha256',
    'recorded_at',
    'data',
  ])) return invalid('generation-receipt-unexpected-keys');
  if (value.schema !== SESSION_GENERATION_RECEIPT_SCHEMA
    || value.version !== SESSION_RUNTIME_VERSION
    || !positiveInteger(value.ordinal)
    || !RECEIPT_PHASES.has(value.phase)
    || !GENERATION_ID_RE.test(value.generation_id || '')
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !SHA256_RE.test(value.intent_sha256 || '')
    || !iso(value.recorded_at)
    || !validReceiptData(value.phase, value.data)) {
    return invalid('generation-receipt-invalid-fields');
  }
  return validCopy(value);
}

export function validateReceiptHistory(intent, receipts) {
  let phase = 'planned';
  let previousTime = Date.parse(intent.recorded_at);
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const checked = validateGenerationReceipt(receipt);
    if (!checked.ok) return checked;
    if (receipt.ordinal !== index + 1
      || receipt.generation_id !== intent.generation_id
      || receipt.mc_session_id !== intent.mc_session_id
      || receipt.intent_sha256 !== intent.intent_sha256
      || Date.parse(receipt.recorded_at) < previousTime) {
      return invalid('generation-receipt-binding-mismatch');
    }
    if (!validPhaseTransition(phase, receipt.phase)) {
      return invalid('generation-receipt-invalid-transition');
    }
    phase = receipt.phase;
    previousTime = Date.parse(receipt.recorded_at);
  }
  return { ok: true, value: { phase } };
}

export function runtimeProjectionState(phase) {
  if (phase === 'planned' || phase === 'accepted') return 'starting';
  if (phase === 'live') return 'running';
  if (phase === 'exited' || phase === 'completed' || phase === 'imported') return 'exited';
  if (phase === 'failed' || phase === 'aborted') return 'failed';
  throw sessionRuntimeError('unknown-generation-phase');
}

export function isTerminalGenerationPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

export function assertTool(value) {
  if (!validTool(value)) throw new TypeError('invalid tool');
}

export function assertConversationHandle(value) {
  if (!CONVERSATION_HANDLE_RE.test(value || '')) throw new TypeError('invalid conversation handle');
}

export function assertSha256(value, label = 'sha256') {
  if (!SHA256_RE.test(value || '')) throw new TypeError(`invalid ${label}`);
}

export function assertRuntimeValid(result) {
  if (!result?.ok) throw sessionRuntimeError(result?.reason || 'invalid-runtime-state');
}

export function sessionRuntimeError(reason) {
  const error = new Error(`mc session runtime error (${reason})`);
  error.code = 'MC_SESSION_RUNTIME_ERROR';
  error.reason = reason;
  return error;
}

function validIntentRelationship(value) {
  const emptyCommon = value.resume_conversation_id === null
    && value.previous_conversation_id === null
    && value.previous_generation_id === null
    && value.replacement_reason === null
    && value.handoff_sha256 === null;
  if (value.action === 'start') return emptyCommon;
  if (value.action === 'resume') {
    return value.resume_conversation_id !== null
      && value.previous_conversation_id === null
      && value.previous_generation_id === null
      && value.replacement_reason === null
      && value.handoff_sha256 === null;
  }
  if (value.action === 'replace') {
    return value.resume_conversation_id === null
      && (value.previous_conversation_id === null) !== (value.previous_generation_id === null)
      && value.replacement_reason !== null
      && value.handoff_sha256 === null;
  }
  return value.action === 'switch'
    && value.resume_conversation_id === null
    && value.previous_conversation_id !== null
    && value.previous_generation_id === null
    && value.replacement_reason === null
    && value.handoff_sha256 !== null;
}

function validRelation(value) {
  if (!plain(value) || !exactKeys(value, [
    'kind',
    'previous_conversation_id',
    'previous_generation_id',
    'handoff_sha256',
  ])) return false;
  if (!nullableMatch(value.previous_conversation_id, CONVERSATION_ID_RE)
    || !nullableMatch(value.previous_generation_id, GENERATION_ID_RE)
    || !nullableMatch(value.handoff_sha256, SHA256_RE)) return false;
  if (value.kind === 'fresh') {
    return value.previous_conversation_id === null
      && value.previous_generation_id === null
      && value.handoff_sha256 === null;
  }
  if (value.kind === 'replace') {
    return (value.previous_conversation_id === null) !== (value.previous_generation_id === null)
      && value.handoff_sha256 === null;
  }
  return value.kind === 'switch'
    && value.previous_conversation_id !== null
    && value.previous_generation_id === null
    && value.handoff_sha256 !== null;
}

function validReceiptData(phase, data) {
  if (!plain(data)) return false;
  if (phase === 'accepted' || phase === 'live') return exactKeys(data, []);
  if (phase === 'exited') {
    return exactKeys(data, ['exit_code', 'signal'])
      && (data.exit_code === null || (Number.isSafeInteger(data.exit_code) && data.exit_code >= 0))
      && (data.signal === null || SIGNAL_RE.test(data.signal || ''))
      && (data.exit_code !== null || data.signal !== null);
  }
  if (phase === 'completed') {
    return exactKeys(data, ['conversation_id'])
      && CONVERSATION_ID_RE.test(data.conversation_id || '');
  }
  if (phase === 'imported') {
    return exactKeys(data, ['conversation_id', 'legacy_evidence_sha256'])
      && CONVERSATION_ID_RE.test(data.conversation_id || '')
      && SHA256_RE.test(data.legacy_evidence_sha256 || '');
  }
  return exactKeys(data, ['reason']) && validReason(data.reason);
}

function validPhaseTransition(from, to) {
  if (from === 'planned') {
    return to === 'accepted' || to === 'imported' || to === 'failed' || to === 'aborted';
  }
  if (from === 'accepted') return to === 'live' || to === 'failed';
  if (from === 'live') return to === 'exited' || to === 'failed';
  if (from === 'exited') return to === 'completed' || to === 'failed';
  return false;
}

function validTool(value) {
  return typeof value === 'string' && TOOL_RE.test(value);
}

function validAbsolutePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\u0000')
    && isAbsolute(value)
    && resolve(value) === value;
}

function validOptionalReason(value) {
  return value === null || validReason(value);
}

function validReason(value) {
  return typeof value === 'string' && REASON_CODE_RE.test(value);
}

function nullableMatch(value, pattern) {
  return value === null || (typeof value === 'string' && pattern.test(value));
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function iso(value) {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function positiveInteger(value) {
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
