/**
 * What the interactive sessions cost in the last 24 hours: every session a
 * person opened — plan, manager, Martin's desk, the helper — on claude or
 * codex. runs.tsv is the runner's own accounting and holds none of them, so
 * they are read from the tools' own transcripts (docs/technical/mc-ui.md,
 * "Manager header").
 *
 * Interactive is what the tool says about itself: a claude transcript's
 * `entrypoint` is `cli` (a runner session's is `sdk-cli`), a codex session's
 * `originator` is `codex-tui` (the runner's is `codex_exec`).
 *
 * A day of transcripts is some 300 MB, so the page never reads one twice: a
 * cache (`~/mc/runner/desk-cost.json`) keeps each file's read offset and what
 * it has priced, and a collect reads only the bytes appended since. A runner
 * transcript is recognised from its first lines and then only its size is kept.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { estimateCost } from './prices.js';

export const DESK_COST_FILE = 'desk-cost.json';
/** A reading younger than this is the answer: the page refreshes far more often. */
export const DESK_COST_FRESH_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bytes read from a file at once; a transcript line is rarely longer. */
const CHUNK = 4 * 1024 * 1024;
/** What tells a runner transcript from an interactive one is in its first lines. */
const HEAD = 64 * 1024;
/**
 * Bytes one collect reads. The first reading of a day is some 300 MB of
 * transcripts; it is spread over collects, and the answer says it is partial.
 */
export const DESK_COST_BUDGET = 24 * 1024 * 1024;

/** A directory's entries, or none. */
function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** The file with its size when it changed inside the window, else null. */
function recent(path, since) {
  try {
    const stat = statSync(path);
    return stat.mtimeMs >= since ? { path, size: stat.size } : null;
  } catch { return null; }
}

/**
 * Claude's transcripts: `projects/<project>/<session>.jsonl`, and a known
 * interactive session's subagents in `<session>/subagents/`. Only those are
 * stat'ed: a project directory holds thousands of tool results besides.
 */
function claudeFiles(dir, since, files) {
  const out = [];
  for (const project of entries(join(dir, 'projects'))) {
    if (!project.isDirectory()) continue;
    const base = join(dir, 'projects', project.name);
    for (const item of entries(base)) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const file = recent(join(base, item.name), since);
      if (!file) continue;
      out.push(file);
      if (files[file.path]?.interactive === false) continue;
      const subagents = join(base, item.name.slice(0, -'.jsonl'.length), 'subagents');
      for (const sub of entries(subagents)) {
        if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
        const found = recent(join(subagents, sub.name), since);
        if (found) out.push(found);
      }
    }
  }
  return out;
}

/** Codex's sessions: `sessions/YYYY/MM/DD/*.jsonl`, for the days the window touches. */
function codexFiles(dir, since, now) {
  const out = [];
  const days = new Set();
  for (let at = since - DAY_MS; at <= now.getTime(); at += DAY_MS / 2) {
    const day = new Date(at);
    days.add(join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')));
  }
  // A session started on an earlier day keeps writing to that day's file.
  for (const day of days) {
    const base = join(dir, 'sessions', day);
    for (const item of entries(base)) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const file = recent(join(base, item.name), since);
      if (file) out.push(file);
    }
  }
  return out;
}

/** The complete lines from `offset` on, and the offset after the last of them. */
function readLines(path, offset, size, budget = Infinity) {
  const lines = [];
  let at = offset;
  let carry = '';
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    // Within the budget, but always to the end of at least one line, so a line
    // longer than the budget still moves the offset on.
    while (at < size && (at - offset < budget || !lines.length)) {
      const want = Math.min(CHUNK, size - at, Math.max(1024, budget - (at - offset)));
      const n = readSync(fd, buffer, 0, want, at);
      if (!n) break;
      at += n;
      const text = carry + buffer.toString('utf8', 0, n);
      const parts = text.split('\n');
      carry = parts.pop();
      lines.push(...parts);
    }
  } finally { closeSync(fd); }
  return { lines, offset: at - Buffer.byteLength(carry) };
}

