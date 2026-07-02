import { requestBroker } from '../broker/client.js';
import { readLocalSessionOutput } from '../broker/cloud.js';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_OUTPUT_TIMEOUT_MS = 750;
const DEFAULT_FOLLOW_INTERVAL_MS = 5_000;
const EXCERPT_CHARS = 500;
const DISPOSITIONS = ['awaiting_reply', 'review_suggested', 'working', 'idle', 'stale_idle', 'dead'];
const ONLY_ALIASES = {
  actionable: ['awaiting_reply', 'review_suggested'],
  active: ['awaiting_reply', 'review_suggested', 'working'],
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  const request = deps.requestBroker || requestBroker;
  const readOutput = deps.readOutput || ((sessionId) => readLocalSessionOutput({
    sessionId,
    timeoutMs: opts.outputTimeoutMs,
  }));
  const wait = deps.sleep || sleep;

  const collectSnapshot = () => collectWatchSnapshot({
    request,
    readOutput,
    opts,
    stderr,
    now: currentNow(deps),
  });

  if (opts.follow) {
    let previous = null;
    for (let iteration = 0; ; iteration += 1) {
      const snapshot = await collectSnapshot();
      if (!previous) {
        writeFollowSnapshot(stdout, snapshot, opts);
      } else {
        const events = diffWatchSnapshots(previous, snapshot);
        if (events.length) writeFollowEvents(stdout, { snapshot, events }, opts);
      }
      previous = snapshot;
      if (opts.iterations && iteration + 1 >= opts.iterations) return 0;
      await wait(opts.intervalMs);
    }
  }

  const snapshot = await collectSnapshot();
  if (opts.json) stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  else stdout.write(renderWatchSnapshot(snapshot));
  return 0;
}

async function collectWatchSnapshot({ request, readOutput, opts, stderr, now }) {
  const broker = await request({ type: 'sessions' }).catch(async (err) => {
    const status = await request({ type: 'status' }).catch(() => null);
    if (status?.ok && Array.isArray(status.sessions)) return status;
    return { ok: false, error: err.message || String(err) };
  });
  if (!broker?.ok || !Array.isArray(broker.sessions)) {
    stderr.write(`mc: broker sessions unavailable (${broker?.error || 'unknown'})\n`);
    return 1;
  }

  const outputs = new Map();
  if (opts.readOutput) {
    for (const session of broker.sessions) {
      if (!isReadableSession(session, opts)) continue;
      const id = session.id || session.coding_session_id;
      const output = await readOutput(id).catch(() => '');
      outputs.set(id, output);
    }
  }

  const snapshot = buildWatchSnapshot({
    sessions: broker.sessions,
    outputs,
    includeDead: opts.includeDead,
    excludeWorktreeNames: [
      ...(opts.hideSelf && process.env.MC_SESSION_NAME ? [process.env.MC_SESSION_NAME] : []),
      ...opts.excludeWorktreeNames,
    ],
    onlyDispositions: opts.onlyDispositions,
    now,
  });
  return snapshot;
}

export function buildWatchSnapshot({
  sessions = [],
  outputs = new Map(),
  includeDead = false,
  excludeWorktreeName = null,
  excludeWorktreeNames = [],
  onlyDispositions = [],
  now = Date.now(),
} = {}) {
  const excluded = new Set([
    ...(excludeWorktreeName ? [excludeWorktreeName] : []),
    ...(Array.isArray(excludeWorktreeNames) ? excludeWorktreeNames : []),
  ].filter(Boolean));
  const only = new Set(Array.isArray(onlyDispositions) ? onlyDispositions : []);
  const items = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => includeDead || session?.session_state !== 'dead')
    .filter((session) => !excluded.has(deriveWorktreeName(session?.cwd)))
    .map((session) => summarizeSession(session, outputs.get(session.id || session.coding_session_id) || '', now))
    .filter((session) => !only.size || only.has(session.disposition))
    .sort(compareWatchItems);
  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    sessions: items,
    counts: countByDisposition(items),
  };
}

export function summarizeSession(session = {}, output = '', now = Date.now()) {
  const id = session.coding_session_id || session.id || null;
  const cwd = stringOrNull(session.cwd);
  const disposition = classifySession({ session, output, now });
  const excerpt = cleanSessionOutput(output).slice(-EXCERPT_CHARS);
  return {
    id,
    name: stringOrNull(session.name) || deriveWorktreeName(cwd) || id,
    tool: stringOrNull(session.tool),
    cwd,
    worktree_name: deriveWorktreeName(cwd),
    state: stringOrNull(session.session_state || session.state) || 'unknown',
    attachable: session.attachable !== false,
    disposition,
    last_output_at: stringOrNull(session.last_output_at || session.lastOutputAt),
    last_input_at: stringOrNull(session.last_input_at || session.lastInputAt),
    last_output_age_seconds: ageSeconds(session.last_output_at || session.lastOutputAt, now),
    latest_text: excerpt,
    recommended_reply: extractRecommendedReply(excerpt),
    command: id ? `mc sessions send ${id} "<message>"` : null,
  };
}

