import { existsSync, realpathSync } from 'node:fs';

import { mcHome } from './paths.js';
import {
  createSessionHomeSync,
  listSessionHomesSync,
  resolveSessionHomeSync,
} from './session-home.js';
import {
  applySessionCutoverSync,
  createSessionCutoverPlanSync,
} from './session-cutover.js';
import { readSessionCutoverCompletionSync } from './session-cutover-interlock.js';
import { resolveLocalSourceSync } from './local-source.js';
import {
  createWorkspaceAssociationSync,
  listWorkspaceAssociationsSync,
  updateWorkspaceUsageSync,
} from './workspace-record.js';
import { inspectSessionRuntimeSync } from './session-runtime-journal.js';

export function ensureV1SessionStorageSync({
  mcHomeDir = mcHome(),
  now = () => new Date().toISOString(),
  random,
  isAlive,
} = {}) {
  const source = resolveLocalSourceSync({ mcHomeDir, now, random });
  const completion = readSessionCutoverCompletionSync({ mcHomeDir });
  if (completion.kind === 'unknown') throw sessionV1Error(completion.reason);
  if (completion.kind === 'absent') {
    createSessionCutoverPlanSync({
      mcHomeDir,
      sourceId: source.source_id,
      now,
      ...(random ? { random } : {}),
      ...(isAlive ? { isAlive } : {}),
    });
    applySessionCutoverSync({
      mcHomeDir,
      now,
      ...(random ? { random } : {}),
      ...(isAlive ? { isAlive } : {}),
    });
  } else if (completion.value.source_id !== source.source_id) {
    throw sessionV1Error('cutover-source-conflict');
  }
  return source;
}

export function createLocalSessionSync({
  mcHomeDir = mcHome(),
  sourceId,
  name,
  objective = null,
  cwd = process.cwd(),
  now,
  random,
  isAlive,
} = {}) {
  const launchCwd = canonicalDirectory(cwd);
  const session = createSessionHomeSync({
    mcHomeDir,
    sourceId,
    name,
    objective,
    preferredLaunchCwd: launchCwd,
    ...(now ? { now } : {}),
    ...(random ? { random } : {}),
    ...(isAlive ? { isAlive } : {}),
  });
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId: session.mc_session_id,
    kind: 'directory',
    currentPath: launchCwd,
    ownership: { kind: 'external' },
    preferredLaunch: true,
    ...(now ? { now } : {}),
    ...(random ? { random } : {}),
    ...(isAlive ? { isAlive } : {}),
  });
  return { session, workspace };
}

export function associateLocalWorkspaceSync({
  mcHomeDir = mcHome(),
  session,
  cwd,
  preferredLaunch = true,
  now,
} = {}) {
  const currentPath = canonicalDirectory(cwd);
  const listed = listWorkspaceAssociationsSync({
    mcHomeDir,
    mcSessionId: session.mc_session_id,
  });
  const existing = listed.workspaces.find((item) => item.current_path === currentPath);
  if (existing) {
    return updateWorkspaceUsageSync({
      mcHomeDir,
      mcSessionId: session.mc_session_id,
      workspaceId: existing.workspace_id,
      expectedRevision: existing.revision,
      preferredLaunch,
      ...(now ? { now } : {}),
    });
  }
  const created = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId: session.mc_session_id,
    kind: 'directory',
    currentPath,
    ownership: { kind: 'external' },
    preferredLaunch,
    ...(now ? { now } : {}),
  });
  return updateWorkspaceUsageSync({
    mcHomeDir,
    mcSessionId: session.mc_session_id,
    workspaceId: created.workspace_id,
    expectedRevision: created.revision,
    preferredLaunch,
    ...(now ? { now } : {}),
  });
}

export function resolveLocalSessionSync(identifier, {
  mcHomeDir = mcHome(),
  ensureCutover = true,
} = {}) {
  if (ensureCutover) ensureV1SessionStorageSync({ mcHomeDir });
  const raw = String(identifier || '');
  if (raw.startsWith('cloud:')) {
    return { ok: false, reason: 'cloud-session-not-local' };
  }
  const localIdentifier = raw.startsWith('local:') ? raw.slice('local:'.length) : raw;
  return resolveSessionHomeSync(localIdentifier, { mcHomeDir });
}

export function listLocalSessionProjectionsSync({
  mcHomeDir = mcHome(),
  ensureCutover = true,
} = {}) {
  if (ensureCutover) ensureV1SessionStorageSync({ mcHomeDir });
  const listed = listSessionHomesSync({ mcHomeDir });
  return {
    sessions: listed.sessions.map((session) => projectLocalSessionSync(session, { mcHomeDir })),
    issues: listed.issues,
  };
}

export function projectLocalSessionSync(session, { mcHomeDir = mcHome() } = {}) {
  const workspaces = listWorkspaceAssociationsSync({
    mcHomeDir,
    mcSessionId: session.mc_session_id,
  });
  const selected = selectLaunchWorkspace(session, workspaces.workspaces);
  return {
    source_kind: 'local',
    source_id: session.identity.owner.source_id,
    mc_session_id: session.mc_session_id,
    name: session.metadata.name,
    objective: session.metadata.objective,
    lifecycle: session.projection.lifecycle,
    runtime_state: session.projection.runtime_state,
    runtime_generation: session.projection.active_runtime_generation,
    tool: session.projection.tool,
    updated_at: session.projection.updated_at,
    workspace_id: selected?.workspace_id || null,
    workspace_path: selected?.current_path || session.metadata.preferred_launch_cwd || null,
    workspace_state: selected?.path_state || null,
    workspace_count: workspaces.workspaces.length,
    workspaces: workspaces.workspaces,
    issues: workspaces.issues,
  };
}

export function sessionStatusSync(session, { mcHomeDir = mcHome() } = {}) {
  return {
    ...projectLocalSessionSync(session, { mcHomeDir }),
    metadata_revision: session.metadata.revision,
    name_revision: session.metadata.name_revision,
    created_at: session.metadata.created_at,
    runtime: inspectSessionRuntimeSync({ mcHomeDir, mcSessionId: session.mc_session_id }),
  };
}

export function selectLaunchWorkspace(session, workspaces = []) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;
  const preferredPath = session?.metadata?.preferred_launch_cwd || null;
  return [...workspaces].sort((a, b) => (
    Number(b.preferred_launch) - Number(a.preferred_launch)
    || String(b.last_launch_used_at || '').localeCompare(String(a.last_launch_used_at || ''))
    || Number(b.current_path === preferredPath) - Number(a.current_path === preferredPath)
    || String(b.last_present_at || '').localeCompare(String(a.last_present_at || ''))
    || a.workspace_id.localeCompare(b.workspace_id)
  ))[0];
}

function canonicalDirectory(path) {
  if (typeof path !== 'string' || !path || !existsSync(path)) {
    throw sessionV1Error('workspace-missing');
  }
  let resolved;
  try { resolved = realpathSync(path); } catch { throw sessionV1Error('workspace-unavailable'); }
  return resolved;
}

function sessionV1Error(reason) {
  const error = new Error(`mc V1 session error (${reason})`);
  error.code = 'MC_SESSION_V1_ERROR';
  error.reason = reason;
  return error;
}
