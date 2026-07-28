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
import { DEFAULT_TOOL } from '../lib/config.js';

const DEFAULTS = {
  kind: 'work',          // work | isolation | spawn
  parent: null,
  tool: DEFAULT_TOOL,
  model_chain: [],
  session_state: 'no-session-yet', // live | idle | dead | no-session-yet
  dirty_files: 0,
  ahead: 0,
  behind: 0,
  open_question: false,
  safety_verdict: 'SAFE_TO_END',
  label: null,
  coding_session_id: null,
  tool_session_id: null,
  tool_session_source: null,
  tool_transcript_path: null,
  tool_session_provider_adapter: null,
  tool_session_provider_generation: null,
  provider_sessions: null,
  session_objective: null,
};

const PROVIDER_KEYS = new Set(['codex', 'claude-code']);

export function normalizeProviderSessions(entry = {}) {
  const existing = entry?.provider_sessions;
  if (existing != null && !validProviderSessions(existing)) {
    return { ok: false, reason: 'provider-sessions-invalid', providerSessions: existing };
  }
  const providerSessions = existing ? structuredClone(existing) : { schema: 1, providers: {} };
  const sessionId = explicitProviderValue(entry?.tool_session_id);
  if (sessionId === null) return { ok: true, providerSessions, migrated: false };
  const source = entry?.tool_session_source;
  const provider = source == null || source === ''
    ? canonicalProvider(entry?.tool)
    : canonicalProvider(source);
  if (!provider) return { ok: false, reason: 'legacy-provider-ambiguous', providerSessions };
  if (!providerSessions.providers[provider]) {
    providerSessions.providers[provider] = {
      session_id: sessionId,
      transcript_path: explicitProviderValue(entry?.tool_transcript_path),
      // Credential-domain generation is not broker runtime-generation evidence.
      runtime_generation: null,
      last_consumed_handoff_sequence: 0,
    };
  }
  if (!validProviderSessions(providerSessions)) {
    return { ok: false, reason: 'legacy-provider-invalid', providerSessions };
  }
  return { ok: true, providerSessions, migrated: true };
}

export function providerSessionFor(entry, provider) {
  const normalized = normalizeProviderSessions(entry);
  if (!normalized.ok) return null;
  return normalized.providerSessions.providers[canonicalProvider(provider)] || null;
}

export function withProviderSession(entry, provider, patch = {}) {
  const normalized = normalizeProviderSessions(entry);
  if (!normalized.ok) return normalized;
  const key = canonicalProvider(provider);
  if (!key) return { ok: false, reason: 'unknown-provider', providerSessions: normalized.providerSessions };
  const current = normalized.providerSessions.providers[key] || {
    session_id: null, transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 0,
  };
  const next = { ...current, ...patch };
  if (!validProviderSession(next)) return { ok: false, reason: 'invalid-provider-session', providerSessions: normalized.providerSessions };
  normalized.providerSessions.providers[key] = next;
  return { ok: true, providerSessions: normalized.providerSessions };
}

/**
 * Commit one provider's consumed handoff watermark in a single registry
 * read/modify/write. This prevents a later local caller from regressing the
 * provider-specific causal cursor; H3 adds the broker single-writer journal.
 */
export function patchProviderSessionSequenceIfPresent(name, provider, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return { ok: false, reason: 'invalid-handoff-sequence' };
  const reg = readRegistryStrict();
  const index = reg.entries.findIndex((entry) => entry.name === name);
  if (index === -1) return { ok: false, reason: 'missing' };
  const updated = withProviderSession(reg.entries[index], provider, {});
  if (!updated.ok) return { ok: false, reason: updated.reason };
  const key = canonicalProvider(provider);
  const current = updated.providerSessions.providers[key];
  if (!current) return { ok: false, reason: 'missing-provider-session' };
  if (sequence < current.last_consumed_handoff_sequence) return { ok: false, reason: 'handoff-sequence-regression' };
  updated.providerSessions.providers[key] = { ...current, last_consumed_handoff_sequence: sequence };
  reg.entries[index] = { ...reg.entries[index], provider_sessions: updated.providerSessions };
  writeRegistry(reg);
  return { ok: true, entry: reg.entries[index] };
}

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

