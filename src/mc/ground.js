/**
 * Session grounding (Phase 1 — Grounding MVP).
 *
 * Every entry into an mc session should hand the LLM the right context
 * *before the user types*. The bundle:
 *
 *   { map    — MEMORO.md from cwd, the repo's intent (read-only)
 *     role   — orchestrator framing + its purpose
 *     lens   — who the user is, from Memoro (governs language + prefs)
 *     focus  — a soft, mutable pointer ("currently on X") }
 *
 * This module owns two concerns, split so the design questions stay
 * testable in-process:
 *
 *   - `assembleBundle(parts)` — PURE. Renders the four parts into one
 *     markdown body for a managed block. No I/O. Empty parts degrade
 *     softly (a missing map / lens / focus is simply omitted).
 *   - `groundSession({ cwd, ... })` — impure orchestration. Reads the
 *     map off disk, pulls the role + (optional) lens through injectable
 *     dep-portals, assembles the bundle, and materialises it into the
 *     cwd's tool instruction file at the pre-launch slot. Every external
 *     dependency is injectable and soft-degrades on failure: no Memoro →
 *     no lens; no MEMORO.md → no map; nothing here ever throws.
 *
 * Materialisation reuses the `writeLens` managed-block pattern
 * (`src/commands/lens.js`), generalised from "just the lens" to the whole
 * bundle as one block via the adapter's `writeGrounding(markdown, {cwd})`.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────
// Pure: bundle assembly
// ─────────────────────────────────────────────────────────────

const HEADER = '# Session grounding';

const PREAMBLE =
  'You are waking into an mc session. The context below was injected ' +
  'before the user typed — read it so you start grounded in the whole, ' +
  'not from a blank slate. It is standing context, not a task.';

/**
 * Render the grounding bundle into one markdown body (no managed-block
 * markers — the adapter wraps it). Pure: same input → same output, no I/O.
 *
 * Every part is optional. A missing / empty part is omitted entirely
 * rather than rendered as an empty heading, so the soft-degrade paths
 * (no Memoro → no lens, no MEMORO.md → no map) produce clean output.
 *
 * @param {object} parts
 * @param {string} [parts.map]   — MEMORO.md contents (the repo's intent-map)
 * @param {string} [parts.role]  — orchestrator framing
 * @param {string} [parts.lens]  — Memoro coding lens (who the user is)
 * @param {string} [parts.focus] — soft opening pointer ("currently on X")
 * @returns {string} markdown body for the managed block
 */
export function assembleBundle({ map, role, lens, focus } = {}) {
  const sections = [];

  const cleanMap = nonEmpty(map);
  const cleanRole = nonEmpty(role);
  const cleanLens = nonEmpty(lens);
  const cleanFocus = nonEmpty(focus);

  if (cleanRole) {
    sections.push(section('Your role', cleanRole));
  }
  if (cleanMap) {
    sections.push(section('The map — what we are building (MEMORO.md)', cleanMap));
  }
  if (cleanLens) {
    sections.push(section('Who you are working with (lens)', cleanLens));
  }
  if (cleanFocus) {
    sections.push(section('Current focus', cleanFocus));
  }

  const body = [`${HEADER}`, '', PREAMBLE, '', ...interleave(sections)].join('\n');
  return body.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function section(title, content) {
  return `## ${title}\n\n${content.trim()}`;
}

function interleave(sections) {
  // One blank line between sections.
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    out.push(sections[i]);
    if (i < sections.length - 1) out.push('');
  }
  return out;
}

function nonEmpty(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length ? t : null;
}

// ─────────────────────────────────────────────────────────────
// Impure: gather the parts + materialise
// ─────────────────────────────────────────────────────────────

/**
 * Read the repo intent-map (MEMORO.md) from cwd. READ-ONLY in Phase 1 —
 * we never write or seed it here. Returns null when absent (no-MEMORO.md
 * soft-degrade) or unreadable.
 */
