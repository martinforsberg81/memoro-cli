/**
 * `mc end [<name>...] [--force] [--keep-branch] [--dry-run] [--json]
 *         [--emit-shell-directives]`
 *
 * Permanent local teardown has one decision point:
 *   1. resolve exact provider transcript authority for the whole batch
 *   2. show every target's current status
 *   3. ask once (interactive) or require --force (automation)
 *   4. revalidate the whole batch before the first destructive side effect
 *   5. remove every known session-owned artifact and verify the leftovers
 *
 * `--force` means "confirmation already supplied" for non-interactive
 * automation. It does not weaken transcript ownership checks.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import { resolveToolInput } from '../../adapters/index.js';
import { DEFAULT_TOOL } from '../../lib/config.js';
import { teardownSessionDevServers } from '../dev-servers.js';
import {
  formatEntryResolutionError,
  patchEntriesIfPresent,
  readRegistry,
  readRegistryStrict,
  removeEntryIfMatches,
  resolveEntry,
} from '../registry.js';
import {
  branchExists,
  commitsAhead,
  git,
  primaryWorktree,
  resolveDefaultBranch,
  tryGit,
} from '../git.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { detectSquashPhantom } from '../squash-phantom.js';
import { removeBrokerSessionForEntry } from '../broker/session-cleanup.js';
import { providerArtifactPath } from '../broker/paths.js';
import { readProviderArtifactSync } from '../broker/provider-artifact-journal.js';
import { mcHome } from '../paths.js';
import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../storage-repair.js';
import { runSessionUploadSync } from '../session-upload.js';
import { resolveToolSessionForResume } from '../tool-session.js';
import {
  classifyToolArtifactAuthority,
  deleteOwnedToolArtifacts,
  inspectOwnedToolArtifacts,
  TOOL_ARTIFACT_AUTHORITY_VERSION,
} from '../tool-artifact-ownership.js';
import {
  inspectBrokerSessionAbsence,
  inspectSessionOwnedMcArtifacts,
  removeSessionOwnedRuntimeArtifacts,
} from '../session-owned-artifacts.js';

const CONFIRM_PROMPT = 'Avsluta och ta bort allt sessionsbundet lokalt? y/n ';
const MANAGED_PROVIDER_AUTHORITY_VERSION = 1;

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * On macOS, `/var/folders/...` and `/tmp` are symlinks to `/private/...`.
 * Git reports the realpath form while the user's shell normally uses the
 * shorter form.
 */
function unprivateMac(path) {
  if (typeof path !== 'string') return path;
  if (process.platform !== 'darwin') return path;
  if (path.startsWith('/private/var/') || path.startsWith('/private/tmp/')) {
    return path.slice('/private'.length);
  }
  return path;
}