const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

/** One claude message's list cost, as one request so a long-prompt tier applies. */
function messageCost(model, usage = {}) {
  const split = usage.cache_creation
    ? { cacheWrite5m: usage.cache_creation.ephemeral_5m_input_tokens || 0, cacheWrite1h: usage.cache_creation.ephemeral_1h_input_tokens || 0 }
    : {};
  return estimateCost({
    input: usage.input_tokens || 0, output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0, ...split,
  }, model, { request: true });
}

/**
 * New claude lines into a file's entry. A message is written once per content
 * block, and only the last carries its final `output_tokens`, so each message
 * id keeps its highest reading.
 */
function readClaude(entry, lines) {
  for (const line of lines) {
    if (entry.interactive == null && line.includes('"entrypoint"')) {
      const event = parse(line);
      if (event?.entrypoint) entry.interactive = event.entrypoint === 'cli';
    }
    if (entry.interactive === false) return;
    if (!line.includes('"assistant"')) continue;
    const event = parse(line);
    const message = event?.message;
    if (event?.type !== 'assistant' || !message?.id || !message.model || message.model === '<synthetic>') continue;
    const cost = messageCost(message.model, message.usage);
    const at = Date.parse(event.timestamp);
    if (cost == null) { entry.unpriced = (entry.unpriced || 0) + 1; continue; }
    const seen = entry.messages[message.id];
    if (!seen || cost > seen[1]) entry.messages[message.id] = [Number.isFinite(at) ? at : seen?.[0] ?? 0, cost];
  }
}

/**
 * New codex lines into a file's entry. Codex reports the session's running
 * total (`total_token_usage`), so each reading is kept as the cumulative cost
 * at its time; the day's cost is the last reading less the last before it.
 */
function readCodex(entry, lines) {
  for (const line of lines) {
    if (entry.interactive == null && line.includes('"session_meta"')) {
      const event = parse(line);
      const originator = event?.payload?.originator;
      if (originator) entry.interactive = originator === 'codex-tui';
    }
    if (entry.interactive === false) return;
    if (line.includes('"turn_context"')) {
      const model = parse(line)?.payload?.model;
      if (model) entry.model = model;
      continue;
    }
    if (!line.includes('"token_count"')) continue;
    const event = parse(line);
    const total = event?.payload?.info?.total_token_usage;
    if (!total) continue;
    const cost = estimateCost({ input: total.input_tokens || 0, cacheRead: total.cached_input_tokens || 0, output: total.output_tokens || 0 }, entry.model);
    if (cost == null) { entry.unpriced = (entry.unpriced || 0) + 1; continue; }
    const at = Date.parse(event.timestamp);
    if (Number.isFinite(at)) entry.readings.push([at, cost]);
  }
}

/** Messages a later chunk may still raise; the rest are folded into buckets. */
const OPEN_MESSAGES = 8;
const BUCKET_MS = 10 * 60 * 1000;

/** Drop what is older than the window, keeping a codex file's last reading before it. */
function prune(entry, since) {
  if (entry.messages) {
    const ids = Object.keys(entry.messages);
    entry.buckets ||= {};
    for (const id of ids.slice(0, Math.max(0, ids.length - OPEN_MESSAGES))) {
      const [at, cost] = entry.messages[id];
      const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
      entry.buckets[bucket] = (entry.buckets[bucket] || 0) + cost;
      delete entry.messages[id];
    }
    for (const [id, [at]] of Object.entries(entry.messages)) if (at < since) delete entry.messages[id];
    for (const bucket of Object.keys(entry.buckets)) if (Number(bucket) + BUCKET_MS <= since) delete entry.buckets[bucket];
  }
  if (entry.readings) {
    const before = entry.readings.filter(([at]) => at < since).at(-1);
    entry.readings = [...(before ? [before] : []), ...entry.readings.filter(([at]) => at >= since)];
  }
}

