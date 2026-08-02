/**
 * Client-side transcript shaping.
 *
 * We normalize tool transcripts into a cleaned conversation payload that
 * Memoro processes server-side. Exact user queries are preserved verbatim.
 * Raw tool output is stripped, but safe execution context is retained as
 * structured activity events for future extraction passes.
 */

import { transcriptDialectFor } from '../adapters/index.js';

/**
 * Parse a coding-tool JSONL transcript into a plain message list plus
 * structured tool activity. Tool output bodies are never uploaded. The
 * per-tool entry shapes come from the adapter's TRANSCRIPT_DIALECT;
 * content normalization and safe-metadata redaction stay here.
 */
export function parseTranscript(raw, { tool = 'claude-code' } = {}) {
  const dialect = transcriptDialectFor(tool);
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];
  const activities = [];
  let startedAt = null;
  let endedAt = null;
  let sessionId = null;
  let cwd = null;
  let toolVersion = null;
  let modelProvider = null;
  let modelName = null;
  let originator = null;
  let clientSource = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const meta = dialect.meta(entry);
    if (meta) {
      if (meta.sessionId && !sessionId) sessionId = meta.sessionId;
      if (meta.cwd && !cwd) cwd = meta.cwd;
      if (meta.toolVersion && !toolVersion) toolVersion = meta.toolVersion;
      if (meta.modelProvider && !modelProvider) modelProvider = meta.modelProvider;
      if (meta.modelName && !modelName) modelName = meta.modelName;
      if (meta.originator && !originator) originator = meta.originator;
      if (meta.clientSource && !clientSource) clientSource = meta.clientSource;
    }

    const ts = entry.timestamp || entry.created_at || null;
    if (ts) {
      if (!startedAt || new Date(ts) < new Date(startedAt)) startedAt = ts;
      if (!endedAt || new Date(ts) > new Date(endedAt)) endedAt = ts;
    }
    if (entry.session_id && !sessionId) sessionId = entry.session_id;
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;

    activities.push(...dialect.toolCalls(entry).map(({ name, input }) => ({
      kind: 'tool_call',
      actor: 'assistant',
      tool_name: name || 'unknown',
      summary: describeToolCall(name, input),
      safe_metadata: pickSafeToolMetadata(input),
      at: ts,
    })));

    const message = dialect.message(entry);
    const role = message?.role || null;
    const content = normalizeContent(message?.content);

    if (!role || !content) continue;
    if (isLocalCommandArtifact(content)) continue;
    if (role === 'user' || role === 'human') {
      messages.push({ role: 'user', content, at: ts });
    } else if (role === 'assistant' || role === 'model') {
      messages.push({ role: 'assistant', content, at: ts });
    }
  }

  if (!modelProvider) modelProvider = dialect.provider || null;

  return {
    messages,
    activities,
    startedAt,
    endedAt,
    sessionId,
    cwd,
    toolVersion,
    modelProvider,
    modelName,
    originator,
    clientSource,
  };
}

/**
 * Distillation is lossy compression by contract: the payload is shaped
 * here, newest-first, because the end of a session carries its
 * conclusions. The server's external-session envelope (512 KB) is a hard
 * stop with headroom, never the shaping mechanism.
 */
export const CLEANED_CONVERSATION_MAX_BYTES = 224 * 1024;

/**
 * Build the external-session payload Memoro expects now: a cleaned
 * conversation stream plus deterministic metadata.
 */
export function buildSessionPayload({
  parsed,
  repoHint = null,
  toolVersion = null,
  source = 'claude-code',
  codingSessionId = null,
}) {
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error('Transcript has no usable messages');
  }

  const mcSessionId = typeof codingSessionId === 'string' && codingSessionId.trim()
    ? codingSessionId.trim()
    : null;
  const bounded = boundConversationNewestFirst(buildCleanedConversation(parsed));
  const payload = {
    source,
    session_id: parsed.sessionId || fallbackSessionId(parsed),
    started_at: parsed.startedAt || null,
    ended_at: parsed.endedAt || null,
    cleaned_conversation: bounded.entries,
    repo_hint: repoHint,
    tool_version: toolVersion,
  };
  if (bounded.dropped) {
    payload.conversation_truncated = true;
    payload.conversation_dropped = bounded.dropped;
  }
  if (mcSessionId) payload.coding_session_id = mcSessionId;
  return payload;
}