export function classifySession({ session = {}, output = '', now = Date.now() } = {}) {
  if (session.exit || session.session_state === 'dead' || session.state === 'dead') return 'dead';
  const tail = cleanSessionOutput(output).slice(-1200);
  if (/\bWorking\(/i.test(tail)) return 'working';
  if (extractRecommendedReply(tail) || looksLikeOpenQuestion(tail)) return 'awaiting_reply';
  if (looksLikeReviewSuggestion(tail)) return 'review_suggested';
  const outputAge = ageSeconds(session.last_output_at || session.lastOutputAt, now);
  if (typeof outputAge === 'number' && outputAge > 60 * 60) return 'stale_idle';
  return 'idle';
}

export function extractRecommendedReply(text) {
  const value = String(text || '');
  const patterns = [
    /Rekommenderat svar:\s*[“"]?(.+?)[”"]?(?:\n|$)/i,
    /Recommended reply:\s*[“"]?(.+?)[”"]?(?:\n|$)/i,
    /Föreslaget svar:\s*[“"]?(.+?)[”"]?(?:\n|$)/i,
    /Suggested reply:\s*[“"]?(.+?)[”"]?(?:\n|$)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/\s+/g, ' ').slice(0, 500);
  }
  return null;
}

export function diffWatchSnapshots(previous = {}, current = {}) {
  const before = new Map((previous.sessions || []).map((session) => [session.id, session]));
  const after = new Map((current.sessions || []).map((session) => [session.id, session]));
  const events = [];
  for (const session of current.sessions || []) {
    const prior = before.get(session.id);
    if (!prior) {
      events.push({ type: 'new', session, previous: null });
    } else if (watchSignature(prior) !== watchSignature(session)) {
      events.push({ type: 'changed', session, previous: prior });
    }
  }
  for (const session of previous.sessions || []) {
    if (!after.has(session.id)) events.push({ type: 'removed', session: null, previous: session });
  }
  return events.sort(compareWatchEvents);
}

export function renderWatchSnapshot(snapshot) {
  const out = [];
  out.push('mc sessions watch');
  out.push(`generated ${snapshot.generated_at}`);
  out.push('');
  if (!snapshot.sessions.length) {
    out.push('(no local broker sessions)');
    return out.join('\n') + '\n';
  }
  for (const session of snapshot.sessions) {
    const age = formatAge(session.last_output_age_seconds);
    const label = [
      `[${session.name || session.id}]`,
      session.disposition,
      session.state,
      age,
    ].filter(Boolean).join('  ');
    out.push(label);
    if (session.latest_text) out.push(`  text: ${oneLine(session.latest_text, 180)}`);
    if (session.recommended_reply) out.push(`  recommended: ${session.recommended_reply}`);
    if (session.command) out.push(`  send: ${session.command}`);
  }
  out.push('');
  const counts = Object.entries(snapshot.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  if (counts) out.push(counts);
  return out.join('\n') + '\n';
}

export function renderWatchEvents({ snapshot, events }) {
  const out = [];
  out.push('mc sessions watch changes');
  out.push(`generated ${snapshot.generated_at}`);
  out.push('');
  for (const event of events) {
    const session = event.session || event.previous;
    const age = formatAge(session?.last_output_age_seconds);
    const parts = [
      event.type,
      `[${session?.name || session?.id}]`,
      event.session?.disposition || event.previous?.disposition,
      event.session && event.previous ? `from=${event.previous.disposition}` : null,
      age,
    ].filter(Boolean);
    out.push(parts.join('  '));
    if (event.session?.latest_text) out.push(`  text: ${oneLine(event.session.latest_text, 180)}`);
    if (event.session?.recommended_reply) out.push(`  recommended: ${event.session.recommended_reply}`);
    if (event.session?.command) out.push(`  send: ${event.session.command}`);
  }
  out.push('');
  const counts = Object.entries(snapshot.counts || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  if (counts) out.push(counts);
  return out.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = {
    json: false,
    follow: false,
    intervalMs: DEFAULT_FOLLOW_INTERVAL_MS,
    iterations: null,
    onlyDispositions: [],
    includeDead: false,
    hideSelf: false,
    excludeWorktreeNames: [],
    readOutput: true,
    outputTimeoutMs: DEFAULT_OUTPUT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--follow') opts.follow = true;
    else if (arg === '--interval') {
      const ms = Number(argv[++i]);
      if (!Number.isFinite(ms) || ms < 0) return { ...opts, error: '--interval must be a non-negative number of milliseconds' };
      opts.intervalMs = ms;
    }
    else if (arg === '--iterations') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return { ...opts, error: '--iterations must be a positive integer' };
      opts.iterations = n;
    }
    else if (arg === '--only') {
      const value = argv[++i];
      if (!value) return { ...opts, error: '--only requires a value' };
      const parsed = parseOnlyDispositions(value);
      if (parsed.error) return { ...opts, error: parsed.error };
      opts.onlyDispositions.push(...parsed.values);
    }
    else if (arg === '--include-dead') opts.includeDead = true;
    else if (arg === '--hide-self') opts.hideSelf = true;
    else if (arg === '--exclude-worktree') {
      const name = argv[++i];
      if (!name) return { ...opts, error: '--exclude-worktree requires a worktree name' };
      opts.excludeWorktreeNames.push(name);
    }
    else if (arg === '--no-output') opts.readOutput = false;
    else if (arg === '--output-timeout') {
      const ms = Number(argv[++i]);
      if (!Number.isFinite(ms) || ms < 0) return { ...opts, error: '--output-timeout must be a non-negative number of milliseconds' };
      opts.outputTimeoutMs = ms;
    } else if (arg === '--help' || arg === '-h') {
      return { ...opts, error: 'usage — `mc sessions watch [--follow] [--json] [--interval <ms>] [--iterations <n>] [--only <actionable|active|disposition>] [--include-dead] [--hide-self] [--exclude-worktree <name>] [--no-output]`' };
    } else {
      return { ...opts, error: `unknown flag: ${arg}` };
    }
  }
  return opts;
}

function parseOnlyDispositions(value) {
  const values = [];
  for (const raw of String(value || '').split(',')) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (ONLY_ALIASES[key]) {
      values.push(...ONLY_ALIASES[key]);
    } else if (DISPOSITIONS.includes(key)) {
      values.push(key);
    } else {
      return {
        error: `--only must be actionable, active, or one of: ${DISPOSITIONS.join(', ')}`,
      };
    }
  }
  if (!values.length) return { error: '--only requires at least one disposition' };
  return { values: [...new Set(values)] };
}

