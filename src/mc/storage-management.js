import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { readRegistry, resolveEntry } from './registry.js';
import {
  branchExists,
  commitsAhead,
  primaryWorktree,
  resolveDefaultBranch,
  tryGit,
} from './git.js';
import { scanDaemons, reapOrphans, DEFAULT_MIN_AGE_MS } from './orphan-daemons.js';
import {
  DEFAULT_SIDECAR_MIN_AGE_MS,
  reapRuntimeSidecars,
  scanRuntimeSidecars,
} from './sidecar-cleanup.js';
import { listLocalBrokerAndHostSessions } from '../runtime/broker/session-hosts.js';
import { fetchActiveCodingSessions } from './session-list.js';
import { sessionHostPaths } from '../runtime/broker/paths.js';
import {
  DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS,
  dependencySnapshotScanJson,
  scanDependencySnapshots,
} from './dependency-snapshot-storage.js';

export const DEFAULT_RUNTIME_MIN_AGE_MS = Math.min(DEFAULT_MIN_AGE_MS, DEFAULT_SIDECAR_MIN_AGE_MS);

export async function buildStorageSnapshot({
  mcDir = mcHome(),
  registry = readRegistry(),
  minAgeMs = DEFAULT_RUNTIME_MIN_AGE_MS,
  dependencySnapshotMinAgeMs = DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS,
  now = Date.now(),
  includeDisk = true,
  listSessions = listLocalBrokerAndHostSessions,
} = {}) {
  const entries = registry?.entries || [];
  const runtime = await scanRuntimeCleanup({
    mcDir,
    registry,
    minAgeMs,
    now,
    listSessions,
  });
  const liveIds = runtime.liveSessionIds;
  const worktrees = entries.map((entry) => classifyWorktreeEntry(entry, { liveIds }));
  const staleWorktrees = worktrees
    .filter((item) => item.cleanup_candidate)
    .map((item) => enrichWorktreeCandidate(item.entry))
    .sort(compareReclaimableCandidates);
  const dependencySnapshots = scanDependencySnapshots({
    mcDir,
    minAgeMs: dependencySnapshotMinAgeMs,
    now,
  });

  return {
    mc_home: mcDir,
    generated_at: new Date(now).toISOString(),
    summary: summarizeStorage({ entries, worktrees, runtime, dependencySnapshots }),
    disk: includeDisk ? diskUsageSnapshot(mcDir) : null,
    runtime: runtimeToJson(runtime),
    dependency_snapshots: dependencySnapshotScanJson(dependencySnapshots),
    worktrees,
    stale_worktrees: staleWorktrees.map(toWorktreeCandidateJson),
    issues: buildIssues({ entries, worktrees, runtime, dependencySnapshots }),
  };
}

export async function scanRuntimeCleanup({
  mcDir = mcHome(),
  registry = readRegistry(),
  minAgeMs = DEFAULT_RUNTIME_MIN_AGE_MS,
  now = Date.now(),
  listSessions = listLocalBrokerAndHostSessions,
} = {}) {
  const sidecars = await scanRuntimeSidecars({
    mcDir,
    registry,
    minAgeMs,
    now,
    listSessions,
  });
  const daemons = scanDaemons({ minAgeMs, now });
  const liveSessionIds = await listSessions()
    .then((sessions) => new Set((sessions || []).map(sessionIdForLiveRow).filter(Boolean)))
    .catch(() => new Set());
  return {
    daemons,
    sidecars,
    liveSessionIds,
    counts: {
      orphan_daemons: daemons.orphan.length,
      stale_pidfiles: daemons.stale.length,
      live_daemons: daemons.live.length,
      sidecar_candidates: sidecars.candidates.length,
      sidecars_kept: sidecars.counts.kept,
      live_session_ids: Math.max(liveSessionIds.size, sidecars.counts.live_session_ids || 0),
      registered_session_ids: sidecars.counts.registered_session_ids || 0,
    },
  };
}

export function reapRuntimeCleanup(scan, {
  reapDaemons = reapOrphans,
  reapSidecars = reapRuntimeSidecars,
} = {}) {
  const daemons = reapDaemons(scan.daemons);
  const sidecars = reapSidecars(scan.sidecars);
  const daemonsOk = daemons.reaped.every((r) => r.signaled)
    && daemons.unlinked.every((u) => u.removed);
  return {
    ok: daemonsOk && sidecars.ok,
    daemons,
    sidecars,
    counts: scan.counts,
  };
}

