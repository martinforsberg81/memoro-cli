import { detectOpenQuestion } from './open-question.js';
import { observeWorktree } from './git.js';

export const SESSION_PROJECTION_CONTRACT_VERSION = 'mc-session-projection-v1';
export const SESSION_PROJECTOR_VERSION = 'mc-session-projector-v1';
export const SESSION_ACTIVITY_FRESH_SECONDS = 150;

const STATUS_REASONS = Object.freeze({
  active: new Set(['turn_started', 'tool_activity', 'recent_output', 'runtime_starting']),
  needs_attention: new Set([
    'awaiting_reply',
    'review_requested',
    'changes_require_review',
    'tests_failed',
    'runtime_failed',
    'repair_required',
  ]),
  resting: new Set([
    'idle_without_conclusion',
    'sleeping_without_conclusion',
    'stopped_without_conclusion',
    'stale_projection',
    'unknown_state',
  ]),
  completed: new Set(['agent_concluded']),
});

const BASIS = new Set(['structured_event', 'deterministic_final_turn', 'runtime_fallback']);
const LIFECYCLES = new Set(['starting', 'live', 'sleeping', 'stopped', 'failed', 'unreachable', 'unknown']);
const SAFETY_VERDICTS = new Set([
  'SAFE_TO_END',
  'IS_ACTIVE_NOW',
  'NEEDS_REVIEW',
  'HAS_UNMERGED_WORK',
  'IS_SQUASH_PHANTOM',
]);
const CONTRADICTORY_SAFETY = new Set(['NEEDS_REVIEW', 'HAS_UNMERGED_WORK']);
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PROJECTION_KEYS = new Set([
  'contract_version',
  'status',
  'reason_code',
  'observed_at',
  'classifier_version',
  'classification_basis',
  'runtime',
  'git',
]);
const RUNTIME_KEYS = new Set(['lifecycle', 'observed_at']);
const GIT_KEYS = new Set([
  'current_branch',
  'dirty_files',
  'ahead',
  'behind',
  'safety_verdict',
  'observed_at',
]);
const STRUCTURED_EVENT_TRANSITIONS = Object.freeze({
  user_input: ['active', 'turn_started'],
  input_received: ['active', 'turn_started'],
  turn_started: ['active', 'turn_started'],
  tool_activity: ['active', 'tool_activity'],
  recent_output: ['active', 'recent_output'],
  assistant_question: ['needs_attention', 'awaiting_reply'],
  awaiting_reply: ['needs_attention', 'awaiting_reply'],
  review_requested: ['needs_attention', 'review_requested'],
  tests_failed: ['needs_attention', 'tests_failed'],
  runtime_failed: ['needs_attention', 'runtime_failed'],
  repair_required: ['needs_attention', 'repair_required'],
  agent_concluded: ['completed', 'agent_concluded'],
});