export async function run(rawArgv, runOpts = {}) {
  const stdout = runOpts.stdout || process.stdout;
  const stderr = runOpts.stderr || process.stderr;
  const deps = runOpts.deps || {};
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }

  const cwd = runOpts.cwd || process.cwd();
  let registry;
  try {
    const loadRegistry = opts.dryRun
      ? (deps.readRegistry || deps.readRegistryStrict || readRegistry)
      : (deps.readRegistryStrict || deps.readRegistry || readRegistryStrict);
    registry = loadRegistry({
      persistMigration: !opts.dryRun,
    });
  } catch (err) {
    return emitFailure({
      opts,
      stdout,
      stderr,
      error: 'registry-unreadable',
      message: `registry is unreadable: ${err.message}`,
    });
  }
  const selected = selectTargets(registry.entries, opts.names, cwd, {
    requireIdentity: !opts.dryRun,
  });
  if (!selected.ok) {
    stderr.write(`mc: ${selected.error}\n`);
    if (selected.usage) {
      stderr.write('mc: usage — `mc end [<name>…] [--force] [--keep-branch] [--dry-run]`\n');
    }
    return selected.code;
  }

  const plans = [];
  for (const originalEntry of selected.entries) {
    const primary = resolvePrimaryForEntry(originalEntry, cwd);
    const worktreePresent = Boolean(
      originalEntry.worktree_path && existsSync(originalEntry.worktree_path),
    );
    // An EXISTING worktree that cannot be mapped to its primary repo is
    // something to protect — fail as before. A session whose worktree is
    // already gone (deleted repo, wiped disk, never created) has no git
    // surface left: tear down what remains and leave any branch alone
    // instead of refusing forever.
    if (!primary && worktreePresent) {
      return emitFailure({
        opts,
        stdout,
        stderr,
        error: 'primary-worktree-unresolved',
        message: `"${originalEntry.name}" has no resolvable primary worktree`,
      });
    }
    const detached = !primary;

    const entry = await synchronizeToolAuthority(originalEntry, { deps });
    const artifacts = withProviderlessDowngrade(entry, await inspectAuthority(entry, { deps }));
    const mcArtifacts = inspectMcAuthority(entry, deps);
    const status = await buildTargetStatus(entry, primary, artifacts, {
      keepBranch: opts.keepBranch,
      detached,
    });
    plans.push({
      originalEntry,
      entry,
      primary,
      detached,
      artifacts,
      mcArtifacts,
      status,
    });
  }

  const unsafe = plans.filter((plan) => !plan.artifacts.safe_to_delete);
  const unsafeMc = plans.filter((plan) => !plan.mcArtifacts.ok);
  if (opts.dryRun) {
    return emitDryRun({
      opts,
      plans,
      unsafe,
      unsafeMc,
      stdout,
      stderr,
    });
  }

  if (unsafe.length > 0) {
    return emitAuthorityFailure({ opts, plans, unsafe, stdout, stderr });
  }
  if (unsafeMc.length > 0) {
    return emitMcAuthorityFailure({
      opts,
      plans,
      unsafe: unsafeMc,
      stdout,
      stderr,
    });
  }

  if (!opts.json) printStatuses(plans, stdout);

  if (!opts.force) {
    const stdin = runOpts.stdin || process.stdin;
    const interactive = deps.isTTY ?? Boolean(stdin?.isTTY && stdout?.isTTY);
    if (opts.json || !interactive) {
      return emitConfirmationRequired({ opts, plans, stdout, stderr });
    }
    const answer = await promptYesNo({
      prompt: CONFIRM_PROMPT,
      stdin,
      stdout,
      deps,
    });
    if (answer.trim().toLowerCase() !== 'y') {
      stderr.write('mc: avbrutet — ingenting togs bort\n');
      return 1;
    }
  }

  // Revalidate every target immediately before the first destructive side
  // effect. A failure blocks the whole batch; no broker, vault, transcript,
  // worktree, or branch operation has happened yet.
  const revalidated = [];
  for (const plan of plans) {
    const artifacts = withProviderlessDowngrade(
      plan.entry,
      await inspectAuthority(plan.entry, { deps }),
    );
    revalidated.push({
      ...plan,
      artifacts,
      mcArtifacts: inspectMcAuthority(plan.entry, deps),
      status: statusWithArtifacts(plan.status, artifacts),
    });
  }
  const changedAuthority = revalidated.filter((plan) => !plan.artifacts.safe_to_delete);
  if (changedAuthority.length > 0) {
    return emitAuthorityFailure({
      opts,
      plans: revalidated,
      unsafe: changedAuthority,
      stdout,
      stderr,
      phase: 'revalidation',
      statusesAlreadyPrinted: !opts.json,
    });
  }
  const changedMcAuthority = revalidated.filter((plan) => !plan.mcArtifacts.ok);
  if (changedMcAuthority.length > 0) {
    return emitMcAuthorityFailure({
      opts,
      plans: revalidated,
      unsafe: changedMcAuthority,
      stdout,
      stderr,
      phase: 'revalidation',
      statusesAlreadyPrinted: !opts.json,
    });
  }

  // Persist only after confirmation, and only by synchronously patching
  // entries that still exist. The marker makes a later repair/retry
  // idempotent if an unexpected failure happens after transcript unlink.
  const persisted = persistVerifiedAuthorities(revalidated, {
    deps,
    now: deps.now || (() => new Date().toISOString()),
  });
  if (!persisted.ok) {
    return emitFailure({
      opts,
      stdout,
      stderr,
      error: 'registry-authority-sync-failed',
      message: persisted.message,
      targets: revalidated.map((plan) => plan.status),
    });
  }

  emitCdBeforeTeardown(revalidated, {
    cwd,
    emitDirectives,
  });

  // Each target's teardown is independent (per-entry authority, per-entry
  // artifacts), so one failure must not strand the rest of the batch —
  // that is how partial failures used to accumulate leftovers across
  // every later target too.
  const results = [];
  for (const plan of revalidated) {
    results.push(await teardownOne(plan, { opts, deps }));
  }

  return emitResults({ opts, results, stdout, stderr });
}