/**
 * Destructive lifecycle commands use the strict reader so malformed or
 * unreadable registry state can never masquerade as an empty registry.
 */
export function readRegistryStrict() {
  const path = registryPath();
  if (!existsSync(path)) return { entries: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error('registry entries must be an array');
  }
  return parsed;
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

function canonicalProvider(value) {
  return value === 'claude' ? 'claude-code' : PROVIDER_KEYS.has(value) ? value : null;
}

function explicitProviderValue(value) {
  if (value == null || value === '') return null;
  return value;
}

function boundedId(value) {
  return typeof value === 'string' && value.trim() === value
    && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function absoluteTranscriptPath(value) {
  return typeof value === 'string' && value.trim() === value && value.startsWith('/')
    && Buffer.byteLength(value) <= 4096 && !/[\0-\x1f\x7f]/.test(value);
}

function validProviderSessions(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1
    && value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers)
    && Object.entries(value.providers).every(([key, session]) => !PROVIDER_KEYS.has(key) || validProviderSession(session));
}

function validProviderSession(value) {
  const allowedKeys = new Set([
    'session_id',
    'transcript_path',
    'runtime_generation',
    'last_consumed_handoff_sequence',
  ]);
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key))
    && (value.session_id === null || boundedId(value.session_id))
    && (value.transcript_path === null || absoluteTranscriptPath(value.transcript_path))
    && (value.runtime_generation === null || boundedId(value.runtime_generation))
    && Number.isSafeInteger(value.last_consumed_handoff_sequence) && value.last_consumed_handoff_sequence >= 0;
}

export function removeEntry(name) {
  const reg = readRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter((e) => e.name !== name);
  if (reg.entries.length === before) return false;
  writeRegistry(reg);
  return true;
}

export function removeEntryIfMatches(name, expected = {}) {
  const reg = readRegistryStrict();
  const index = reg.entries.findIndex((entry) => entry.name === name);
  if (index === -1) return { ok: false, removed: false, reason: 'missing' };
  const entry = reg.entries[index];
  for (const key of [
    'worktree_path',
    'branch',
    'tool_session_source',
    'tool_session_id',
    'tool_transcript_path',
  ]) {
    if (expected[key] !== undefined && entry[key] !== expected[key]) {
      return {
        ok: false,
        removed: false,
        reason: 'entry-changed',
        field: key,
      };
    }
  }
  reg.entries.splice(index, 1);
  writeRegistry(reg);
  return { ok: true, removed: true };
}

/**
 * Patch a set of existing entries in one synchronous registry round-trip.
 *
 * Unlike `upsertEntry`, this helper never creates a missing entry. Destructive
 * lifecycle commands use it after async discovery so a concurrently removed
 * session cannot be resurrected by a late authority backfill write.
 */
export function patchEntriesIfPresent(patches) {
  const requested = Array.isArray(patches) ? patches : [];
  const reg = readRegistry();
  const byName = new Map(requested
    .filter((patch) => patch && typeof patch.name === 'string')
    .map((patch) => [patch.name, patch]));
  const found = new Set();
  reg.entries = reg.entries.map((entry) => {
    const patch = byName.get(entry.name);
    if (!patch) return entry;
    found.add(entry.name);
    return { ...entry, ...patch };
  });
  const missing = [...byName.keys()].filter((name) => !found.has(name));
  if (missing.length > 0) {
    return { ok: false, missing, entries: reg.entries };
  }
  if (byName.size > 0) writeRegistry(reg);
  return {
    ok: true,
    missing: [],
    entries: reg.entries.filter((entry) => byName.has(entry.name)),
  };
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