function costOf(entry, since) {
  if (entry.messages) {
    const open = Object.values(entry.messages).reduce((n, [at, cost]) => n + (at >= since ? cost : 0), 0);
    return open + Object.entries(entry.buckets || {}).reduce((n, [bucket, cost]) => n + (Number(bucket) >= since - BUCKET_MS ? cost : 0), 0);
  }
  const inside = entry.readings.filter(([at]) => at >= since);
  if (!inside.length) return 0;
  const before = entry.readings.find(([at]) => at < since);
  return Math.max(0, inside.at(-1)[1] - (before ? before[1] : 0));
}

/**
 * The interactive sessions' list cost over the last 24 hours, reading only
 * what changed since the cached reading. `{ cost, sessions, unpriced }`;
 * the cache is written back unless `write` is null.
 */
export function deskCost({
  claudeDir, codexDir, cache = null, now = new Date(), write = null, budget = DESK_COST_BUDGET,
} = {}) {
  const since = now.getTime() - DAY_MS;
  const age = now.getTime() - Date.parse(cache?.at || '');
  if (cache?.answer && !cache.answer.partial && age >= 0 && age < DESK_COST_FRESH_MS) return { ...cache.answer, cache };
  const files = { ...(cache?.files || {}) };
  const seen = new Set();
  let left = budget;
  let partial = false;
  const sources = [
    ...(claudeDir ? claudeFiles(claudeDir, since, files).map((file) => ({ ...file, tool: 'claude' })) : []),
    ...(codexDir ? codexFiles(codexDir, since, now).map((file) => ({ ...file, tool: 'codex' })) : []),
  ];
  for (const { path, size, tool } of sources) {
    seen.add(path);
    let entry = files[path];
    if (!entry || entry.tool !== tool || size < entry.offset) {
      entry = { tool, offset: 0, interactive: null, ...(tool === 'claude' ? { messages: {} } : { readings: [], model: null }) };
    }
    files[path] = entry;
    if (entry.interactive === false || size === entry.offset) continue;
    const reader = tool === 'claude' ? readClaude : readCodex;
    try {
      // An unknown file: its head says whose it is, and a runner's is not read further.
      if (entry.interactive == null) {
        const probe = { ...entry, messages: {}, readings: [] };
        reader(probe, readLines(path, 0, Math.min(size, HEAD)).lines);
        if (probe.interactive === false) { files[path] = { tool, offset: size, interactive: false }; continue; }
      }
      if (left <= 0) { partial = true; continue; }
      const read = readLines(path, entry.offset, size, left);
      left -= read.offset - entry.offset;
      reader(entry, read.lines);
      entry.offset = read.offset;
      if (entry.offset < size) partial = true;
    } catch { continue; }
    // A runner transcript is known from its first lines and never read again.
    if (entry.interactive === false) { delete entry.messages; delete entry.readings; delete entry.buckets; }
  }
  let cost = 0;
  let sessions = 0;
  let unpriced = 0;
  for (const [path, entry] of Object.entries(files)) {
    if (!seen.has(path)) { delete files[path]; continue; }
    if (!entry.interactive) continue;
    prune(entry, since);
    const own = costOf(entry, since);
    // A subagent's transcript is part of the session that started it.
    if (own > 0 && !path.includes('/subagents/')) sessions += 1;
    cost += own;
    unpriced += entry.unpriced || 0;
  }
  // Partial while some transcript is not yet read to its end: the cost so far.
  const answer = { cost: Math.round(cost * 100) / 100, sessions, unpriced, partial };
  const next = { at: now.toISOString(), answer, files };
  if (write) { try { write(next); } catch { /* a cache that cannot be written is still a page */ } }
  return { ...answer, cache: next };
}

/** `deskCost` against the real homes, with its cache under `~/mc/runner/`. */
export function readDeskCost({ root, claudeDir, codexDir, now = new Date(), read }) {
  const path = join(root, 'runner', DESK_COST_FILE);
  let cache = null;
  try { cache = JSON.parse(read(path, 'utf8')); } catch { cache = null; }
  const { cache: _written, ...answer } = deskCost({ claudeDir, codexDir, cache, now, write: (value) => writeJsonAtomic(path, value) });
  return answer;
}
