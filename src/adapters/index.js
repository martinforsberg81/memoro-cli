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
