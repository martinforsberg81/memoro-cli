import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import {
  ensurePrivateDirectoryChainSync,
  fsyncDirectorySync,
  inspectPrivateDirectoryChainSync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
  replacePrivateJsonSync,
} from './private-state.js';
import { sessionHomePaths } from './session-home-paths.js';
import {
  acquireLockSync,
  processIsAlive,
  releaseLockSync,
  validateLockOwner,
  withLocksSync,
} from './session-home-lock.js';
import {
  classifyNameClaim,
  listNameClaimsSync,
  readNameClaimSync,
  removeNameClaimIfOwned,
} from './session-name-catalog.js';
import {
  MC_SESSION_ID_RE,
  SESSION_HOME_VERSION,
  SESSION_IDENTITY_SCHEMA,
  SESSION_METADATA_SCHEMA,
  SESSION_PROJECTION_SCHEMA,
  assertExpectedRevision,
  assertMcSessionId,
  assertSourceId,
  assertValid,
  mintMcSessionId,
  nameClaimFromMetadata,
  normalizeSessionName,
  sessionHomeError,
  sessionNameDigest,
  unknown,
  validateIso,
  validateObjective,
  validateOptionalAbsolutePath,
  validateSessionIdentity,
  validateSessionMetadata,
  validateSessionNameClaim,
  validateSessionProjection,
} from './session-home-schema.js';

export { sessionHomePaths } from './session-home-paths.js';

export {
  MC_SESSION_ID_RE,
  SESSION_HOME_VERSION,
  SESSION_IDENTITY_SCHEMA,
  SESSION_LOCK_OWNER_SCHEMA,
  SESSION_METADATA_SCHEMA,
  SESSION_NAME_CLAIM_SCHEMA,
  SESSION_NAME_RE,
  SESSION_PROJECTION_SCHEMA,
  mintMcSessionId,
  normalizeSessionName,
  validateSessionIdentity,
  validateSessionMetadata,
  validateSessionNameClaim,
  validateSessionProjection,
} from './session-home-schema.js';

const SESSION_DIRECTORY_NAMES = Object.freeze([
  'workspaces',
  'conversations',
  'generations',
  'resources',
]);
const SESSION_FILE_NAMES = new Set([
  'identity.json',
  'legacy-references.json',
  'metadata.json',
  'projection.json',
]);