/**
 * Reclaiming a worktree is destructive, and "live" is bigger than the
 * local broker: a session can be attached from anywhere via the cloud
 * (this machine's coordinator included). Candidates are offered only
 * with the FULL liveness picture — if either the local enumeration or
 * the cloud-active lookup fails, offer nothing and say why.
 */
export async function staleWorktreeCandidates(registry = readRegistry(), {
  listSessions = listLocalBrokerAndHostSessions,
  // MC_TEST_MODE keeps spawned-CLI tests off the network (the established
  // test gate); unit tests inject fetchCloudActive to cover the real path.
  fetchCloudActive = process.env.MC_TEST_MODE === '1'
    ? async () => ({ ok: true, sessions: [] })
    : fetchActiveCodingSessions,
  // Auto-reclaim covers only what mc itself launched. A worktree with a
  // registry entry but no coding session (created out-of-band, e.g. by
  // other worktree tooling) may be in active use by something mc cannot
  // see — it is offered only when explicitly named (`--only`).
  includeUnlaunched = false,
} = {}) {
  const local = await listSessions()
    .then((sessions) => ({ ok: true, sessions: sessions || [] }))
    .catch((err) => ({ ok: false, error: err?.message || 'local broker enumeration failed' }));
  const cloud = await fetchCloudActive({}).catch((err) => ({
    ok: false,
    warning: err?.message || 'cloud active-session lookup failed',
  }));
  if (!local.ok || !cloud.ok) {
    return {
      candidates: [],
      warning: `worktree reclaim skipped — incomplete liveness picture (${
        [!local.ok ? (local.error || 'local') : null, !cloud.ok ? (cloud.warning || 'cloud') : null]
          .filter(Boolean).join('; ')
      })`,
    };
  }

  // Match by id AND by cwd/repo+branch: a session that was never linked
  // into the registry (coding_session_id null) must still protect the
  // worktree it runs in.
  const liveSessions = [...local.sessions, ...(cloud.sessions || [])];
  const liveIds = new Set(liveSessions
    .map((session) => sessionIdForLiveRow(session) || nonEmpty(session?.coding_session_id))
    .filter(Boolean));
  const out = [];
  for (const entry of registry?.entries || []) {
    if (!includeUnlaunched && !entryWasMcLaunched(entry)) continue;
    const candidate = staleWorktreeCandidate(entry, { liveIds, liveSessions });
    if (candidate) out.push(candidate);
  }
  return { candidates: out.sort(compareReclaimableCandidates), warning: null };
}

function entryWasMcLaunched(entry) {
  return Boolean(nonEmpty(entry?.coding_session_id))
    || (entry?.session_state || 'no-session-yet') !== 'no-session-yet';
}

export function staleWorktreeCandidate(entry, { liveIds = new Set(), liveSessions = [] } = {}) {
  const classified = classifyWorktreeEntry(entry, { liveIds, liveSessions });
  if (!classified.cleanup_candidate) return null;
  return {
    ...entry,
    dirty_files: classified.git.dirty_files,
    ahead: classified.git.ahead,
    reason: classified.cleanup_reason,
    ...worktreeReclaimEstimate(entry),
  };
}

export async function explainSessionStorage(name, {
  mcDir = mcHome(),
  registry = readRegistry(),
  cwd = process.cwd(),
  listSessions = listLocalBrokerAndHostSessions,
} = {}) {
  const resolved = resolveEntry(name, { registry, cwd });
  if (!resolved.ok) return null;
  const entry = resolved.entry;
  const liveIds = await listSessions()
    .then((sessions) => new Set((sessions || []).map(sessionIdForLiveRow).filter(Boolean)))
    .catch(() => new Set());
  const classified = classifyWorktreeEntry(entry, { liveIds });
  const sessionId = nonEmpty(entry.coding_session_id);
  return {
    entry: toEntryJson(entry),
    provider: providerState(entry),
    live: classified.live,
    git: classified.git,
    cleanup_candidate: classified.cleanup_candidate,
    cleanup_reason: classified.cleanup_reason,
    sidecars: sessionId ? sidecarPathState(mcDir, sessionId) : [],
  };
}

