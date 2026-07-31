import { setTimeout as sleep } from 'node:timers/promises';

import { ACCOUNTS } from '../commands/auth.js';
import { memoroFetch } from '../lib/api.js';
import { getApiUrl, readConfig } from '../lib/config.js';
import { getSecret } from '../lib/keychain.js';

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_ID_RE = /^sess_[a-zA-Z0-9_-]{6,}$/;
const RUNTIME_GENERATION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/**
 * Build the shared, credential-free heartbeat body. Provider adapters supply
 * only their public source name; lifecycle ownership stays in mc.
 */
export function buildSessionHeartbeatPayload({
  codingSessionId,
  runtimeGeneration = null,
  presenceState = null,
  machineId,
  sourceIdentity = {},
  source,
  repo,
  branch,
  idleSeconds = 0,
  at,
  sessionProjection,
  label = null,
} = {}) {
  const terminal = presenceState === 'terminal';
  const metadata = {
    coding_session_id: codingSessionId,
    ...(runtimeGeneration ? { runtime_generation: runtimeGeneration } : {}),
    ...(presenceState ? { presence_state: presenceState } : {}),
    machine_id: machineId,
    source_id: sourceIdentity.source_id,
    source_kind: sourceIdentity.source_kind,
    source_name: sourceIdentity.source_name,
    cloud_session_id: sourceIdentity.cloud_session_id,
    source,
    repo,
    branch,
    idle_seconds: terminal ? 0 : idleSeconds,
    at,
    ...(label ? { label } : {}),
  };
  if (terminal) return metadata;
  return {
    ...metadata,
    session_projection: sessionProjection,
  };
}

export async function postHeartbeatWithRetry({
  apiUrl,
  token,
  payload,
  memoroFetchImpl = memoroFetch,
  sleepImpl = sleep,
  retryIntervalMs = RETRY_INTERVAL_MS,
  maxAttempts = MAX_ATTEMPTS,
  shouldContinue = () => true,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!shouldContinue()) return false;
    try {
      await memoroFetchImpl(apiUrl, '/api/sessions/heartbeat', {
        token, method: 'POST', body: payload,
      });
      return true;
    } catch {
      if (attempt < maxAttempts - 1) {
        try { await sleepImpl(retryIntervalMs); } catch {}
        if (!shouldContinue()) return false;
      }
    }
  }
  return false;
}

/**
 * Publish from a trusted local mc process without carrying device identity
 * through a launch or broker message. The token is read from the OS keychain
 * for this operation and remains closed over the HTTP call.
 *
 * argv is deliberately null for broker-owned calls. This prevents a long-lived
 * broker from inheriting an API destination through process environment while
 * still allowing an interactive CLI repair to honour an explicit --api flag.
 */
export async function publishLocalSessionPresence({
  payload,
  argv = null,
  deps = {},
  maxAttempts = MAX_ATTEMPTS,
  retryIntervalMs = RETRY_INTERVAL_MS,
  shouldContinue = () => true,
} = {}) {
  const loadSecret = deps.getSecret || getSecret;
  const loadConfig = deps.readConfig || readConfig;
  const fetchImpl = deps.memoroFetch || memoroFetch;
  const sleepImpl = deps.sleep || sleep;
  let token;
  let config;
  try {
    [token, config] = await Promise.all([
      loadSecret(ACCOUNTS.TOKEN),
      loadConfig(),
    ]);
  } catch {
    return false;
  }
  const explicitApiUrl = Array.isArray(argv)
    ? (deps.getApiUrl || getApiUrl)(argv)
    : null;
  const apiUrl = deps.apiUrl || explicitApiUrl || config?.apiUrl;
  if (typeof token !== 'string' || !token
    || typeof apiUrl !== 'string' || !apiUrl) {
    return false;
  }
  return postHeartbeatWithRetry({
    apiUrl,
    token,
    payload,
    memoroFetchImpl: fetchImpl,
    sleepImpl,
    retryIntervalMs,
    maxAttempts,
    shouldContinue,
  });
}

/**
 * Repair server presence only from positive local proof that the same logical
 * session generation exited. A different generated server row is never
 * terminalized. A generation-less row is eligible because the Worker migration
 * contract uses this generated terminal event to adopt and hide the legacy key.
 */
export async function repairExitedSessionPresence({
  active,
  runtimeGeneration,
  argv = [],
  now = () => Date.now(),
  deps = {},
} = {}) {
  const codingSessionId = nonEmpty(active?.coding_session_id || active?.id);
  const serverGeneration = nonEmpty(active?.runtime_generation);
  if (!SESSION_ID_RE.test(codingSessionId || '')
    || !RUNTIME_GENERATION_RE.test(runtimeGeneration || '')) {
    return { ok: false, reason: 'presence-repair-identity-invalid' };
  }
  if (serverGeneration && serverGeneration !== runtimeGeneration) {
    return { ok: false, reason: 'presence-repair-generation-conflict' };
  }
  const machineId = nonEmpty(active?.machine_id);
  const source = nonEmpty(active?.source || active?.tool);
  const repo = nonEmpty(active?.repo);
  const branch = nonEmpty(active?.branch);
  if (!machineId || !source || !repo || !branch) {
    return { ok: false, reason: 'presence-repair-metadata-incomplete' };
  }
  const sourceId = nonEmpty(active?.source_id) || machineId;
  const published = await (deps.publishLocalSessionPresence
    || publishLocalSessionPresence)({
    argv,
    payload: buildSessionHeartbeatPayload({
      codingSessionId,
      runtimeGeneration,
      presenceState: 'terminal',
      machineId,
      sourceIdentity: {
        source_id: sourceId,
        source_kind: nonEmpty(active?.source_kind) || 'local',
        source_name: nonEmpty(active?.source_name) || machineId,
        cloud_session_id: nonEmpty(active?.cloud_session_id),
      },
      source,
      repo,
      branch,
      idleSeconds: 0,
      at: new Date(now()).toISOString(),
      label: nonEmpty(active?.label),
    }),
    maxAttempts: 1,
    deps,
  });
  return published
    ? { ok: true, repairedGeneration: runtimeGeneration, legacy: !serverGeneration }
    : { ok: false, reason: 'presence-repair-publish-failed' };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const __test__ = {
  MAX_ATTEMPTS,
  RETRY_INTERVAL_MS,
};
