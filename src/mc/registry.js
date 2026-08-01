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
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { registryPath } from './paths.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import { resolveToolInput } from '../adapters/index.js';
import {
  REPOSITORY_ID_RE,
  repositoryIdForCanonicalRemote,
  repositoryIdentityProjection,
  resolveRepositoryIdentity,
} from './repository-identity.js';

export const REGISTRY_SCHEMA_VERSION = 2;
export const MC_SESSION_ID_RE = /^mcs_[a-f0-9]{24}$/u;

const DEFAULTS = {
  session_id: null,
  repository_id: null,
  repository_identity: null,
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

const PROVIDER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
    ? knownProvider(entry?.tool)
    : knownProvider(source);
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
export function patchProviderSessionSequenceIfPresent(identifier, provider, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return { ok: false, reason: 'invalid-handoff-sequence' };
  const reg = readRegistryStrict();
  const resolved = resolveEntry(identifier, { registry: reg });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const index = reg.entries.findIndex((entry) => entry.session_id === resolved.entry.session_id);
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

export function readRegistry({ persistMigration = true } = {}) {
  const path = registryPath();
  if (!existsSync(path)) return { schema_version: REGISTRY_SCHEMA_VERSION, entries: [] };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return migrateLoadedRegistry(parsed, { path, persistMigration }).registry;
  } catch {
    return { entries: [] };
  }
}

/**
 * Destructive lifecycle commands use the strict reader so malformed or
 * unreadable registry state can never masquerade as an empty registry.
 */
export function readRegistryStrict({ persistMigration = true } = {}) {
  const path = registryPath();
  if (!existsSync(path)) return { schema_version: REGISTRY_SCHEMA_VERSION, entries: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error('registry entries must be an array');
  }
  const migration = migrateLoadedRegistry(parsed, { path, persistMigration });
  const preservedVersionedLegacyAmbiguity = migration.reason === 'ambiguous-legacy-session'
    && migration.ambiguity_kind === 'unresolved-legacy'
    && parsed.schema_version === REGISTRY_SCHEMA_VERSION;
  if (!migration.ok && !preservedVersionedLegacyAmbiguity) {
    if (migration.reason === 'unsupported-registry-schema') {
      throw new Error(`registry schema ${parsed.schema_version} is newer than supported schema ${REGISTRY_SCHEMA_VERSION}`);
    }
    throw new Error(`registry migration blocked (${migration.reason})`);
  }
  return migration.registry;
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

export function resolveEntry(identifier, {
  cwd = process.cwd(),
  repositoryId = null,
  registry = readRegistry(),
  repositoryResolver = resolveRepositoryIdentity,
  // Lifecycle commands that OPERATE ON an existing session (open/end)
  // pass true: a name that is unique across every repository resolves
  // even from the wrong cwd — mc list shows all sessions, so acting on
  // them must not require standing in the right directory. Commands
  // that CREATE sessions (new) keep the repo-scoped default so the same
  // name may exist in different repositories.
  fallbackGlobal = false,
} = {}) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  const value = typeof identifier === 'object' && identifier
    ? identifier.session_id || identifier.id || identifier.name
    : identifier;
  if (typeof value !== 'string' || !value) return lookupFailure('invalid-identifier');

  if (MC_SESSION_ID_RE.test(value)) {
    const matches = entries.filter((entry) => entry?.session_id === value);
    if (matches.length === 1) return lookupSuccess(matches[0], 'session-id');
    return lookupFailure(matches.length > 1 ? 'duplicate-session-id' : 'missing');
  }

  const byName = entries.filter((entry) => entry?.name === value);
  if (byName.length === 0) return lookupFailure('missing');

  let currentRepositoryId = repositoryId;
  if (!currentRepositoryId) {
    const current = repositoryResolver(cwd, { createLocal: false });
    if (current?.ok) currentRepositoryId = current.id;
  }
  if (currentRepositoryId) {
    const scoped = byName.filter((entry) => entry?.repository_id === currentRepositoryId);
    if (scoped.length === 1) return lookupSuccess(scoped[0], 'repository-name');
    if (scoped.length > 1) return lookupFailure('ambiguous-session-name', { candidates: scoped });

    const legacy = byName.filter((entry) => !entry?.repository_id);
    if (legacy.length === 1 && byName.length === 1) {
      return lookupSuccess(legacy[0], 'unique-legacy-name', { legacy: true });
    }
    if (legacy.length > 0) return lookupFailure('ambiguous-legacy-session', { candidates: byName });
    if (fallbackGlobal && byName.length === 1) {
      return lookupSuccess(byName[0], 'unique-global-name', { crossRepository: true });
    }
    return lookupFailure('repository-mismatch', { candidates: byName });
  }

  if (byName.length > 1) {
    return lookupFailure(
      byName.some((entry) => !entry?.repository_id)
        ? 'ambiguous-legacy-session'
        : 'ambiguous-session-name',
      { candidates: byName },
    );
  }
  if (!byName[0]?.repository_id) {
    return lookupSuccess(byName[0], 'unique-legacy-name', { legacy: true });
  }
  if (fallbackGlobal) {
    return lookupSuccess(byName[0], 'unique-global-name', { crossRepository: true });
  }
  return lookupFailure('repository-context-required', { candidates: byName });
}

export function findEntry(identifier, options = {}) {
  const result = resolveEntry(identifier, options);
  return result.ok ? result.entry : null;
}

export function formatEntryResolutionError(identifier, result) {
  const quoted = `"${String(identifier)}"`;
  switch (result?.reason) {
    case 'ambiguous-session-name':
      return `session ${quoted} exists in more than one repository; use its opaque session_id:${formatCandidateLines(result)}`;
    case 'ambiguous-legacy-session':
      return `legacy session ${quoted} is ambiguous; use its opaque session_id:${formatCandidateLines(result)}`;
    case 'repository-context-required':
      return `session ${quoted} is repository-scoped; run the command inside its repository or use its opaque session_id${formatCandidateLines(result)}`;
    case 'repository-mismatch':
      return `no session ${quoted} exists in the current repository${formatCandidateLines(result)}`;
    default:
      return `no such session ${quoted}`;
  }
}

/**
 * An error that says "use the session_id" must SHOW the session_ids —
 * they appear nowhere else in normal output. One line per candidate.
 */
function formatCandidateLines(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length === 0) return '';
  return candidates.map((entry) => {
    const repo = entry?.repository_identity?.canonical
      || entry?.repo_slug
      || (entry?.repository_id ? entry.repository_id : 'no repository');
    const where = entry?.worktree_path || 'no worktree';
    return `\n  ${entry?.session_id || '(no session_id)'}  repo=${repo}  state=${entry?.session_state || '?'}  ${where}`;
  }).join('');
}

