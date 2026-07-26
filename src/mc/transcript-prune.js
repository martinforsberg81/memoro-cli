/**
 * Provider transcript hygiene.
 *
 * Sessions that end outside mc — closed terminal tabs, crashes, side
 * sessions a model opened next to its own — leave their transcripts in
 * ~/.codex/sessions and ~/.claude/projects forever. 11 GB had accumulated
 * unseen on the machine this was built on. A transcript survives the prune
 * if any of these hold:
 *
 *  - it is younger than the retention window (default 7 days) — live
 *    sessions keep writing, so recency also protects every running
 *    session's current transcript;
 *  - its id is resumable from the registry (tool_session_id);
 *  - its id appears in a live process's argv (codex resume <id>).
 *
 * Everything else is an orphan no session can ever reach again. Only
 * transcript files (uuid-named .jsonl) and their per-session auxiliary
 * directories are ever touched — never memory/, config, or anything else
 * living in the provider stores.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { readRegistry } from './registry.js';

export const DEFAULT_TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CODEX_ROLLOUT_RE = /^rollout-[0-9T-]+-([0-9a-f-]{36})\.jsonl$/;
const CLAUDE_TRANSCRIPT_RE = /^([0-9a-f-]{36})\.jsonl$/;
const MAX_WALK_DEPTH = 6;

export function defaultTranscriptRoots({ home = homedir() } = {}) {
  return {
    codexSessionsDir: join(home, '.codex', 'sessions'),
    claudeProjectsDir: join(home, '.claude', 'projects'),
  };
}

export function collectProtectedTranscriptIds({
  registry = readRegistry(),
  ps = defaultPs,
} = {}) {
  const ids = new Set();
  for (const entry of registry?.entries || []) {
    const id = nonEmpty(entry?.tool_session_id);
    if (id) ids.add(id.toLowerCase());
  }
  const psOutput = ps();
  for (const line of String(psOutput || '').split('\n')) {
    if (!/(?:codex|claude)/.test(line)) continue;
    const match = line.match(UUID_RE);
    if (match) ids.add(match[0].toLowerCase());
  }
  return ids;
}

export function buildTranscriptPrunePlan({
  roots = defaultTranscriptRoots(),
  registry = readRegistry(),
  olderThanMs = DEFAULT_TRANSCRIPT_RETENTION_MS,
  now = Date.now(),
  ps = defaultPs,
} = {}) {
  const protectedIds = collectProtectedTranscriptIds({ registry, ps });
  const nowMs = typeof now === 'function' ? now() : now;
  const candidates = [];
  const kept = { recent: 0, protected: 0 };

  for (const item of listCodexRollouts(roots.codexSessionsDir)) {
    classify(item, { protectedIds, nowMs, olderThanMs, candidates, kept });
  }
  for (const item of listClaudeTranscripts(roots.claudeProjectsDir)) {
    classify(item, { protectedIds, nowMs, olderThanMs, candidates, kept });
  }

  candidates.sort((a, b) => b.bytes - a.bytes);
  return {
    ok: true,
    older_than_ms: olderThanMs,
    candidates,
    counts: {
      total: candidates.length,
      bytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      kept,
      protected_ids: protectedIds.size,
    },
  };
}

export function applyTranscriptPrunePlan(plan, {
  remove = (path) => rmSync(path, { recursive: true, force: true }),
  roots = defaultTranscriptRoots(),
} = {}) {
  const removed = [];
  const errors = [];
  for (const item of plan?.candidates || []) {
    try {
      remove(item.path);
      for (const aux of item.aux_paths || []) remove(aux);
      removed.push(item);
    } catch (err) {
      errors.push({ ...item, error: err?.message || String(err) });
    }
  }
  removeEmptyDirs(roots.codexSessionsDir);
  return {
    ok: errors.length === 0,
    removed,
    counts: {
      total: removed.length,
      bytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    },
    ...(errors.length ? { errors } : {}),
  };
}

function classify(item, { protectedIds, nowMs, olderThanMs, candidates, kept }) {
  if (protectedIds.has(item.id)) {
    kept.protected += 1;
    return;
  }
  if (nowMs - item.mtimeMs < olderThanMs) {
    kept.recent += 1;
    return;
  }
  candidates.push({
    source: item.source,
    id: item.id,
    path: item.path,
    bytes: item.bytes,
    age_ms: Math.max(0, nowMs - item.mtimeMs),
    ...(item.auxPaths?.length ? { aux_paths: item.auxPaths } : {}),
  });
}

function listCodexRollouts(root) {
  const out = [];
  walk(root, 0, (path) => {
    const match = basename(path).match(CODEX_ROLLOUT_RE);
    if (!match) return;
    const stats = safeStat(path);
    if (!stats?.isFile()) return;
    out.push({
      source: 'codex',
      id: match[1].toLowerCase(),
      path,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  });
  return out;
}

function listClaudeTranscripts(root) {
  const out = [];
  for (const project of safeReaddir(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    for (const entry of safeReaddir(projectDir)) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(CLAUDE_TRANSCRIPT_RE);
      if (!match) continue;
      const path = join(projectDir, entry.name);
      const stats = safeStat(path);
      if (!stats) continue;
      const id = match[1].toLowerCase();
      const auxDir = join(projectDir, match[1]);
      out.push({
        source: 'claude',
        id,
        path,
        bytes: stats.size + dirBytes(auxDir),
        mtimeMs: stats.mtimeMs,
        auxPaths: existsSync(auxDir) ? [auxDir] : [],
      });
    }
  }
  return out;
}

function walk(root, depth, visit) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, depth + 1, visit);
    else visit(path);
  }
}

function dirBytes(root, depth = 0) {
  if (depth > MAX_WALK_DEPTH || !existsSync(root)) return 0;
  let total = 0;
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += dirBytes(path, depth + 1);
    else total += safeStat(path)?.size || 0;
  }
  return total;
}

function removeEmptyDirs(root, depth = 0) {
  if (depth > MAX_WALK_DEPTH || !existsSync(root)) return false;
  let empty = true;
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && removeEmptyDirs(path, depth + 1)) {
      // Verified empty just above; recursive:true only satisfies rmSync's
      // directory contract.
      try { rmSync(path, { recursive: true, force: true }); } catch { empty = false; }
    } else {
      empty = false;
    }
  }
  // Never remove the root itself — only emptied date/subdirectories.
  return depth > 0 && empty;
}

function defaultPs() {
  const result = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  return result?.status === 0 ? result.stdout : '';
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
