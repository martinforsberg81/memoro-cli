/**
 * THE teardown engine — mc's one primitive for destroying session-owned
 * state, born from `mc end` and consolidating gc/repair modes next.
 *
 * Invariants, in order:
 *   1. Distill before delete — the transcript is the only copy of the
 *      session's knowledge; failure leaves everything intact.
 *   2. Authority before destruction — exact provider transcript/artifact
 *      ownership is verified fail-closed; managed credential domains are
 *      finalized through the full receipt chain (self-healing a crashed
 *      runtime inline via the open-path reconciliation).
 *   3. Verify leftovers — teardown is complete only when the inspection
 *      proves nothing session-owned remains, and only then does the
 *      registry row fall.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import {
  patchEntriesIfPresent,
  readRegistry,
  readRegistryStrict,
  removeEntryIfMatches,
} from '../../mc/registry.js';
import {
  branchExists,
  git,
  tryGit,
} from '../../mc/git.js';
import { detectSquashPhantom } from '../../mc/squash-phantom.js';
import { removeBrokerSessionForEntry } from '../../runtime/broker/session-cleanup.js';
import { reconcileManagedSession } from '../../mc/managed-session-reconciler.js';
import { inspectLocalBrokerSessionForEntry } from '../liveness/presence.js';
import { providerArtifactPath } from '../../runtime/broker/paths.js';
import { readProviderArtifactSync } from '../../runtime/broker/provider-artifact-journal.js';
import { mcHome } from '../../mc/paths.js';
import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../../mc/storage-repair.js';
import { runSessionUploadSync } from '../../mc/session-upload.js';
import { teardownSessionDevServers } from '../../mc/dev-servers.js';
import {
  classifyToolArtifactAuthority,
  deleteOwnedToolArtifacts,
  inspectOwnedToolArtifacts,
  TOOL_ARTIFACT_AUTHORITY_VERSION,
} from '../../mc/tool-artifact-ownership.js';
import {
  inspectBrokerSessionAbsence,
  inspectSessionOwnedMcArtifacts,
  removeSessionOwnedRuntimeArtifacts,
} from '../../mc/session-owned-artifacts.js';

export const MANAGED_PROVIDER_AUTHORITY_VERSION = 1;

export function withProviderlessDowngrade(entry, artifacts) {
  const providerless = artifacts?.state === 'unverified'
    && (artifacts.issues || []).length === 1
    && artifacts.issues[0]?.code === 'missing-tool-session-source'
    && !nonEmpty(entry?.tool_session_source)
    && !nonEmpty(entry?.tool_session_id)
    && !nonEmpty(entry?.tool_transcript_path);
  if (!providerless) return artifacts;
  return {
    ...artifacts,
    state: 'none',
    safe_to_delete: true,
    provider_untouched: true,
    artifacts: [],
    totals: { paths: 0, files: 0, bytes: 0 },
  };
}

export function isBackfillableIssue(code) {
  return new Set([
    'missing-tool-session-source',
    'missing-tool-session-id',
    'missing-tool-transcript-path',
  ]).has(code);
}

export function conflictsWithStoredAuthority(entry, patch) {
  return [
    ['tool_session_source', patch.tool_session_source],
    ['tool_session_id', patch.tool_session_id],
    ['tool_transcript_path', patch.tool_transcript_path],
  ].some(([key, value]) => nonEmpty(entry?.[key]) && nonEmpty(entry[key]) !== value);
}

export async function inspectAuthority(entry, { deps = {} } = {}) {
  const managed = inspectManagedToolAuthority(entry, deps);
  if (managed) return managed;
  const inspect = deps.inspectOwnedToolArtifacts || inspectOwnedToolArtifacts;
  const options = {
    roots: deps.toolArtifactRoots,
    ...(deps.toolArtifactFs ? { fs: deps.toolArtifactFs } : {}),
    ...(deps.toolArtifactScanPolicy ? { scanPolicy: deps.toolArtifactScanPolicy } : {}),
  };
  const result = await inspect(entry, options);
  if (isVerifiedMissingRetry(entry, result, deps.toolArtifactRoots)) {
    return inspect(entry, {
      ...options,
      allowVerifiedMissingTranscript: true,
    });
  }
  return result;
}

export function inspectManagedToolAuthority(entry, deps = {}) {
  const adapter = nonEmpty(entry?.tool_session_provider_adapter);
  if (!adapter) return null;
  const codingSessionId = nonEmpty(entry?.coding_session_id);
  const runtimeGeneration = nonEmpty(entry?.tool_session_provider_generation);
  const source = nonEmpty(entry?.tool_session_source);
  const sessionId = nonEmpty(entry?.tool_session_id);
  if (!codingSessionId || !runtimeGeneration || !source || !sessionId) {
    return unverifiedManagedAuthority('managed-provider-identity-incomplete');
  }
  const root = deps.mcArtifactDeps?.mcDir || deps.mcDir || mcHome();
  const artifactPath = (deps.providerArtifactPath || providerArtifactPath)(
    codingSessionId,
    runtimeGeneration,
    { root },
  );
  const read = deps.readProviderArtifact || readProviderArtifactSync;
  let result;
  try {
    result = read({
      path: artifactPath,
      codingSessionId,
      runtimeGeneration,
      trustedRoot: root,
    });
  } catch {
    return unverifiedManagedAuthority('managed-provider-artifact-unreadable');
  }
  if (result?.kind === 'absent' && managedProviderCleanupMarkerMatches(entry)) {
    return managedAuthority(entry, {
      transcriptPath: entry.managed_provider_authority_verified.transcript_path,
      cleanupConfirmed: true,
    });
  }
  if (result?.kind !== 'present') {
    return unverifiedManagedAuthority(
      `managed-provider-artifact-${result?.reason || result?.kind || 'missing'}`,
    );
  }
  const artifact = result.artifact;
  if (artifact?.tool !== source || artifact?.provider_session_id !== sessionId) {
    return unverifiedManagedAuthority('managed-provider-artifact-identity-mismatch');
  }
  return managedAuthority(entry, { transcriptPath: artifact.transcript_path });
}

function managedAuthority(entry, { transcriptPath, cleanupConfirmed = false }) {
  return {
    state: 'managed',
    safe_to_delete: true,
    provider_managed: true,
    provider_cleanup_confirmed: cleanupConfirmed,
    source: nonEmpty(entry.tool_session_source),
    session_id: nonEmpty(entry.tool_session_id),
    transcript_path: transcriptPath,
    runtime_generation: nonEmpty(entry.tool_session_provider_generation),
    coding_session_id: nonEmpty(entry.coding_session_id),
    artifacts: [],
    totals: { paths: 0, files: 0, bytes: 0 },
    issues: [],
  };
}

function unverifiedManagedAuthority(code) {
  return {
    state: 'unverified',
    safe_to_delete: false,
    provider_managed: true,
    artifacts: [],
    totals: { paths: 0, files: 0, bytes: 0 },
    issues: [{ code }],
  };
}

export function isVerifiedMissingRetry(entry, result, roots) {
  if (result?.issues?.length !== 1 || result.issues[0]?.code !== 'transcript-missing') {
    return false;
  }
  const marker = entry?.tool_artifact_authority_verified;
  const classified = classifyToolArtifactAuthority(entry, { roots });
  return marker?.version === TOOL_ARTIFACT_AUTHORITY_VERSION
    && marker.source === classified.source
    && marker.session_id === classified.session_id
    && marker.transcript_path === classified.transcript_path
    && classified.state === 'candidate';
}


export function inspectMcAuthority(entry, deps) {
  const inspect = deps.inspectSessionOwnedMcArtifacts || inspectSessionOwnedMcArtifacts;
  try {
    return inspect(entry, deps.mcArtifactDeps || {});
  } catch {
    return {
      ok: false,
      state: 'unverified',
      leftovers: [],
      issues: [{ code: 'mc-artifact-inspection-failed' }],
    };
  }
}


export async function teardownOne(plan, { opts, deps }) {
  const { entry: originalEntry, primary, status } = plan;
  let entry = originalEntry;
  const repairs = [];
  try {
    // Distill FIRST, while nothing has been destroyed. The transcript is
    // the only copy of the session's knowledge; a failed upload leaves
    // everything intact for a clean retry instead of deleting it unread.
    const distilled = await distillTranscriptBeforeDelete(plan, { opts, deps });
    if (!distilled.ok) {
      throw new Error(
        `transcript distill failed before deletion (${distilled.reason}); `
        + 'nothing was deleted — retry when the upload can succeed, or pass --no-distill',
      );
    }

    const removeBroker = deps.removeBrokerSessionForEntry || removeBrokerSessionForEntry;
    const broker = await removeBroker(entry, {
      requestBroker: deps.requestBroker,
      deps,
    });
    if (!brokerCleanupIsAcceptable(entry, broker)) {
      // A registry row stuck on `live` with no reachable broker is the
      // documented deadlock (docs/incidents/2026-07-26): end refused and
      // pointed at a different command. Run that exact repair inline —
      // verify the broker is really gone, mark the row idle, continue.
      const repaired = await repairStaleLiveRegistryState(entry, { broker, deps });
      if (repaired.ok) {
        entry = { ...entry, ...repaired.patch };
        plan = { ...plan, entry };
        repairs.push(repaired.reason);
      }
      if (!repaired.ok || !brokerCleanupIsAcceptable(entry, broker)) {
        // Self-healing: a managed runtime that crashed before finalization
        // left its credential domain unclosed and no cleanup marker. Run
        // the SAME reconciliation open uses — recover exit receipts,
        // finalize and close the domain — inline. Only a reconciliation
        // the machinery itself refuses may stop the teardown.
        let managedFinalized = false;
        if (entry?.tool_session_provider_adapter && broker?.reason === 'not-found') {
          const reconcile = deps.reconcileManagedSession || reconcileManagedSession;
          const inspectPresence = deps.inspectLocalBrokerSessionForEntry
            || inspectLocalBrokerSessionForEntry;
          const reconciled = await reconcile({
            entry,
            inspectLocalPresence: (target) => inspectPresence(target),
            deps: deps.managedReconcilerDeps || deps,
          }).catch(() => null);
          if (reconciled?.ok && ['start', 'resume'].includes(reconciled.action)) {
            managedFinalized = true;
            repairs.push('managed-domain-finalized');
          } else {
            throw new Error(
              'managed credential domain could not be finalized '
              + `(${reconciled?.reason || 'managed-session-reconciliation-failed'}); nothing was deleted`,
            );
          }
        }
        if (!managedFinalized) {
          throw new Error(`broker cleanup failed (${broker?.error || broker?.reason || 'unknown'})`);
        }
      }
    }
    if (plan.artifacts?.provider_managed && !plan.artifacts?.provider_cleanup_confirmed) {
      const confirmed = persistManagedProviderCleanupConfirmation(plan, {
        deps,
        now: deps.now || (() => new Date().toISOString()),
      });
      if (!confirmed.ok) {
        throw new Error(`managed provider cleanup confirmation sync failed (${confirmed.reason})`);
      }
    }

    // Stop and unregister the session's dev servers before the worktree
    // they run in disappears; leaving them orphans the processes and the
    // manifests both.
    const teardownDev = deps.teardownSessionDevServers || teardownSessionDevServers;
    const devServers = await teardownDev({
      sessionName: entry.name,
      codingSessionId: entry.coding_session_id || null,
      worktreePath: entry.worktree_path || null,
    });
    if (!devServers?.ok) {
      const failed = (devServers?.results || [])
        .filter((item) => !item.unregistered || (item.was_running && !item.stopped))
        .map((item) => `${item.service || item.instance_id}: ${item.stop_error || 'unregister failed'}`);
      throw new Error(`dev server teardown failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
    }

    const removeRuntime = deps.removeSessionOwnedRuntimeArtifacts
      || removeSessionOwnedRuntimeArtifacts;
    const runtime = await removeRuntime(entry, {
      ...(deps.mcArtifactDeps || {}),
      ...(deps.requestBroker ? { requestBroker: deps.requestBroker } : {}),
    });
    if (!runtime?.ok) {
      const reasons = (runtime?.issues || []).map((issue) => issue.code).filter(Boolean);
      throw new Error(`runtime sidecar cleanup failed${reasons.length ? ` (${reasons.join(', ')})` : ''}`);
    }

    const shred = deps.shredForSession || defaultShredForSession;
    const shredded = await shred({
      sessionId: entry.legacy_session_key || entry.session_id || entry.name,
      worktreePath: entry.worktree_path || undefined,
      retainManifestOnFailure: true,
    });
    if (!shredded?.ok) {
      const reasons = (shredded?.failures || []).map((failure) => failure.reason).filter(Boolean);
      throw new Error(`vault shred failed${reasons.length ? ` (${reasons.join(', ')})` : ''}`);
    }

    // Providerless sessions have nothing identifiable to delete on the
    // provider surface (see withProviderlessDowngrade) — skip rather than
    // let the deleter's own inspection fail closed on the whole teardown.
    if (!plan.artifacts?.provider_untouched && !plan.artifacts?.provider_managed) {
      const removeToolArtifacts = deps.deleteOwnedToolArtifacts || deleteOwnedToolArtifacts;
      const deleted = await removeToolArtifacts(entry, {
        roots: deps.toolArtifactRoots,
        ...(deps.toolArtifactFs ? { fs: deps.toolArtifactFs } : {}),
        ...(deps.toolArtifactScanPolicy ? { scanPolicy: deps.toolArtifactScanPolicy } : {}),
        allowVerifiedMissingTranscript: true,
      });
      if (!deleted?.ok) {
        const reasons = (deleted?.issues || []).map((issue) => issue.code).filter(Boolean);
        throw new Error(`tool artifact cleanup failed${reasons.length ? ` (${reasons.join(', ')})` : ''}`);
      }
    }

    if (primary) {
      removeWorktreeAndBranch(entry, {
        primary,
        keepBranch: opts.keepBranch,
      });
    }

    const leftovers = await inspectLeftovers(plan, opts, deps, {
      includeRegistry: false,
    });
    if (leftovers.length > 0) {
      throw new Error(`teardown verification failed: ${leftovers.join(', ')}`);
    }

    const remove = deps.removeEntryIfMatches
      || (deps.removeEntry
        ? () => ({ ok: deps.removeEntry(entry.name), removed: true })
        : removeEntryIfMatches);
    const removed = remove(entry.session_id, {
      session_id: entry.session_id,
      repository_id: entry.repository_id,
      worktree_path: entry.worktree_path,
      branch: entry.branch,
      tool_session_source: entry.tool_session_source,
      tool_session_id: entry.tool_session_id,
      tool_transcript_path: entry.tool_transcript_path,
    });
    if (!removed?.ok) {
      throw new Error(`registry removal failed: ${entry.name}`);
    }
    const finalLeftovers = await inspectLeftovers(plan, opts, deps);
    if (finalLeftovers.length > 0) {
      throw new Error(`teardown verification failed: ${finalLeftovers.join(', ')}`);
    }
    return {
      name: entry.name,
      ok: true,
      verdict: status.verdict,
      status,
      leftovers: [],
      ...(repairs.length ? { repairs } : {}),
    };
  } catch (err) {
    return {
      name: entry.name,
      ok: false,
      error: err.message,
      status,
      leftovers: await inspectLeftovers(plan, opts, deps),
      ...(repairs.length ? { repairs } : {}),
    };
  }
}

/**
 * Distill gate for the native transcript that `teardownOne` is about to
 * delete. Skips (ok) when there is nothing to distill: providerless or
 * managed targets, no recorded transcript, an already-removed file, or
 * an explicit `--no-distill`.
 */
