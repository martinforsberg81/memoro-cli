import { join } from 'node:path';

import { deriveRepoName } from '../lib/git-context.js';

export function wrapRuntimePaths({ mcDir, codingSessionId } = {}) {
  if (!mcDir) throw new Error('wrapRuntimePaths: mcDir required');
  if (!codingSessionId) throw new Error('wrapRuntimePaths: codingSessionId required');
  return {
    sockPath: join(mcDir, `${codingSessionId}.sock`),
    metaPath: join(mcDir, `${codingSessionId}.json`),
  };
}

export function buildSessionMeta({
  codingSessionId,
  label = null,
  sockPath,
  repoContext,
  cwd,
  pid,
  tool = null,
  source = null,
  toolSessionId = null,
  transcriptPath = null,
  now = new Date(),
} = {}) {
  if (!codingSessionId) throw new Error('buildSessionMeta: codingSessionId required');
  return {
    runtime_manifest_version: 1,
    cleanup_owner: 'mc',
    coding_session_id: codingSessionId,
    label,
    tool,
    source,
    tool_session_id: toolSessionId,
    tool_transcript_path: transcriptPath,
    sock_path: sockPath || null,
    repo: deriveRepoName(repoContext),
    branch: repoContext?.branch || null,
    cwd: cwd || null,
    started_at: asIso(now),
    pid: pid ?? null,
  };
}

export function buildHeartbeatBase({
  codingSessionId,
  machineId,
  heartbeatSource,
  repoContext,
  label = null,
} = {}) {
  if (!codingSessionId) throw new Error('buildHeartbeatBase: codingSessionId required');
  return {
    coding_session_id: codingSessionId,
    machine_id: machineId || null,
    source: heartbeatSource || null,
    repo: deriveRepoName(repoContext),
    branch: repoContext?.branch || null,
    files_touched_since_last: [],
    last_user_excerpt: '',
    ...(label ? { label } : {}),
  };
}

export function buildHeartbeatPayload({
  base,
  outputBuffer = '',
  lastOutputAt,
  now = Date.now(),
  excerptMax,
  extractExcerpt,
} = {}) {
  if (!base || typeof base !== 'object') {
    throw new Error('buildHeartbeatPayload: base required');
  }
  if (typeof extractExcerpt !== 'function') {
    throw new Error('buildHeartbeatPayload: extractExcerpt required');
  }
  const nowMs = timestampMs(now);
  const lastMs = timestampMs(lastOutputAt ?? nowMs);
  return {
    ...base,
    last_assistant_excerpt: extractExcerpt(outputBuffer, excerptMax),
    idle_seconds: Math.max(0, Math.floor((nowMs - lastMs) / 1000)),
    at: new Date(nowMs).toISOString(),
  };
}

export async function resolveCodingSessionIdForWrap({
  sessionName = null,
  registryEntry = null,
  repoIdentity,
  machineId,
  nowMs = Date.now(),
  pid = process.pid,
  lookupOrMint,
} = {}) {
  if (sessionName && registryEntry?.coding_session_id) {
    return { codingSessionId: registryEntry.coding_session_id, source: 'registry' };
  }
  if (typeof lookupOrMint !== 'function') {
    throw new Error('resolveCodingSessionIdForWrap: lookupOrMint required');
  }
  const identity = buildWrapLookupIdentity({
    repoIdentity,
    machineId,
    sessionName,
    nowMs,
    pid,
  });
  const codingSessionId = await lookupOrMint(identity);
  return {
    codingSessionId,
    source: sessionName ? 'stable-session-name' : 'runtime',
    identity,
  };
}

export function buildWrapLookupIdentity({
  repoIdentity,
  machineId,
  sessionName = null,
  nowMs = Date.now(),
  pid = process.pid,
} = {}) {
  return {
    repoIdentity,
    machineId,
    llmSessionId: sessionName ? `mc-session:${sessionName}` : `mc-${nowMs}-${pid}`,
  };
}

export function buildWrapStartRegistryPatch({
  sessionName,
  codingSessionId,
  tool,
  heartbeatSource,
  repoContext,
  cwd,
  machineId,
  pid,
  now = new Date(),
} = {}) {
  if (!sessionName) return null;
  if (!codingSessionId) throw new Error('buildWrapStartRegistryPatch: codingSessionId required');
  const at = asIso(now);
  const patch = {
    name: sessionName,
    coding_session_id: codingSessionId,
    session_state: 'live',
    last_activity: at,
    last_started_at: at,
    last_pid: pid ?? null,
    machine_id: machineId || null,
  };
  if (tool) patch.tool = tool;
  if (heartbeatSource) patch.source = heartbeatSource;
  if (repoContext?.branch) patch.branch = repoContext.branch;
  if (repoContext?.toplevel || cwd) patch.worktree_path = repoContext?.toplevel || cwd;
  return patch;
}

export function buildWrapExitRegistryPatch({
  sessionName,
  codingSessionId,
  exitCode = 0,
  now = new Date(),
} = {}) {
  if (!sessionName) return null;
  if (!codingSessionId) throw new Error('buildWrapExitRegistryPatch: codingSessionId required');
  const at = asIso(now);
  return {
    name: sessionName,
    coding_session_id: codingSessionId,
    session_state: exitCode === 0 ? 'idle' : 'dead',
    last_activity: at,
    last_exit_at: at,
    last_exit_code: exitCode ?? null,
    last_pid: null,
  };
}

function asIso(value) {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