export function upsertEntry(patch, { cwd = process.cwd(), repositoryResolver = resolveRepositoryIdentity } = {}) {
  if (!patch || typeof patch.name !== 'string') {
    throw new Error('registry.upsertEntry: patch.name required');
  }
  if (patch.session_id != null && !validSessionId(patch.session_id)) {
    throw new Error('registry.upsertEntry: invalid patch.session_id');
  }
  const reg = readRegistryStrict();
  let repositoryId = patch.repository_id || null;
  let repositoryIdentity = patch.repository_identity || null;
  if (repositoryId && !REPOSITORY_ID_RE.test(repositoryId)) {
    throw new Error('registry.upsertEntry: invalid patch.repository_id');
  }
  if (repositoryIdentity != null && !validRepositoryIdentity(repositoryIdentity)) {
    throw new Error('registry.upsertEntry: invalid patch.repository_identity');
  }
  if (!repositoryId && repositoryIdentity?.kind === 'remote') {
    repositoryId = repositoryIdForCanonicalRemote(repositoryIdentity.canonical);
  }
  if (!validRepositoryIdentityPair(repositoryId, repositoryIdentity)) {
    throw new Error('registry.upsertEntry: repository identity does not match repository_id');
  }
  if (!repositoryId) {
    const identityPaths = [patch.primary_worktree, patch.worktree_path, cwd]
      .filter((value, index, values) => (
        typeof value === 'string' && value.trim() && values.indexOf(value) === index
      ));
    for (const identityPath of identityPaths) {
      const resolvedRepository = repositoryResolver(identityPath, { createLocal: true });
      if (!resolvedRepository?.ok) continue;
      repositoryId = resolvedRepository.id;
      repositoryIdentity = repositoryIdentityProjection(resolvedRepository);
      break;
    }
  }

  let i = typeof patch.session_id === 'string'
    ? reg.entries.findIndex((entry) => entry.session_id === patch.session_id)
    : -1;
  if (patch.session_id && i === -1) {
    throw new Error(`registry.upsertEntry: session_id ${patch.session_id} not found`);
  }
  if (i !== -1) {
    const current = reg.entries[i];
    if (current.name !== patch.name) {
      throw new Error('registry.upsertEntry: session name does not match session_id');
    }
    if (repositoryId && current.repository_id && current.repository_id !== repositoryId) {
      throw new Error('registry.upsertEntry: repository_id does not match session_id');
    }
  }
  if (i === -1 && repositoryId) {
    i = reg.entries.findIndex((entry) => (
      entry.name === patch.name && entry.repository_id === repositoryId
    ));
  }
  if (i === -1 && !repositoryId) {
    const legacy = reg.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.name === patch.name && !entry.repository_id);
    if (legacy.length > 1) throw new Error(`registry entry "${patch.name}" is ambiguous`);
    if (legacy.length === 1) i = legacy[0].index;
  }

  const identityPatch = {
    ...(repositoryId ? { repository_id: repositoryId } : {}),
    ...(repositoryIdentity ? { repository_identity: repositoryIdentity } : {}),
  };
  if (i === -1) {
    reg.entries.push({
      ...DEFAULTS,
      session_id: validSessionId(patch.session_id) ? patch.session_id : mintSessionId(),
      created_at: new Date().toISOString(),
      ...identityPatch,
      ...patch,
    });
    i = reg.entries.length - 1;
  } else {
    reg.entries[i] = {
      ...reg.entries[i],
      ...identityPatch,
      ...patch,
      session_id: reg.entries[i].session_id || (validSessionId(patch.session_id) ? patch.session_id : mintSessionId()),
    };
  }
  reg.schema_version = REGISTRY_SCHEMA_VERSION;
  writeRegistry(reg);
  return reg.entries[i];
}