export function classifyWorktreeEntry(entry, { liveIds = new Set(), liveSessions = [] } = {}) {
  const sessionId = nonEmpty(entry?.coding_session_id);
  const worktreePath = nonEmpty(entry?.worktree_path);
  const live = Boolean(
    (sessionId && (liveIds.has(sessionId) || hostBrokerPidAlive(sessionId)))
    || liveSessions.some((session) => liveSessionProtectsEntry(session, entry)),
  );
  const gitState = observeGitForCleanup(entry);
  const provider = providerState(entry);
  const cleanupCandidate = Boolean(
    worktreePath
      && gitState.exists
      && !live
      && gitState.dirty_files === 0
      && gitState.branch_exists
      && gitState.ahead === 0
  );

  return {
    name: entry?.name || null,
    entry: cleanupCandidate
      ? {
          ...entry,
          dirty_files: gitState.dirty_files,
          ahead: gitState.ahead,
          reason: 'clean-merged-not-live',
        }
      : entry,
    session_state: entry?.session_state || 'no-session-yet',
    coding_session_id: sessionId,
    provider,
    live,
    git: gitState,
    cleanup_candidate: cleanupCandidate,
    cleanup_reason: cleanupCandidate ? 'clean-merged-not-live' : null,
  };
}

function observeGitForCleanup(entry) {
  const worktreePath = nonEmpty(entry?.worktree_path);
  if (!worktreePath) {
    return {
      worktree_path: null,
      exists: false,
      current_branch: null,
      branch_exists: false,
      dirty_files: null,
      ahead: null,
      default_branch: null,
      default_branch_ref: null,
      default_branch_source: null,
      default_branch_reason: 'worktree-path-missing',
      primary_worktree: null,
    };
  }
  const exists = existsSync(worktreePath);
  if (!exists) {
    return {
      worktree_path: worktreePath,
      exists: false,
      current_branch: null,
      branch_exists: false,
      dirty_files: null,
      ahead: null,
      default_branch: null,
      default_branch_ref: null,
      default_branch_source: null,
      default_branch_reason: 'worktree-missing',
      primary_worktree: null,
    };
  }

  const dirty = countPorcelain(tryGit(worktreePath, ['status', '--porcelain']));
  const primary = nonEmpty(entry.primary_worktree) || primaryWorktree(worktreePath);
  const branch = nonEmpty(tryGit(worktreePath, ['branch', '--show-current']))
    || nonEmpty(entry.current_branch)
    || nonEmpty(entry.branch);
  const branchKnown = Boolean(primary && branch && branchExists(primary, branch));
  const defaultBranch = primary
    ? resolveDefaultBranch(primary)
    : { ok: false, reason: 'primary-worktree-missing' };
  const ahead = branchKnown && defaultBranch.ok
    ? commitsAhead(primary, branch, defaultBranch.ref)
    : null;

  return {
    worktree_path: worktreePath,
    exists: true,
    current_branch: branch,
    branch_exists: branchKnown,
    dirty_files: dirty,
    ahead,
    default_branch: defaultBranch.ok ? defaultBranch.branch : null,
    default_branch_ref: defaultBranch.ok ? defaultBranch.ref : null,
    default_branch_source: defaultBranch.ok ? defaultBranch.source : null,
    default_branch_reason: defaultBranch.ok ? null : defaultBranch.reason,
    primary_worktree: primary,
  };
}

function summarizeStorage({ entries, worktrees, runtime, dependencySnapshots }) {
  const byState = {};
  for (const entry of entries) {
    const state = entry?.session_state || 'no-session-yet';
    byState[state] = (byState[state] || 0) + 1;
  }
  const dirty = worktrees.filter((item) => (item.git.dirty_files || 0) > 0).length;
  const ahead = worktrees.filter((item) => (item.git.ahead || 0) > 0).length;
  const missing = worktrees.filter((item) => item.git.worktree_path && !item.git.exists).length;
  const providerMissing = worktrees.filter((item) => item.provider.needs_backfill).length;
  return {
    registry_entries: entries.length,
    by_session_state: byState,
    worktrees: {
      existing: worktrees.filter((item) => item.git.exists).length,
      missing,
      dirty,
      ahead,
      stale_candidates: worktrees.filter((item) => item.cleanup_candidate).length,
    },
    provider: {
      resumable: worktrees.filter((item) => item.provider.resumable).length,
      missing_native_id: providerMissing,
    },
    runtime: {
      orphan_daemons: runtime.counts.orphan_daemons,
      stale_pidfiles: runtime.counts.stale_pidfiles,
      sidecar_candidates: runtime.counts.sidecar_candidates,
    },
    dependency_snapshots: {
      ...dependencySnapshots.counts,
      disk_bytes: dependencySnapshots.disk_bytes,
      reclaimable_bytes: dependencySnapshots.reclaimable_bytes,
    },
  };
}