function selectTargets(entries, names, cwd, { requireIdentity = true } = {}) {
  const requested = names.length > 0 ? names : ['.'];
  const selected = [];
  for (const name of requested) {
    const implicit = name === '.' ? resolveImplicitEntry(entries, cwd) : null;
    const resolution = name === '.'
      ? { ok: Boolean(implicit), entry: implicit, reason: implicit ? null : 'missing' }
      : resolveEntry(name, { registry: { entries }, cwd, fallbackGlobal: true });
    const entry = resolution.entry || null;
    if (!entry) {
      if (name === '.') {
        return {
          ok: false,
          code: 2,
          usage: true,
          error: 'could not infer which session to end from this directory',
        };
      }
      return {
        ok: false,
        code: 1,
        error: formatEntryResolutionError(name, resolution),
      };
    }
    // session_id is the removal anchor and must exist. repository_id may
    // legitimately be absent (rows created outside any repository); such a
    // row could otherwise never satisfy the gate and became unremovable.
    if (requireIdentity && !entry.session_id) {
      return {
        ok: false,
        code: 1,
        error: `session "${entry.name}" has unresolved legacy identity; registry state was preserved`,
      };
    }
    selected.push(entry);
  }
  return { ok: true, entries: selected };
}

async function synchronizeToolAuthority(entry, { deps = {} } = {}) {
  const managed = inspectManagedToolAuthority(entry, deps);
  if (managed?.safe_to_delete) return entry;
  const classified = classifyToolArtifactAuthority(entry, {
    roots: deps.toolArtifactRoots,
  });
  if (classified.state === 'candidate' || classified.state === 'none') return entry;
  if (!classified.issues?.every((issue) => isBackfillableIssue(issue.code))) return entry;

  const resolver = deps.resolveToolSessionForResume || resolveToolSessionForResume;
  const launchTool = resolveToolInput(entry?.tool || DEFAULT_TOOL);
  let resolved;
  try {
    resolved = await resolver({
      // Preserve any authority fields that are already known. In particular,
      // resolveToolSessionForResume can repair a missing transcript path only
      // when it can match the discovered transcript against the stored native
      // session ID. The resolver still performs fresh discovery when the ID is
      // absent.
      entry,
      launchTool,
      deps: deps.toolSessionDeps || deps,
    });
  } catch {
    return entry;
  }
  if (!resolved?.ok) return entry;

  const patch = {
    tool_session_source: nonEmpty(resolved.source),
    tool_session_id: nonEmpty(resolved.sessionId),
    tool_transcript_path: nonEmpty(resolved.transcriptPath),
  };
  if (!patch.tool_session_source || !patch.tool_session_id || !patch.tool_transcript_path) {
    return entry;
  }
  if (conflictsWithStoredAuthority(entry, patch)) return entry;

  const next = { ...entry, ...patch };
  return classifyToolArtifactAuthority(next, {
    roots: deps.toolArtifactRoots,
  }).state === 'candidate'
    ? next
    : entry;
}

/**
 * A launched session can have NO identifiable provider artifacts at all —
 * e.g. the provider ran with transcripts disabled (child-session marker),
 * or exited before recording anything. After a fresh discovery attempt
 * (synchronizeToolAuthority) has confirmed there is nothing to name, there
 * is nothing to protect on the provider surface: proceed with an empty
 * provider-artifact set (delete nothing provider-side) instead of blocking
 * the whole teardown forever. Any real unnamed artifacts are left in place.
 */
