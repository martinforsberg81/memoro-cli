/**
 * `mc reconcile` classifier (§9e).
 *
 * Two action buckets surfaced in v1 (file-overlap heuristics deferred —
 * tracked in §11g / open questions):
 *
 *   safe_to_end             — squash-phantom branches. Deterministic
 *                             via cherry + content-diff. `--apply
 *                             --only-safe` acts on this bucket only.
 *   verify_and_end          — transcript-mention PR look-up. A recent
 *                             merged PR's number shows up in the
 *                             session's transcript, suggesting the
 *                             session's work was carried elsewhere.
 *                             Always human-reviewed.
 *
 * A third surface, `branch_merged_recently`, lists sessions whose
 * branch was merged via gh in the last 7 days but where cherry didn't
 * confirm a phantom. Useful information; not auto-applyable because a
 * matching head ref could still cover divergent work in pathological
 * cases.
 *
 * The acceptance bar coordinator named: "Can I run `mc reconcile
 * --apply --only-safe` on a cron and never lose work?" Drives the
 * choice to put only squash-phantoms in `--only-safe`'s reach.
 *
 * `gh` calls go through an injectable portal so soft-degradation when
 * `gh` is missing turns the verify_and_end bucket empty rather than
 * crashing the verb.
 *
 * Pure: every external dep (gh, phantom detector, transcript reader,
 * clock) is injected. Tests cover each tier.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { detectSquashPhantom } from './squash-phantom.js';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Per coordinator: cap transcript scans so very long sessions stay off the hot path. */
export const MAX_TRANSCRIPT_BYTES = 200 * 1024;

/**
 * Find PR-like mentions (`#NNNN`) in a body of text. Returns the
 * unique numbers in insertion order, dropping obvious junk
 * (zero/leading-zero/over-a-million).
 *
 * Pure for testing.
 */
export function findPrMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(/#(\d{1,6})\b/g)) {
    const raw = m[1];
    if (raw.startsWith('0')) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n >= 1_000_000) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Resolve and read the tail of a Claude Code transcript for a given
 * worktree path. Claude stores transcripts under
 * `~/.claude/projects/<encoded-path>/*.jsonl` where the encoding
 * replaces `/` and `.` with `-`. Returns the trailing
 * `MAX_TRANSCRIPT_BYTES` of the newest jsonl, or null if not found.
 *
 * `readDir` and `readFileSlice` are injectable for tests.
 */
export function defaultReadTranscript(worktreePath, {
  projectsRoot = join(homedir(), '.claude', 'projects'),
  maxBytes = MAX_TRANSCRIPT_BYTES,
} = {}) {
  if (!worktreePath) return null;
  const encoded = worktreePath.replace(/[/.]/g, '-');
  const dir = join(projectsRoot, encoded);
  if (!existsSync(dir)) return null;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const jsonls = names.filter((n) => n.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;
  // Newest by mtime.
  let newest = null;
  let newestMtime = -Infinity;
  for (const n of jsonls) {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (st.mtimeMs > newestMtime) { newest = p; newestMtime = st.mtimeMs; }
    } catch { /* skip */ }
  }
  if (!newest) return null;
  try {
    const raw = readFileSync(newest, 'utf8');
    // Cap to the trailing `maxBytes` so very long transcripts stay
    // bounded. The transcript scan only looks for `#NNNN` mentions
    // so missing earlier history is acceptable.
    return raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
  } catch { return null; }
}

/**
 * Default gh portal — same shape as the one in squash-phantom.js,
 * extended with `prInfo(number)` for transcript-mention look-up.
 * Soft-degrades to null / [] on any failure; classifier treats those
 * as "no signal" and skips the bucket.
 */