function buildIssues({ entries, worktrees, runtime, dependencySnapshots }) {
  const issues = [];
  const providerMissing = worktrees.filter((item) => item.provider.needs_backfill);
  if (providerMissing.length) {
    issues.push({
      severity: 'warning',
      code: 'provider-native-id-missing',
      count: providerMissing.length,
      names: providerMissing.map((item) => item.name).filter(Boolean),
    });
  }
  const liveWithoutBroker = worktrees.filter((item) => item.session_state === 'live' && !item.live);
  if (liveWithoutBroker.length) {
    issues.push({
      severity: 'info',
      code: 'registry-live-without-local-broker',
      count: liveWithoutBroker.length,
      names: liveWithoutBroker.map((item) => item.name).filter(Boolean),
    });
  }
  const missingWorktrees = worktrees.filter((item) => item.git.worktree_path && !item.git.exists);
  if (missingWorktrees.length) {
    issues.push({
      severity: 'warning',
      code: 'registered-worktree-missing',
      count: missingWorktrees.length,
      names: missingWorktrees.map((item) => item.name).filter(Boolean),
    });
  }
  if (runtime.counts.orphan_daemons || runtime.counts.stale_pidfiles || runtime.counts.sidecar_candidates) {
    issues.push({
      severity: 'cleanup',
      code: 'stale-runtime',
      orphan_daemons: runtime.counts.orphan_daemons,
      stale_pidfiles: runtime.counts.stale_pidfiles,
      sidecar_candidates: runtime.counts.sidecar_candidates,
    });
  }
  const stale = worktrees.filter((item) => item.cleanup_candidate);
  if (stale.length) {
    issues.push({
      severity: 'cleanup',
      code: 'stale-worktrees',
      count: stale.length,
      names: stale.map((item) => item.name).filter(Boolean),
    });
  }
  if (dependencySnapshots.counts.candidates) {
    issues.push({
      severity: 'cleanup',
      code: 'stale-dependency-snapshots',
      count: dependencySnapshots.counts.candidates,
      reclaimable_bytes: dependencySnapshots.reclaimable_bytes,
    });
  }
  if (!entries.length) {
    issues.push({
      severity: 'info',
      code: 'registry-empty',
      count: 0,
    });
  }
  return issues;
}

function providerState(entry) {
  const resumable = Boolean(
    nonEmpty(entry?.tool_session_id)
      || nonEmpty(entry?.provider_session_id)
      || nonEmpty(entry?.llm_session_id)
  );
  const hasLaunched = Boolean(nonEmpty(entry?.coding_session_id))
    && (entry?.session_state || 'no-session-yet') !== 'no-session-yet';
  return {
    tool: nonEmpty(entry?.tool) || null,
    resumable,
    tool_session_id: nonEmpty(entry?.tool_session_id),
    tool_session_source: nonEmpty(entry?.tool_session_source),
    tool_transcript_path: nonEmpty(entry?.tool_transcript_path),
    needs_backfill: hasLaunched && !resumable,
  };
}

function runtimeToJson(runtime) {
  return {
    counts: runtime.counts,
    daemons: {
      orphan: runtime.daemons.orphan.map(toOrphanJson),
      stale: runtime.daemons.stale.map(toStaleJson),
      live_count: runtime.daemons.live.length,
    },
    sidecars: {
      candidates: runtime.sidecars.candidates,
      counts: runtime.sidecars.counts,
    },
  };
}

function diskUsageSnapshot(mcDir) {
  return {
    total: duBytes(mcDir),
    worktrees: duBytes(join(mcDir, 'worktrees')),
    hosts: duBytes(join(mcDir, 'hosts')),
    guard_bin: duBytes(join(mcDir, 'guard-bin')),
    dependency_snapshots: duBytes(join(mcDir, 'dependency-snapshots')),
    registry: duBytes(join(mcDir, 'registry.json')),
  };
}