async function distillTranscriptBeforeDelete(plan, { opts = {}, deps = {} } = {}) {
  if (opts.noDistill) return { ok: true, skipped: 'opted-out' };
  const { entry, artifacts } = plan;
  if (artifacts?.provider_untouched || artifacts?.provider_managed) {
    return { ok: true, skipped: 'no-native-provider-artifacts' };
  }
  // No coding session id → the tool session never launched under mc and
  // there is no server-side session record to distill into.
  if (!nonEmpty(entry?.coding_session_id)) return { ok: true, skipped: 'never-launched' };
  const transcriptPath = nonEmpty(entry?.tool_transcript_path);
  if (!transcriptPath) return { ok: true, skipped: 'no-transcript-path' };
  const fileExists = deps.transcriptExists || existsSync;
  if (!fileExists(transcriptPath)) return { ok: true, skipped: 'transcript-already-absent' };
  const upload = deps.runSessionUploadSync || runSessionUploadSync;
  const uploaded = await upload({
    source: entry.tool_session_source || null,
    transcriptPath,
    cwd: entry.worktree_path || null,
    codingSessionId: entry.coding_session_id || null,
  });
  return uploaded?.ok === true
    ? { ok: true, transcriptPath }
    : { ok: false, reason: uploaded?.reason || 'upload-failed' };
}

