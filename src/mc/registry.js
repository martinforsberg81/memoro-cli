/**
 * Worktree registry — central JSON file at ${MC_HOME}/registry.json.
 *
 * `git worktree list` is the source of truth for *which worktrees exist*
 * (per plan §7). The registry stores extra metadata mc needs: tool, model
 * chain, kind (work/isolation/spawn), parent, last activity, derived
 * status fields, label, coding_session_id, etc.
 *
 * Schema is intentionally permissive — unknown fields are preserved on
 * round-trip so future versions can add columns without rewriting reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registryPath, mcHome } from './paths.js';

const DEFAULTS = {
  kind: 'work',          // work | isolation | spawn
  parent: null,
  tool: 'claude',
  model_chain: [],
  session_state: 'no-session-yet', // live | idle | dead | no-session-yet
  dirty_files: 0,
  ahead: 0,
  behind: 0,
  open_question: false,
  safety_verdict: 'SAFE_TO_END',
  label: null,
  coding_session_id: null,
};

export function readRegistry() {
  const path = registryPath();
  if (!existsSync(path)) return { entries: [] };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch {
    return { entries: [] };
  }
}

export function writeRegistry(reg) {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic-ish: write to .tmp, rename.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, path);
  return path;
}

export function findEntry(name) {
  const reg = readRegistry();
  return reg.entries.find((e) => e.name === name) || null;
}

export function upsertEntry(patch) {
  if (!patch || typeof patch.name !== 'string') {
    throw new Error('registry.upsertEntry: patch.name required');
  }
  const reg = readRegistry();
  const i = reg.entries.findIndex((e) => e.name === patch.name);
  if (i === -1) {
    reg.entries.push({ ...DEFAULTS, created_at: new Date().toISOString(), ...patch });
  } else {
    reg.entries[i] = { ...reg.entries[i], ...patch };
  }
  writeRegistry(reg);
  return reg.entries.find((e) => e.name === patch.name);
}

export function removeEntry(name) {
  const reg = readRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter((e) => e.name !== name);
  if (reg.entries.length === before) return false;
  writeRegistry(reg);
  return true;
}

export function renameEntry(oldName, newName, patch = {}) {
  const reg = readRegistry();
  if (reg.entries.some((e) => e.name === newName)) {
    throw new Error(`registry entry "${newName}" already exists`);
  }
  const i = reg.entries.findIndex((e) => e.name === oldName);
  if (i === -1) {
    throw new Error(`registry entry "${oldName}" not found`);
  }
  reg.entries[i] = { ...reg.entries[i], ...patch, name: newName };
  writeRegistry(reg);
  return reg.entries[i];
}