function boundConversationNewestFirst(entries, maxBytes = CLEANED_CONVERSATION_MAX_BYTES) {
  let used = 2; // JSON array brackets
  let start = entries.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(entries[start - 1]), 'utf8') + 1;
    if (used + size > maxBytes) break;
    used += size;
    start -= 1;
  }
  if (start === 0) return { entries, dropped: null };

  let kept = entries.slice(start);
  if (kept.length === 0) {
    // Even the newest entry alone exceeds the budget: keep it with its
    // content cut to fit rather than distilling an empty session.
    kept = [truncateEntryContent(entries[entries.length - 1], maxBytes - 2048)];
    start = entries.length - 1;
  }
  const droppedEntries = entries.slice(0, start);
  const droppedMessages = droppedEntries.filter(entry => entry.kind === 'message').length;
  return {
    entries: kept,
    dropped: {
      messages: droppedMessages,
      activities: droppedEntries.length - droppedMessages,
    },
  };
}

function truncateEntryContent(entry, maxBytes) {
  if (typeof entry?.content !== 'string') return entry;
  let text = entry.content;
  while (text.length > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = text.slice(0, Math.floor(text.length * 0.9));
  }
  return { ...entry, content: `${text}…`, content_truncated: true };
}

function buildCleanedConversation(parsed) {
  const entries = [
    ...parsed.messages.map(message => ({
      kind: 'message',
      role: message.role,
      content: message.content,
      at: message.at || null,
    })),
    ...(Array.isArray(parsed.activities) ? parsed.activities : []),
  ];

  return entries.sort(compareConversationEntries);
}

function isLocalCommandArtifact(content) {
  const head = content.slice(0, 32);
  return head.startsWith('<local-command-') || head.startsWith('<command-name>') || head.startsWith('<command-message>');
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content).trim();
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[tool: ${block.name || 'unknown'}]`);
    } else if (block.type === 'tool_result') {
      parts.push('[tool result]');
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function describeToolCall(name, input) {
  const tool = String(name || 'unknown');
  const metadata = pickSafeToolMetadata(input);
  if (metadata.file_path) return `${tool} on ${metadata.file_path}`;
  if (metadata.paths?.length) return `${tool} on ${metadata.paths[0]}`;
  if (metadata.command_preview) return `${tool}: ${metadata.command_preview}`;
  if (metadata.pattern) return `${tool} for pattern "${metadata.pattern}"`;
  return tool;
}

function pickSafeToolMetadata(input) {
  const metadata = {};
  if (!input || typeof input !== 'object') return metadata;

  const filePath = firstString(input, ['file_path', 'path', 'notebook_path']);
  if (filePath) metadata.file_path = filePath;

  const paths = Array.isArray(input.paths)
    ? input.paths.filter(v => typeof v === 'string').slice(0, 5)
    : [];
  if (paths.length > 0) metadata.paths = paths;

  const command = firstString(input, ['command', 'cmd']);
  if (command) metadata.command_preview = truncateValue(command, 160);

  const pattern = firstString(input, ['pattern', 'query']);
  if (pattern) metadata.pattern = truncateValue(pattern, 120);

  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    metadata.has_inline_code = true;
  }

  return metadata;
}

function firstString(input, keys) {
  for (const key of keys) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
  }
  return null;
}

function truncateValue(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function compareConversationEntries(a, b) {
  const atA = a?.at || '';
  const atB = b?.at || '';
  if (atA && atB && atA !== atB) return atA.localeCompare(atB);
  if (a.kind === b.kind) return 0;
  if (a.kind === 'message') return -1;
  if (b.kind === 'message') return 1;
  return 0;
}

function fallbackSessionId(parsed) {
  const seed = `${parsed.startedAt || ''}:${parsed.messages.length}:${parsed.messages[0]?.content?.slice(0, 40) || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return `cc_${Math.abs(hash).toString(16)}`;
}