export function defaultGh() {
  return {
    async prListMerged(branch) {
      const r = spawnSync('gh', [
        'pr', 'list', '--head', branch, '--state', 'merged',
        '--json', 'number,mergedAt',
      ], { encoding: 'utf8' });
      if (r.status !== 0) return [];
      try {
        const arr = JSON.parse(r.stdout || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch { return []; }
    },
    async prInfo(number) {
      const r = spawnSync('gh', [
        'pr', 'view', String(number),
        '--json', 'number,mergedAt,state,title',
      ], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      try {
        const obj = JSON.parse(r.stdout || 'null');
        if (!obj || typeof obj !== 'object') return null;
        return obj;
      } catch { return null; }
    },
  };
}

/**
 * Classify each registry entry into the action buckets above.
 *
 * Deps (all injectable):
 *   - gh                — { prListMerged, prInfo }, see defaultGh()
 *   - detectPhantom     — defaults to detectSquashPhantom
 *   - readTranscript    — defaults to defaultReadTranscript
 *   - now               — clock for the "within 7 days" cutoff
 *
 * Returns:
 *   {
 *     actions: { safe_to_end, branch_merged_recently, verify_and_end },
 *     skipped: [{ entry, reason }]
 *   }
 *
 * Each bucket holds `{ entry, source, ...extra }` objects. The CLI
 * formats them; the classifier itself emits no console output.
 */
export async function classifyEntries(entries, {
  gh = defaultGh(),
  detectPhantom = (args) => detectSquashPhantom(args),
  readTranscript = (wt) => defaultReadTranscript(wt),
  now = Date.now(),
} = {}) {
  const safe = [];
  const branchMerged = [];
  const verify = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry?.branch) {
      skipped.push({ name: entry?.name ?? '<unknown>', reason: 'no-branch' });
      continue;
    }
    const repoDir = entry.primary_worktree || entry.worktree_path;
    if (!repoDir) {
      skipped.push({ name: entry.name, reason: 'no-repo-dir' });
      continue;
    }

    // Tier 1 — squash-phantom (deterministic, local + gh fallback).
    let phantom;
    try {
      phantom = await detectPhantom({ repoDir, branch: entry.branch, gh });
    } catch (err) {
      skipped.push({ name: entry.name, reason: `phantom-detect-failed: ${err.message}` });
      continue;
    }
    if (phantom?.isPhantom) {
      safe.push({
        entry,
        source: 'squash-phantom',
        confidence: phantom.cherryConfirms ? 'high' : 'medium',
      });
      continue;
    }

    // Tier 2a — branch-match merged in last 7d (informational).
    let merged = [];
    try { merged = await gh.prListMerged(entry.branch); } catch { merged = []; }
    const recentMerged = (merged || []).filter((p) => isRecent(p?.mergedAt, now));
    if (recentMerged.length > 0) {
      branchMerged.push({
        entry,
        source: 'branch-merged-recent',
        prs: recentMerged.map(normalisePr),
      });
      // Not `continue` — a session can also have transcript-mentions
      // for OTHER PRs; show both signals. But for now, take this as
      // a strong-enough signal and move on.
      continue;
    }

    // Tier 2b — transcript-mention.
    const verified = await classifyTranscriptMentions(entry, { readTranscript, gh, now });
    if (verified.length > 0) {
      verify.push({
        entry,
        source: 'transcript-mention',
        prs: verified,
      });
      continue;
    }

    skipped.push({ name: entry.name, reason: 'no-signals' });
  }

  return {
    actions: {
      safe_to_end: safe,
      branch_merged_recently: branchMerged,
      verify_and_end: verify,
    },
    skipped,
    deferred_categories: ['file-overlap'],
  };
}

async function classifyTranscriptMentions(entry, { readTranscript, gh, now }) {
  let text;
  try { text = await readTranscript(entry.worktree_path); } catch { text = null; }
  if (!text) return [];
  const mentions = findPrMentions(text);
  if (mentions.length === 0) return [];
  if (!gh?.prInfo) return [];
  const verified = [];
  for (const num of mentions) {
    let info;
    try { info = await gh.prInfo(num); } catch { info = null; }
    if (info?.mergedAt && isRecent(info.mergedAt, now)) {
      verified.push(normalisePr(info));
    }
  }
  return verified;
}

function isRecent(isoString, now) {
  if (!isoString) return false;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return false;
  return (now - t) < SEVEN_DAYS_MS;
}

function normalisePr(pr) {
  return {
    number: pr.number ?? null,
    merged_at: pr.mergedAt ?? null,
    title: pr.title ?? null,
    state: pr.state ?? null,
  };
}