export function createSessionHomeSync({
  mcHomeDir = mcHome(),
  mcSessionId = mintMcSessionId(),
  sourceId,
  name,
  objective = null,
  preferredLaunchCwd = null,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertSourceId(sourceId);
  const normalizedName = normalizeSessionName(name);
  validateObjective(objective);
  validateOptionalAbsolutePath(preferredLaunchCwd, 'preferred launch cwd');
  const recordedAt = validateIso(now());
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId, normalizedName });
  ensureCatalogRoots(paths);

  return withLocksSync([paths.nameLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'create-session',
    isAlive,
    random,
  }, () => {
    const currentClaim = readNameClaimSync({ mcHomeDir: paths.mcHomeDir, normalizedName });
    if (currentClaim.kind !== 'absent') throw sessionHomeError('session-name-claim-conflict');

    let homeCreated = false;
    let claimCreated = false;
    try {
      const identity = {
        schema: SESSION_IDENTITY_SCHEMA,
        version: SESSION_HOME_VERSION,
        mc_session_id: mcSessionId,
        owner: { kind: 'machine', source_id: sourceId },
        created_at: recordedAt,
      };
      const metadata = {
        schema: SESSION_METADATA_SCHEMA,
        version: SESSION_HOME_VERSION,
        mc_session_id: mcSessionId,
        revision: 1,
        name_revision: 1,
        name,
        normalized_name: normalizedName,
        objective,
        preferred_launch_cwd: preferredLaunchCwd,
        created_at: recordedAt,
        updated_at: recordedAt,
      };
      const projection = {
        schema: SESSION_PROJECTION_SCHEMA,
        version: SESSION_HOME_VERSION,
        mc_session_id: mcSessionId,
        revision: 1,
        lifecycle: 'open',
        runtime_state: 'none',
        active_runtime_generation: null,
        tool: null,
        updated_at: recordedAt,
      };
      const claim = nameClaimFromMetadata(metadata, recordedAt);
      assertValid(validateSessionIdentity(identity));
      assertValid(validateSessionMetadata(metadata));
      assertValid(validateSessionProjection(projection));
      assertValid(validateSessionNameClaim(claim));

      // Claim the human name before publishing the home. A process crash can
      // therefore leave a bounded dangling claim, but never an unclaimed home
      // that allows a second session to take the same name.
      publishImmutablePrivateJsonSync({
        path: paths.nameClaimPath,
        value: claim,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      claimCreated = true;
      mkdirSync(paths.home, { mode: 0o700 });
      homeCreated = true;
      for (const directory of SESSION_DIRECTORY_NAMES) {
        ensurePrivateDirectoryChainSync({
          trustedRoot: paths.mcHomeDir,
          directory: join(paths.home, directory),
        });
      }
      publishImmutablePrivateJsonSync({
        path: paths.identityPath,
        value: identity,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      replacePrivateJsonSync({
        path: paths.metadataPath,
        value: metadata,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      replacePrivateJsonSync({
        path: paths.projectionPath,
        value: projection,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      fsyncDirectorySync(paths.sessionsRoot);

      const read = readSessionHomeSync({ mcHomeDir: paths.mcHomeDir, mcSessionId });
      if (read.kind !== 'present' || read.catalog_state !== 'ready') {
        throw sessionHomeError('session-publication-verification-failed');
      }
      return read;
    } catch (error) {
      if (claimCreated) removeNameClaimIfOwned(paths, mcSessionId, 1);
      if (homeCreated) {
        try { rmSync(paths.home, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  });
}

export function readSessionHomeSync({
  mcHomeDir = mcHome(),
  mcSessionId,
} = {}) {
  try {
    assertMcSessionId(mcSessionId);
  } catch {
    return unknown('invalid-session-id');
  }
  let paths;
  try {
    paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  } catch {
    return unknown('invalid-private-root');
  }
  const homeSafety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.home,
  });
  if (!homeSafety.ok) {
    return homeSafety.missing ? { kind: 'absent' } : unknown(homeSafety.reason);
  }
  for (const directory of SESSION_DIRECTORY_NAMES) {
    const safety = inspectPrivateDirectoryChainSync({
      trustedRoot: paths.mcHomeDir,
      directory: join(paths.home, directory),
    });
    if (!safety.ok) return unknown(`unsafe-${directory}-${safety.reason}`);
  }
  const unexpected = unexpectedSessionEntries(paths.home);
  if (unexpected.length > 0) return unknown('unexpected-session-entry', { entries: unexpected });

  const identity = readPrivateJsonSync({
    path: paths.identityPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateSessionIdentity,
  });
  const metadata = readPrivateJsonSync({
    path: paths.metadataPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateSessionMetadata,
  });
  const projection = readPrivateJsonSync({
    path: paths.projectionPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateSessionProjection,
  });
  for (const [label, read] of Object.entries({ identity, metadata, projection })) {
    if (read.kind !== 'present') return unknown(`${label}-${read.reason || read.kind}`);
  }
  if (identity.value.mc_session_id !== mcSessionId
    || metadata.value.mc_session_id !== mcSessionId
    || projection.value.mc_session_id !== mcSessionId) {
    return unknown('session-id-binding-mismatch');
  }

  const claim = readNameClaimSync({
    mcHomeDir: paths.mcHomeDir,
    normalizedName: metadata.value.normalized_name,
  });
  const catalog = classifyNameClaim(claim, metadata.value);
  return {
    kind: 'present',
    mc_session_id: mcSessionId,
    identity: identity.value,
    metadata: metadata.value,
    projection: projection.value,
    catalog_state: catalog.state,
    ...(catalog.reason ? { catalog_reason: catalog.reason } : {}),
  };
}

export function listSessionHomesSync({ mcHomeDir = mcHome() } = {}) {
  let paths;
  try {
    paths = sessionHomePaths({ mcHomeDir });
  } catch {
    return { sessions: [], issues: [{ scope: 'catalog', reason: 'invalid-private-root' }] };
  }
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.sessionsRoot,
  });
  if (!safety.ok) {
    return safety.missing
      ? { sessions: [], issues: [] }
      : { sessions: [], issues: [{ scope: 'catalog', reason: safety.reason }] };
  }
  let names;
  try {
    names = readdirSync(paths.sessionsRoot).sort();
  } catch {
    return { sessions: [], issues: [{ scope: 'catalog', reason: 'unreadable-sessions-root' }] };
  }

  const sessions = [];
  const issues = [];
  for (const name of names) {
    if (!MC_SESSION_ID_RE.test(name)) {
      issues.push({ scope: 'entry', entry: name, reason: 'unexpected-session-directory' });
      continue;
    }
    const read = readSessionHomeSync({ mcHomeDir: paths.mcHomeDir, mcSessionId: name });
    if (read.kind !== 'present') {
      issues.push({ scope: 'session', mc_session_id: name, reason: read.reason || read.kind });
      continue;
    }
    sessions.push(read);
    if (read.catalog_state !== 'ready') {
      issues.push({
        scope: 'name-claim',
        mc_session_id: name,
        normalized_name: read.metadata.normalized_name,
        reason: read.catalog_reason || read.catalog_state,
      });
    }
  }
  sessions.sort((a, b) => (
    a.metadata.normalized_name.localeCompare(b.metadata.normalized_name)
    || a.mc_session_id.localeCompare(b.mc_session_id)
  ));
  return { sessions, issues };
}

export function resolveSessionHomeSync(identifier, { mcHomeDir = mcHome() } = {}) {
  if (MC_SESSION_ID_RE.test(identifier || '')) {
    const read = readSessionHomeSync({ mcHomeDir, mcSessionId: identifier });
    return read.kind === 'present'
      ? { ok: true, source: 'session-id', session: read }
      : { ok: false, reason: read.reason || read.kind };
  }
  let normalizedName;
  try {
    normalizedName = normalizeSessionName(identifier);
  } catch {
    return { ok: false, reason: 'invalid-session-identifier' };
  }
  const claim = readNameClaimSync({ mcHomeDir, normalizedName });
  if (claim.kind !== 'present') return { ok: false, reason: claim.reason || claim.kind };
  const read = readSessionHomeSync({ mcHomeDir, mcSessionId: claim.value.mc_session_id });
  if (read.kind !== 'present') return { ok: false, reason: read.reason || read.kind };
  const classified = classifyNameClaim(claim, read.metadata);
  if (classified.state !== 'ready') return { ok: false, reason: classified.reason };
  return { ok: true, source: 'session-name', session: read };
}

export function updateSessionMetadataSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  expectedRevision,
  objective,
  preferredLaunchCwd,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertExpectedRevision(expectedRevision);
  if (objective !== undefined) validateObjective(objective);
  if (preferredLaunchCwd !== undefined) {
    validateOptionalAbsolutePath(preferredLaunchCwd, 'preferred launch cwd');
  }
  if (objective === undefined && preferredLaunchCwd === undefined) {
    throw new TypeError('metadata update requires a supported field');
  }
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'update-session-metadata',
    isAlive,
    random,
  }, () => {
    const current = requireSession(paths.mcHomeDir, mcSessionId);
    if (current.metadata.revision !== expectedRevision) {
      throw sessionHomeError('metadata-revision-conflict');
    }
    const next = {
      ...current.metadata,
      revision: expectedRevision + 1,
      ...(objective !== undefined ? { objective } : {}),
      ...(preferredLaunchCwd !== undefined ? { preferred_launch_cwd: preferredLaunchCwd } : {}),
      updated_at: validateIso(now()),
    };
    assertValid(validateSessionMetadata(next));
    replacePrivateJsonSync({
      path: paths.metadataPath,
      value: next,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireSession(paths.mcHomeDir, mcSessionId);
  });
}

export function renameSessionHomeSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  expectedRevision,
  name,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertExpectedRevision(expectedRevision);
  const normalizedName = normalizeSessionName(name);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const before = requireSession(paths.mcHomeDir, mcSessionId);
  const oldNormalizedName = before.metadata.normalized_name;
  if (oldNormalizedName === normalizedName && before.metadata.name === name) return before;
  const oldPaths = sessionHomePaths({ mcHomeDir: paths.mcHomeDir, normalizedName: oldNormalizedName });
  const newPaths = sessionHomePaths({ mcHomeDir: paths.mcHomeDir, normalizedName });

  return withLocksSync([
    paths.mutationLockPath,
    oldPaths.nameLockPath,
    newPaths.nameLockPath,
  ], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'rename-session',
    isAlive,
    random,
  }, () => {
    const current = requireSession(paths.mcHomeDir, mcSessionId);
    if (current.metadata.revision !== expectedRevision) {
      throw sessionHomeError('metadata-revision-conflict');
    }
    const conflicts = sessionsWithNormalizedNameSync(paths.mcHomeDir, normalizedName)
      .filter((session) => session.mc_session_id !== mcSessionId);
    if (conflicts.length > 0) throw sessionHomeError('session-name-conflict');
    const existingClaim = readNameClaimSync({ mcHomeDir: paths.mcHomeDir, normalizedName });
    if (existingClaim.kind !== 'absent'
      && existingClaim.value?.mc_session_id !== mcSessionId) {
      throw sessionHomeError('session-name-claim-conflict');
    }

    const next = {
      ...current.metadata,
      revision: current.metadata.revision + 1,
      name_revision: current.metadata.name_revision + 1,
      name,
      normalized_name: normalizedName,
      updated_at: validateIso(now()),
    };
    const claim = nameClaimFromMetadata(next, next.updated_at);
    const sameClaimPath = oldPaths.nameClaimPath === newPaths.nameClaimPath;
    let newClaimCreated = false;
    const existingMatchesNext = existingClaim.kind === 'present'
      && classifyNameClaim(existingClaim, next).state === 'ready';
    if (!existingMatchesNext) {
      if (existingClaim.kind === 'present') {
        removeNameClaimIfOwned(
          newPaths,
          existingClaim.value.mc_session_id,
          existingClaim.value.name_revision,
        );
      }
      publishImmutablePrivateJsonSync({
        path: newPaths.nameClaimPath,
        value: claim,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      newClaimCreated = true;
    }
    try {
      replacePrivateJsonSync({
        path: paths.metadataPath,
        value: next,
        trustedRoot: paths.mcHomeDir,
        random,
      });
    } catch (error) {
      if (newClaimCreated) {
        removeNameClaimIfOwned(newPaths, mcSessionId, next.name_revision);
        if (sameClaimPath && existingClaim.kind === 'present') {
          try {
            publishImmutablePrivateJsonSync({
              path: oldPaths.nameClaimPath,
              value: existingClaim.value,
              trustedRoot: paths.mcHomeDir,
              random,
            });
          } catch {}
        }
      }
      throw error;
    }
    if (!sameClaimPath) {
      removeNameClaimIfOwned(oldPaths, mcSessionId, current.metadata.name_revision);
    }
    return requireSession(paths.mcHomeDir, mcSessionId);
  });
}

export function writeSessionProjectionSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  expectedRevision,
  lifecycle,
  runtimeState,
  activeRuntimeGeneration = null,
  tool = null,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertExpectedRevision(expectedRevision);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'write-session-projection',
    isAlive,
    random,
  }, () => {
    const current = requireSession(paths.mcHomeDir, mcSessionId);
    if (current.projection.revision !== expectedRevision) {
      throw sessionHomeError('projection-revision-conflict');
    }
    const next = {
      schema: SESSION_PROJECTION_SCHEMA,
      version: SESSION_HOME_VERSION,
      mc_session_id: mcSessionId,
      revision: expectedRevision + 1,
      lifecycle,
      runtime_state: runtimeState,
      active_runtime_generation: activeRuntimeGeneration,
      tool,
      updated_at: validateIso(now()),
    };
    assertValid(validateSessionProjection(next));
    replacePrivateJsonSync({
      path: paths.projectionPath,
      value: next,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireSession(paths.mcHomeDir, mcSessionId);
  });
}

export function inspectSessionCatalogSync({ mcHomeDir = mcHome() } = {}) {
  const listed = listSessionHomesSync({ mcHomeDir });
  const actions = [];
  const byId = new Map(listed.sessions.map((session) => [session.mc_session_id, session]));
  const byName = new Map();
  for (const session of listed.sessions) {
    const key = session.metadata.normalized_name;
    const group = byName.get(key) || [];
    group.push(session);
    byName.set(key, group);
  }
  for (const session of listed.sessions) {
    const key = session.metadata.normalized_name;
    if (session.catalog_state !== 'ready') {
      actions.push({
        action: 'publish-name-claim',
        mc_session_id: session.mc_session_id,
        normalized_name: key,
        safe: byName.get(key)?.length === 1,
      });
    }
  }

  const claims = listNameClaimsSync(mcHomeDir);
  for (const claim of claims.claims) {
    const session = byId.get(claim.value.mc_session_id);
    const current = session && classifyNameClaim({ kind: 'present', value: claim.value }, session.metadata);
    if (current?.state === 'ready') continue;
    if (session && claim.value.normalized_name === session.metadata.normalized_name) {
      // The publish action above replaces a stale revision for the current
      // name. Do not also schedule a removal that could delete the repair.
      continue;
    }
    const homeExists = exactDirectoryExists(sessionHomePaths({
      mcHomeDir,
      mcSessionId: claim.value.mc_session_id,
    }).home);
    actions.push({
      action: 'remove-stale-name-claim',
      mc_session_id: claim.value.mc_session_id,
      normalized_name: claim.value.normalized_name,
      safe: !homeExists || Boolean(session),
    });
  }
  return {
    sessions: listed.sessions,
    issues: [...listed.issues, ...claims.issues],
    actions: dedupeActions(actions),
  };
}

export function repairSessionCatalogSync({
  mcHomeDir = mcHome(),
  apply = false,
  random = randomBytes,
  isAlive = processIsAlive,
  now = () => new Date().toISOString(),
} = {}) {
  const before = inspectSessionCatalogSync({ mcHomeDir });
  if (!apply) return { ok: true, applied: false, ...before };
  const applied = [];
  const skipped = [];
  for (const action of before.actions) {
    if (!action.safe) {
      skipped.push({ ...action, reason: 'manual-review-required' });
      continue;
    }
    const paths = sessionHomePaths({ mcHomeDir, normalizedName: action.normalized_name });
    try {
      withLocksSync([paths.nameLockPath], {
        trustedRoot: paths.mcHomeDir,
        purpose: 'repair-session-catalog',
        isAlive,
        random,
      }, () => {
        if (action.action === 'publish-name-claim') {
          const session = requireSession(paths.mcHomeDir, action.mc_session_id);
          const sameName = sessionsWithNormalizedNameSync(paths.mcHomeDir, action.normalized_name);
          if (sameName.length !== 1 || sameName[0].mc_session_id !== action.mc_session_id) {
            throw sessionHomeError('session-name-conflict');
          }
          const current = readNameClaimSync({
            mcHomeDir: paths.mcHomeDir,
            normalizedName: action.normalized_name,
          });
          if (current.kind === 'present') {
            const classified = classifyNameClaim(current, session.metadata);
            if (classified.state === 'ready') return;
            removeNameClaimIfOwned(paths, current.value.mc_session_id, current.value.name_revision);
          } else if (current.kind !== 'absent') {
            throw sessionHomeError('unsafe-name-claim');
          }
          publishImmutablePrivateJsonSync({
            path: paths.nameClaimPath,
            value: nameClaimFromMetadata(session.metadata, validateIso(now())),
            trustedRoot: paths.mcHomeDir,
            random,
          });
        } else if (action.action === 'remove-stale-name-claim') {
          const current = readNameClaimSync({
            mcHomeDir: paths.mcHomeDir,
            normalizedName: action.normalized_name,
          });
          if (current.kind === 'present'
            && current.value.mc_session_id === action.mc_session_id) {
            removeNameClaimIfOwned(paths, current.value.mc_session_id, current.value.name_revision);
          }
        }
      });
      applied.push(action);
    } catch (error) {
      skipped.push({ ...action, reason: error.reason || error.message });
    }
  }
  const after = inspectSessionCatalogSync({ mcHomeDir });
  return {
    ok: skipped.length === 0,
    applied: true,
    actions_applied: applied,
    actions_skipped: skipped,
    ...after,
  };
}

export const __test__ = Object.freeze({
  acquireLockSync,
  classifyNameClaim,
  listNameClaimsSync,
  releaseLockSync,
  sessionNameDigest,
  validateLockOwner,
});

function ensureCatalogRoots(paths) {
  for (const directory of [
    paths.sessionsRoot,
    paths.namesRoot,
    paths.runRoot,
    paths.locksRoot,
  ]) {
    ensurePrivateDirectoryChainSync({ trustedRoot: paths.mcHomeDir, directory });
  }
}

function requireSession(mcHomeDir, mcSessionId) {
  const read = readSessionHomeSync({ mcHomeDir, mcSessionId });
  if (read.kind !== 'present') throw sessionHomeError(read.reason || read.kind);
  return read;
}

function sessionsWithNormalizedNameSync(mcHomeDir, normalizedName) {
  return listSessionHomesSync({ mcHomeDir }).sessions
    .filter((session) => session.metadata.normalized_name === normalizedName);
}

function unexpectedSessionEntries(home) {
  try {
    return readdirSync(home)
      .filter((name) => !SESSION_FILE_NAMES.has(name) && !SESSION_DIRECTORY_NAMES.includes(name))
      .sort();
  } catch {
    return ['<unreadable>'];
  }
}

function exactDirectoryExists(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function dedupeActions(actions) {
  const byKey = new Map();
  for (const action of actions) {
    const key = `${action.action}\0${action.normalized_name}\0${action.mc_session_id}`;
    if (!byKey.has(key)) byKey.set(key, action);
  }
  return [...byKey.values()];
}
