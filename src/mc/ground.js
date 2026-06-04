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

import { readPackageCanon } from './canon.js';

// ─────────────────────────────────────────────────────────────
// Pure: bundle assembly
// ─────────────────────────────────────────────────────────────

const HEADER = '# Session grounding';

const PREAMBLE =
  'You are waking into an mc session. The context below was injected ' +
  'before the user typed — read it so you start grounded in the whole, ' +
  'not from a blank slate. It is standing context, not a task.';

// ─────────────────────────────────────────────────────────────
// Pure: language resolution (Phase 4)
//
// The session's RENDER language — the language the LLM wakes and responds
// in — is DERIVED from the user's Memoro profile, never a static choice.
// The default is English, expressed as `null` (no directive at all), so an
// ungrounded / English session carries zero extra noise.
//
// SERVER-GATE NOTE (verified live 2026-06-03 against meetmemoro.app): the
// lens endpoints do NOT expose a language/locale field today, and no
// /api/user_state endpoint exists (all 404). So this resolver returns null
// (English) for every real response right now — language steering is
// server-gated. It is wired against the actual response SHAPE (the lens
// object is the only realistic carrier) across a small set of candidate
// keys, so the moment the server adds a `language` / `locale` / nested
// preference field, language steering lights up with no CLI change.
// ─────────────────────────────────────────────────────────────

