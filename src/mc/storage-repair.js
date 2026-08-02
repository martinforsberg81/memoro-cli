import { existsSync } from 'node:fs';

import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import { readRegistry, writeRegistry } from './registry.js';
import { requestBroker } from '../runtime/broker/client.js';
import { listLocalBrokerAndHostSessions } from '../runtime/broker/session-hosts.js';
import { inspectLocalBrokerSessionForEntry } from '../core/liveness/presence.js';
import { resolveToolSessionForResume } from './tool-session.js';

export async function buildStorageRepairPlan({
  registry = readRegistry(),
  now = Date.now(),
  listSessions = listLocalBrokerAndHostSessions,
  resolveToolSession = resolveToolSessionForResume,
  resolveTool = resolveToolInput,
  includeProviderBackfill = false,
  names = null,
  request = requestBroker,
  inspectPresence = inspectLocalBrokerSessionForEntry,
} = {}) {
  const probeRequest = request;
  const nowIso = new Date(resolveNowMs(now)).toISOString();
  // One broker+host enumeration for the whole plan. The engine would
  // otherwise re-list (and re-probe every host manifest socket) per
  // entry — on a registry with many live rows that compounds into
  // minutes of socket timeouts. Evidence is point-in-time either way.
  const sharedRows = await listSessions().catch(() => []);
  const listOnce = async () => sharedRows;
  const actions = [];
  const selectedNames = Array.isArray(names) && names.length
    ? new Set(names.map((name) => String(name)))
    : null;

  for (const entry of registry?.entries || []) {
    if (selectedNames
      && !selectedNames.has(entry?.session_id)
      && !selectedNames.has(entry?.name)) continue;
    const worktreePath = nonEmpty(entry?.worktree_path);
    const worktreeExists = Boolean(worktreePath && existsSync(worktreePath));

    if (entry?.session_state === 'live') {
      // THE liveness engine decides — never a local socket-only check.
      // A socket that answers while its host holds no session (a restarted
      // empty host) is not liveness; the engine's hosted-session listing,
      // lifecycle journal, and boot-time proof catch what a bare probe
      // cannot. 'unreachable' fails CLOSED here: a live journal without
      // exit proof keeps the row live for the resume-side recovery paths.
      const presence = await inspectPresence(entry, {
        request: probeRequest,
        deps: { listLocalBrokerAndHostSessions: listOnce },
      }).catch(() => ({ verdict: 'unknown' }));
      // Attachability standard: an answering host socket keeps the row
      // (host-socket-reachable) — but a lingering daemon pid with a dead
      // socket is NOT attachable and never was (the pre-engine bug this
      // module fixed once already).
      const keepUnknown = presence?.verdict === 'unknown'
        && presence?.host_runtime?.reason === 'host-socket-reachable';
      if ((presence?.verdict === 'exited' || presence?.verdict === 'unknown') && !keepUnknown) {
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

export function applyStorageRepairPlan(registry, plan, {
  write = writeRegistry,
} = {}) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const bySessionId = new Map();
  for (const action of actions) {
    if (!action?.session_id || !action?.repository_id
      || !action.patch || typeof action.patch !== 'object') {
      return { ok: false, applied: [], reason: 'repair-action-identity-missing' };
    }
    const current = (registry?.entries || []).find((entry) => (
      entry.session_id === action.session_id
    ));
    if (!current
      || current.repository_id !== action.repository_id
      || (current.worktree_path || null) !== (action.worktree_path || null)) {
      return { ok: false, applied: [], reason: 'repair-action-identity-changed' };
    }
    bySessionId.set(action.session_id, {
      ...(bySessionId.get(action.session_id) || {}),
      ...action.patch,
    });
  }

  const next = {
    ...(registry || {}),
    entries: (registry?.entries || []).map((entry) => {
      const patch = bySessionId.get(entry.session_id);
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
    session_id: entry.session_id || null,
    repository_id: entry.repository_id || null,
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


function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveNowMs(now) {
  if (typeof now === 'function') return Number(now());
  return Number(now);
}
