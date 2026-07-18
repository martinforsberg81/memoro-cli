import { existsSync, readFileSync } from 'node:fs';

import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import { readRegistry, writeRegistry } from './registry.js';
import { listLocalBrokerAndHostSessions } from './broker/session-hosts.js';
import { sessionHostPaths } from './broker/paths.js';
import { resolveToolSessionForResume } from './tool-session.js';

export async function buildStorageRepairPlan({
  registry = readRegistry(),
  now = Date.now(),
  listSessions = listLocalBrokerAndHostSessions,
  resolveToolSession = resolveToolSessionForResume,
  resolveTool = resolveToolInput,
  includeProviderBackfill = false,
  names = null,
} = {}) {
  const nowIso = new Date(resolveNowMs(now)).toISOString();
  const liveIds = await listSessions()
    .then((sessions) => new Set((sessions || []).map(sessionIdForLiveRow).filter(Boolean)))
    .catch(() => new Set());
  const actions = [];
  const selectedNames = Array.isArray(names) && names.length
    ? new Set(names.map((name) => String(name)))
    : null;

  for (const entry of registry?.entries || []) {
    if (selectedNames && !selectedNames.has(entry?.name)) continue;
    const sessionId = nonEmpty(entry?.coding_session_id);
    const worktreePath = nonEmpty(entry?.worktree_path);
    const worktreeExists = Boolean(worktreePath && existsSync(worktreePath));
    const live = Boolean(sessionId && (liveIds.has(sessionId) || hostBrokerPidAlive(sessionId)));

    if (entry?.session_state === 'live' && !live) {
      actions.push(registryPatchAction({
        type: 'mark-idle',
        entry,
        reason: 'registry-live-without-local-broker',
        patch: {
          session_state: 'idle',
          last_storage_repair_at: nowIso,
          last_storage_repair_reason: 'registry-live-without-local-broker',
        },
      }));
    }

    if (worktreePath && !worktreeExists && entry?.worktree_missing !== true) {
      actions.push(registryPatchAction({
        type: 'mark-worktree-missing',
        entry,
        reason: 'registered-worktree-missing',
        patch: {
          worktree_missing: true,
          last_storage_repair_at: nowIso,
          last_storage_repair_reason: 'registered-worktree-missing',
        },
      }));
    }

    if (worktreePath && worktreeExists && entry?.worktree_missing === true) {
      actions.push(registryPatchAction({
        type: 'clear-worktree-missing',
        entry,
        reason: 'registered-worktree-present',
        patch: {
          worktree_missing: false,
          last_storage_repair_at: nowIso,
          last_storage_repair_reason: 'registered-worktree-present',
        },
      }));
    }

    if (includeProviderBackfill && needsProviderBackfill(entry)) {
      const backfill = await providerBackfillAction(entry, {
        resolveToolSession,
        resolveTool,
        nowIso,
      });
      if (backfill) actions.push(backfill);
    }
  }

  return {
    ok: true,
    generated_at: nowIso,
    actions,
    counts: summarizeActions(actions),
  };
}

function needsProviderBackfill(entry) {
  const hasLaunched = Boolean(nonEmpty(entry?.coding_session_id))
    && (entry?.session_state || 'no-session-yet') !== 'no-session-yet';
  return hasLaunched && !(
    nonEmpty(entry?.tool_session_id)
    || nonEmpty(entry?.provider_session_id)
    || nonEmpty(entry?.llm_session_id)
  );
}

function hostBrokerPidAlive(sessionId) {
  const pidPath = sessionHostPaths(sessionId).pidPath;
  let pid = null;
  try {
    const parsed = Number(readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function applyStorageRepairPlan(registry, plan, {
  write = writeRegistry,
} = {}) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const byName = new Map();
  for (const action of actions) {
    if (!action?.name || !action.patch || typeof action.patch !== 'object') continue;
    byName.set(action.name, {
      ...(byName.get(action.name) || {}),
      ...action.patch,
    });
  }

  const next = {
    ...(registry || {}),
    entries: (registry?.entries || []).map((entry) => {
      const patch = byName.get(entry.name);
      return patch ? { ...entry, ...patch } : entry;
    }),
  };
  write(next);
  return {
    ok: true,
    applied: actions,
    counts: summarizeActions(actions),
  };
}

async function providerBackfillAction(entry, {
  resolveToolSession,
  resolveTool,
  nowIso,
} = {}) {
  const launchTool = resolveTool(entry?.tool || DEFAULT_TOOL);
  let resolved = null;
  try {
    resolved = await resolveToolSession({
      entry,
      launchTool,
    });
  } catch {
    return null;
  }
  if (!resolved?.ok || !nonEmpty(resolved.sessionId)) return null;
  return registryPatchAction({
    type: 'backfill-tool-session',
    entry,
    reason: `found-${resolved.from || 'provider'}-session-id`,
    patch: {
      tool_session_id: resolved.sessionId,
      tool_session_source: resolved.source || null,
      tool_transcript_path: resolved.transcriptPath || null,
      last_storage_repair_at: nowIso,
      last_storage_repair_reason: 'provider-native-id-missing',
    },
  });
}

function registryPatchAction({
  type,
  entry,
  reason,
  patch,
} = {}) {
  return {
    type,
    name: entry.name,
    reason,
    worktree_path: entry.worktree_path || null,
    patch: compactPatch(patch),
  };
}

function compactPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function summarizeActions(actions) {
  const byType = {};
  for (const action of actions || []) {
    byType[action.type] = (byType[action.type] || 0) + 1;
  }
  return {
    total: actions.length,
    by_type: byType,
  };
}

function sessionIdForLiveRow(session) {
  return nonEmpty(session?.id || session?.coding_session_id || session?.host_session_id);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveNowMs(now) {
  if (typeof now === 'function') return Number(now());
  return Number(now);
}