// Minimal locale-code → language-label map. Deliberately small: it covers
// the common cases and otherwise passes the raw tag through (better to
// instruct the LLM with `ja` than to silently drop a real preference).
// English variants resolve to null (the default), not the label "English".
const LOCALE_TO_LANGUAGE = {
  sv: 'Swedish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  da: 'Danish',
  no: 'Norwegian',
  nb: 'Norwegian',
  fi: 'Finnish',
  pl: 'Polish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

const ENGLISH = /^(en|eng|english)$/i;

/**
 * Resolve the session's render language from a Memoro lens response object.
 * PURE. Returns a language LABEL (e.g. "Swedish") or `null` for the English
 * default. Never throws on a hostile / missing shape.
 *
 * Carrier search order (first non-empty wins): top-level `language`, then
 * `locale`, then the same two nested under `user_state` / `preferences`.
 * A `locale` value is mapped via LOCALE_TO_LANGUAGE (unmapped codes pass
 * through verbatim). English variants → null (no directive).
 *
 * @param {*} lensResponse — the parsed lens endpoint response (or null)
 * @returns {string|null}
 */
export function resolveLanguage(lensResponse) {
  if (!lensResponse || typeof lensResponse !== 'object') return null;

  const carriers = [
    lensResponse,
    isObj(lensResponse.user_state) ? lensResponse.user_state : null,
    isObj(lensResponse.preferences) ? lensResponse.preferences : null,
  ];

  for (const c of carriers) {
    if (!c) continue;
    const lang = nonEmpty(c.language);
    if (lang) return normalizeLanguage(lang);
    const locale = nonEmpty(c.locale);
    if (locale) return normalizeLocale(locale);
  }
  return null;
}

function isObj(v) {
  return v != null && typeof v === 'object';
}

function normalizeLanguage(label) {
  if (ENGLISH.test(label.trim())) return null;
  return label.trim();
}

function normalizeLocale(locale) {
  // "sv-SE" → "sv"; map to a label, else pass the raw tag through.
  const base = locale.trim().split(/[-_]/)[0].toLowerCase();
  if (ENGLISH.test(base)) return null;
  return LOCALE_TO_LANGUAGE[base] || locale.trim();
}

// ─────────────────────────────────────────────────────────────
// Pure: MEMORO.md `language` setting + precedence (this drev)
//
// Product decision: code-language ≠ Memoro-locale. A per-repo `language`
// setting in MEMORO.md un-gates language steering LOCALLY, ahead of the
// server (whose lens exposes no language field today). Precedence — the
// MEMORO.md setting WINS:
//
//   MEMORO.md language-setting   (primary — explicit per-repo choice)
//     > Memoro user_state locale  (fallback — unchanged Phase 4 seam)
//       > English                 (default)
//
// SYNTAX: a single HTML-comment convention line, anywhere in MEMORO.md:
//
//   <!-- memoro:language: Swedish -->
//
// Chosen over YAML frontmatter because `readMap` renders the WHOLE file as
// prose into the bundle's map section — an HTML comment is invisible in
// rendered markdown, sits anywhere, and strips out with one regex without
// disturbing the sparse prose-map form (frontmatter would change the file's
// first bytes and the heading rendering). Deliberately NOT a general config
// system: one setting, one line. The value reuses the SAME normalisation as
// the lens path (locale codes map, English → null), so a `sv-SE` here behaves
// identically to a `sv-SE` from the server.
// ─────────────────────────────────────────────────────────────

// Matches `<!-- memoro:language: <value> -->` with loose whitespace. The
// value is everything up to the comment close; trimmed by the caller.
const MAP_LANGUAGE_SETTING = /<!--\s*memoro:language:\s*([^>]*?)\s*-->/i;

/**
 * Parse the MEMORO.md `language` setting out of the map text. PURE. Returns a
 * language LABEL (e.g. "Swedish") or `null` (no setting / English / hostile
 * input). Reuses the lens-path normalisation so locale codes map to labels
 * and English variants collapse to null. Never throws.
 *
 * @param {string|null} map — MEMORO.md contents
 * @returns {string|null}
 */
export function parseMapLanguage(map) {
  const text = nonEmpty(map);
  if (!text) return null;
  const m = text.match(MAP_LANGUAGE_SETTING);
  if (!m) return null;
  const value = nonEmpty(m[1]);
  if (!value) return null;
  // Same normalisation as a server-provided language label/locale: a bare
  // label passes through (English → null), a locale code maps via the table.
  return /[-_]/.test(value) || LOCALE_TO_LANGUAGE[value.toLowerCase()] !== undefined
    ? normalizeLocale(value)
    : normalizeLanguage(value);
}

/**
 * Resolve the session render language by precedence: the MEMORO.md setting
 * wins, else the Memoro server locale (Phase 4 seam), else English (null).
 * PURE. Never throws — a hostile map or lens degrades to the next level.
 *
 * Note an explicit English setting in the map (→ null) deliberately SHADOWS a
 * non-English server locale: a user who chooses English locally overrides
 * their Memoro profile for this repo. That's the point of the per-repo
 * setting. ("No setting present" — parseMapLanguage returns null too, so we
 * distinguish the two by whether the map carried the convention line at all.)
 *
 * @param {object} [arg]
 * @param {string|null} [arg.map]          — MEMORO.md contents
 * @param {*}           [arg.lensResponse] — the Memoro lens response (Phase 4)
 * @returns {string|null}
 */
export function resolveSessionLanguage({ map, lensResponse } = {}) {
  const text = safeSync(() => nonEmpty(map), null);
  // The map's setting wins whenever the convention line is PRESENT — even if
  // its resolved value is null (an explicit English choice shadows the server).
  if (text && MAP_LANGUAGE_SETTING.test(text)) {
    return safeSync(() => parseMapLanguage(text), null);
  }
  return safeSync(() => resolveLanguage(lensResponse), null);
}

/**
 * Strip mc settings (today: the `language` convention line) out of the map
 * text before it is rendered as prose into the bundle. PURE. A map with no
 * setting is returned byte-identical. Non-string input is returned unchanged.
 * Never throws. Collapses the blank line the removed comment would leave so
 * the prose-map spacing stays clean.
 *
 * @param {string|null} map
 * @returns {string|null}
 */
export function stripMapSettings(map) {
  if (typeof map !== 'string') return map;
  if (!MAP_LANGUAGE_SETTING.test(map)) return map; // byte-identical fast path
  // Remove the setting line (and its trailing newline) wherever it sits, then
  // collapse any resulting run of blank lines so we don't leave a gap.
  return map
    .replace(new RegExp(`^[ \\t]*${MAP_LANGUAGE_SETTING.source}[ \\t]*\\n?`, 'gim'), '')
    .replace(MAP_LANGUAGE_SETTING, '') // any inline occurrence not on its own line
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Render the minimal "respond in <language>" directive line for the bundle.
 * PURE. Empty string for the English default (null) — zero noise when the
 * session needs no steering. Kept to a single explicit instruction line
 * rather than re-rendering the whole role in the target language: minimal,
 * tool-agnostic, and it leaves mc's own framing untouched.
 *
 * @param {string|null} language
 * @returns {string}
 */
export function languageDirective(language) {
  const lang = nonEmpty(language);
  if (!lang) return '';
  return `**Respond to the user in ${lang}.** This is their preferred language ` +
    '(from their Memoro profile); use it for your replies and prose. Keep code, ' +
    'identifiers, commit messages, and file contents in their conventional language.';
}

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
 * @param {string} [parts.language]  — the session's render language
 *   (Phase 4), resolved from the lens/user_state. `null`/empty → English
 *   (no directive). Rendered as a single "respond in <language>" line
 *   right after the preamble so it governs the whole session.
 * @returns {string} markdown body for the managed block
 */
export function assembleBundle({ map, role, lens, focus, lifecycle, language } = {}) {
  const sections = [];

  const cleanMap = nonEmpty(map);
  const cleanRole = nonEmpty(role);
  const cleanLens = nonEmpty(lens);
  const cleanFocus = nonEmpty(focus);
  const cleanLifecycle = nonEmpty(lifecycle);
  const directive = languageDirective(language);

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

  // The language directive sits right after the preamble — before the
  // role/map/lens — so it governs how the LLM reads and replies to
  // everything below it. English default ⇒ empty ⇒ omitted entirely.
  const head = directive ? [`${HEADER}`, '', PREAMBLE, '', directive, ''] : [`${HEADER}`, '', PREAMBLE, ''];
  const body = [...head, ...interleave(sections)].join('\n');
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
// hands the LLM a seed template + an instruction to OFFER seeding, then
// build the first draft from repo evidence after opt-in; when nodes look
// in-flight it surfaces them + an instruction to OFFER an update. Every
// write is the LLM's, confirmed by the user. The default grounding path
// stays strictly read-only — asserted in the tests.
// ─────────────────────────────────────────────────────────────

/**
 * An initial MEMORO.md skeleton the grounded LLM can use as the shape for
 * the first repo-derived draft when the repo has no map. Mirrors this
 * repo's reference form (north star → long-term goals → nodes) and keeps
 * the sparse-by-rule reminder so the seeded file stays a map, not a docs
 * dump. Pure + deterministic.
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
 *   - No map  → include the seed template + "OFFER to create it" (opt-in),
 *               then inspect repo evidence and write the first draft.
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
      'future session. As your first move inside this Claude/Codex session,',
      'offer to create one: ask the user, and only if they agree, build the',
      'first `MEMORO.md` inside the launched coding session. Never create or',
      'overwrite `MEMORO.md` before that opt-in.',
      '',
      'After opt-in, do not stop at an empty skeleton and do not ask broad',
      'discovery questions before making a first draft. Inspect repo evidence',
      'first — README, package/manifest files, docs/plans, tests, git status/log',
      'where useful — then write a concise MEMORO.md using the skeleton shape',
      'below. Use placeholders only for facts the repo does not support, and',
      'after writing the file summarize assumptions/gaps for the user to correct.',
      'Because `MEMORO.md` is cross-session project state, tell the user it',
      'should be committed after creation so every future worktree/session',
      'inherits the same map.',
      '',
      'Draft shape:',
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
    'When the user approves a map change, remind them it should be committed',
    'because it is cross-session project state.',
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
 * The orchestrator role framing — UNIVERSAL as of Phase 5 (plan §13b.1).
 *
 * Two layers, by design:
 *
 *   1. INLINE, ALWAYS. The orchestrator framing PLUS a short distillation of
 *      the two load-bearing purposes (protect the coordinator's context;
 *      the brief is the quality mechanism). This is the part that must be
 *      fully present in *any* repo — including an empty one — because it is
 *      the whole point of "universal": the role does not depend on the repo
 *      carrying files. Kept short so it never bloats the bundle.
 *
 *   2. POINTERS to the long canon. The full protocol / coordination skill is
 *      long; we point at it rather than inlining it. Source resolution follows
 *      §13b.1: a repo-local copy is the override (point at the repo path so the
 *      session reads its project-specific annotations); ELSE the mc package
 *      ships the canon (`mc setup` / `mc adapter sync` materialise it from the
 *      package), so the pointer is still surfaced. Only when NEITHER the repo
 *      nor the package has the file (a broken install) does the pointer drop —
 *      that, and only that, is the terse fallback. "Repo has no .claude" is NOT
 *      terse fallback any more: the package canon covers it.
 *
 * Canon resolution is injected (Pattern 2) + soft-degrades: a throwing /
 * empty resolver collapses to the inline framing alone, never throwing.
 *
 * @param {string} cwd
 * @param {object} [arg]
 * @param {Function} [arg.exists] — (absPath) => boolean; injected.
 * @param {Function} [arg.canon]  — () => packaged-canon map; injected. Defaults
 *   to reading the package `canon/` dir via `readPackageCanon`.
 */
export function buildRole(cwd, { exists = existsSync, canon = readPackageCanon } = {}) {
  // Where the repo carries its own copy (the override layer).
  const repoHas = {
    protocol: exists(join(cwd, 'docs', 'coding-agent-protocol.md')),
    coordination: exists(join(cwd, '.claude', 'skills', 'agent-coordination.md')),
    beCoordinator: exists(join(cwd, '.claude', 'commands', 'be-coordinator.md')),
  };

  // What the package ships (the universal baseline). Soft-degrade: a broken
  // install (canon unreadable) → all-null, and the pointers simply drop.
  let pkg = { protocol: null, coordination: null, beCoordinator: null };
  try {
    const resolved = canon();
    if (resolved && typeof resolved === 'object') pkg = resolved;
  } catch {
    // keep the all-null default — terse fallback.
  }

  const repoRefs = [];
  if (repoHas.protocol) repoRefs.push(refLine('protocol'));
  if (repoHas.coordination) repoRefs.push(refLine('coordination'));
  if (repoHas.beCoordinator) repoRefs.push(refLine('beCoordinator'));
  const hasPackageCanon = !!(pkg.protocol || pkg.coordination || pkg.beCoordinator);

  const lines = [
    'You are the coordinator of this work. One human directs the work; this ' +
      'session is the high-altitude seat that holds the whole — the roadmap, the ' +
      'intent, and the bird\'s-eye view across changes. Protect that altitude: ' +
      'push implementation detail out to focused agents, keep design judgment here.',
    '',
    'Three targets define the role:',
    '- **Roadmap and end-goal awareness.** Keep the north star, active project ' +
      'nodes, and why the current work matters in view before acting.',
    '- **Orchestrator-role discipline.** Plan, brief, delegate, and review by ' +
      'default; only implement here when the user explicitly asks or the task is tiny.',
    '- **Cross-session work-project order.** Treat `MEMORO.md`, session state, ' +
      'worktrees, branches, and tool choice as one continuity system so work ' +
      'projects survive across sessions and days.',
    '',
    'Two purposes govern the role (lose them and the loop becomes empty ritual):',
    '- **Protect the coordinator\'s context.** Your scarcest resource is your own ' +
      'attention and context window — it holds the plan and the design intent. ' +
      'Push implementation detail (which file, which flag, the diff) OUT to ' +
      'focused agents whose contexts are disposable; stay high-altitude on purpose.',
    '- **The brief is the quality mechanism.** Writing a brief for another agent ' +
      'forces intent to be explicit, complete, and bounded — it manufactures the ' +
      'critical distance a single heads-down stream loses. A worse-but-examined ' +
      'design beats a faster-but-unexamined one.',
  ];
  if (repoRefs.length) {
    lines.push('', 'Repo-local coordinator sources available to read:');
    for (const r of repoRefs) lines.push(`- ${r}`);
  } else if (hasPackageCanon) {
    lines.push(
      '',
      'Repo-local coordinator source files are not present in this worktree. Do not try to read `docs/coding-agent-protocol.md`, `.claude/skills/agent-coordination.md`, or `.claude/commands/be-coordinator.md` unless they have been materialised here. The mc package canon has already supplied the coordinator role summary in this grounding; if full on-disk canon is needed, ask to run `mc adapter materialise`.',
    );
  }
  return lines.join('\n');
}

// Pointer text for repo-local canon assets. Package-only canon is described
// as already supplied by mc, not as repo paths to read, because those paths
// may not exist in ordinary target repos.
function refLine(key) {
  switch (key) {
    case 'protocol':
      return '`docs/coding-agent-protocol.md` — the project protocol';
    case 'coordination':
      return '`.claude/skills/agent-coordination.md` — the coordinator ↔ agent loop and why it exists';
    case 'beCoordinator':
      return '`.claude/commands/be-coordinator.md` — priming as coordinator';
    default:
      return '';
  }
}

/**
 * Auto-injection portal (Phase 4): fetch the WHOLE Memoro lens response —
 * not just its markdown — so grounding can both render the lens AND derive
 * the session language from the same call. Lens auto-injection is
 * first-class: no manual `lens pull` step precedes this; it fetches
 * directly through the keychain-token + endpoint path.
 *
 * The dependency is injected so tests never hit the network or keychain.
 * The default soft-degrades to `null` on ANY failure (not logged in,
 * Memoro unreachable, no config) — grounding then proceeds with no lens
 * and the English default, never throwing.
 *
 * @param {object} [arg]
 * @param {() => Promise<*>} [arg.fetchLens] — returns the lens response
 *   object (or a bare markdown string); injected in tests.
 * @returns {Promise<*|null>} the lens response (object or string) or null
 */
export async function fetchLensData({ fetchLens = defaultFetchLens } = {}) {
  try {
    const resp = await fetchLens();
    return resp ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull just the lens *markdown* for inclusion in the bundle. Built on
 * `fetchLensData`; tolerates either the full response object (extracts
 * `.markdown`) or a bare markdown string (back-compat with Phase 1 tests
 * and any caller injecting a plain string). Soft-degrades to null.
 *
 * Note: we read the lens, we do not re-materialise it — the SessionStart
 * `lens pull` hook still owns writing the standalone lens block to the
 * global config. Here it's one part of the grounding bundle.
 */
export async function pullLensMarkdown({ fetchLens = defaultFetchLens } = {}) {
  const resp = await fetchLensData({ fetchLens });
  return lensMarkdownOf(resp);
}

/**
 * Extract the lens markdown from a fetch result that may be a full
 * response object or a bare string. PURE; null when neither yields text.
 */
export function lensMarkdownOf(resp) {
  if (typeof resp === 'string') return nonEmpty(resp);
  if (isObj(resp)) return nonEmpty(resp.markdown);
  return null;
}

async function defaultFetchLens() {
  // Reuse the existing lens path: keychain token + portrait-coding endpoint.
  // Any missing piece (no token, no config, no data) returns null instead
  // of throwing, so grounding proceeds without a lens. Returns the WHOLE
  // response object so the caller can both render markdown and resolve the
  // language from it (Phase 4).
  const { getSecret } = await import('../lib/keychain.js');
  const { ACCOUNTS } = await import('../commands/auth.js');
  const { readConfig, getApiUrl } = await import('../lib/config.js');
  const { memoroFetch } = await import('../lib/api.js');

  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) return null;
  const config = await readConfig();
  const apiUrl = getApiUrl([]) || config.apiUrl;
  if (!apiUrl) return null;
  return memoroFetch(apiUrl, '/api/lens/portrait-coding', { token });
}

/**
 * Ground a session in place: assemble the bundle from cwd + injected
 * dep-portals and hand it to the selected adapter at the pre-launch slot.
 * Adapters may materialise it into a tool instruction file or return a
 * startup-message delivery when the native instruction file is tracked
 * project state. Returns a result object; NEVER throws — grounding must
 * not block the launch.
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
    // Phase 4: fetch the WHOLE lens response once, then derive both the
    // rendered markdown and the session language from it — one Memoro call,
    // not two. `fetchLensDataImpl` is the injectable seam (tests stub it);
    // `pullLensImpl` is kept for back-compat with callers/tests that only
    // care about markdown (it short-circuits the data fetch when given).
    fetchLensDataImpl = () => fetchLensData(deps.lensDeps || {}),
    pullLensImpl = null,
    repoName = basename(cwd),
  } = deps;

  const map = await safe(() => readMapImpl(cwd), null);
  const role = await safe(() => buildRoleImpl(cwd), null);

  // Lens auto-injection + language. Soft-degrade everywhere: a null lens
  // response → no lens section + (absent a MEMORO.md setting) English default.
  let lens = null;
  let lensResp = null;
  if (pullLensImpl) {
    // Legacy markdown-only path (Phase 1/2 tests inject this). No lens
    // response object → no server locale to resolve from; the MEMORO.md
    // setting still drives the language below.
    lens = await safe(() => pullLensImpl(), null);
  } else {
    lensResp = await safe(() => fetchLensDataImpl(), null);
    lens = lensMarkdownOf(lensResp);
  }

  // Language precedence (this drev): MEMORO.md `language` setting WINS over
  // the server locale, which wins over English. Resolved from the SAME map
  // we read above + the lens response. Pure + soft-degrading.
  const language = safeSync(() => resolveSessionLanguage({ map, lensResponse: lensResp }), null);

  // Strip mc settings (the language convention line) out of the map prose so
  // the setting never renders as text in the bundle. A map with no setting is
  // byte-identical — the pre-drev grounding output is preserved.
  const mapProse = safeSync(() => stripMapSettings(map), map);

  // MEMORO.md lifecycle OFFER (Phase 2). PURE + read-only on mc's side —
  // it only adds guidance the LLM may act on (seed when absent, offer an
  // update when nodes look in-flight), never a silent write. safe() so a
  // surprise never blocks the launch.
  const lifecycle = safeSync(() => lifecycleGuidance({ map: mapProse, repoName }), null);

  const parts = { map: mapProse, role, lens, focus, lifecycle, language };
  const markdown = assembleBundle(parts);

  try {
    const writeResult = await adapter.writeGrounding(markdown, { cwd });
    if (writeResult && typeof writeResult === 'object') {
      return {
        ok: true,
        path: writeResult.path || null,
        delivery: writeResult.delivery || 'file',
        message: writeResult.message || null,
        parts,
        markdown,
      };
    }
    return { ok: true, path: writeResult, delivery: 'file', message: null, parts, markdown };
  } catch (err) {
    return { ok: false, reason: err?.message || 'write failed', parts, markdown };
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