/**
 * Upgrade a 0.7.10 registry without dropping or coalescing entries. The
 * function is exported so migration behavior can be tested deterministically.
 * Ambiguous legacy namespaces return the original object unchanged.
 */
export function migrateRegistry(registry, {
  repositoryResolver = resolveRepositoryIdentity,
  sessionIdFactory = mintSessionId,
  createLocalRepositoryIdentity = true,
} = {}) {
  if (!registry || !Array.isArray(registry.entries)) {
    return { ok: false, changed: false, reason: 'invalid-registry', registry };
  }
  const version = registry.schema_version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, changed: false, reason: 'invalid-registry-schema', registry };
  }
  if (version > REGISTRY_SCHEMA_VERSION) {
    return { ok: false, changed: false, reason: 'unsupported-registry-schema', registry };
  }

  const original = registry;
  const next = structuredClone(registry);
  const issues = [];
  const pendingLocalIdentities = [];
  const legacyNameCounts = new Map();
  for (const entry of next.entries) {
    if (typeof entry?.name === 'string') {
      legacyNameCounts.set(entry.name, (legacyNameCounts.get(entry.name) || 0) + 1);
    }
  }
  for (let index = 0; index < next.entries.length; index += 1) {
    const entry = next.entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return migrationBlocked(original, 'invalid-registry-entry', [{ index }]);
    }
    if (entry.session_id != null && !validSessionId(entry.session_id)) {
      return migrationBlocked(original, 'invalid-session-id', [{ index, name: entry.name || null }]);
    }
    if (entry.repository_id != null && !REPOSITORY_ID_RE.test(entry.repository_id)) {
      return migrationBlocked(original, 'invalid-repository-id', [{ index, name: entry.name || null }]);
    }
    if (entry.repository_identity != null && !validRepositoryIdentity(entry.repository_identity)) {
      return migrationBlocked(original, 'invalid-repository-identity', [{ index, name: entry.name || null }]);
    }
    if (!entry.repository_id && entry.repository_identity?.kind === 'remote') {
      entry.repository_id = repositoryIdForCanonicalRemote(entry.repository_identity.canonical);
    }
    if (!validRepositoryIdentityPair(entry.repository_id, entry.repository_identity)) {
      return migrationBlocked(original, 'repository-identity-mismatch', [{ index, name: entry.name || null }]);
    }

    const resolved = entry.repository_id && entry.repository_identity
      ? null
      : resolveRepositoryForLegacyEntry(entry, repositoryResolver, false);
    if (resolved?.ok) {
      if (entry.repository_id && entry.repository_id !== resolved.id) {
        return migrationBlocked(original, 'repository-identity-mismatch', [{ index, name: entry.name || null }]);
      }
      entry.repository_id = resolved.id;
      entry.repository_identity = repositoryIdentityProjection(resolved);
    } else if (!entry.repository_id
      && createLocalRepositoryIdentity
      && resolved?.reason === 'local-repository-id-missing'
      && resolved.root) {
      pendingLocalIdentities.push({ index, root: resolved.root, paths: resolved.paths });
    } else if (!entry.repository_id) {
      issues.push({
        code: 'legacy-repository-unresolved',
        index,
        name: typeof entry.name === 'string' ? entry.name : null,
      });
    }
  }

  const duplicateSessionIds = duplicateKeys(next.entries, (entry) => entry.session_id);
  if (duplicateSessionIds.length > 0) {
    return migrationBlocked(original, 'duplicate-session-id', duplicateSessionIds);
  }
  const pendingByIndex = new Map(pendingLocalIdentities.map((pending) => [pending.index, pending]));
  const prospectiveQualifiedNames = duplicateKeys(
    next.entries
      .map((entry, index) => ({ entry, pending: pendingByIndex.get(index) }))
      .filter(({ entry, pending }) => (
        typeof entry.name === 'string' && (entry.repository_id || pending?.root)
      )),
    ({ entry, pending }) => `${entry.repository_id || `local-root:${pending.root}`}\0${entry.name}`,
  );
  if (prospectiveQualifiedNames.length > 0) {
    return migrationBlocked(original, 'ambiguous-legacy-session', prospectiveQualifiedNames, {
      ambiguity_kind: 'qualified-duplicate',
    });
  }
  const unresolvedBeforeWrites = next.entries
    .map((entry, index) => ({ entry, pending: pendingByIndex.get(index) }))
    .filter(({ entry, pending }) => (
      !entry.repository_id
      && !pending
      && (legacyNameCounts.get(entry.name) || 0) > 1
    ))
    .map(({ entry }) => entry.name);
  if (unresolvedBeforeWrites.length > 0) {
    return migrationBlocked(
      original,
      'ambiguous-legacy-session',
      [...new Set(unresolvedBeforeWrites)],
      { ambiguity_kind: 'unresolved-legacy' },
    );
  }

  for (const pending of pendingLocalIdentities) {
    const entry = next.entries[pending.index];
    const resolved = resolveRepositoryForPaths(pending.paths, repositoryResolver, true);
    if (resolved?.ok) {
      entry.repository_id = resolved.id;
      entry.repository_identity = repositoryIdentityProjection(resolved);
    } else {
      issues.push({
        code: 'legacy-repository-unresolved',
        index: pending.index,
        name: typeof entry.name === 'string' ? entry.name : null,
      });
    }
  }
  for (const entry of next.entries) {
    if (!entry.session_id) entry.session_id = sessionIdFactory();
    if (version < REGISTRY_SCHEMA_VERSION
      && typeof entry.name === 'string'
      && legacyNameCounts.get(entry.name) === 1
      && entry.legacy_session_key == null) {
      entry.legacy_session_key = entry.name;
    }
  }

  const duplicateQualifiedNames = duplicateKeys(
    next.entries.filter((entry) => entry.repository_id && typeof entry.name === 'string'),
    (entry) => `${entry.repository_id}\0${entry.name}`,
  );
  if (duplicateQualifiedNames.length > 0) {
    return migrationBlocked(original, 'ambiguous-legacy-session', duplicateQualifiedNames, {
      ambiguity_kind: 'qualified-duplicate',
    });
  }
  const allNameCounts = new Map();
  for (const entry of next.entries) {
    if (typeof entry.name === 'string') {
      allNameCounts.set(entry.name, (allNameCounts.get(entry.name) || 0) + 1);
    }
  }
  const unresolvedCollisions = next.entries
    .filter((entry) => !entry.repository_id && (allNameCounts.get(entry.name) || 0) > 1)
    .map((entry) => entry.name);
  if (unresolvedCollisions.length > 0) {
    return migrationBlocked(
      original,
      'ambiguous-legacy-session',
      [...new Set(unresolvedCollisions)],
      { ambiguity_kind: 'unresolved-legacy' },
    );
  }

  next.schema_version = REGISTRY_SCHEMA_VERSION;
  const changed = JSON.stringify(next) !== JSON.stringify(original);
  return { ok: true, changed, registry: next, issues };
}