/**
 * Inline escape from the `registry-live-without-local-broker` deadlock:
 * reuse the storage-repair plan (its liveness check probes the host
 * socket, not just the pid) scoped to this one entry, and apply only the
 * mark-idle action. Anything still genuinely live keeps failing closed.
 */
async function repairStaleLiveRegistryState(entry, { broker = null, deps = {} } = {}) {
  if (entry?.session_state !== 'live') return { ok: false, reason: 'not-live' };
  if (entry?.tool_session_provider_adapter) return { ok: false, reason: 'managed-provider' };
  if (broker && broker.ok !== true && broker.reason !== 'broker-unavailable'
    && broker.reason !== 'not-found') {
    return { ok: false, reason: 'broker-failure-not-repairable' };
  }
  const read = deps.readRegistry || readRegistry;
  let registry;
  try {
    registry = read();
  } catch {
    return { ok: false, reason: 'registry-unreadable' };
  }
  let repairPlan;
  try {
    repairPlan = await (deps.buildStorageRepairPlan || buildStorageRepairPlan)({
      registry,
      names: [entry.session_id || entry.name],
      ...(deps.requestBroker ? { request: deps.requestBroker } : {}),
    });
  } catch {
    return { ok: false, reason: 'repair-plan-failed' };
  }
  const actions = (repairPlan?.actions || []).filter((action) => (
    action.type === 'mark-idle' && action.session_id === entry.session_id
  ));
  if (actions.length === 0) return { ok: false, reason: 'session-still-live' };
  const applied = (deps.applyStorageRepairPlan || applyStorageRepairPlan)(
    registry,
    { actions },
  );
  if (!applied?.ok) return { ok: false, reason: applied?.reason || 'repair-apply-failed' };
  return {
    ok: true,
    reason: 'registry-live-without-local-broker',
    patch: actions[0].patch,
  };
}

