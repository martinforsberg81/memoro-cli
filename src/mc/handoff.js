import { canonicalToolId } from '../adapters/index.js';

const CONTRACT_VERSION = 'mc-session-handoff-v1';
const MAX_GOAL_STATE_BYTES = 2048;
const MAX_LIST_ITEM_BYTES = 512;
const MAX_ITEMS = 12;
const MAX_PATHS = 64;
const MAX_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CODING_SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{6,}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CREDENTIAL_RE = /(?:\b(?:mem_[A-Za-z0-9._:-]{6,}|sk-[A-Za-z0-9._-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|cap_[A-Za-z0-9_-]{6,})\b|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:access|refresh)[_-]?token\s*[:=])/i;

/**
 * Produces only the bounded candidate accepted by the Worker v1 boundary.
 * It does not read transcripts, persist data, launch a provider, or render a
 * prompt. H2 owns authority/digests and H3 owns user-message delivery.
 */
export function buildHandoff(input, { scan = createDefenceInDepthScanner() } = {}) {
  const handoff = normalizeInput(input);
  if (!handoff) return { ok: false, code: 'handoff-invalid-input' };

  const result = scanHandoff(scan, handoff);
  if (!result.ok) return result;
  return { ok: true, handoff };
}

/**
 * H1 transcript seam: callers must supply a trusted finder that already knows
 * how to associate provider-native transcript evidence with a runtime fence.
 * This function intentionally has no latest-file fallback.
 */
export async function discoverHandoffTranscript({ provider, expectedSessionId, runtimeGeneration, find } = {}) {
  const canonical = canonicalProvider(provider);
  if (!canonical || !id(expectedSessionId) || !id(runtimeGeneration) || typeof find !== 'function') {
    return { ok: false, code: 'handoff-transcript-unfenced' };
  }
  let found;
  try {
    found = await find({ provider: canonical, expectedSessionId, runtimeGeneration });
  } catch {
    return { ok: false, code: 'handoff-transcript-unavailable' };
  }
  if (!found?.sessionId) return { ok: false, code: 'handoff-transcript-missing-id' };
  if (found.sessionId !== expectedSessionId) return { ok: false, code: 'handoff-transcript-id-mismatch' };
  if (!found.runtimeGeneration) return { ok: false, code: 'handoff-transcript-unfenced' };
  if (found.runtimeGeneration !== runtimeGeneration) return { ok: false, code: 'handoff-transcript-generation-mismatch' };
  return { ok: true, transcript: found };
}

/**
 * Defence in depth only: credential-domain isolation remains the boundary.
 * Results never include the matching text so callers cannot reflect a secret.
 */
export function createDefenceInDepthScanner({ canaries = [], maxBytes = MAX_BYTES } = {}) {
  const needles = canaryNeedles(canaries);
  return (value) => {
    let text;
    try {
      text = canonicalJson(value);
    } catch {
      return { ok: false, uncertain: true };
    }
    if (Buffer.byteLength(text) > maxBytes) return { ok: false, uncertain: true };
    const lower = text.toLowerCase();
    const compact = lower.replace(/[^a-z0-9]/g, '');
    if (CREDENTIAL_RE.test(text) || needles.some((needle) => (
      lower.includes(needle.lower) || compact.includes(needle.compact)
    ))) {
      return { ok: false, version: 'mc-handoff-scanner-v1' };
    }
    if (/\b[A-Za-z0-9+/]{80,}={0,2}\b/.test(text)) return { ok: false, uncertain: true };
    return { ok: true, version: 'mc-handoff-scanner-v1' };
  };
}

function normalizeInput(input) {
  const allowed = new Set(['codingSessionId', 'sequence', 'parentDigest', 'source', 'workspace', 'content']);
  if (!plain(input) || Object.keys(input).some((key) => !allowed.has(key))) return null;
  if (!CODING_SESSION_ID_RE.test(input.codingSessionId || '') || !Number.isSafeInteger(input.sequence) || input.sequence < 1) return null;
  if (!validParentDigest(input.parentDigest, input.sequence)) return null;
  const source = normalizeSource(input.source);
  const workspace = normalizeWorkspace(input.workspace);
  const content = normalizeContent(input.content);
  if (!source || !workspace || !content) return null;
  return {
    contract_version: CONTRACT_VERSION,
    coding_session_id: input.codingSessionId,
    sequence: input.sequence,
    parent_digest: input.parentDigest ?? null,
    source,
    workspace,
    content,
    scanner: { version: 'mc-handoff-scanner-v1', result: 'clean', redaction_count: 0 },
  };
}