function migrateLoadedRegistry(parsed, { path, persistMigration = true }) {
  const migration = migrateRegistry(parsed, {
    createLocalRepositoryIdentity: persistMigration,
  });
  if (persistMigration && migration.ok && migration.changed) {
    try {
      writeRegistry(migration.registry);
    } catch {
      return {
        ok: false,
        changed: false,
        reason: 'registry-migration-write-failed',
        registry: parsed,
        issues: migration.issues,
        path,
      };
    }
  }
  return { ...migration, path };
}

function resolveRepositoryForLegacyEntry(entry, resolver, createLocalRepositoryIdentity) {
  const paths = [entry.primary_worktree, entry.worktree_path]
    .filter((value, index, values) => (
      typeof value === 'string' && value.trim() && values.indexOf(value) === index
    ));
  return resolveRepositoryForPaths(paths, resolver, createLocalRepositoryIdentity);
}

function resolveRepositoryForPaths(paths, resolver, createLocalRepositoryIdentity) {
  let preferredFailure = null;
  for (const path of paths) {
    const resolved = resolver(path, { createLocal: createLocalRepositoryIdentity });
    if (resolved?.ok) return { ...resolved, paths };
    if (resolved?.reason === 'local-repository-id-missing' && resolved.root) {
      preferredFailure = { ...resolved, paths };
    }
  }
  return preferredFailure;
}