function brokerCleanupIsAcceptable(entry, result) {
  if (entry?.tool_session_provider_adapter) {
    return (result?.ok === true && result?.credential_cleanup === 'confirmed')
      || (result?.reason === 'not-found' && managedProviderCleanupMarkerMatches(entry));
  }
  if (result?.ok) return true;
  if (result?.reason === 'not-found') return true;
  if (result?.reason === 'broker-unavailable') {
    return entry?.session_state !== 'live';
  }
  return false;
}

function persistManagedProviderCleanupConfirmation(plan, { deps = {}, now }) {
  const marker = plan.entry?.managed_provider_authority_verified;
  if (!managedProviderAuthorityMarkerMatches(plan.entry, marker)) {
    return { ok: false, reason: 'verified-authority-marker-missing' };
  }
  const patch = deps.patchEntriesIfPresent || patchEntriesIfPresent;
  const result = patch([{
    name: plan.entry.name,
    session_id: plan.entry.session_id,
    repository_id: plan.entry.repository_id,
    managed_provider_authority_verified: {
      ...marker,
      cleanup_confirmed_at: now(),
    },
  }]);
  const updated = result?.entries?.find((entry) => entry.session_id === plan.entry.session_id);
  if (!result?.ok || !updated) return { ok: false, reason: 'registry-entry-missing' };
  plan.entry = updated;
  return { ok: true };
}