function duBytes(path) {
  if (!path || !existsSync(path)) return 0;
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  if (r.status !== 0) {
    try {
      const size = readFileSync(path).byteLength;
      return size;
    } catch {
      return null;
    }
  }
  const n = Number((r.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n * 1024 : null;
}

function enrichWorktreeCandidate(entry) {
  return {
    ...entry,
    ...worktreeReclaimEstimate(entry),
  };
}

function worktreeReclaimEstimate(entry) {
  const diskBytes = duBytes(entry?.worktree_path);
  return {
    disk_bytes: diskBytes,
    reclaimable_bytes: diskBytes,
  };
}

function compareReclaimableCandidates(a, b) {
  const reclaimA = Number.isFinite(Number(a?.reclaimable_bytes)) ? Number(a.reclaimable_bytes) : 0;
  const reclaimB = Number.isFinite(Number(b?.reclaimable_bytes)) ? Number(b.reclaimable_bytes) : 0;
  if (reclaimA !== reclaimB) return reclaimB - reclaimA;
  return String(a?.name || '').localeCompare(String(b?.name || ''));
}

function sidecarPathState(mcDir, sessionId) {
  const host = sessionHostPaths(sessionId);
  const guardDir = join(mcDir, 'guard-bin', sessionId);
  return [
    { kind: 'host', path: host.dir, exists: existsSync(host.dir) },
    { kind: 'guard-bin', path: guardDir, exists: existsSync(guardDir) },
  ];
}

function toWorktreeCandidateJson(entry) {
  return {
    name: entry.name,
    branch: entry.branch,
    worktree_path: entry.worktree_path,
    reason: entry.reason || 'clean-merged-not-live',
    dirty_files: entry.dirty_files || 0,
    ahead: entry.ahead || 0,
    disk_bytes: entry.disk_bytes ?? null,
    reclaimable_bytes: entry.reclaimable_bytes ?? null,
  };
}

function toEntryJson(entry) {
  return {
    name: entry.name,
    session_id: entry.session_id || null,
    repository_id: entry.repository_id || null,
    branch: entry.branch || null,
    worktree_path: entry.worktree_path || null,
    coding_session_id: entry.coding_session_id || null,
    session_state: entry.session_state || 'no-session-yet',
    tool: entry.tool || null,
  };
}

function toOrphanJson(e) {
  return { pid_file: e.pidFile, llm_session_id: e.llmSessionId, pid: e.pid, ppid: e.ppid, age_ms: e.ageMs };
}

function toStaleJson(e) {
  return { pid_file: e.pidFile, llm_session_id: e.llmSessionId, pid: e.pid, reason: e.reason };
}

/**
 * Permissive on purpose — the strict removal matcher
 * (brokerSessionMatchesEntry) rejects on id mismatch even when the cwd
 * matches, which is right for deleting and wrong for protecting: any
 * live session working in the entry's worktree protects it, ids or not.
 */
function liveSessionProtectsEntry(session, entry) {
  const sessionId = nonEmpty(session?.coding_session_id || session?.id);
  const entryId = nonEmpty(entry?.coding_session_id);
  if (sessionId && entryId && sessionId === entryId) return true;
  const cwd = normalizeWorktreePathForMatch(session?.cwd || session?.worktree_path);
  const worktree = normalizeWorktreePathForMatch(entry?.worktree_path);
  if (cwd && worktree && cwd === worktree) return true;
  if (entry?.session_id || entry?.repository_id) return false;
  const label = nonEmpty(session?.label || session?.name);
  return Boolean(label && nonEmpty(entry?.name) && label === entry.name);
}

function normalizeWorktreePathForMatch(value) {
  const text = nonEmpty(value);
  if (!text) return null;
  let out = text.replace(/[/\\]+$/, '');
  if (process.platform === 'darwin' && out.startsWith('/private/')) {
    out = out.slice('/private'.length);
  }
  return out;
}

function sessionIdForLiveRow(session) {
  return nonEmpty(session?.id || session?.coding_session_id || session?.host_session_id);
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

function countPorcelain(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  return value.split('\n').filter(Boolean).length;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