function withProviderlessDowngrade(entry, artifacts) {
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

function isBackfillableIssue(code) {
  return new Set([
    'missing-tool-session-source',
    'missing-tool-session-id',
    'missing-tool-transcript-path',
  ]).has(code);
}

function conflictsWithStoredAuthority(entry, patch) {
  return [
    ['tool_session_source', patch.tool_session_source],
    ['tool_session_id', patch.tool_session_id],
    ['tool_transcript_path', patch.tool_transcript_path],
  ].some(([key, value]) => nonEmpty(entry?.[key]) && nonEmpty(entry[key]) !== value);
}

async function inspectAuthority(entry, { deps = {} } = {}) {
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

function inspectManagedToolAuthority(entry, deps = {}) {
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

function isVerifiedMissingRetry(entry, result, roots) {
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

async function buildTargetStatus(entry, primary, artifacts, {
  keepBranch = false,
  detached = false,
} = {}) {
  const dirtyFiles = countDirtyFiles(entry.worktree_path);
  const defaultBranch = resolveDefaultBranch(primary);
  const observedAhead = entry.branch && defaultBranch.ok
    ? commitsAhead(primary, entry.branch, defaultBranch.ref)
    : entry.branch ? null : 0;
  const ahead = observedAhead === null
    ? null
    : Math.max(observedAhead, finiteNumber(entry.ahead));
  const verdict = await computeVerdict(entry, primary, {
    dirtyFiles,
    ahead,
    defaultBranch,
    detached,
  });
  return {
    name: entry.name,
    session_state: entry.session_state || 'idle',
    worktree_path: entry.worktree_path || null,
    dirty_files: dirtyFiles,
    branch: entry.branch || null,
    commits_ahead: ahead,
    unmerged: ahead === null ? null : ahead > 0,
    default_branch: defaultBranch.ok ? defaultBranch.branch : null,
    default_branch_source: defaultBranch.ok ? defaultBranch.source : null,
    default_branch_reason: defaultBranch.ok ? null : defaultBranch.reason,
    keep_branch: keepBranch,
    ...(detached ? { detached: true } : {}),
    verdict: verdict.value,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    transcript: transcriptStatus(artifacts),
    auxiliary: auxiliaryStatus(artifacts),
  };
}

function statusWithArtifacts(status, artifacts) {
  return {
    ...status,
    transcript: transcriptStatus(artifacts),
    auxiliary: auxiliaryStatus(artifacts),
  };
}

function transcriptStatus(artifacts) {
  if (artifacts?.state === 'none') {
    return {
      state: 'none',
      path: null,
      bytes: 0,
      ...(artifacts.provider_untouched ? { provider_untouched: true } : {}),
    };
  }
  if (artifacts?.state === 'owned') {
    const transcript = artifacts.artifacts?.find((artifact) => artifact.kind === 'transcript');
    return {
      state: 'owned',
      path: transcript?.path || artifacts.transcript_path || null,
      bytes: transcript?.bytes || 0,
    };
  }
  if (artifacts?.state === 'absent') {
    return {
      state: 'absent',
      path: artifacts.transcript_path || null,
      bytes: 0,
    };
  }
  if (artifacts?.state === 'managed') {
    return {
      state: 'managed',
      path: artifacts.transcript_path || null,
      bytes: 0,
    };
  }
  return {
    state: 'unverified',
    path: artifacts?.transcript_path || artifacts?.issues?.[0]?.path || null,
    bytes: 0,
    issues: (artifacts?.issues || []).map((issue) => issue.code),
  };
}

function auxiliaryStatus(artifacts) {
  const auxiliary = (artifacts?.artifacts || [])
    .filter((artifact) => artifact.kind !== 'transcript');
  const totals = auxiliary.reduce((out, artifact) => ({
    paths: out.paths + 1,
    files: out.files + finiteNumber(artifact.file_count),
    bytes: out.bytes + finiteNumber(artifact.bytes),
  }), { paths: 0, files: 0, bytes: 0 });
  return {
    state: artifacts?.safe_to_delete ? 'verified' : 'unverified',
    ...totals,
    bounded: artifacts?.scan?.bounded === true,
    truncated: artifacts?.scan?.truncated === true,
    ...(artifacts?.scan?.reason ? { reason: artifacts.scan.reason } : {}),
  };
}

function inspectMcAuthority(entry, deps) {
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

function countDirtyFiles(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return 0;
  const porcelain = tryGit(worktreePath, ['status', '--porcelain']);
  if (!porcelain) return 0;
  return porcelain.split('\n').filter(Boolean).length;
}

async function computeVerdict(entry, primary, { dirtyFiles, ahead, defaultBranch, detached }) {
  const stored = entry.safety_verdict;
  if (entry.session_state === 'live') {
    return { value: 'IS_ACTIVE_NOW', reason: 'live session' };
  }
  if (dirtyFiles > 0) {
    return { value: 'NEEDS_REVIEW', reason: `${dirtyFiles} uncommitted file(s)` };
  }
  if (detached) {
    // No primary repo could be found, so no worktree or branch will be
    // touched — teardown only removes session-owned artifacts and the
    // registry row. Any branch (and whatever is on it) stays where it is.
    return entry.branch
      ? {
        value: 'SAFE_TO_END',
        reason: `primary repo not found; branch ${entry.branch} is left in place`,
      }
      : { value: 'SAFE_TO_END', reason: 'primary repo not found; nothing git-side to remove' };
  }
  if (ahead === null) {
    return {
      value: 'NEEDS_REVIEW',
      reason: `default branch is unknown (${defaultBranch.reason}); refusing merged classification`,
    };
  }
  if (stored === 'IS_SQUASH_PHANTOM' || ahead > 0) {
    const phantom = await detectSquashPhantom({
      repoDir: primary,
      branch: entry.branch,
    }).catch(() => ({ isPhantom: false }));
    if (phantom.isPhantom) {
      return {
        value: 'IS_SQUASH_PHANTOM',
        reason: `changes already on ${defaultBranch.branch}`,
      };
    }
  }
  if (ahead > 0 || stored === 'HAS_UNMERGED_WORK') {
    return {
      value: 'HAS_UNMERGED_WORK',
      reason: `${ahead || finiteNumber(entry.ahead)} commit(s) ahead of ${defaultBranch.branch}`,
    };
  }
  return { value: 'SAFE_TO_END' };
}

function printStatuses(plans, stdout) {
  for (const { status } of plans) {
    const branchAction = status.detached
      ? 'left in place — primary repo not found'
      : status.keep_branch ? 'keep' : 'delete';
    stdout.write(`${status.name}\n`);
    stdout.write(`  session: ${status.session_state}\n`);
    stdout.write(`  worktree: ${status.worktree_path || 'none'} (dirty: ${status.dirty_files})\n`);
    const ahead = status.commits_ahead === null ? 'unknown' : status.commits_ahead;
    stdout.write(status.branch
      ? `  branch: ${status.branch} (ahead: ${ahead}, ${branchAction})\n`
      : '  branch: none\n');
    if (status.transcript.state === 'none') {
      stdout.write(status.transcript.provider_untouched
        ? '  transcript: none identifiable — provider artifacts left untouched\n'
        : '  transcript: none\n');
    } else if (status.transcript.state === 'unverified') {
      const issues = status.transcript.issues?.join(', ') || 'unknown';
      stdout.write(`  transcript: unverified ${status.transcript.path || 'none'} (${issues})\n`);
    } else if (status.transcript.state === 'absent') {
      stdout.write(`  transcript: ${status.transcript.path} (already absent)\n`);
    } else {
      stdout.write(`  transcript: ${status.transcript.path} (${formatBytes(status.transcript.bytes)})\n`);
    }
    if (status.auxiliary.truncated) {
      stdout.write(`  auxiliary: unknown (bounded scan truncated: ${status.auxiliary.reason})\n`);
    } else {
      stdout.write(
        `  auxiliary: ${status.auxiliary.paths} paths, ${status.auxiliary.files} files`
        + ` (${formatBytes(status.auxiliary.bytes)})\n`,
      );
    }
  }
}

function emitDryRun({
  opts,
  plans,
  unsafe,
  unsafeMc,
  stdout,
  stderr,
}) {
  const blocked = unsafe.length > 0 || unsafeMc.length > 0;
  const out = {
    ok: !blocked,
    dry_run: true,
    confirmation_required: true,
    targets: plans.map((plan) => plan.status),
    ...(unsafe.length > 0 ? {
      error: 'tool-artifact-authority-unverified',
      unsafe_targets: unsafe.map(authorityFailureShape),
    } : unsafeMc.length > 0 ? {
      error: 'mc-artifact-authority-unverified',
      unsafe_targets: unsafeMc.map(mcAuthorityFailureShape),
    } : {}),
  };
  if (opts.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    printStatuses(plans, stdout);
    if (unsafe.length > 0) {
      stderr.write('mc: dry-run blocked — exact tool transcript authority could not be verified\n');
    } else if (unsafeMc.length > 0) {
      stderr.write('mc: dry-run blocked — exact mc-owned artifact paths could not be verified\n');
    }
  }
  return blocked ? 1 : 0;
}

function emitAuthorityFailure({
  opts,
  plans,
  unsafe,
  stdout,
  stderr,
  phase = 'preflight',
  statusesAlreadyPrinted = false,
}) {
  const out = {
    ok: false,
    error: 'tool-artifact-authority-unverified',
    phase,
    targets: plans.map((plan) => plan.status),
    unsafe_targets: unsafe.map(authorityFailureShape),
  };
  if (opts.json) {
    stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    if (!statusesAlreadyPrinted) printStatuses(plans, stdout);
    const names = unsafe.map((plan) => `"${plan.entry.name}"`).join(', ');
    stderr.write(`mc: ${phase} blocked for ${names} — exact tool transcript ownership/authority is unverified\n`);
    for (const plan of unsafe) {
      const issues = (plan.artifacts.issues || []).map((issue) => issue.code).join(', ');
      stderr.write(`mc: ${plan.entry.name}: ${issues || 'unknown authority failure'}\n`);
    }
  }
  return 1;
}

function authorityFailureShape(plan) {
  return {
    name: plan.entry.name,
    issues: (plan.artifacts.issues || []).map((issue) => ({
      code: issue.code,
      ...(issue.path ? { path: issue.path } : {}),
    })),
  };
}

function emitMcAuthorityFailure({
  opts,
  plans,
  unsafe,
  stdout,
  stderr,
  phase = 'preflight',
  statusesAlreadyPrinted = false,
}) {
  const out = {
    ok: false,
    error: 'mc-artifact-authority-unverified',
    phase,
    targets: plans.map((plan) => plan.status),
    unsafe_targets: unsafe.map(mcAuthorityFailureShape),
  };
  if (opts.json) {
    stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    if (!statusesAlreadyPrinted) printStatuses(plans, stdout);
    const names = unsafe.map((plan) => `"${plan.entry.name}"`).join(', ');
    stderr.write(`mc: ${phase} blocked for ${names} — exact mc-owned artifact paths are unverified\n`);
    for (const plan of unsafe) {
      const issues = (plan.mcArtifacts.issues || []).map((issue) => issue.code).join(', ');
      stderr.write(`mc: ${plan.entry.name}: ${issues || 'unknown mc artifact failure'}\n`);
    }
  }
  return 1;
}

function mcAuthorityFailureShape(plan) {
  return {
    name: plan.entry.name,
    issues: (plan.mcArtifacts.issues || []).map((issue) => ({
      code: issue.code,
      ...(issue.path ? { path: issue.path } : {}),
    })),
  };
}

function emitConfirmationRequired({ opts, plans, stdout, stderr }) {
  const out = {
    ok: false,
    error: 'confirmation-required',
    confirmation_required: true,
    hint: 'rerun with --force for explicit non-interactive teardown',
    targets: plans.map((plan) => plan.status),
  };
  if (opts.json) stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    stderr.write('mc: confirmation required — rerun interactively or pass --force for automation\n');
  }
  return 1;
}

function persistVerifiedAuthorities(plans, { deps = {}, now }) {
  const read = deps.readRegistry || readRegistry;
  const patch = deps.patchEntriesIfPresent || patchEntriesIfPresent;
  const current = read();
  const patches = [];
  for (const plan of plans) {
    const latest = current.entries.find((entry) => entry.session_id === plan.entry.session_id);
    if (!latest) {
      return {
        ok: false,
        message: `"${plan.entry.name}" disappeared from the registry before teardown`,
      };
    }
    if (!sameSessionContainer(latest, plan.originalEntry)) {
      return {
        ok: false,
        message: `"${plan.entry.name}" changed in the registry before teardown`,
      };
    }
    if (conflictsWithStoredAuthority(latest, {
      tool_session_source: plan.entry.tool_session_source,
      tool_session_id: plan.entry.tool_session_id,
      tool_transcript_path: plan.entry.tool_transcript_path,
    })) {
      return {
        ok: false,
        message: `"${plan.entry.name}" tool transcript authority changed before teardown`,
      };
    }
    const authority = classifyToolArtifactAuthority(plan.entry, {
      roots: deps.toolArtifactRoots,
    });
    const authorityPatch = {
      name: plan.entry.name,
      session_id: plan.entry.session_id,
      repository_id: plan.entry.repository_id,
      tool_session_source: plan.entry.tool_session_source || null,
      tool_session_id: plan.entry.tool_session_id || null,
      tool_transcript_path: plan.entry.tool_transcript_path || null,
    };
    if (authority.state === 'candidate') {
      authorityPatch.tool_artifact_authority_verified = {
        version: TOOL_ARTIFACT_AUTHORITY_VERSION,
        source: authority.source,
        session_id: authority.session_id,
        transcript_path: authority.transcript_path,
        verified_at: now(),
      };
    }
    if (plan.artifacts?.provider_managed) {
      authorityPatch.managed_provider_authority_verified = {
        version: MANAGED_PROVIDER_AUTHORITY_VERSION,
        adapter: plan.entry.tool_session_provider_adapter,
        coding_session_id: plan.artifacts.coding_session_id,
        runtime_generation: plan.artifacts.runtime_generation,
        source: plan.artifacts.source,
        session_id: plan.artifacts.session_id,
        transcript_path: plan.artifacts.transcript_path,
        cleanup_confirmed_at: plan.artifacts.provider_cleanup_confirmed
          ? plan.entry.managed_provider_authority_verified?.cleanup_confirmed_at || now()
          : null,
      };
    }
    patches.push(authorityPatch);
  }
  const result = patch(patches);
  if (!result?.ok) {
    return {
      ok: false,
      message: `registry entries disappeared before authority sync: ${(result?.missing || []).join(', ')}`,
    };
  }
  for (const plan of plans) {
    const updated = result.entries?.find((entry) => entry.session_id === plan.entry.session_id);
    if (updated) plan.entry = updated;
  }
  return { ok: true };
}

function sameSessionContainer(current, original) {
  return current?.session_id === original?.session_id
    && current?.repository_id === original?.repository_id
    && current?.name === original?.name
    && nonEmpty(current?.worktree_path) === nonEmpty(original?.worktree_path)
    && nonEmpty(current?.branch) === nonEmpty(original?.branch);
}

function emitCdBeforeTeardown(plans, { cwd, emitDirectives }) {
  const cwdReal = safeRealpath(cwd);
  const insideTarget = plans.find(({ entry }) => (
    entry.worktree_path
      && isInsidePath(cwdReal, safeRealpath(entry.worktree_path))
  ));
  if (insideTarget) {
    emitCd(unprivateMac(insideTarget.primary), {
      enabled: emitDirectives || undefined,
    });
  }
}

async function teardownOne(plan, { opts, deps }) {
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
        throw new Error(`broker cleanup failed (${broker?.error || broker?.reason || 'unknown'})`);
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

function managedProviderCleanupMarkerMatches(entry) {
  const marker = entry?.managed_provider_authority_verified;
  return managedProviderAuthorityMarkerMatches(entry, marker)
    && nonEmpty(marker.cleanup_confirmed_at) != null;
}

function managedProviderAuthorityMarkerMatches(entry, marker) {
  return marker?.version === MANAGED_PROVIDER_AUTHORITY_VERSION
    && marker.adapter === nonEmpty(entry?.tool_session_provider_adapter)
    && marker.coding_session_id === nonEmpty(entry?.coding_session_id)
    && marker.runtime_generation === nonEmpty(entry?.tool_session_provider_generation)
    && marker.source === nonEmpty(entry?.tool_session_source)
    && marker.session_id === nonEmpty(entry?.tool_session_id)
    && nonEmpty(marker.transcript_path) != null;
}

async function defaultShredForSession(args) {
  const { shredForSession } = await import('../vault/lifecycle.js');
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

function emitResults({ opts, results, stdout, stderr }) {
  const allOk = results.every((result) => result.ok);
  const out = {
    ok: allOk,
    results,
  };
  if (results.length === 1) {
    Object.assign(out, {
      name: results[0].name,
      verdict: results[0].verdict || results[0].status?.verdict,
      ...(results[0].error ? { error: results[0].error } : {}),
      leftovers: results[0].leftovers,
    });
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (results.length === 1) {
    const result = results[0];
    if (result.ok) {
      stdout.write(`mc: ended ${result.name}\n`);
    } else {
      stderr.write(`mc: failed to end ${result.name}: ${result.error}\n`);
      stderr.write(`mc: leftovers: ${result.leftovers.length ? result.leftovers.join(', ') : 'none detected'}\n`);
    }
  } else {
    for (const result of results) {
      const suffix = result.error ? ` — ${result.error}` : '';
      stdout.write(`${result.ok ? '✓' : '✗'} ${result.name}${suffix}\n`);
      if (!result.ok) {
        stdout.write(`  leftovers: ${result.leftovers.length ? result.leftovers.join(', ') : 'none detected'}\n`);
      }
    }
  }
  return allOk ? 0 : 1;
}

function emitFailure({
  opts,
  stdout,
  stderr,
  error,
  message,
  targets = [],
}) {
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ok: false,
      error,
      message,
      targets,
    }, null, 2)}\n`);
  } else {
    stderr.write(`mc: ${message}\n`);
  }
  return 1;
}

async function promptYesNo({ prompt, stdin, stdout, deps = {} } = {}) {
  if (typeof deps.readLine === 'function') {
    stdout.write(prompt);
    return deps.readLine({ stdin, stdout, prompt });
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function findEntryForCwd(entries, cwd) {
  const cwdReal = safeRealpath(cwd);
  return (entries || [])
    .filter((entry) => entry?.worktree_path)
    .map((entry) => ({ entry, worktreeReal: safeRealpath(entry.worktree_path) }))
    .filter(({ worktreeReal }) => isInsidePath(cwdReal, worktreeReal))
    .sort((a, b) => b.worktreeReal.length - a.worktreeReal.length)[0]?.entry || null;
}

function resolveImplicitEntry(entries, cwd) {
  const current = findEntryForCwd(entries, cwd);
  if (current) return current;

  const primary = primaryWorktree(cwd);
  if (!primary) return null;
  const primaryReal = safeRealpath(primary);
  return (entries || [])
    .filter((entry) => entry?.worktree_path)
    .filter((entry) => entryMatchesPrimary(entry, primaryReal))
    .map((entry) => ({ entry, openedAt: timestampMs(entry.last_opened_at) }))
    .filter((item) => Number.isFinite(item.openedAt))
    .sort((a, b) => b.openedAt - a.openedAt)[0]?.entry || null;
}

function entryMatchesPrimary(entry, primaryReal) {
  if (entry.primary_worktree
    && samePath(safeRealpath(entry.primary_worktree), primaryReal)) {
    return true;
  }
  if (entry.worktree_path && existsSync(entry.worktree_path)) {
    const entryPrimary = primaryWorktree(entry.worktree_path);
    return entryPrimary
      ? samePath(safeRealpath(entryPrimary), primaryReal)
      : false;
  }
  return false;
}

function resolvePrimaryForEntry(entry, cwd) {
  if (entry?.primary_worktree) {
    const primary = primaryWorktree(entry.primary_worktree);
    if (primary) return primary;
  }
  if (entry?.worktree_path && existsSync(entry.worktree_path)) {
    const primary = primaryWorktree(entry.worktree_path);
    if (primary) return primary;
  }
  const currentPrimary = primaryWorktree(cwd);
  if (currentPrimary
    && (!entry?.worktree_path
      || worktreeBelongsToPrimary(currentPrimary, entry.worktree_path))) {
    return currentPrimary;
  }
  return null;
}

function worktreeBelongsToPrimary(primary, worktreePath) {
  if (!primary || !worktreePath) return false;
  const out = tryGit(primary, ['worktree', 'list', '--porcelain']);
  if (!out) return false;
  const needle = safeRealpath(worktreePath);
  return out.split('\n\n').some((block) => {
    const match = block.match(/^worktree\s+(.+)$/m);
    return match && samePath(safeRealpath(match[1].trim()), needle);
  });
}

function isInsidePath(candidate, parent) {
  if (!candidate || !parent) return false;
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function samePath(a, b) {
  return a === b || (isInsidePath(a, b) && isInsidePath(b, a));
}

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : NaN;
}

function formatBytes(bytes) {
  const value = finiteNumber(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseArgs(argv) {
  const opts = {
    names: [],
    force: false,
    keepBranch: false,
    dryRun: false,
    json: false,
    noDistill: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--force': opts.force = true; break;
      case '--keep-branch': opts.keepBranch = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--no-distill': opts.noDistill = true; break;
      default:
        if (arg.startsWith('--')) return { error: `unknown flag: ${arg}` };
        opts.names.push(arg);
    }
  }
  return opts;
}