export function managedProviderCleanupMarkerMatches(entry) {
  const marker = entry?.managed_provider_authority_verified;
  return managedProviderAuthorityMarkerMatches(entry, marker)
    && nonEmpty(marker.cleanup_confirmed_at) != null;
}

export function managedProviderAuthorityMarkerMatches(entry, marker) {
  return marker?.version === MANAGED_PROVIDER_AUTHORITY_VERSION
    && marker.adapter === nonEmpty(entry?.tool_session_provider_adapter)
    && marker.coding_session_id === nonEmpty(entry?.coding_session_id)
    && marker.runtime_generation === nonEmpty(entry?.tool_session_provider_generation)
    && marker.source === nonEmpty(entry?.tool_session_source)
    && marker.session_id === nonEmpty(entry?.tool_session_id)
    && nonEmpty(marker.transcript_path) != null;
}

async function defaultShredForSession(args) {
  const { shredForSession } = await import('../../vault/engine/lifecycle.js');
  return shredForSession(args);
}

function removeWorktreeAndBranch(entry, { primary, keepBranch }) {
  const worktree = entry.worktree_path;
  if (worktree && existsSync(worktree)) {
    git(primary, ['worktree', 'remove', '--force', worktree]);
  } else {
    tryGit(primary, ['worktree', 'prune']);
  }
  if (!keepBranch && entry.branch && branchExists(primary, entry.branch)) {
    git(primary, ['branch', '-D', entry.branch]);
  }
}

