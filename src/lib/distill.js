/**
 * Client-side transcript distillation.
 *
 * Claude Code stores session transcripts as JSONL (one JSON message per
 * line). We parse the user turns + a paraphrase of each assistant turn,
 * then ask a cheap Anthropic model to produce the structured payload
 * Memoro expects. Code bodies, diffs, and tool outputs never leave the
 * user's machine — the LLM only sees prose.
 *
 * Output schema matches POST /api/sessions/external:
 *   {
 *     source: 'claude-code',
 *     session_id, started_at, ended_at,
 *     summary, user_turns[], corrections[], decisions[], open_threads[],
 *     repo_hint, tool_version
 *   }
 */

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Parse a Claude Code JSONL transcript into a plain message list.
 * Strips tool_use / tool_result bodies — we keep only what the user said
 * and short descriptions of what the assistant did.
 */
export function parseTranscript(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];
  let startedAt = null;
  let endedAt = null;
  let sessionId = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp || entry.created_at || null;
    if (ts) {
      if (!startedAt || new Date(ts) < new Date(startedAt)) startedAt = ts;
      if (!endedAt   || new Date(ts) > new Date(endedAt))   endedAt   = ts;
    }
    if (entry.session_id && !sessionId) sessionId = entry.session_id;
    if (entry.sessionId  && !sessionId) sessionId = entry.sessionId;

    const role = entry.role || entry.message?.role || entry.type;
    const content = normalizeContent(entry.content || entry.message?.content || entry.text);

    if (!role || !content) continue;
    // Claude Code injects synthetic "user" entries wrapping local CLI
    // output — slash-command invocations, caveats, stdout echoes. These
    // aren't real user turns; skip them so empty sessions don't distill
    // into a rejected payload.
    if (isLocalCommandArtifact(content)) continue;
    if (role === 'user' || role === 'human') {
      messages.push({ role: 'user', content, at: ts });
    } else if (role === 'assistant' || role === 'model') {
      messages.push({ role: 'assistant', content, at: ts });
    }
  }

  return { messages, startedAt, endedAt, sessionId };
}

function isLocalCommandArtifact(content) {
  const head = content.slice(0, 32);
  return head.startsWith('<local-command-') || head.startsWith('<command-name>') || head.startsWith('<command-message>');
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content).trim();
  // Content blocks: keep text, summarise tool_use / tool_result opaquely.
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[tool: ${block.name || 'unknown'}]`);
    } else if (block.type === 'tool_result') {
      // Opaque — never expose raw tool output to the distillation LLM.
      parts.push(`[tool result]`);
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Build the LLM prompt for distillation.
 *
 * The transcript may be large — we pass it verbatim for user turns, and
 * let the LLM summarise assistant turns in one sentence each. We do NOT
 * include tool outputs or assistant code blocks directly; parseTranscript
 * has already stripped them to opaque `[tool: …]` placeholders.
 */
export function buildDistillPrompt(parsed, { repoHint = null, toolVersion = null } = {}) {
  const conversation = parsed.messages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are distilling a coding-session transcript into a structured knowledge payload for an external knowledge hub (Memoro).

Memoro is interested in what the USER did and decided, not in the code. Extract only:
- User turns (verbatim — the user's queries are the primary signal)
- A one-sentence paraphrase of what the assistant did in response to each user turn
- Explicit corrections the user issued ("no, don't use X")
- Decisions committed during the session
- Open threads left unresolved

Do NOT include code blocks, file paths, diffs, or tool outputs. Those stay on the user's machine.

Output JSON exactly matching this schema — no extra fields:

{
  "summary": "1–3 sentence retrospective of what was accomplished",
  "user_turns": [
    { "text": "verbatim user message", "responded_with": "1-sentence paraphrase of what the assistant did" }
  ],
  "corrections": [
    { "text": "the correction as stated", "about": "what it was about, brief" }
  ],
  "decisions": [
    { "text": "decision committed by the user" }
  ],
  "open_threads": [
    { "text": "unresolved question or next step the user identified" }
  ]
}

Rules:
- user_turns preserves user text verbatim. No paraphrasing of what the user said.
- Merge consecutive user turns that form one logical ask.
- corrections are explicit user pushbacks ("don't do X", "use Y instead"). Do not fabricate.
- decisions are decisions the user explicitly committed to, not discussed alternatives.
- open_threads are things left unresolved, or explicit "next steps" the user stated.
- If a field has no content, use an empty array. Never invent.
- Output pure JSON. No markdown fences. No prose.`;

  return {
    system: systemPrompt,
    user: `Session transcript:\n\n${conversation}\n\n---\n\nOutput the JSON distillation.`,
    meta: {
      sessionId: parsed.sessionId,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      repoHint,
      toolVersion,
    },
  };
}

/**
 * Call Anthropic's API with the distillation prompt and return the parsed
 * payload, ready to POST to /api/sessions/external.
 */
export async function distill({ parsed, anthropicApiKey, repoHint = null, toolVersion = null, model = DEFAULT_MODEL }) {
  if (!anthropicApiKey) throw new Error('Anthropic API key not set. Run `memoro-cli config set anthropic-api-key sk-ant-...`');
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error('Transcript has no usable messages');
  }

  const prompt = buildDistillPrompt(parsed, { repoHint, toolVersion });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Anthropic response missing content');

  const distilled = parseDistillJson(text);

  return {
    source: 'claude-code',
    session_id: parsed.sessionId || fallbackSessionId(parsed),
    started_at: parsed.startedAt || null,
    ended_at: parsed.endedAt || null,
    summary: distilled.summary || null,
    user_turns: Array.isArray(distilled.user_turns) ? distilled.user_turns : [],
    corrections: Array.isArray(distilled.corrections) ? distilled.corrections : [],
    decisions: Array.isArray(distilled.decisions) ? distilled.decisions : [],
    open_threads: Array.isArray(distilled.open_threads) ? distilled.open_threads : [],
    repo_hint: repoHint,
    tool_version: toolVersion,
  };
}

function parseDistillJson(text) {
  // Strip any markdown fences the model may have added despite instructions.
  const cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
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