export function projectRuntimeSession({
  session = {},
  output = '',
  now = Date.now(),
  git = null,
} = {}) {
  const existing = sanitizeSessionProjection(session?.session_projection);
  const nowMs = timestampMs(now, Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const runtime = runtimeFacts(session, nowIso);
  const normalizedGit = normalizeGitFacts(git || gitFactsFromSession(session), nowIso);
  const cleanOutput = cleanSessionOutput(output);
  const inferredRuntimeActivityAt = idleActivityTimestamp(session, nowMs);
  const latestAt = latestTimestamp([
    session?.last_input_at,
    session?.lastInputAt,
    session?.last_output_at,
    session?.lastOutputAt,
    session?.started_at,
    session?.startedAt,
    inferredRuntimeActivityAt,
  ]) || nowIso;
  const newerActivityAt = latestTimestamp([
    session?.last_input_at,
    session?.lastInputAt,
    session?.last_output_at,
    session?.lastOutputAt,
    inferredRuntimeActivityAt,
  ]);
  const existingIsCurrent = existing
    && !isLater(newerActivityAt, existing.observed_at)
    && runtime.lifecycle !== 'failed'
    && !(runtime.lifecycle === 'live' && looksLikeLiveProgress(cleanOutput))
    && (existing.status !== 'active' || isFresh(existing.observed_at, nowMs));
  if (existingIsCurrent) return existing;

  if (runtime.lifecycle === 'failed') {
    return projection({
      status: 'needs_attention',
      reasonCode: session?.needs_repair === true ? 'repair_required' : 'runtime_failed',
      observedAt: exitTimestamp(session) || latestAt,
      basis: 'structured_event',
      runtime,
      git: normalizedGit,
    });
  }

  if (looksLikeFailedTests(cleanOutput)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'tests_failed',
      observedAt: lastOutputTimestamp(session) || latestAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }
  if (detectOpenQuestion(cleanOutput) || looksLikeRecommendedReply(cleanOutput)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'awaiting_reply',
      observedAt: lastOutputTimestamp(session) || latestAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }
  if (looksLikeReviewRequest(cleanOutput)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'review_requested',
      observedAt: lastOutputTimestamp(session) || latestAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }

  if (runtime.lifecycle === 'sleeping' || runtime.lifecycle === 'stopped') {
    return withGitContradiction(projection({
      status: 'resting',
      reasonCode: runtime.lifecycle === 'sleeping'
        ? 'sleeping_without_conclusion'
        : 'stopped_without_conclusion',
      observedAt: exitTimestamp(session) || latestAt,
      basis: 'runtime_fallback',
      runtime,
      git: normalizedGit,
    }));
  }

  const lastInput = latestTimestamp([session?.last_input_at, session?.lastInputAt]);
  const lastOutput = latestTimestamp([lastOutputTimestamp(session), inferredRuntimeActivityAt]);
  const startedAt = latestTimestamp([session?.started_at, session?.startedAt]);
  if (!lastOutput && runtime.lifecycle === 'live' && looksLikeLiveProgress(cleanOutput)) {
    return projection({
      status: 'active',
      reasonCode: 'tool_activity',
      observedAt: nowIso,
      basis: 'structured_event',
      runtime,
      git: normalizedGit,
    });
  }
  if (isFresh(lastInput, nowMs)) {
    return projection({
      status: 'active',
      reasonCode: 'turn_started',
      observedAt: lastInput,
      basis: 'structured_event',
      runtime,
      git: normalizedGit,
    });
  }
  if (isFresh(lastOutput, nowMs)) {
    return projection({
      status: 'active',
      reasonCode: looksLikeToolActivity(cleanOutput) ? 'tool_activity' : 'recent_output',
      observedAt: lastOutput,
      basis: looksLikeToolActivity(cleanOutput) ? 'structured_event' : 'runtime_fallback',
      runtime,
      git: normalizedGit,
    });
  }
  if (isFresh(startedAt, nowMs)) {
    return projection({
      status: 'active',
      reasonCode: 'runtime_starting',
      observedAt: startedAt,
      basis: 'runtime_fallback',
      runtime: { ...runtime, lifecycle: 'starting' },
      git: normalizedGit,
    });
  }

  return withGitContradiction(projection({
    status: 'resting',
    reasonCode: 'idle_without_conclusion',
    observedAt: latestAt,
    basis: 'runtime_fallback',
    runtime,
    git: normalizedGit,
  }));
}

export function projectTranscriptSession({
  parsed = {},
  events = null,
  now = Date.now(),
  git = null,
  runtimeLifecycle = 'stopped',
} = {}) {
  const nowMs = timestampMs(now, Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const normalizedGit = normalizeGitFacts(git, nowIso);
  const runtime = {
    lifecycle: LIFECYCLES.has(runtimeLifecycle) ? runtimeLifecycle : 'unknown',
    observed_at: nowIso,
  };
  const structured = projectStructuredEvents({
    events: events || parsed?.events,
    now: nowMs,
    git: normalizedGit,
    runtime,
  });
  if (structured) return structured;

  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const activities = Array.isArray(parsed?.activities) ? parsed.activities : [];
  const lastUser = lastByRole(messages, 'user');
  const lastAssistant = lastByRole(messages, 'assistant');
  const lastActivityAt = latestTimestamp(activities.map((activity) => activity?.at));
  const assistantAt = timestampOrFallback(lastAssistant?.at, parsed?.endedAt, nowIso);
  const userAt = timestampOrFallback(lastUser?.at, null, null);

  if (!lastAssistant || isLater(userAt, assistantAt) || isLater(lastActivityAt, assistantAt)) {
    if (runtime.lifecycle === 'live' && (isTimestamp(userAt) || isTimestamp(lastActivityAt))) {
      const toolIsLatest = isLater(lastActivityAt, userAt);
      return projection({
        status: 'active',
        reasonCode: toolIsLatest ? 'tool_activity' : 'turn_started',
        observedAt: latestTimestamp([lastActivityAt, userAt]) || nowIso,
        basis: 'structured_event',
        runtime,
        git: normalizedGit,
      });
    }
    return withGitContradiction(projection({
      status: 'resting',
      reasonCode: runtime.lifecycle === 'stopped'
        ? 'stopped_without_conclusion'
        : 'idle_without_conclusion',
      observedAt: latestTimestamp([lastActivityAt, userAt, parsed?.endedAt]) || nowIso,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    }));
  }

  const finalText = boundedFinalText(lastAssistant.content);
  if (looksLikeFailedTests(finalText)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'tests_failed',
      observedAt: assistantAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }
  if (detectOpenQuestion(finalText) || looksLikeRecommendedReply(finalText)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'awaiting_reply',
      observedAt: assistantAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }
  if (looksLikeReviewRequest(finalText)) {
    return projection({
      status: 'needs_attention',
      reasonCode: 'review_requested',
      observedAt: assistantAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    });
  }
  if (looksLikeCompletionConclusion(finalText)) {
    return withGitContradiction(projection({
      status: 'completed',
      reasonCode: 'agent_concluded',
      observedAt: assistantAt,
      basis: 'deterministic_final_turn',
      runtime,
      git: normalizedGit,
    }));
  }

  return withGitContradiction(projection({
    status: 'resting',
    reasonCode: runtime.lifecycle === 'stopped'
      ? 'stopped_without_conclusion'
      : 'idle_without_conclusion',
    observedAt: assistantAt,
    basis: 'deterministic_final_turn',
    runtime,
    git: normalizedGit,
  }));
}

export function projectStructuredEvents({ events = [], now = Date.now(), git = null, runtime = null } = {}) {
  const normalized = (Array.isArray(events) ? events : [])
    .map((event, index) => normalizeStructuredEvent(event, index))
    .filter(Boolean)
    .sort(compareStructuredEvents);
  if (!normalized.length) return null;

  const lastConclusion = [...normalized].reverse().find((event) => event.type === 'agent_concluded');
  const lastContradiction = [...normalized].reverse().find((event) => [
    'user_input',
    'input_received',
    'turn_started',
    'tool_activity',
    'assistant_question',
    'awaiting_reply',
    'review_requested',
    'tests_failed',
    'runtime_failed',
    'repair_required',
  ].includes(event.type));
  const selected = lastConclusion && (!lastContradiction || compareStructuredEvents(lastConclusion, lastContradiction) > 0)
    ? lastConclusion
    : lastContradiction || normalized.at(-1);
  const transition = STRUCTURED_EVENT_TRANSITIONS[selected.type];
  if (!transition) return null;

  const nowMs = timestampMs(now, Date.now());
  const nowIso = new Date(nowMs).toISOString();
  return withGitContradiction(projection({
    status: transition[0],
    reasonCode: transition[1],
    observedAt: selected.at || nowIso,
    basis: 'structured_event',
    runtime: runtime || { lifecycle: 'unknown', observed_at: nowIso },
    git: normalizeGitFacts(git, nowIso),
  }));
}

export class SessionProjectionTracker {
  constructor({
    cwd = null,
    observeGit = observeWorktree,
    now = () => Date.now(),
  } = {}) {
    this.cwd = cwd;
    this.observeGit = observeGit;
    this.now = now;
    this.cachedGit = null;
    this.lastTransition = null;
  }

  runtime(input = {}) {
    const now = input.now ?? this.now();
    const provisional = projectRuntimeSession({ ...input, now, git: null });
    const transition = `${provisional.status}:${provisional.reason_code}`;
    const git = input.git || this._readGit({ refresh: transition !== this.lastTransition });
    this.lastTransition = transition;
    return projectRuntimeSession({ ...input, now, git });
  }

  transcript(input = {}) {
    const now = input.now ?? this.now();
    const provisional = projectTranscriptSession({ ...input, now, git: null });
    const transition = `${provisional.status}:${provisional.reason_code}`;
    const git = input.git || this._readGit({
      refresh: input.terminal === true || transition !== this.lastTransition,
    });
    const projected = projectTranscriptSession({ ...input, now, git });
    this.lastTransition = transition;
    return projected;
  }

  _readGit({ refresh = false } = {}) {
    if (!refresh && this.cachedGit) return this.cachedGit;
    if (!this.cwd || typeof this.observeGit !== 'function') return this.cachedGit;
    try {
      const observed = this.observeGit(this.cwd);
      if (observed?.ok) this.cachedGit = observed;
    } catch {}
    return this.cachedGit;
  }
}

export function resolveSessionSourceIdentity({
  sourceId = null,
  sourceKind = null,
  sourceName = null,
  cloudSessionId = null,
  machineId = null,
  env = process.env,
} = {}) {
  const cloudId = stringOrNull(cloudSessionId) || stringOrNull(env?.MC_CLOUD_SESSION_ID);
  const fallbackMachine = safeSourcePart(machineId || 'unknown');
  const preferredId = stringOrNull(sourceId) || stringOrNull(env?.MC_SOURCE_ID);
  const resolvedId = preferredId && SOURCE_ID_RE.test(preferredId)
    ? preferredId
    : cloudId
      ? `cloud:${safeSourcePart(cloudId)}`
      : `local:${fallbackMachine}`;
  const kind = stringOrNull(sourceKind)
    || stringOrNull(env?.MC_SOURCE_KIND)
    || (cloudId ? 'cloud' : 'local');
  return {
    source_id: resolvedId.slice(0, 128),
    source_kind: kind.slice(0, 64),
    source_name: (stringOrNull(sourceName) || stringOrNull(env?.MC_SOURCE_NAME) || stringOrNull(machineId) || resolvedId).slice(0, 128),
    cloud_session_id: cloudId?.slice(0, 128) || null,
  };
}

export function sanitizeSessionProjection(input) {
  if (!isObject(input) || unknownKeys(input, PROJECTION_KEYS).length) return null;
  if (input.contract_version !== SESSION_PROJECTION_CONTRACT_VERSION) return null;
  if (!STATUS_REASONS[input.status]?.has(input.reason_code)) return null;
  if (!BASIS.has(input.classification_basis)) return null;
  if (input.status === 'completed' && input.classification_basis === 'runtime_fallback') return null;
  if (!isTimestamp(input.observed_at)) return null;
  if (!boundedString(input.classifier_version, 128)) return null;
  const runtime = normalizeRuntime(input.runtime);
  if (input.runtime != null && !runtime) return null;
  const git = normalizeGitFacts(input.git, input.observed_at, { strict: true });
  if (input.git != null && !git) return null;
  return {
    contract_version: SESSION_PROJECTION_CONTRACT_VERSION,
    status: input.status,
    reason_code: input.reason_code,
    observed_at: input.observed_at,
    classifier_version: input.classifier_version,
    classification_basis: input.classification_basis,
    runtime,
    git,
  };
}

export function sessionWorkStatusCounts(sessions = []) {
  const counts = { needs_attention: 0, active: 0, resting: 0, completed: 0 };
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const status = session?.work_status?.status;
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  }
  return counts;
}

export function cleanSessionOutput(value) {
  return String(value || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[(?:\d{1,3};)*\d{1,3}[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(stripCodexRedrawNoise)
    .filter((line) => line.trim() || !isCodexRedrawNoise(line))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function projection({ status, reasonCode, observedAt, basis, runtime, git }) {
  return {
    contract_version: SESSION_PROJECTION_CONTRACT_VERSION,
    status,
    reason_code: reasonCode,
    observed_at: observedAt,
    classifier_version: SESSION_PROJECTOR_VERSION,
    classification_basis: basis,
    runtime: normalizeRuntime(runtime),
    git: normalizeGitFacts(git, observedAt),
  };
}

function withGitContradiction(projected) {
  if (!projected || projected.status === 'active') return projected;
  if (!gitRequiresReview(projected.git)) return projected;
  return {
    ...projected,
    status: 'needs_attention',
    reason_code: 'changes_require_review',
  };
}

function gitRequiresReview(git) {
  return CONTRADICTORY_SAFETY.has(git?.safety_verdict)
    || positiveInteger(git?.dirty_files) > 0
    || positiveInteger(git?.ahead) > 0;
}

function runtimeFacts(session, observedAt) {
  const state = String(
    session?.runtime_status?.lifecycle_state
      || session?.runtime_state
      || session?.lifecycle_state
      || session?.session_state
      || session?.state
      || '',
  ).toLowerCase();
  const exit = isObject(session?.exit) ? session.exit : null;
  const failed = session?.runtime_status?.failed === true
    || session?.runtime_status?.needs_repair === true
    || session?.needs_repair === true
    || ['failed', 'error'].includes(state)
    || (exit && Number.isInteger(exit.code) && exit.code !== 0);
  let lifecycle = 'unknown';
  if (failed) lifecycle = 'failed';
  else if (['starting', 'booting', 'waking', 'broker_connecting'].includes(state)) lifecycle = 'starting';
  else if (['sleeping', 'asleep'].includes(state)) lifecycle = 'sleeping';
  else if (exit || ['dead', 'stopped', 'succeeded'].includes(state)) lifecycle = 'stopped';
  else if (['live', 'active', 'running'].includes(state) || session?.attachable === true) lifecycle = 'live';
  else if (state === 'unreachable') lifecycle = 'unreachable';
  return { lifecycle, observed_at: observedAt };
}

function gitFactsFromSession(session) {
  if (!isObject(session)) return null;
  return {
    current_branch: session.current_branch || session.branch || null,
    dirty_files: session.dirty_files ?? session.observed_dirty_files ?? null,
    ahead: session.ahead ?? session.observed_ahead ?? null,
    behind: session.behind ?? session.observed_behind ?? null,
    safety_verdict: session.safety_verdict || null,
    observed_at: session.git_observed_at || session.last_observed_at || null,
  };
}

function normalizeGitFacts(input, fallbackObservedAt, { strict = false } = {}) {
  if (input == null) return null;
  if (!isObject(input) || (strict && unknownKeys(input, GIT_KEYS).length)) return null;
  const observedAt = isTimestamp(input.observed_at) ? input.observed_at : fallbackObservedAt;
  if (!isTimestamp(observedAt)) return null;
  const dirtyFiles = nonNegativeIntegerOrNull(input.dirty_files);
  const ahead = nonNegativeIntegerOrNull(input.ahead);
  const behind = nonNegativeIntegerOrNull(input.behind);
  if (strict && [input.dirty_files, input.ahead, input.behind].some((value, index) => (
    value != null && [dirtyFiles, ahead, behind][index] == null
  ))) return null;
  let verdict = stringOrNull(input.safety_verdict);
  if (strict && verdict && !SAFETY_VERDICTS.has(verdict)) return null;
  if (!SAFETY_VERDICTS.has(verdict)) {
    verdict = dirtyFiles > 0
      ? 'NEEDS_REVIEW'
      : ahead > 0
        ? 'HAS_UNMERGED_WORK'
        : dirtyFiles === 0 && ahead === 0
          ? 'SAFE_TO_END'
          : null;
  }
  return {
    current_branch: boundedNullableString(input.current_branch, 256),
    dirty_files: dirtyFiles,
    ahead,
    behind,
    safety_verdict: verdict,
    observed_at: observedAt,
  };
}

function normalizeRuntime(input) {
  if (input == null) return null;
  if (!isObject(input) || unknownKeys(input, RUNTIME_KEYS).length) return null;
  if (!LIFECYCLES.has(input.lifecycle) || !isTimestamp(input.observed_at)) return null;
  return { lifecycle: input.lifecycle, observed_at: input.observed_at };
}

function normalizeStructuredEvent(event, index) {
  if (!isObject(event) || !STRUCTURED_EVENT_TRANSITIONS[event.type]) return null;
  const at = isTimestamp(event.at || event.observed_at) ? (event.at || event.observed_at) : null;
  return { type: event.type, at, index };
}

function compareStructuredEvents(a, b) {
  const aMs = timestampMs(a?.at, 0);
  const bMs = timestampMs(b?.at, 0);
  return aMs - bMs || (a?.index ?? 0) - (b?.index ?? 0);
}

function looksLikeToolActivity(text) {
  return /\bWorking\(|\btool\s*(?:call|activity)|\bRunning\s+(?:tests?|command)|\bReading\s+|\bEditing\s+/i.test(text);
}

function looksLikeLiveProgress(text) {
  return /\bWorking\(\s*\d+(?:\.\d+)?s\b/i.test(text);
}

function looksLikeFailedTests(text) {
  const tail = boundedFinalText(text);
  return /\b(?:tests?\s+(?:failed|failing)|failing\s+tests?|testerna\s+(?:misslyckades|felar)|[1-9]\d*\s+tests?\s+failed)\b/i.test(tail);
}

function looksLikeRecommendedReply(text) {
  const tail = boundedFinalText(text);
  return /(?:^|\n)\s*(?:recommended\s+reply|rekommenderat\s+svar)\s*:/i.test(tail);
}

function looksLikeReviewRequest(text) {
  const tail = boundedFinalText(text);
  return /\b(?:please\s+review|ready\s+for\s+review|needs?\s+review|review\s+requested|recommended\s+plan|revised\s+plan|i\s+recommend|redo\s+för\s+granskning|redo\s+för\s+review|vänligen\s+granska|behöver\s+granskas|min\s+rekommendation|reviderade\s+plan)\b/i.test(tail);
}

function looksLikeCompletionConclusion(text) {
  const tail = boundedFinalText(text);
  if (!tail) return false;
  if (looksLikeIncompleteConclusion(tail)) return false;
  const explicit = /\b(?:done|completed|finished|implemented|fixed|resolved|shipped|klart|färdigt|slutfört|implementerat|åtgärdat|löst)\b/i;
  const conclusionSection = /(?:^|\n)\s*(?:result|results|conclusion|summary|slutsats|resultat|sammanfattning)\s*[:\n]/i;
  const verified = /\b(?:all\s+tests?\s+pass(?:ed|ing)?|tests?\s+pass(?:ed|ing)?|samtliga\s+tester\s+(?:är\s+)?gröna|alla\s+tester\s+(?:passerar|är\s+gröna))\b/i;
  return explicit.test(tail) || conclusionSection.test(tail) || verified.test(tail);
}

function looksLikeIncompleteConclusion(text) {
  return /\b(?:not|isn't|isnt|aren't|arent|haven't|havent|hasn't|hasnt|didn't|didnt|doesn't|doesnt|inte|ej)\b[^.\n]{0,48}\b(?:done|complete(?:d)?|finished|implemented|fixed|resolved|shipped|pass(?:ed|ing)?|klart|färdigt|slutfört|implementerat|åtgärdat|löst|gröna)\b/i.test(text)
    || /\b(?:next|remaining|pending|todo|wip|därefter|återstår|kvar)\b[^.\n]{0,80}\b(?:implement|fix|complete|finish|test|ship|merge|implementera|åtgärda|slutföra|testa|merga)\w*/i.test(text);
}

function lastByRole(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index];
  }
  return null;
}

function boundedFinalText(value) {
  return String(value || '').trim().slice(-2400);
}

function lastOutputTimestamp(session) {
  return latestTimestamp([session?.last_output_at, session?.lastOutputAt]);
}

function exitTimestamp(session) {
  return latestTimestamp([
    session?.exit?.at,
    session?.runtime_failed_at,
    session?.runtime_stopped_at,
    session?.stopped_at,
  ]);
}

function idleActivityTimestamp(session, nowMs) {
  const value = session?.idle_seconds ?? session?.idleSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return new Date(nowMs - Math.min(value, 31_536_000) * 1000).toISOString();
}

function latestTimestamp(values) {
  let latest = null;
  let latestMs = -Infinity;
  for (const value of values) {
    if (!isTimestamp(value)) continue;
    const ms = Date.parse(value);
    if (ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function timestampOrFallback(value, fallback, finalFallback) {
  if (isTimestamp(value)) return value;
  if (isTimestamp(fallback)) return fallback;
  return finalFallback;
}

function isLater(left, right) {
  if (!isTimestamp(left)) return false;
  if (!isTimestamp(right)) return true;
  return Date.parse(left) > Date.parse(right);
}

function isFresh(value, nowMs) {
  if (!isTimestamp(value)) return false;
  const ageMs = Math.max(0, nowMs - Date.parse(value));
  return ageMs <= SESSION_ACTIVITY_FRESH_SECONDS * 1000;
}

function stripCodexRedrawNoise(line) {
  const value = String(line || '');
  const matches = [...value.matchAll(CODEX_REDRAW_TOKEN_RE)];
  for (const match of matches) {
    const index = match.index ?? 0;
    const suffix = value.slice(index);
    if (isCodexRedrawNoise(suffix)) return value.slice(0, index).trimEnd();
  }
  return value;
}

function isCodexRedrawNoise(value) {
  const text = String(value || '');
  const tokens = text.match(CODEX_REDRAW_TOKEN_RE) || [];
  if (tokens.length < 5) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  const tokenLetters = tokens.join('').replace(/[^A-Za-z]/g, '');
  return tokenLetters.length / letters.length > 0.55;
}

const CODEX_REDRAW_TOKEN_RE = /W{1,2}o|Wor|Worki?|Workin|Working|orking|rking|Reviewi?|Reviewin|Reviewing|eviewing|viewing|iewing|approval|approv[a-z]*|request|reques[a-z]*|ingngg|ngg/gi;

function safeSourcePart(value) {
  const sanitized = String(value || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 110);
  return sanitized || 'unknown';
}

function unknownKeys(input, allowed) {
  return Object.keys(input).filter((key) => !allowed.has(key));
}

function timestampMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedString(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max;
}

function boundedNullableString(value, max) {
  const text = stringOrNull(value);
  return text ? text.slice(0, max) : null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}