function duplicateKeys(entries, keyFor) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyFor(entry);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

function migrationBlocked(registry, reason, issues = [], extra = {}) {
  return { ok: false, changed: false, reason, registry, issues, ...extra };
}

function mintSessionId() {
  return `mcs_${randomBytes(12).toString('hex')}`;
}

function validSessionId(value) {
  return typeof value === 'string' && MC_SESSION_ID_RE.test(value);
}

function validRepositoryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) return false;
  if (value.kind === 'local') return value.canonical === null;
  return value.kind === 'remote'
    && typeof value.canonical === 'string'
    && value.canonical.length > 0
    && value.canonical.length <= 2048
    && !/[\0-\x1f\x7f@]/u.test(value.canonical);
}

function validRepositoryIdentityPair(repositoryId, identity) {
  if (!repositoryId || !identity || identity.kind !== 'remote') return true;
  return repositoryId === repositoryIdForCanonicalRemote(identity.canonical);
}

function lookupSuccess(entry, source, extra = {}) {
  return { ok: true, entry, source, ...extra };
}

function lookupFailure(reason, extra = {}) {
  return { ok: false, entry: null, reason, ...extra };
}

function canonicalProvider(value) {
  const known = resolveToolInput(value)?.id;
  if (known) return known;
  return typeof value === 'string' && PROVIDER_KEY.test(value) ? value : null;
}

