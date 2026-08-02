/**
 * Tool adapter registry.
 *
 * Each adapter exports: ID, LABEL, CONFIG_PATH, writeLens, removeLens,
 * installHooks, uninstallHooks, detect.
 *
 * Available adapters are fully implemented. Planned adapters remain stubbed
 * with explicit notes so the CLI can explain the current support boundary.
 */

import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';

const ADAPTERS = {
  [claudeCode.ID]: claudeCode,
  [codex.ID]: codex,
};

const PLANNED = {
  'cursor':     { label: 'Cursor',     note: 'Stubbed — writes to .cursorrules; adapter coming in PR 4.1' },
  'windsurf':   { label: 'Windsurf',   note: 'Stubbed — writes to .windsurfrules; adapter coming in PR 4.1' },
  'gemini-cli': { label: 'Gemini CLI', note: 'Stubbed — adapter coming in PR 4.1' },
};

export function getAdapter(id) {
  if (ADAPTERS[id]) return ADAPTERS[id];
  if (PLANNED[id]) {
    const err = new Error(`${PLANNED[id].label} adapter is not yet implemented. ${PLANNED[id].note}`);
    err.planned = true;
    throw err;
  }
  const err = new Error(`Unknown tool: ${id}. Known tools: ${[...Object.keys(ADAPTERS), ...Object.keys(PLANNED)].join(', ')}`);
  throw err;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map(a => ({ id: a.ID, label: a.LABEL, available: true }));
}

export function listPlanned() {
  return Object.entries(PLANNED).map(([id, meta]) => ({ id, label: meta.label, note: meta.note, available: false }));
}

/**
 * Auto-detect which adapters are usable on this machine. Non-implemented
 * adapters are never returned.
 */
export function detectInstalled() {
  return Object.values(ADAPTERS).filter(a => typeof a.detect === 'function' && a.detect());
}

/**
 * Two name spaces exist for the same tool, by accident of history:
 *   - **adapter ID** (e.g. `claude-code`, `codex`, `gemini-cli`) — what
 *     `mc adapter sync --tool` and `mc tool-switch` accept, and what
 *     `config.defaultTool` stores. Stable identifier across the contract.
 *   - **short name** (e.g. `claude`, `codex`, `gemini`) — what
 *     `mc auth <tool>` and `mc new --tool` accept. Closer to what users
 *     type at the prompt.
 *
 * `resolveToolInput` accepts either form and returns both, plus the
 * resolved adapter (or null when the input matches a planned-but-not-
 * implemented adapter). Returns null when input is unknown so callers
 * can decide whether to error or fall back.
 */
const SHORT_NAME_TO_ID = {
  'claude':     'claude-code',
  'codex':      'codex',
  'gemini':     'gemini-cli',
};

const ID_TO_SHORT_NAME = Object.fromEntries(
  Object.entries(SHORT_NAME_TO_ID).map(([s, id]) => [id, s]),
);

export function resolveToolInput(input) {
  if (typeof input !== 'string' || !input) return null;
  const id = SHORT_NAME_TO_ID[input] || (ADAPTERS[input] || PLANNED[input] ? input : null);
  if (!id) return null;
  const shortName = ID_TO_SHORT_NAME[id] || input;
  const adapter = ADAPTERS[id] || null;
  return { id, shortName, adapter, planned: !!PLANNED[id] && !adapter };
}

// Historical aliases that appear in stored data but are not part of the
// two official name spaces above.
const TOOL_ID_ALIASES = {
  'codex-cli': 'codex',
};

/**
 * THE canonical tool-name mapping. Accepts a short name, adapter id, or
 * historical alias in any casing/whitespace and returns the adapter id —
 * or null when the value names no known tool. Every module that needs to
 * normalize or compare tool names goes through this (or the helpers
 * below); local copies of the claude↔claude-code map are forbidden.
 */
export function canonicalToolId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return resolveToolInput(TOOL_ID_ALIASES[trimmed] || trimmed)?.id || null;
}

/** The user-facing short name for any known tool-name form; null when unknown. */
export function toolShortName(value) {
  const id = canonicalToolId(value);
  return id ? resolveToolInput(id).shortName : null;
}

/** True when both values name the same known tool, in any name form. */
export function isSameTool(a, b) {
  const canonical = canonicalToolId(a);
  return canonical !== null && canonical === canonicalToolId(b);
}

/**
 * Resolve a tool name (short name OR adapter ID) to everything the
 * wrap-mode launcher needs to spawn it: the live adapter (for grounding)
 * and its `launchSpec()` (the binary + heartbeat shape). Pure-ish — the
 * only impurity is the adapter's own binary resolution inside
 * `launchSpec()`, which is injectable on the codex adapter for tests.
 *
 * Fails HIGH (never a silent no-op), distinguishing the failure modes so
 * the caller can surface a precise, actionable error:
 *   - unknown      → the name matches no adapter at all
 *   - planned      → a known-but-unimplemented adapter (e.g. gemini-cli)
 *   - missing-bin  → adapter exists but its binary isn't installed
 *
 * @param {string} toolInput — `claude` | `codex` | `claude-code` | …
 * @returns {{ ok: true, id, shortName, adapter, spec }
 *          | { ok: false, reason, hint, id?, label? }}
 */
export function resolveLaunch(toolInput) {
  const resolved = resolveToolInput(toolInput);
  if (!resolved) {
    return {
      ok: false,
      reason: 'unknown',
      hint: `unknown tool: ${toolInput}. Known: ${Object.keys(SHORT_NAME_TO_ID).join(', ')}`,
    };
  }
  if (resolved.planned || !resolved.adapter) {
    const planned = PLANNED[resolved.id];
    return {
      ok: false,
      reason: 'planned',
      id: resolved.id,
      hint: planned?.note
        ? `${planned.label} adapter is not implemented yet. ${planned.note}`
        : `${resolved.id} adapter is not implemented yet.`,
    };
  }
  const adapter = resolved.adapter;
  if (typeof adapter.launchSpec !== 'function') {
    return {
      ok: false,
      reason: 'no-launch',
      id: resolved.id,
      hint: `${resolved.id} adapter cannot be launched interactively (no launchSpec).`,
    };
  }
  const spec = adapter.launchSpec();
  if (!spec || !spec.bin) {
    return {
      ok: false,
      reason: 'missing-bin',
      id: resolved.id,
      label: spec?.label || resolved.id,
      hint: spec?.installHint || `${resolved.id} binary not found in PATH.`,
    };
  }
  return {
    ok: true,
    id: resolved.id,
    shortName: resolved.shortName,
    adapter,
    spec,
  };
}