async function inspectLeftovers(plan, opts, deps, { includeRegistry = true } = {}) {
  const leftovers = [];
  const exists = deps.existsSync || existsSync;
  if (!plan.artifacts?.provider_managed) {
    try {
      const artifacts = withProviderlessDowngrade(
        plan.entry,
        await inspectAuthority(plan.entry, { deps }),
      );
      if (!artifacts.safe_to_delete) {
        const issues = (artifacts.issues || []).map((issue) => issue.code).join('|') || 'unverified';
        leftovers.push(`tool-artifacts:${issues}`);
      } else {
        for (const artifact of artifacts.artifacts || []) {
          leftovers.push(`tool-artifact:${artifact.kind}:${artifact.path}`);
        }
      }
    } catch {
      leftovers.push('tool-artifacts:inspection-failed');
    }
  }
  const inspectMc = deps.inspectSessionOwnedMcArtifacts || inspectSessionOwnedMcArtifacts;
  try {
    const mcArtifacts = inspectMc(plan.entry, deps.mcArtifactDeps || {});
    if (!mcArtifacts?.ok) {
      const issues = (mcArtifacts?.issues || []).map((issue) => issue.code).join('|') || 'unverified';
      leftovers.push(`mc-artifacts:${issues}`);
    } else {
      for (const artifact of mcArtifacts.leftovers || []) {
        leftovers.push(`${artifact.kind}:${artifact.path}`);
      }
    }
  } catch {
    leftovers.push('mc-artifacts:inspection-failed');
  }
  const inspectBroker = deps.inspectBrokerSessionAbsence || inspectBrokerSessionAbsence;
  try {
    const broker = await inspectBroker(plan.entry, {
      requestBroker: deps.requestBroker,
      ...(deps.mcArtifactDeps || {}),
    });
    if (!broker?.ok) {
      const issues = (broker?.issues || []).map((issue) => issue.code).join('|') || 'unverified';
      leftovers.push(`broker:${issues}`);
    }
  } catch {
    leftovers.push('broker:inspection-failed');
  }
  if (plan.entry.worktree_path && exists(plan.entry.worktree_path)) {
    leftovers.push(`worktree:${plan.entry.worktree_path}`);
  }
  if (plan.entry.worktree_path && worktreeBelongsToPrimary(plan.primary, plan.entry.worktree_path)) {
    leftovers.push(`git-worktree:${plan.entry.worktree_path}`);
  }
  if (!opts.keepBranch && plan.entry.branch && branchExists(plan.primary, plan.entry.branch)) {
    leftovers.push(`branch:${plan.entry.branch}`);
  }
  if (includeRegistry) {
    try {
      const registry = (deps.readRegistryStrict || deps.readRegistry || readRegistryStrict)();
      if (registry.entries.some((entry) => entry.session_id === plan.entry.session_id)) {
        leftovers.push(`registry:${plan.entry.name}`);
      }
    } catch {
      leftovers.push('registry:unverified');
    }
  }
  return leftovers;
}


function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function worktreeBelongsToPrimary(primary, worktreePath) {
  if (!primary || !worktreePath) return false;
  const out = tryGit(primary, ['worktree', 'list', '--porcelain']);
  if (!out) return false;
  const needle = safeRealpath(worktreePath);
  return out.split('\n\n').some((block) => {
    const match = block.match(/^worktree\s+(.+)$/m);
    return match && samePath(safeRealpath(match[1].trim()), needle);
  });
}


function safeRealpath(path) {
  try { return realpathSync(path); } catch { return path; }
}

function samePath(a, b) {
  return a === b || (isInsidePath(a, b) && isInsidePath(b, a));
}

function isInsidePath(candidate, parent) {
  if (!candidate || !parent) return false;
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
