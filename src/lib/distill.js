/**
 * Client-side transcript shaping.
 *
 * We normalize tool transcripts into a cleaned conversation payload that
 * Memoro processes server-side. Exact user queries are preserved verbatim.
 * Raw tool output is stripped, but safe execution context is retained as
 * structured activity events for future extraction passes.
 */

/**
 * Parse a coding-tool JSONL transcript into a plain message list plus
 * structured tool activity. Tool output bodies are never uploaded.
 */
export function parseTranscript(raw, { tool = 'claude-code' } = {}) {
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

    if (tool === 'codex' && entry.type === 'session_meta' && entry.payload) {
      if (entry.payload.id && !sessionId) sessionId = entry.payload.id;
      if (entry.payload.cwd && !cwd) cwd = entry.payload.cwd;
      if (entry.payload.cli_version && !toolVersion) toolVersion = entry.payload.cli_version;
      if (entry.payload.model_provider && !modelProvider) modelProvider = entry.payload.model_provider;
      if (entry.payload.originator && !originator) originator = entry.payload.originator;
      if (entry.payload.source && !clientSource) clientSource = entry.payload.source;
    }

    if (tool === 'codex' && entry.type === 'turn_context' && entry.payload) {
      if (entry.payload.model && !modelName) modelName = entry.payload.model;
    }

    const ts = entry.timestamp || entry.created_at || null;
    if (ts) {
      if (!startedAt || new Date(ts) < new Date(startedAt)) startedAt = ts;
      if (!endedAt || new Date(ts) > new Date(endedAt)) endedAt = ts;
    }
    if (entry.session_id && !sessionId) sessionId = entry.session_id;
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;

    activities.push(...extractActivities(entry, tool, ts));

    const role = extractRole(entry, tool);
    const content = normalizeContent(extractContent(entry, tool));

    if (!role || !content) continue;
    if (isLocalCommandArtifact(content)) continue;
    if (role === 'user' || role === 'human') {
      messages.push({ role: 'user', content, at: ts });
    } else if (role === 'assistant' || role === 'model') {
      messages.push({ role: 'assistant', content, at: ts });
    }
  }

  if (!modelProvider) modelProvider = inferProvider(tool);

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
 * Build the external-session payload Memoro expects now: a cleaned
 * conversation stream plus deterministic metadata.
 */
export function buildSessionPayload({ parsed, repoHint = null, toolVersion = null, source = 'claude-code' }) {
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error('Transcript has no usable messages');
  }

  return {
    source,
    session_id: parsed.sessionId || fallbackSessionId(parsed),
    started_at: parsed.startedAt || null,
    ended_at: parsed.endedAt || null,
    cleaned_conversation: buildCleanedConversation(parsed),
    repo_hint: repoHint,
    tool_version: toolVersion,
  };
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

function inferProvider(tool) {
  if (tool === 'claude-code') return 'anthropic';
  if (tool === 'codex') return 'openai';
  return null;
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

function extractRole(entry, tool) {
  if (tool === 'codex') {
    if (entry.type === 'response_item' && entry.payload?.type === 'message') {
      return entry.payload.role || null;
    }
    return null;
  }
  return entry.role || entry.message?.role || entry.type;
}

function extractContent(entry, tool) {
  if (tool === 'codex') {
    if (entry.type === 'response_item' && entry.payload?.type === 'message') {
      return entry.payload.content;
    }
    return null;
  }
  return entry.content || entry.message?.content || entry.text;
}

function extractActivities(entry, tool, at) {
  const activities = [];

  if (tool === 'codex') {
    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      const args = parseCodexArguments(entry.payload.arguments);
      activities.push({
        kind: 'tool_call',
        actor: 'assistant',
        tool_name: entry.payload.name || 'unknown',
        summary: describeToolCall(entry.payload.name, args),
        safe_metadata: pickSafeToolMetadata(args),
        at,
      });
    }
    return activities;
  }

  const content = entry.content || entry.message?.content;
  if (!Array.isArray(content)) return activities;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const input = block.input || {};
    activities.push({
      kind: 'tool_call',
      actor: 'assistant',
      tool_name: block.name || 'unknown',
      summary: describeToolCall(block.name, input),
      safe_metadata: pickSafeToolMetadata(input),
      at,
    });
  }
  return activities;
}

function parseCodexArguments(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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