function isReadableSession(session, opts) {
  if (!session?.id && !session?.coding_session_id) return false;
  if (session.session_state === 'dead' && !opts.includeDead) return false;
  return session.attachable !== false;
}

function looksLikeOpenQuestion(text) {
  const tail = String(text || '').trim().slice(-600);
  if (!tail) return false;
  return /([?？]\s*(?:$|\n)|Vill du|Ska jag|Want me|Do you want|Should I|Which option|Vilken)/i.test(tail);
}

function looksLikeReviewSuggestion(text) {
  const tail = String(text || '').trim().slice(-900);
  return /(Jag skulle|Min rekommendation|Föreslagen rewrite|Så min reviderade plan|I would|Recommended plan|I recommend)/i.test(tail);
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

function oneLine(value, max) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ageSeconds(isoString, now) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}

function formatAge(seconds) {
  if (typeof seconds !== 'number') return null;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function deriveWorktreeName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compareWatchItems(a, b) {
  const weight = {
    awaiting_reply: 0,
    review_suggested: 1,
    working: 2,
    idle: 3,
    stale_idle: 4,
    dead: 5,
  };
  return (weight[a.disposition] ?? 9) - (weight[b.disposition] ?? 9)
    || (a.last_output_age_seconds ?? Number.MAX_SAFE_INTEGER) - (b.last_output_age_seconds ?? Number.MAX_SAFE_INTEGER)
    || String(a.name || a.id).localeCompare(String(b.name || b.id));
}

function watchSignature(session) {
  return JSON.stringify({
    disposition: session?.disposition || null,
    recommended_reply: session?.recommended_reply || null,
    latest_text: shouldTrackLatestText(session) ? oneLine(session?.latest_text || '', 240) : null,
    state: session?.state || null,
    attachable: session?.attachable !== false,
  });
}

function shouldTrackLatestText(session) {
  return ['awaiting_reply', 'review_suggested', 'idle', 'stale_idle'].includes(session?.disposition);
}

function compareWatchEvents(a, b) {
  const weight = { new: 0, changed: 1, removed: 2 };
  return (weight[a.type] ?? 9) - (weight[b.type] ?? 9)
    || compareWatchItems(a.session || a.previous, b.session || b.previous);
}

function writeFollowSnapshot(stdout, snapshot, opts) {
  if (opts.json) stdout.write(JSON.stringify({ type: 'snapshot', ...snapshot }) + '\n');
  else stdout.write(renderWatchSnapshot(snapshot));
}

function writeFollowEvents(stdout, { snapshot, events }, opts) {
  if (opts.json) {
    stdout.write(JSON.stringify({
      type: 'events',
      generated_at: snapshot.generated_at,
      events,
      counts: snapshot.counts,
    }) + '\n');
  } else {
    stdout.write(renderWatchEvents({ snapshot, events }));
  }
}

function countByDisposition(items) {
  const counts = {};
  for (const item of items) counts[item.disposition] = (counts[item.disposition] || 0) + 1;
  return counts;
}

function currentNow(deps = {}) {
  if (typeof deps.now === 'function') return deps.now();
  return deps.now || Date.now();
}