export async function readMap(cwd, { readFileImpl = readFile, exists = existsSync } = {}) {
  const path = join(cwd, 'MEMORO.md');
  if (!exists(path)) return null;
  try {
    return await readFileImpl(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The orchestrator role framing. Authority lives in the verbs / canonical
 * docs — we point at the repo's own protocol + coordination files rather
 * than duplicating their content here. The grounded session reads those
 * files via its native tooling; this block tells it they exist and why
 * they matter, so the session wakes knowing its role without the user
 * re-explaining it.
 *
 * Phase 5 ships this as package-canon; Phase 1 references the existing
 * repo `.claude` sources, soft-degrading to a terse default if none are
 * present (so grounding still works in a repo without them).
 */
export function buildRole(cwd, { exists = existsSync } = {}) {
  const coordination = join(cwd, '.claude', 'skills', 'agent-coordination.md');
  const protocol = join(cwd, 'docs', 'coding-agent-protocol.md');
  const beCoordinator = join(cwd, '.claude', 'commands', 'be-coordinator.md');

  const refs = [];
  if (exists(protocol)) refs.push('`docs/coding-agent-protocol.md` — the project protocol');
  if (exists(coordination)) {
    refs.push('`.claude/skills/agent-coordination.md` — the coordinator ↔ agent loop and why it exists');
  }
  if (exists(beCoordinator)) refs.push('`.claude/commands/be-coordinator.md` — priming as coordinator');

  const lines = [
    'You are the orchestrator of this work. One human directs a fleet; this ' +
      'session is the high-altitude seat that holds the whole — the plan, the ' +
      'intent, the bird\'s-eye view across many changes. Protect that altitude: ' +
      'push implementation detail out to focused agents, keep design judgment here.',
  ];
  if (refs.length) {
    lines.push('', 'Canonical sources for this role (read them, don\'t make the user re-explain):');
    for (const r of refs) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

/**
 * Pull the Memoro coding lens for inclusion in the bundle. Phase 1 uses
 * ONLY the existing `lens pull` mechanism — no new Memoro wiring. The
 * dependency is injected so tests never hit the network or keychain, and
 * the default soft-degrades to null (no lens) on any failure: not logged
 * in, Memoro unreachable, no observation data yet.
 *
 * Note: we read the lens *markdown*, we do not re-materialise it — the
 * SessionStart `lens pull` hook still owns writing the standalone lens
 * block to the global config. Here it's one part of the grounding bundle.
 */
export async function pullLensMarkdown({ fetchLens = defaultFetchLens } = {}) {
  try {
    const md = await fetchLens();
    return nonEmpty(md);
  } catch {
    return null;
  }
}

async function defaultFetchLens() {
  // Reuse the existing lens path: keychain token + portrait-coding endpoint.
  // Any missing piece (no token, no config, no data) returns null instead
  // of throwing, so grounding proceeds without a lens.
  const { getSecret } = await import('../lib/keychain.js');
  const { ACCOUNTS } = await import('../commands/auth.js');
  const { readConfig, getApiUrl } = await import('../lib/config.js');
  const { memoroFetch } = await import('../lib/api.js');

  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) return null;
  const config = await readConfig();
  const apiUrl = getApiUrl([]) || config.apiUrl;
  if (!apiUrl) return null;
  const result = await memoroFetch(apiUrl, '/api/lens/portrait-coding', { token });
  return result?.markdown || null;
}

/**
 * Ground a session in place: assemble the bundle from cwd + injected
 * dep-portals and materialise it into the cwd's tool instruction file at
 * the pre-launch slot. Returns a result object; NEVER throws — grounding
 * must not block the launch.
 *
 * @param {object} arg
 * @param {string} arg.cwd          — the session's working directory
 * @param {object} arg.adapter      — tool adapter exposing writeGrounding({cwd})
 * @param {string} [arg.focus]      — soft opening pointer
 * @param {object} [arg.deps]       — injection for tests
 * @returns {Promise<{ ok: boolean, path?: string, parts: object, reason?: string }>}
 */
export async function groundSession({ cwd, adapter, focus = null, deps = {} } = {}) {
  if (!cwd || !adapter || typeof adapter.writeGrounding !== 'function') {
    return { ok: false, reason: 'cwd + adapter with writeGrounding required', parts: {} };
  }

  const {
    readMapImpl = (c) => readMap(c, deps.mapDeps || {}),
    buildRoleImpl = (c) => buildRole(c, deps.roleDeps || {}),
    pullLensImpl = () => pullLensMarkdown(deps.lensDeps || {}),
  } = deps;

  const map = await safe(() => readMapImpl(cwd), null);
  const role = await safe(() => buildRoleImpl(cwd), null);
  const lens = await safe(() => pullLensImpl(), null);

  const parts = { map, role, lens, focus };
  const markdown = assembleBundle(parts);

  try {
    const path = await adapter.writeGrounding(markdown, { cwd });
    return { ok: true, path, parts };
  } catch (err) {
    return { ok: false, reason: err?.message || 'write failed', parts };
  }
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