function knownProvider(value) {
  return resolveToolInput(value)?.id || null;
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
    && Object.entries(value.providers).every(([key, session]) => (
      PROVIDER_KEY.test(key) && validProviderSession(session)
    ));
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

export function removeEntry(identifier, options = {}) {
  const reg = readRegistryStrict();
  const resolved = resolveEntry(identifier, { ...options, registry: reg });
  if (!resolved.ok) return false;
  const before = reg.entries.length;
  reg.entries = reg.entries.filter((entry) => entry.session_id !== resolved.entry.session_id);
  if (reg.entries.length === before) return false;
  writeRegistry(reg);
  return true;
}

export function removeEntryIfMatches(identifier, expected = {}, options = {}) {
  const reg = readRegistryStrict();
  const resolved = resolveEntry(identifier, { ...options, registry: reg });
  if (!resolved.ok) return { ok: false, removed: false, reason: resolved.reason };
  const index = reg.entries.findIndex((entry) => entry.session_id === resolved.entry.session_id);
  if (index === -1) return { ok: false, removed: false, reason: 'missing' };
  const entry = reg.entries[index];
  if (!validSessionId(expected.session_id) || !REPOSITORY_ID_RE.test(expected.repository_id || '')) {
    return { ok: false, removed: false, reason: 'expected-identity-required' };
  }
  for (const key of [
    'session_id',
    'repository_id',
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
  const reg = readRegistryStrict();
  const resolvedPatches = [];
  const missing = [];
  for (const patch of requested) {
    if (!patch || typeof patch.name !== 'string') continue;
    const identifier = patch.session_id || patch.name;
    const resolved = resolveEntry(identifier, {
      registry: reg,
      repositoryId: patch.repository_id || null,
    });
    if (!resolved.ok) {
      missing.push(patch.session_id || patch.name);
      continue;
    }
    if ((patch.session_id && resolved.entry.session_id !== patch.session_id)
      || (patch.repository_id && resolved.entry.repository_id !== patch.repository_id)) {
      missing.push(patch.session_id || patch.name);
      continue;
    }
    resolvedPatches.push({ patch, sessionId: resolved.entry.session_id });
  }
  if (missing.length > 0) {
    return { ok: false, missing, entries: reg.entries };
  }
  const seen = new Set();
  for (const { patch, sessionId } of resolvedPatches) {
    if (seen.has(sessionId)) {
      return { ok: false, missing: [], reason: 'duplicate-patch-identity', entries: reg.entries };
    }
    seen.add(sessionId);
    const index = reg.entries.findIndex((entry) => entry.session_id === sessionId);
    reg.entries[index] = { ...reg.entries[index], ...patch };
  }
  if (resolvedPatches.length > 0) writeRegistry(reg);
  return {
    ok: true,
    missing: [],
    entries: reg.entries.filter((entry) => seen.has(entry.session_id)),
  };
}

export function renameEntry(identifier, newName, patch = {}, options = {}) {
  const reg = readRegistryStrict();
  const resolved = resolveEntry(identifier, { ...options, registry: reg });
  if (!resolved.ok) {
    throw new Error(`registry entry "${String(identifier)}" not found (${resolved.reason})`);
  }
  const repositoryId = resolved.entry.repository_id;
  if (reg.entries.some((entry) => (
    entry.name === newName && entry.repository_id === repositoryId
  ))) {
    throw new Error(`registry entry "${newName}" already exists`);
  }
  const i = reg.entries.findIndex((entry) => entry.session_id === resolved.entry.session_id);
  reg.entries[i] = { ...reg.entries[i], ...patch, name: newName };
  writeRegistry(reg);
  return reg.entries[i];
}
