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
import { join, basename } from 'node:path';

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
 * @param {string} [parts.map]       — MEMORO.md contents (the repo's intent-map)
 * @param {string} [parts.role]      — orchestrator framing
 * @param {string} [parts.lens]      — Memoro coding lens (who the user is)
 * @param {string} [parts.focus]     — soft opening pointer ("currently on X")
 * @param {string} [parts.lifecycle] — MEMORO.md lifecycle OFFER block
 *   (Phase 2). Read-only on mc's side: it tells the grounded LLM it MAY
 *   offer to seed/update the map, always with the user's confirmation.
 * @returns {string} markdown body for the managed block
 */
export function assembleBundle({ map, role, lens, focus, lifecycle } = {}) {
  const sections = [];

  const cleanMap = nonEmpty(map);
  const cleanRole = nonEmpty(role);
  const cleanLens = nonEmpty(lens);
  const cleanFocus = nonEmpty(focus);
  const cleanLifecycle = nonEmpty(lifecycle);

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
  if (cleanLifecycle) {
    sections.push(section('Keeping the map current (MEMORO.md)', cleanLifecycle));
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

// ─────────────────────────────────────────────────────────────
// Pure: MEMORO.md lifecycle (Phase 2) — OFFER, never auto-write
//
// mc itself NEVER writes MEMORO.md. The lifecycle is realised as guidance
// folded into the grounding bundle: when the map is absent the bundle
// hands the LLM a seed template + an instruction to OFFER seeding; when
// nodes look in-flight it surfaces them + an instruction to OFFER an
// update. Every write is the LLM's, confirmed by the user. The default
// grounding path stays strictly read-only — asserted in the tests.
// ─────────────────────────────────────────────────────────────

/**
 * An initial MEMORO.md skeleton the grounded LLM can OFFER to write when
 * the repo has no map. Mirrors this repo's reference form (north star →
 * long-term goals → nodes) and keeps the sparse-by-rule reminder so the
 * seeded file stays a map, not a docs dump. Pure + deterministic.
 *
 * @param {object} [arg]
 * @param {string} [arg.repoName] — threaded into the heading; generic if absent
 */
export function seedTemplate({ repoName } = {}) {
  const name = nonEmpty(repoName) || 'this repo';
  return [
    `# MEMORO.md — ${name}`,
    '',
    `The intent-map for ${name}: **what** we're building, **where** we're headed,`,
    'and **where everything stands.** Sparse by rule — a node is never more than a',
    'name, 2–3 sentences, and a `status · scope · timeframe` line, with an optional',
    'pointer to a detailed plan. Detail lives in `docs/plans/`, never here.',
    '',
    '## North star',
    '',
    '_One or two sentences: the change this repo exists to make._',
    '',
    '## Long-term goals',
    '',
    '- **G1 — …** _the durable outcome_',
    '',
    '## Delmål & projects   (`status · scope · timeframe`)',
    '',
    '### <Area>   · serves G1',
    '- **<Node name>** — `active · M · now`',
    '  _2–3 sentences: what + why + where it stands._ → `docs/plans/<plan>.md`',
    '',
  ].join('\n');
}

// A node's status looks "in-flight" (worth a re-check at grounding) when
// its status token is one of these. Settled tokens (done/shipped/planned/
// later/gated/next/blocked) are deliberately NOT flagged — the heuristic
// is intentionally low-false-positive: it nudges the LLM to confirm only
// the things that claim to be happening right now.
const IN_FLIGHT_STATUS = /\b(active|in-progress|in progress|now)\b/i;

// A map node line: `- **Name** — \`status · … · …\``. We pull the name +
// the backtick-delimited status atom so detectStale can reason per node.
const NODE_LINE = /^\s*[-*]\s+\*\*(.+?)\*\*.*?`([^`]+)`/;

/**
 * Light, low-false-positive staleness heuristic. Returns the display
 * labels ("Name — `status`") of nodes whose status token reads as
 * in-flight, so grounding can surface a gentle "verify these are still
 * current" nudge. It NEVER asserts a node is stale and never mutates
 * anything — the LLM decides, with the user, whether to act.
 *
 * Deliberately minimal: settled statuses are ignored; a map with none
 * returns []. Never throws on malformed input.
 *
 * @param {string|null} map — MEMORO.md contents
 * @returns {string[]} display labels of in-flight nodes (possibly empty)
 */
export function detectStale(map) {
  const text = nonEmpty(map);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(NODE_LINE);
    if (!m) continue;
    const [, name, status] = m;
    if (IN_FLIGHT_STATUS.test(status)) {
      out.push(`${name.trim()} — \`${status.trim()}\``);
    }
  }
  return out;
}

/**
 * The read-only MEMORO.md lifecycle OFFER block folded into the bundle.
 * Pure. mc writes nothing here — this is *instructions to the LLM*:
 *
 *   - No map  → include the seed template + "OFFER to create it" (opt-in).
 *   - Map     → "you MAY offer to update it" + (if any) the in-flight
 *               nodes to re-check. Always confirmed with the user; never
 *               a silent write.
 *
 * @param {object} [arg]
 * @param {string} [arg.map]      — MEMORO.md contents (null/empty ⇒ seed)
 * @param {string} [arg.repoName] — for the seed template heading
 */
export function lifecycleGuidance({ map, repoName } = {}) {
  const text = nonEmpty(map);
  if (!text) {
    return [
      'This repo has **no `MEMORO.md`** yet — the intent-map that grounds every',
      'future session. As your first move you MAY *offer* to seed one: ask the',
      'user, and only if they agree, write the skeleton below (then fill it in',
      'with them). Never create or overwrite `MEMORO.md` without that opt-in.',
      '',
      'Suggested skeleton:',
      '',
      '```markdown',
      seedTemplate({ repoName }).trimEnd(),
      '```',
    ].join('\n');
  }

  const stale = detectStale(text);
  const lines = [
    '`MEMORO.md` is **read-only by default** — you ground in it, you do not',
    'auto-edit it. As work lands you MAY *offer* to update a node\'s status or',
    'add one, but only with the user\'s confirmation — never a silent write.',
  ];
  if (stale.length) {
    lines.push(
      '',
      'These nodes read as in-flight; if you touch their area, confirm they\'re',
      'still current and offer to tick the status:',
    );
    for (const s of stale) lines.push(`- ${s}`);
  }
  return lines.join('\n');
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
    repoName = basename(cwd),
  } = deps;

  const map = await safe(() => readMapImpl(cwd), null);
  const role = await safe(() => buildRoleImpl(cwd), null);
  const lens = await safe(() => pullLensImpl(), null);

  // MEMORO.md lifecycle OFFER (Phase 2). PURE + read-only on mc's side —
  // it only adds guidance the LLM may act on (seed when absent, offer an
  // update when nodes look in-flight), never a silent write. safe() so a
  // surprise never blocks the launch.
  const lifecycle = safeSync(() => lifecycleGuidance({ map, repoName }), null);

  const parts = { map, role, lens, focus, lifecycle };
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

function safeSync(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
