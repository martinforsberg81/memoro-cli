export const CODING_FEATURE_EVIDENCE_CONTRACT_VERSION = 'coding-feature-evidence-v1';
export const CODING_FEATURE_DETECTOR_VERSION = 'coding-features-v1';

const MAX_ARTIFACTS = 200;
const MAX_ARTIFACT_CHARS = 64 * 1024;
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REPO_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|sql|toml|jsonc?|ya?ml)$/i;
const IGNORED_DETECTOR_PATH_RE = /(?:^|\/)coding-feature-evidence(?:\.|-|\/)/i;
const WRANGLER_CONFIG_RE = /(?:^|\/)wrangler(?:\.[^.\/]+)?\.(?:toml|jsonc?)$/i;

function signal(code, pattern, { pathPattern = null } = {}) {
  return Object.freeze({ code, pattern, pathPattern });
}

function feature(highSignalCodes, signals) {
  return Object.freeze({
    highSignalCodes: new Set(highSignalCodes),
    signals: Object.freeze(signals),
  });
}

export const CODING_FEATURE_DETECTORS = Object.freeze({
  'cloudflare.durable_objects.websocket_hibernation': feature([
    'api:acceptWebSocket',
    'api:getWebSockets',
    'api:serializeAttachment',
    'api:deserializeAttachment',
  ], [
    signal('api:acceptWebSocket', /\bacceptWebSocket\s*\(/),
    signal('api:getWebSockets', /\bgetWebSockets\s*\(/),
    signal('api:serializeAttachment', /\bserializeAttachment\s*\(/),
    signal('api:deserializeAttachment', /\bdeserializeAttachment\s*\(/),
    signal('config:durable_objects', /(?:\[\s*durable_objects\s*\]|["']durable_objects["']\s*:|\bdurable_objects\s*=)/i, {
      pathPattern: WRANGLER_CONFIG_RE,
    }),
  ]),
  'cloudflare.workers.queues_delivery': feature([
    'api:queue.send',
    'api:queue.sendBatch',
    'handler:queue',
    'api:message.ack',
    'api:message.retry',
  ], [
    signal('api:queue.send', /\benv\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*send\s*\(/),
    signal('api:queue.sendBatch', /\benv\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*sendBatch\s*\(/),
    signal('handler:queue', /\b(?:async\s+)?queue\s*(?:\(\s*(?:batch|messages|event)\b|:\s*(?:async\s*)?\()/),
    signal('api:message.ack', /\b(?:message|msg)\s*\.\s*ack\s*\(/),
    signal('api:message.retry', /\b(?:message|msg)\s*\.\s*retry\s*\(/),
    signal('config:queues', /(?:\[\[\s*queues\.(?:producers|consumers)\s*\]\]|["']queues["']\s*:)/i, {
      pathPattern: WRANGLER_CONFIG_RE,
    }),
  ]),
  'cloudflare.workers.service_bindings': feature([
    'api:service.fetch',
    'api:rpc.entrypoint',
  ], [
    signal('api:service.fetch', /\benv\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*fetch\s*\(/),
    signal('api:rpc.entrypoint', /\bextends\s+(?:WorkerEntrypoint|RpcTarget)\b/),
    signal('config:services', /(?:\[\[\s*services\s*\]\]|["']services["']\s*:)/i, {
      pathPattern: WRANGLER_CONFIG_RE,
    }),
  ]),
  'sqlite.fts5_search': feature([
    'sql:create_virtual_table_fts5',
    'sql:match_query',
  ], [
    signal('sql:create_virtual_table_fts5', /\bCREATE\s+VIRTUAL\s+TABLE\b[\s\S]{0,300}?\bUSING\s+fts5\s*\(/i),
    signal('sql:match_query', /\b(?:WHERE|AND|OR)\s+[A-Za-z0-9_."`\[\]]+\s+MATCH\s+/i),
    signal('api:fts5_rank_bm25', /\bbm25\s*\(/i),
    signal('api:fts5_highlight', /\b(?:highlight|snippet)\s*\(/i),
  ]),
  'postgres.row_level_security': feature([
    'sql:enable_row_level_security',
    'sql:force_row_level_security',
    'sql:create_policy',
  ], [
    signal('sql:enable_row_level_security', /\bALTER\s+TABLE\b[\s\S]{0,200}?\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i),
    signal('sql:force_row_level_security', /\bALTER\s+TABLE\b[\s\S]{0,200}?\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i),
    signal('sql:create_policy', /\bCREATE\s+POLICY\s+[A-Za-z0-9_"-]+\s+ON\b/i),
    signal('config:row_security', /\brow_security\s*=\s*(?:on|off|force)\b/i),
  ]),
  'node.worker_threads': feature([
    'api:new_Worker',
    'api:parentPort',
    'api:workerData',
    'api:MessageChannel',
  ], [
    signal('import:node_worker_threads', /(?:\bfrom\s*["'](?:node:)?worker_threads["']|\brequire\s*\(\s*["'](?:node:)?worker_threads["']\s*\))/),
    signal('api:new_Worker', /\bnew\s+Worker\s*\(/),
    signal('api:parentPort', /\bparentPort\s*(?:\.|\?|,|\})/),
    signal('api:workerData', /\bworkerData\b/),
    signal('api:MessageChannel', /\bnew\s+MessageChannel\s*\(/),
  ]),
  'web.abort_signal_composition': feature([
    'api:AbortSignal.any',
    'api:AbortSignal.timeout',
    'api:AbortController.abort',
    'api:signal.throwIfAborted',
  ], [
    signal('api:AbortSignal.any', /\bAbortSignal\s*\.\s*any\s*\(/),
    signal('api:AbortSignal.timeout', /\bAbortSignal\s*\.\s*timeout\s*\(/),
    signal('api:AbortController.abort', /\b(?:controller|abortController)\s*\.\s*abort\s*\(/i),
    signal('api:signal.throwIfAborted', /\b(?:signal|abortSignal)\s*\.\s*throwIfAborted\s*\(/i),
  ]),
});

export function detectCodingFeatures(entries) {
  const artifacts = collectCodingArtifacts(entries);
  const detected = [];

  for (const [featureId, definition] of Object.entries(CODING_FEATURE_DETECTORS)) {
    const codes = new Set();
    const files = new Set();
    for (const artifact of artifacts) {
      let artifactMatched = false;
      for (const detector of definition.signals) {
        if (detector.pathPattern && !detector.pathPattern.test(artifact.path)) continue;
        if (!detector.pattern.test(artifact.content)) continue;
        codes.add(detector.code);
        artifactMatched = true;
      }
      if (artifactMatched) files.add(artifact.path);
    }

    if (codes.size < 2) continue;
    if (![...codes].some((code) => definition.highSignalCodes.has(code))) continue;
    detected.push({
      feature_id: featureId,
      evidence_codes: [...codes].sort(),
      files_observed: Math.min(files.size, 100),
    });
  }

  return detected.sort((a, b) => a.feature_id < b.feature_id ? -1 : a.feature_id > b.feature_id ? 1 : 0);
}

export function detectCodingFeaturesSafely(entries, { detect = detectCodingFeatures } = {}) {
  try {
    const detected = detect(entries);
    return Array.isArray(detected) ? detected : [];
  } catch {
    return [];
  }
}

export function buildCodingFeatureEvidenceRecords({
  detections,
  sourceId,
  codingSessionId,
  repoCandidates = [],
  observedAt = new Date().toISOString(),
} = {}) {
  if (!SOURCE_ID_RE.test(sourceId || '') || !SESSION_ID_RE.test(codingSessionId || '')) return [];
  const repo = (Array.isArray(repoCandidates) ? repoCandidates : [repoCandidates])
    .map(normalizeRepo)
    .find(Boolean);
  if (!repo) return [];
  const canonicalObservedAt = canonicalTimestamp(observedAt);
  if (!canonicalObservedAt) return [];

  return (Array.isArray(detections) ? detections : []).flatMap((detected) => {
    const definition = CODING_FEATURE_DETECTORS[detected?.feature_id];
    if (!definition) return [];
    const allowedCodes = new Set(definition.signals.map((entry) => entry.code));
    const codes = [...new Set(
      (Array.isArray(detected.evidence_codes) ? detected.evidence_codes : [])
        .filter((code) => allowedCodes.has(code)),
    )].sort();
    if (codes.length < 2 || !codes.some((code) => definition.highSignalCodes.has(code))) return [];
    const filesObserved = boundedInteger(detected.files_observed, 1, 100);
    return [{
      contract_version: CODING_FEATURE_EVIDENCE_CONTRACT_VERSION,
      feature_id: detected.feature_id,
      source_id: sourceId,
      coding_session_id: codingSessionId,
      repo,
      observed_at: canonicalObservedAt,
      evidence_codes: codes,
      files_observed: filesObserved,
      confidence: 'high',
      detector_version: CODING_FEATURE_DETECTOR_VERSION,
    }];
  });
}

export async function publishCodingFeatureEvidence(records, {
  apiUrl,
  token,
  request,
} = {}) {
  const normalized = Array.isArray(records) ? records : [];
  const summary = { attempted: normalized.length, accepted: 0, rejected: 0 };
  if (typeof request !== 'function') {
    summary.rejected = normalized.length;
    return summary;
  }
  for (const record of normalized) {
    const safeRecord = sanitizeCodingFeatureEvidenceRecord(record);
    if (!safeRecord) {
      summary.rejected += 1;
      continue;
    }
    try {
      await request(apiUrl, '/api/sessions/coding-feature-evidence', {
        token,
        method: 'POST',
        body: safeRecord,
      });
      summary.accepted += 1;
    } catch {
      summary.rejected += 1;
    }
  }
  return summary;
}

export function sanitizeCodingFeatureEvidenceRecord(record) {
  if (!isObject(record)
    || record.contract_version !== CODING_FEATURE_EVIDENCE_CONTRACT_VERSION
    || record.detector_version !== CODING_FEATURE_DETECTOR_VERSION
    || record.confidence !== 'high'
    || !SOURCE_ID_RE.test(record.source_id || '')
    || !SESSION_ID_RE.test(record.coding_session_id || '')) return null;
  const repo = normalizeRepo(record.repo);
  const observedAt = canonicalTimestamp(record.observed_at);
  const definition = CODING_FEATURE_DETECTORS[record.feature_id];
  if (!repo || !observedAt || !definition || !Number.isInteger(record.files_observed)
    || record.files_observed < 1 || record.files_observed > 100) return null;
  const allowedCodes = new Set(definition.signals.map((entry) => entry.code));
  const codes = [...new Set(
    (Array.isArray(record.evidence_codes) ? record.evidence_codes : [])
      .filter((code) => typeof code === 'string' && allowedCodes.has(code)),
  )].sort();
  if (codes.length < 2 || !codes.some((code) => definition.highSignalCodes.has(code))) return null;
  return {
    contract_version: CODING_FEATURE_EVIDENCE_CONTRACT_VERSION,
    feature_id: record.feature_id,
    source_id: record.source_id,
    coding_session_id: record.coding_session_id,
    repo,
    observed_at: observedAt,
    evidence_codes: codes,
    files_observed: record.files_observed,
    confidence: 'high',
    detector_version: CODING_FEATURE_DETECTOR_VERSION,
  };
}

export function collectCodingArtifacts(entries) {
  const artifacts = [];
  const calls = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const call of extractToolCalls(entry)) {
      const descriptor = describeToolCall(call);
      if (call.id) calls.set(call.id, descriptor);
      artifacts.push(...descriptor.inlineArtifacts);
    }
    for (const result of extractToolResults(entry)) {
      const descriptor = result.callId ? calls.get(result.callId) : null;
      if (!descriptor?.scanResult || descriptor.paths.length === 0) continue;
      const content = textFromToolResult(result.output);
      for (const path of descriptor.paths) addArtifact(artifacts, path, content);
    }
    if (artifacts.length >= MAX_ARTIFACTS) break;
  }
  return artifacts.slice(0, MAX_ARTIFACTS);
}

function describeToolCall(call) {
  const input = isObject(call.input) ? call.input : {};
  const name = String(call.name || '').toLowerCase();
  const patch = firstString(input, ['patch', 'diff']);
  const patchArtifacts = patch ? splitPatchArtifacts(patch) : [];
  const explicitPaths = extractPaths(input);
  const commandPath = isCommandTool(name) ? readOnlyCommandPath(firstString(input, ['command', 'cmd'])) : null;
  const paths = unique([...explicitPaths, ...(commandPath ? [commandPath] : []), ...patchArtifacts.map((item) => item.path)]);
  const inlineArtifacts = [...patchArtifacts];
  if (isMutationTool(name)) {
    const inline = [
      firstString(input, ['old_string', 'oldText']),
      firstString(input, ['new_string', 'newText']),
      firstString(input, ['content', 'code', 'text']),
    ].filter(Boolean).join('\n');
    for (const path of explicitPaths) addArtifact(inlineArtifacts, path, inline);
  }
  return {
    paths,
    inlineArtifacts,
    scanResult: isReadTool(name) || (isCommandTool(name) && Boolean(commandPath)),
  };
}

function extractToolCalls(entry) {
  const out = [];
  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call') {
    out.push({
      id: entry.payload.call_id || entry.payload.id || null,
      name: entry.payload.name,
      input: parseArguments(entry.payload.arguments),
    });
  }
  if (entry?.type === 'tool_call' || entry?.type === 'function_call') {
    out.push({
      id: entry.id || entry.call_id || null,
      name: entry.name || entry.function?.name,
      input: parseArguments(entry.args ?? entry.arguments ?? entry.input ?? entry.function?.arguments),
    });
  }
  for (const toolCall of entry?.message?.tool_calls || []) {
    out.push({
      id: toolCall.id || toolCall.call_id || null,
      name: toolCall.name || toolCall.function?.name,
      input: parseArguments(toolCall.args ?? toolCall.arguments ?? toolCall.function?.arguments),
    });
  }
  const content = entry?.message?.content || entry?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_use' && block?.type !== 'tool_call' && block?.type !== 'function_call') continue;
      out.push({
        id: block.id || block.tool_use_id || block.call_id || null,
        name: block.name || block.function?.name,
        input: parseArguments(block.input ?? block.args ?? block.arguments ?? block.function?.arguments),
      });
    }
  }
  return out;
}

function extractToolResults(entry) {
  const out = [];
  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call_output') {
    out.push({ callId: entry.payload.call_id || entry.payload.id || null, output: entry.payload.output });
  }
  if (entry?.type === 'tool_result' || entry?.type === 'function_result' || entry?.type === 'function_call_output') {
    out.push({
      callId: entry.tool_use_id || entry.tool_call_id || entry.call_id || entry.id || null,
      output: entry.output ?? entry.result ?? entry.content,
    });
  }
  const content = entry?.message?.content || entry?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_result' && block?.type !== 'function_result' && block?.type !== 'function_call_output') continue;
      out.push({
        callId: block.tool_use_id || block.tool_call_id || block.call_id || block.id || null,
        output: block.output ?? block.result ?? block.content,
      });
    }
  }
  return out;
}

function splitPatchArtifacts(patch) {
  if (typeof patch !== 'string') return [];
  const headers = [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].slice(0, MAX_ARTIFACTS);
  if (headers.length === 0) {
    const gitHeaders = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].slice(0, MAX_ARTIFACTS);
    return gitHeaders.map((match, index) => ({
      path: match[1],
      content: patch.slice(match.index, gitHeaders[index + 1]?.index ?? patch.length).slice(0, MAX_ARTIFACT_CHARS),
    })).filter((item) => validArtifactPath(item.path));
  }
  return headers.map((match, index) => ({
    path: match[1].trim(),
    content: patch.slice(match.index, headers[index + 1]?.index ?? patch.length).slice(0, MAX_ARTIFACT_CHARS),
  })).filter((item) => validArtifactPath(item.path));
}

function extractPaths(input) {
  const paths = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string') paths.push(input[key]);
  }
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((value) => typeof value === 'string'));
  return unique(paths.map(normalizeArtifactPath).filter(validArtifactPath));
}

function addArtifact(list, path, content) {
  const normalizedPath = normalizeArtifactPath(path);
  if (list.length >= MAX_ARTIFACTS || !validArtifactPath(normalizedPath) || typeof content !== 'string' || !content) return;
  list.push({ path: normalizedPath, content: content.slice(0, MAX_ARTIFACT_CHARS) });
}

function validArtifactPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 1024
    && CODE_FILE_RE.test(path)
    && !IGNORED_DETECTOR_PATH_RE.test(path);
}

function normalizeArtifactPath(path) {
  return typeof path === 'string' ? path.trim().replaceAll('\\', '/') : '';
}

function textFromToolResult(output) {
  const parts = [];
  let remaining = MAX_ARTIFACT_CHARS;
  const visit = (value) => {
    if (remaining <= 0) return;
    if (typeof value === 'string') {
      const part = value.slice(0, remaining);
      parts.push(part);
      remaining -= part.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    visit(value.text);
    visit(value.content);
    visit(value.output);
  };
  visit(output);
  return parts.join('\n').slice(0, MAX_ARTIFACT_CHARS);
}

function parseArguments(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isMutationTool(name) {
  return /(?:^|_)(?:edit|write|replace|create_file|apply_patch)(?:$|_)/.test(name)
    || ['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch'].includes(name);
}

function isReadTool(name) {
  return /(?:^|_)(?:read|view_file|grep|search_file)(?:$|_)/.test(name)
    || ['read', 'grep', 'view'].includes(name);
}

function isCommandTool(name) {
  return ['bash', 'exec_command', 'shell', 'run_command'].includes(name);
}

function readOnlyCommandPath(command) {
  if (typeof command !== 'string' || /(?:;|&&|\|\||`|\$\()/.test(command)) return null;
  const match = command.match(/^(?:\s*)(?:cat|head(?:\s+-n\s+\d+)?|tail(?:\s+-n\s+\d+)?|sed\s+-n\s+['"][^'"]+['"])[ \t]+(?:--[ \t]+)?([A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|sql|toml|jsonc?|ya?ml))(?:\s*)$/i);
  return match ? normalizeArtifactPath(match[1]) : null;
}

function normalizeRepo(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\.git$/i, '');
  if (normalized.length > 128 || normalized.includes('..')) return null;
  const segments = normalized.split('/');
  if (segments.length < 1 || segments.length > 2) return null;
  return segments.every((segment) => REPO_SEGMENT_RE.test(segment)) ? normalized : null;
}

function canonicalTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function firstString(input, keys) {
  for (const key of keys) {
    if (typeof input?.[key] === 'string' && input[key]) return input[key];
  }
  return null;
}

function boundedInteger(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.max(min, Math.min(max, Math.trunc(Number(value))));
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