function normalizeSource(value) {
  if (!plain(value) || Object.keys(value).some((key) => !['kind', 'id', 'tool', 'runtimeGeneration'].includes(key))) return null;
  const tool = canonicalProvider(value.tool);
  if (value.kind !== 'local' || !id(value.id) || !tool || !id(value.runtimeGeneration)) return null;
  return { kind: value.kind, id: value.id, tool, runtime_generation: value.runtimeGeneration };
}

function normalizeWorkspace(value) {
  if (!plain(value) || Object.keys(value).some((key) => !['anchor', 'digest'].includes(key))) return null;
  if (!plain(value.anchor) || Object.keys(value.anchor).some((key) => !['repoId', 'ref', 'branch'].includes(key))) return null;
  if (!id(value.anchor.repoId) || !DIGEST_RE.test(value.digest || '')) return null;
  if ((value.anchor.ref != null && !safeText(value.anchor.ref, 256)) || (value.anchor.branch != null && !safeText(value.anchor.branch, 256))) return null;
  return { anchor: { repo_id: value.anchor.repoId, ...(value.anchor.ref ? { ref: value.anchor.ref } : {}), ...(value.anchor.branch ? { branch: value.anchor.branch } : {}) }, digest: value.digest };
}

function normalizeContent(value) {
  const allowed = new Set(['goal', 'state', 'decisions', 'nextActions', 'risks', 'changedPaths']);
  if (!plain(value) || Object.keys(value).some((key) => !allowed.has(key))) return null;
  const goal = optionalText(value.goal, MAX_GOAL_STATE_BYTES);
  const state = optionalText(value.state, MAX_GOAL_STATE_BYTES);
  const decisions = optionalList(value.decisions);
  const nextActions = optionalList(value.nextActions);
  const risks = optionalList(value.risks);
  const changedPaths = optionalPaths(value.changedPaths);
  if ((value.goal !== undefined && goal === null) || (value.state !== undefined && state === null)
    || decisions === null || nextActions === null || risks === null || changedPaths === null) return null;
  if (!goal && !state && !decisions?.length && !nextActions?.length && !risks?.length && !changedPaths?.length) return null;
  const content = {
    ...(goal ? { goal } : {}),
    ...(state ? { state } : {}),
    ...(decisions?.length ? { decisions } : {}),
    ...(nextActions?.length ? { next_actions: nextActions } : {}),
    ...(risks?.length ? { risks } : {}),
    ...(changedPaths?.length ? { changed_paths: changedPaths } : {}),
  };
  return content;
}

function scanHandoff(scan, handoff) {
  let result;
  try {
    result = scan(handoff);
  } catch {
    return { ok: false, code: 'handoff-scan-failed' };
  }
  if (result?.ok) return { ok: true };
  return { ok: false, code: result?.uncertain ? 'handoff-scan-uncertain' : 'handoff-content-rejected' };
}

function optionalText(value, maxBytes) {
  if (value === undefined || value === null || value === '') return null;
  return safeText(value, maxBytes) ? value : null;
}

function optionalList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const items = value.map((item) => optionalText(item, MAX_LIST_ITEM_BYTES));
  return items.every(Boolean) ? items : null;
}

function optionalPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PATHS) return null;
  const paths = value.map(normalizeRelativePath);
  return paths.every(Boolean) ? paths : null;
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || /[\\\0-\x1f\x7f]/.test(value)) return null;
  const path = value.replace(/^\.\//, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

function canaryNeedles(canaries) {
  return [...canaries]
    .filter((value) => typeof value === 'string' && value)
    .flatMap((value) => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')])
    .map((value) => ({ lower: value.toLowerCase(), compact: value.toLowerCase().replace(/[^a-z0-9]/g, '') }));
}

function validParentDigest(value, sequence) {
  return sequence === 1 ? value === null || value === undefined : DIGEST_RE.test(value || '');
}

function canonicalProvider(value) {
  const known = canonicalToolId(value);
  if (known) return known;
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

function id(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function safeText(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value) <= maxBytes && !/[\0-\x1f\x7f]/.test(value);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!plain(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
