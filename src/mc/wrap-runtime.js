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
  now = new Date(),
} = {}) {
  if (!codingSessionId) throw new Error('buildSessionMeta: codingSessionId required');
  return {
    coding_session_id: codingSessionId,
    label,
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
