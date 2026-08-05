import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { arch, homedir, platform, userInfo } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCachedVaultKey } from '../engine/key-cache.js';
import {
  decryptEnvelopeSecret,
  isEnvelopeSecret,
  unwrapCustodyRoot,
} from '../engine/custody-crypto.js';
import { encryptForWrite } from '../engine/custody-session.js';
import * as VaultApi from '../engine/api.js';
import { WIRE_SECRET_TYPE } from '../engine/types.js';
import { mcHome } from '../../mc/paths.js';
import { resolveRealCodexBinary } from '../../lib/codex.js';
import { RUNTIME_SECRET_ENV_NAMES } from '../../mc/runtime-secrets.js';
import { resolveTrustedVaultPortal } from '../engine/trusted-portal.js';
import {
  MANAGED_CODEX_DOMAIN_SCHEMA,
  MANAGED_CODEX_PROFILE,
  MANAGED_CODEX_PROVIDER_ID,
  MANAGED_CODEX_RELEASE_SHA256,
  MANAGED_CODEX_TEAM_ID,
  MANAGED_CODEX_VERSION,
  renderManagedCodexProviderObservationBinding,
} from '../../adapters/managed-runtime/codex-managed.js';
import {
  verifyInstalledManagedCodexArtifact,
} from '../../adapters/managed-runtime/codex-managed-artifacts.js';
import {
  appendManagedGenerationReceiptSync,
  inspectManagedGenerationSync,
  validateManagedGenerationTransaction,
} from '../../mc/managed-generation-journal.js';

export const LOCAL_CODEX_BOUNDARY_UNAVAILABLE = 'managed-portable-boundary-unavailable';
export const LOCAL_CODEX_CUSTODY_LOCKED = 'managed-portable-custody-locked';
export const LOCAL_CODEX_AUTH_MISSING = 'managed-portable-codex-auth-missing';
export const LOCAL_CODEX_RELEASE_UNTRUSTED = 'managed-portable-codex-release-untrusted';
export const LOCAL_CODEX_WORKSPACE_CONTAINS_MC = 'managed-portable-workspace-contains-mc';

const TOOL_AUTH_LABEL = 'tool-auth:codex';
const LEGACY_TOOL_AUTH_LABEL = 'tool_auth.codex';
const SESSION_OWNER_ID_RE = /^(?:sess_[A-Za-z0-9_-]{6,}|mcs_[a-f0-9]{24})$/u;
const BOUNDARY_CANARY_ENV_NAME = 'MC_BOUNDARY_CANARY';
const PROBE_TIMEOUT_MS = 30_000;
const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const MAX_USER_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_USER_PROFILE_FILES = 64;
const MAX_PROVIDER_TRANSCRIPT_ENTRIES = 4096;
const MANAGED_SESSION_STATE_SCHEMA = 'mc-managed-codex-session-state/v1';
const MANAGED_GENERATION_ARCHIVE_SCHEMA = 'mc-managed-codex-generation-archive/v1';
const MANAGED_SESSION_PROJECTION_SCHEMA = 'mc-managed-codex-session-projection/v1';
const MANAGED_SHELL_SECRET_ENV_NAMES = Object.freeze([
  ...new Set([...RUNTIME_SECRET_ENV_NAMES, BOUNDARY_CANARY_ENV_NAME]),
].sort());
const MANAGED_DOMAIN_MANIFEST_KEYS = Object.freeze([
  'schema',
  'provider_adapter',
  'state',
  'session_id',
  'generation',
  'launch_nonce',
  'profile',
  'codex_version',
  'codex_team_id',
  'native_binary',
  'native_binary_sha256',
  'domain_path',
  'codex_home',
  'provider_home',
  'provider_tmp',
  'executor_root',
  'executor_home',
  'executor_tmp',
  'lease_path',
  'custody_secret_id',
  'provider_config_path',
  'provider_config_sha256',
  'provider_hook_path',
  'provider_hook_sha256',
  'provider_hook_node_path',
  'provider_hook_node_sha256',
  'provider_hook_runner_path',
  'provider_hook_runner_sha256',
]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANAGED_GITHUB_RUNTIME_PATHS = Object.freeze([
  'package.json',
  'src/lib/api.js',
  'src/runtime/broker/client.js',
  'src/runtime/broker/paths.js',
  'src/capabilities/github/github-contract.js',
  'src/capabilities/github/github-session.js',
  'src/capabilities/github/github-shim.js',
  'src/capabilities/github/github-write-client.js',
  'src/mc/paths.js',
].map((path) => join(PACKAGE_ROOT, path)));
const BOUNDARY_CHILD_SOURCE = join(
  PACKAGE_ROOT,
  'scripts',
  'security',
  'credential-boundary-child.c',
);
const BOUNDARY_CHILD_SOURCE_SHA256 =
  '13d2c2204b0df8c849198653de671f9bc638cbaa20fbfeb968d1d0f6dc818281';
const BOUNDARY_REPORT_KEYS = Object.freeze([
  'schema',
  'file_readable',
  'canary_in_environment',
  'canary_in_argv',
  'parent_process_exposes_canary',
  'detached_boundary_reachable',
  'credential_socket_reachable',
  'external_network_reachable',
  'workspace_write_blocked',
  'vault_admin_via_bin_callable',
  'vault_admin_via_node_callable',
]);

/**
 * Prepare a per-session provider credential domain. Every platform and release
 * check, plus the hostile canary probe, completes before custody is opened.
 */
export async function prepareLocalCodexCredentialDomain({
  codingSessionId,
  domainGeneration = null,
  providerSessionId = null,
  githubCapability = false,
  githubSocketPath: requestedGitHubSocketPath = null,
  cwd,
  tool,
  portal,
  env = process.env,
  root = mcHome(),
  deps = {},
} = {}) {
  const certifiedGitHubSocketPath = join(
    root,
    'run',
    'sessions',
    codingSessionId || 'invalid',
    'github.sock',
  );
  if (tool !== 'codex') {
    return safeFailure('managed-portable-tool-unsupported');
  }
  if (!SESSION_OWNER_ID_RE.test(codingSessionId || '')
    || !isAbsolute(cwd || '')
    || (requestedGitHubSocketPath !== null
      && requestedGitHubSocketPath !== certifiedGitHubSocketPath)) {
    return safeFailure('managed-portable-request-invalid');
  }
  if (domainGeneration != null && !isUuidV4(domainGeneration)) {
    return safeFailure('managed-portable-request-invalid');
  }

  const release = await Promise.resolve(
    deps.inspectCodexRelease
      ? deps.inspectCodexRelease({
          launcherPath: deps.codexBinary || resolveRealCodexBinary(),
          deps: deps.releaseDeps || {},
        })
      : verifyInstalledManagedCodexArtifact(),
  ).catch(() => null);
  if (!release?.ok) {
    return safeFailure(release?.reason || LOCAL_CODEX_RELEASE_UNTRUSTED);
  }

  // New transaction-bound launches use the runtime generation itself. That
  // makes a prepared domain attributable even if the client dies between
  // writing the domain manifest and its domain-ready receipt. Legacy callers
  // retain a generated domain ID so their existing recovery evidence remains
  // distinguishable.
  const generation = domainGeneration || randomUUID();
  const sessionPart = sessionDirectoryPart(codingSessionId);
  const domainPath = join(root, 'credential-domains', 'codex', sessionPart, generation);
  const executorRoot = join(root, 'executor-domains', 'codex', sessionPart, generation);
  const leaseDir = join(root, 'credential-domain-leases', 'codex');
  const leasePath = join(leaseDir, `${sessionPart}.json`);
  const providerHome = join(domainPath, 'home');
  const codexHome = join(providerHome, '.codex');
  const providerTmp = join(domainPath, 'tmp');
  const executorHome = join(executorRoot, 'home');
  const executorTmp = join(executorRoot, 'tmp');
  const executorBin = join(executorRoot, 'bin');
  const probeDir = join(executorRoot, 'probe');
  const boundarySocketPath = managedBoundarySocketPath();
  const githubSocketPath = requestedGitHubSocketPath
    || managedGitHubSocketPath({ root, codingSessionId });
  const manifestPath = join(domainPath, 'manifest.json');
  const providerConfigPath = join(codexHome, `${MANAGED_CODEX_PROFILE}.config.toml`);
  const providerHookPath = join(codexHome, 'mc-provider-artifact-observer.json');
  let providerHookNodePath = null;
  let providerHookRunnerPath = null;
  const vaultTarget = (deps.resolveVaultProbeTarget || resolveVaultProbeTarget)();
  const hostMcRoot = vaultTarget?.entryPath
    ? resolve(dirname(vaultTarget.entryPath), '..')
    : null;
  const safePath = managedSafePath({ executorBin, env });
  const userCodexHome = resolveUserCodexHome(env);
  const npmCachePath = resolveManagedNpmCachePath({ env });
  // A credential boundary works by denying the sandbox everything that could
  // reach vault admin — including mc's own binary. A workspace that *contains*
  // that binary cannot have it denied without denying the workspace, so the
  // boundary is unbuildable there and the probe correctly reports vault admin
  // as reachable. Saying so beats a probe violation code the user cannot act
  // on: the answer is to run the session somewhere other than mc's own install.
  if (workspaceContainsMcInstallSync(cwd)) {
    return safeFailure(LOCAL_CODEX_WORKSPACE_CONTAINS_MC);
  }
  const forbiddenPaths = managedForbiddenPaths({
    cwd,
    domainPath,
    root,
    userCodexHome,
    hostMcRoot,
    hostMcBinPath: vaultTarget?.binPath || null,
    hostMcEntryPath: vaultTarget?.entryPath || null,
  });
  const configBody = renderManagedCodexConfig({
    domainPath,
    executorRoot,
    workspaceRoot: cwd,
    executorHome,
    executorTmp,
    safePath,
    npmCachePath,
    forbiddenPaths,
    runtimeReadPaths: githubCapability === true ? MANAGED_GITHUB_RUNTIME_PATHS : [],
    deniedUnixSocketPaths: [boundarySocketPath],
    allowedUnixSocketPaths: githubCapability === true ? [githubSocketPath] : [],
  });
  const launchNonce = randomBytes(32).toString('base64url');
  let custody = null;
  let leaseAcquired = false;

  try {
    providerHookNodePath = realpathSync(process.execPath);
    providerHookRunnerPath = realpathSync(join(
      PACKAGE_ROOT,
      'src',
      'adapters',
      'artifacts',
      'codex.js',
    ));
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    chmodSync(leaseDir, 0o700);
    const leaseBody = `${JSON.stringify({
      schema: 1,
      provider_adapter: MANAGED_CODEX_PROVIDER_ID,
      session_id: codingSessionId,
      generation,
      owner_pid: process.pid,
    })}\n`;
    try {
      writeFileSync(leasePath, leaseBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      // The lease says a runtime holds this credential domain. It said so
      // exclusively and released on a clean exit, which meant a crash, a
      // SIGKILL, or a machine that lost power left the session unopenable
      // forever — the domain was quarantined against a process that no longer
      // exists. A lease is a claim about a process, so it is reclaimed when
      // that process is gone, and only then.
      if (!reclaimAbandonedLeaseSync(leasePath)) {
        return safeFailure('managed-portable-domain-quarantined');
      }
      try {
        writeFileSync(leasePath, leaseBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch {
        return safeFailure('managed-portable-domain-quarantined');
      }
    }
    leaseAcquired = true;
    for (const path of [
      domainPath,
      providerHome,
      codexHome,
      providerTmp,
      executorRoot,
      executorHome,
      executorTmp,
      executorBin,
      probeDir,
    ]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const restored = restoreManagedCodexSessionState({
      root,
      codingSessionId,
      providerSessionId,
      codexHome,
    });
    if (!restored.ok) {
      return safeFailure(restored.reason);
    }
    const userConfiguration = materializeManagedCodexUserConfiguration({
      sourceHome: userCodexHome,
      codexHome,
    });
    if (!userConfiguration.ok) {
      return safeFailure(userConfiguration.reason);
    }
    writeFileSync(providerConfigPath, configBody, { mode: 0o600 });
    const probe = deps.verifyBoundary || verifyManagedCodexBoundary;
    const boundary = await probe({
      cwd,
      codexHome,
      credentialDomainPath: domainPath,
      executorRoot,
      nativeBinary: release.nativeBinary,
      probeDir,
      socketPath: boundarySocketPath,
      vaultTarget,
      env,
      deps: deps.boundaryDeps || {},
    });
    if (!boundary?.ok) {
      return {
        ...safeFailure(boundary?.reason || LOCAL_CODEX_BOUNDARY_UNAVAILABLE),
        ...(boundary?.diagnostic_code
          ? { diagnostic_code: boundary.diagnostic_code }
          : {}),
      };
    }

    const providerHookBody = renderManagedCodexProviderObservationBinding({
      nodePath: providerHookNodePath,
      observerPath: providerHookRunnerPath,
    });
    writeFileSync(providerHookPath, providerHookBody, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    const loadAuth = deps.loadCustodyAuth || loadCustodyCodexAuth;
    custody = await loadAuth({
      portal,
      deps: deps.custodyDeps || {},
    });
    if (!custody?.ok) {
      return safeFailure(custody?.reason || LOCAL_CODEX_AUTH_MISSING);
    }
    const auth = normalizeCodexAuthArtifact(custody.authBody);
    if (!auth.ok) return safeFailure(LOCAL_CODEX_AUTH_MISSING);
    writeFileSync(join(codexHome, 'auth.json'), auth.body, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    const manifest = {
      schema: MANAGED_CODEX_DOMAIN_SCHEMA,
      provider_adapter: MANAGED_CODEX_PROVIDER_ID,
      state: 'ready',
      session_id: codingSessionId,
      generation,
      launch_nonce: launchNonce,
      profile: MANAGED_CODEX_PROFILE,
      codex_version: release.version,
      codex_team_id: release.teamId,
      native_binary: release.nativeBinary,
      native_binary_sha256: release.sha256,
      domain_path: domainPath,
      codex_home: codexHome,
      provider_home: providerHome,
      provider_tmp: providerTmp,
      executor_root: executorRoot,
      executor_home: executorHome,
      executor_tmp: executorTmp,
      lease_path: leasePath,
      custody_secret_id: custody.secretId,
      provider_config_path: providerConfigPath,
      provider_config_sha256: sha256(configBody),
      provider_hook_path: providerHookPath,
      provider_hook_sha256: sha256(providerHookBody),
      provider_hook_node_path: providerHookNodePath,
      provider_hook_node_sha256: sha256(readFileSync(providerHookNodePath)),
      provider_hook_runner_path: providerHookRunnerPath,
      provider_hook_runner_sha256: sha256(readFileSync(providerHookRunnerPath)),
    };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    writeFileSync(manifestPath, manifestBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    return {
      ok: true,
      descriptor: {
        ...manifest,
        manifest_path: manifestPath,
        manifest_sha256: sha256(manifestBody),
      },
      env: buildManagedCodexProviderEnv({
        providerHome,
        codexHome,
        providerTmp,
        safePath,
        env,
      }),
      state: 'managed-ready',
      portable: true,
    };
  } catch {
    return safeFailure('managed-portable-domain-prepare-failed');
  } finally {
    if (!custody?.ok || !existsSync(manifestPath)) {
      const removed = removeDomainPaths({ domainPath, executorRoot });
      if (leaseAcquired && removed) removeDomainLease(leasePath);
    }
  }
}

/**
 * Persist provider refresh state back to the same custody record and remove
 * the entire per-session domain. All public results are metadata-only.
 */
export async function closeLocalCodexCredentialDomain({
  descriptor,
  providerArtifact = null,
  portal,
  managedTransaction = null,
  deps = {},
} = {}) {
  const ownedPaths = resolveOwnedDomainPaths(descriptor);
  if (!ownedPaths) {
    return { ok: false, persisted: false, reason: 'managed-domain-descriptor-invalid' };
  }
  const { root, domainPath, executorRoot, leasePath } = ownedPaths;
  const transaction = validateManagedCloseTransaction({
    descriptor,
    managedTransaction,
    providerArtifact,
    root,
    deps,
  });
  if (!transaction.ok) {
    return {
      ok: false,
      persisted: false,
      quarantined: true,
      reason: transaction.reason,
    };
  }
  const appendReceipt = deps.appendManagedGenerationReceipt
    || appendManagedGenerationReceiptSync;
  const providerAbsent = transaction.value != null && providerArtifact == null;
  const receipt = (phase, data) => {
    if (!transaction.value) return null;
    return appendReceipt({
      mcHomeDir: root,
      phase,
      codingSessionId: transaction.value.coding_session_id,
      runtimeGeneration: transaction.value.runtime_generation,
      intentDigest: transaction.value.intent_digest,
      recordedAt: new Date().toISOString(),
      data,
    });
  };
  let durable = transaction.generation;
  let persisted = false;
  let reason = 'managed-domain-closed';
  if (durable?.receipts?.['custody-persisted']) {
    persisted = true;
  } else {
    try {
      const authPath = join(descriptor.codex_home, 'auth.json');
      const body = readBoundedText(authPath, MAX_AUTH_BYTES);
      const auth = normalizeCodexAuthArtifact(body);
      if (!auth.ok) {
        reason = 'managed-domain-refresh-invalid';
      } else {
        const persist = deps.persistCustodyAuth || persistCustodyCodexAuth;
        const result = await persist({
          portal,
          secretId: descriptor.custody_secret_id,
          authBody: auth.body,
          deps: deps.custodyDeps || {},
        });
        persisted = result?.ok === true;
        if (!persisted) reason = result?.reason || 'managed-domain-refresh-not-persisted';
      }
    } catch {
      reason = 'managed-domain-close-failed';
    }
    if (persisted && transaction.value) {
      try {
        receipt('custody-persisted', {
          record_digest: sha256(JSON.stringify({
            coding_session_id: transaction.value.coding_session_id,
            runtime_generation: transaction.value.runtime_generation,
            custody_secret_id: descriptor.custody_secret_id,
          })),
        });
        durable = inspectManagedGenerationForClose({
          transaction: transaction.value,
          root,
          deps,
        });
      } catch {
        return {
          ok: false,
          persisted: true,
          quarantined: true,
          reason: 'managed-domain-custody-receipt-unconfirmed',
        };
      }
    }
  }
  if (!persisted) {
    return { ok: false, persisted: false, quarantined: true, reason };
  }
  let sessionState = null;
  if (!providerAbsent) {
    sessionState = persistManagedCodexSessionState({
      root,
      descriptor,
      providerArtifact,
    });
    if (!sessionState.ok) {
      return {
        ok: false,
        persisted: true,
        quarantined: true,
        reason: sessionState.reason,
      };
    }
    const durableArchive = durable?.receipts?.['archive-ready']?.data;
    if (durableArchive
      && (durableArchive.provider_session_id !== sessionState.state.provider_session_id
        || durableArchive.archive_digest !== sessionState.state.archive_digest)) {
      return {
        ok: false,
        persisted: true,
        quarantined: true,
        reason: 'managed-domain-archive-integrity-lost',
      };
    }
    if (transaction.value && !durableArchive) {
      try {
        receipt('archive-ready', {
          provider_session_id: sessionState.state.provider_session_id,
          archive_digest: sessionState.state.archive_digest,
        });
      } catch {
        return {
          ok: false,
          persisted: true,
          quarantined: true,
          reason: 'managed-domain-archive-receipt-unconfirmed',
        };
      }
    }
  }
  if (!removeDomainPaths({ domainPath, executorRoot }) || !removeDomainLease(leasePath)) {
    return {
      ok: false,
      persisted: true,
      quarantined: true,
      reason: 'managed-domain-cleanup-unconfirmed',
    };
  }
  if (transaction.value) {
    try {
      receipt('domain-cleaned', {
        domain_generation: descriptor.generation,
      });
      receipt('ready', {
        provider_session_id: sessionState?.state?.provider_session_id || null,
        archive_digest: sessionState?.state?.archive_digest || null,
      });
    } catch {
      return {
        ok: false,
        persisted: true,
        quarantined: false,
        reason: 'managed-domain-ready-receipt-unconfirmed',
      };
    }
  }
  return {
    ok: true,
    persisted: true,
    quarantined: false,
    reason,
    provider_session_state: sessionState?.state || null,
  };
}

/**
 * Reconstruct one quarantined descriptor from mc-owned private state.
 *
 * This recovery reader never executes the old provider hook or binary. It
 * accepts only the exact lease/manifest layout originally written by
 * prepareLocalCodexCredentialDomain, verifies the private domain and the
 * bound transcript artifact, and returns the descriptor solely so the trusted
 * close path can persist the fixed custody record and rollout before cleanup.
 */
export function inspectQuarantinedLocalCodexCredentialDomain({
  root = mcHome(),
  codingSessionId,
  providerArtifact,
} = {}) {
  const prepared = inspectPreparedLocalCodexCredentialDomain({
    root,
    codingSessionId,
  });
  if (!prepared.ok) return prepared;
  const artifact = managedSessionArtifact({
    descriptor: prepared.descriptor,
    providerArtifact,
  });
  if (!artifact.ok) return artifact;
  return {
    ok: true,
    descriptor: prepared.descriptor,
    relative_transcript_path: artifact.relativeTranscriptPath,
  };
}

/**
 * Recover the exact safe descriptor for a prepared or quarantined generation
 * without requiring provider-exit evidence. Callers may use it only for
 * journal-directed abort or finalization; it grants no launch authority.
 */
export function inspectPreparedLocalCodexCredentialDomain({
  root = mcHome(),
  codingSessionId,
} = {}) {
  if (!isAbsolute(root || '') || typeof codingSessionId !== 'string' || !codingSessionId) {
    return safeSessionStateFailure('managed-recovery-request-invalid');
  }
  const sessionPart = sessionDirectoryPart(codingSessionId);
  const leasePath = join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`);
  const lease = readPrivateJsonFile(leasePath, 2048);
  if (!lease.ok
    || !hasExactObjectKeys(lease.value, [
      'schema',
      'provider_adapter',
      'session_id',
      'generation',
      'owner_pid',
    ])
    || lease.value.schema !== 1
    || lease.value.provider_adapter !== MANAGED_CODEX_PROVIDER_ID
    || lease.value.session_id !== codingSessionId
    || !isUuidV4(lease.value.generation)) {
    return safeSessionStateFailure('managed-recovery-lease-invalid');
  }

  const domainPath = join(
    root,
    'credential-domains',
    'codex',
    sessionPart,
    lease.value.generation,
  );
  const manifestPath = join(domainPath, 'manifest.json');
  const manifest = readPrivateJsonFile(manifestPath, 64 * 1024);
  if (!manifest.ok
    || !hasExactObjectKeys(manifest.value, MANAGED_DOMAIN_MANIFEST_KEYS)
    || manifest.value.schema !== MANAGED_CODEX_DOMAIN_SCHEMA
    || manifest.value.provider_adapter !== MANAGED_CODEX_PROVIDER_ID
    || manifest.value.state !== 'ready'
    || manifest.value.session_id !== codingSessionId
    || manifest.value.generation !== lease.value.generation) {
    return safeSessionStateFailure('managed-recovery-manifest-invalid');
  }

  const descriptor = {
    ...manifest.value,
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifest.body),
  };
  const ownedPaths = resolveOwnedDomainPaths(descriptor);
  if (!ownedPaths || ownedPaths.root !== resolve(root)) {
    return safeSessionStateFailure('managed-recovery-domain-invalid');
  }

  const privateDirectories = [
    descriptor.domain_path,
    descriptor.codex_home,
    descriptor.provider_home,
    descriptor.provider_tmp,
    descriptor.executor_root,
    descriptor.executor_home,
    descriptor.executor_tmp,
  ];
  const privateFiles = [
    descriptor.lease_path,
    descriptor.manifest_path,
    join(descriptor.codex_home, 'auth.json'),
    descriptor.provider_config_path,
    descriptor.provider_hook_path,
  ];
  if (privateDirectories.some((path) => !isPrivateOwnedPath(path, { directory: true }))
    || privateFiles.some((path) => !isPrivateOwnedPath(path, { directory: false }))) {
    return safeSessionStateFailure('managed-recovery-domain-unsafe');
  }
  try {
    const resolvedRoot = resolve(root);
    const canonicalRoot = realpathSync(resolvedRoot);
    const canonicalPath = (path) => join(
      canonicalRoot,
      relative(resolvedRoot, resolve(path)),
    );
    const legacyMutableConfigPath = join(descriptor.codex_home, 'config.toml');
    const managedProfilePath = join(
      descriptor.codex_home,
      `${MANAGED_CODEX_PROFILE}.config.toml`,
    );
    if (descriptor.provider_config_path !== legacyMutableConfigPath
      && descriptor.provider_config_path !== managedProfilePath) {
      return safeSessionStateFailure('managed-recovery-domain-invalid');
    }
    if (privateDirectories.some((path) => realpathSync(path) !== canonicalPath(path))
      || privateFiles.some((path) => realpathSync(path) !== canonicalPath(path))
      // Older domains put the boundary in config.toml. Codex legitimately
      // appends native project trust to that file while running, so its launch
      // hash is not stable enough to block an exit-confirmed cleanup. Current
      // domains keep the boundary in a separate immutable managed profile.
      || (descriptor.provider_config_path === managedProfilePath
        && sha256(readFileSync(descriptor.provider_config_path))
          !== descriptor.provider_config_sha256)
      || sha256(readFileSync(descriptor.provider_hook_path))
        !== descriptor.provider_hook_sha256) {
      return safeSessionStateFailure('managed-recovery-domain-mismatch');
    }
  } catch {
    return safeSessionStateFailure('managed-recovery-domain-unavailable');
  }

  return {
    ok: true,
    descriptor,
  };
}

export function inspectLocalCodexCredentialDomainPresence({
  root = mcHome(),
  codingSessionId,
} = {}) {
  if (!isAbsolute(root || '') || typeof codingSessionId !== 'string' || !codingSessionId) {
    return { kind: 'unknown', reason: 'managed-recovery-request-invalid' };
  }
  const sessionPart = sessionDirectoryPart(codingSessionId);
  const leasePath = join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`);
  if (existsSync(leasePath)) {
    const prepared = inspectPreparedLocalCodexCredentialDomain({ root, codingSessionId });
    return prepared.ok
      ? { kind: 'present', descriptor: prepared.descriptor }
      : { kind: 'unknown', reason: prepared.reason };
  }
  const sessionRoots = [
    join(root, 'credential-domains', 'codex', sessionPart),
    join(root, 'executor-domains', 'codex', sessionPart),
  ];
  try {
    const hasGeneration = sessionRoots.some((path) => (
      existsSync(path) && readdirSync(path).length > 0
    ));
    return hasGeneration
      ? { kind: 'unknown', reason: 'managed-domain-generation-without-lease' }
      : { kind: 'absent' };
  } catch {
    return { kind: 'unknown', reason: 'managed-domain-presence-unreadable' };
  }
}

export function persistManagedCodexSessionState({
  root = mcHome(),
  descriptor,
  providerArtifact,
} = {}) {
  const checked = managedSessionArtifact({ descriptor, providerArtifact });
  if (!checked.ok) return checked;
  if (!isUuidV4(providerArtifact.runtime_generation)) {
    return safeSessionStateFailure('managed-portable-session-state-invalid');
  }
  const stateRoot = managedSessionStateRoot(root, descriptor.session_id);
  const archiveRoot = join(
    stateRoot,
    'generations',
    providerArtifact.runtime_generation,
  );
  const transcriptPath = join(archiveRoot, checked.relativeTranscriptPath);
  const manifestPath = join(archiveRoot, 'manifest.json');
  const projectionPath = join(stateRoot, 'current.json');
  const temporaryTranscript = `${transcriptPath}.${randomUUID()}.tmp`;
  const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
  const temporaryProjection = `${projectionPath}.${randomUUID()}.tmp`;
  try {
    ensurePrivateDirectoryChain(root, dirname(transcriptPath));
    const existingManifest = readPrivateJsonFile(manifestPath, 4096);
    if (existingManifest.ok) {
      const manifest = existingManifest.value;
      if (!validManagedGenerationArchiveManifest(manifest)
        || manifest.coding_session_id !== descriptor.session_id
        || manifest.runtime_generation !== providerArtifact.runtime_generation
        || manifest.provider_session_id !== providerArtifact.provider_session_id
        || manifest.relative_transcript_path !== checked.relativeTranscriptPath
        || !isPrivateOwnedPath(transcriptPath, { directory: false })
        || sha256FileSync(transcriptPath) !== manifest.transcript_sha256) {
        return safeSessionStateFailure('managed-portable-session-state-conflict');
      }
      return publishManagedSessionProjection({
        root,
        stateRoot,
        manifest,
        manifestPath,
        projectionPath,
        temporaryProjection,
      });
    }
    if (existsSync(manifestPath)) {
      return safeSessionStateFailure('managed-portable-session-state-conflict');
    }
    const source = lstatSync(providerArtifact.transcript_path);
    const realSourcePath = realpathSync(providerArtifact.transcript_path);
    const realCodexHome = realpathSync(descriptor.codex_home);
    if (!source.isFile() || source.isSymbolicLink()
      || !isPathInside(realCodexHome, realSourcePath)) {
      return safeSessionStateFailure('managed-portable-session-state-invalid');
    }
    const transcriptSha256 = sha256FileSync(providerArtifact.transcript_path);
    const manifest = {
      schema: MANAGED_GENERATION_ARCHIVE_SCHEMA,
      coding_session_id: descriptor.session_id,
      runtime_generation: providerArtifact.runtime_generation,
      provider_session_id: providerArtifact.provider_session_id,
      relative_transcript_path: checked.relativeTranscriptPath,
      transcript_sha256: transcriptSha256,
    };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    if (existsSync(transcriptPath)) {
      if (!isPrivateOwnedPath(transcriptPath, { directory: false })
        || sha256FileSync(transcriptPath) !== transcriptSha256) {
        return safeSessionStateFailure('managed-portable-session-state-conflict');
      }
    } else {
      copyFileSync(
        providerArtifact.transcript_path,
        temporaryTranscript,
        constants.COPYFILE_EXCL,
      );
      chmodSync(temporaryTranscript, 0o600);
      fsyncFileSync(temporaryTranscript);
      try {
        linkSync(temporaryTranscript, transcriptPath);
      } catch (error) {
        if (error?.code !== 'EEXIST'
          || !isPrivateOwnedPath(transcriptPath, { directory: false })
          || sha256FileSync(transcriptPath) !== transcriptSha256) throw error;
      }
      unlinkSync(temporaryTranscript);
      fsyncDirectorySync(dirname(transcriptPath));
    }
    writeFileSync(temporaryManifest, manifestBody, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fsyncFileSync(temporaryManifest);
    try {
      linkSync(temporaryManifest, manifestPath);
    } catch (error) {
      const raced = readPrivateJsonFile(manifestPath, 4096);
      if (error?.code !== 'EEXIST'
        || !raced.ok
        || JSON.stringify(raced.value) !== JSON.stringify(manifest)) throw error;
    }
    unlinkSync(temporaryManifest);
    fsyncDirectorySync(dirname(manifestPath));

    return publishManagedSessionProjection({
      root,
      stateRoot,
      manifest,
      manifestPath,
      projectionPath,
      temporaryProjection,
    });
  } catch (error) {
    try { rmSync(temporaryTranscript, { force: true }); } catch {}
    try { rmSync(temporaryManifest, { force: true }); } catch {}
    try { rmSync(temporaryProjection, { force: true }); } catch {}
    return safeSessionStateFailure(
      safeManagedSessionStateReason(error)
        || 'managed-portable-session-state-persist-failed',
    );
  }
}

function publishManagedSessionProjection({
  root,
  stateRoot,
  manifest,
  manifestPath,
  projectionPath,
  temporaryProjection,
}) {
  const archiveDigest = sha256(`${JSON.stringify(manifest)}\n`);
  const projection = {
    schema: MANAGED_SESSION_PROJECTION_SCHEMA,
    coding_session_id: manifest.coding_session_id,
    runtime_generation: manifest.runtime_generation,
    provider_session_id: manifest.provider_session_id,
    relative_manifest_path: relative(stateRoot, manifestPath),
    archive_digest: archiveDigest,
  };
  ensurePrivateDirectoryChain(root, dirname(projectionPath));
  writeFileSync(temporaryProjection, `${JSON.stringify(projection)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fsyncFileSync(temporaryProjection);
  renameSync(temporaryProjection, projectionPath);
  fsyncDirectorySync(dirname(projectionPath));
  return {
    ok: true,
    state: {
      provider_session_id: manifest.provider_session_id,
      transcript_path: join(dirname(manifestPath), manifest.relative_transcript_path),
      runtime_generation: manifest.runtime_generation,
      archive_digest: archiveDigest,
    },
  };
}

function safeManagedSessionStateReason(error) {
  return typeof error?.reason === 'string'
    && /^managed-[a-z0-9-]{1,96}$/u.test(error.reason)
    ? error.reason
    : null;
}

export function restoreManagedCodexSessionState({
  root = mcHome(),
  codingSessionId,
  providerSessionId = null,
  codexHome,
} = {}) {
  if (providerSessionId == null) return { ok: true, restored: false };
  if (!boundedProviderId(providerSessionId) || !isAbsolute(codexHome || '')) {
    return safeSessionStateFailure('managed-portable-session-state-invalid');
  }
  const stateRoot = managedSessionStateRoot(root, codingSessionId);
  const projection = readPrivateJsonFile(join(stateRoot, 'current.json'), 4096);
  let manifestPath = projection.ok && validManagedSessionProjection(projection.value)
    ? join(stateRoot, projection.value.relative_manifest_path)
    : join(stateRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // No managed transcript for this conversation. Before giving up: a
    // session that ran before managed execution wrote its rollout into the
    // user's own Codex home and nowhere else, so the history is on the disk,
    // just not anywhere mc controls. Adopting it is what makes those sessions
    // resumable instead of quietly starting over.
    const adopted = adoptNativeCodexTranscriptSync({
      stateRoot,
      codingSessionId,
      providerSessionId,
    });
    if (!adopted.ok) return safeSessionStateFailure('managed-portable-session-manifest-missing');
    try {
      manifest = JSON.parse(readFileSync(adopted.manifestPath, 'utf8'));
    } catch {
      return safeSessionStateFailure('managed-portable-session-manifest-missing');
    }
    manifestPath = adopted.manifestPath;
  }
  const currentArchive = validManagedGenerationArchiveManifest(manifest);
  const legacyArchive = validManagedSessionManifest(manifest);
  if ((!currentArchive && !legacyArchive)
    || manifest.coding_session_id !== codingSessionId
    || manifest.provider_session_id !== providerSessionId
    || (projection.ok && (
      !validManagedSessionProjection(projection.value)
      || projection.value.coding_session_id !== codingSessionId
      || projection.value.provider_session_id !== providerSessionId
      || projection.value.archive_digest !== sha256(`${JSON.stringify(manifest)}\n`)
    ))) {
    return safeSessionStateFailure('managed-portable-session-state-mismatch');
  }
  const sourcePath = currentArchive
    ? join(dirname(manifestPath), manifest.relative_transcript_path)
    : join(stateRoot, manifest.relative_transcript_path);
  const targetPath = join(codexHome, manifest.relative_transcript_path);
  let source;
  let realStateRoot;
  let realSourcePath;
  let sourceDigest = null;
  try {
    source = lstatSync(sourcePath);
    realStateRoot = realpathSync(stateRoot);
    realSourcePath = realpathSync(sourcePath);
    if (currentArchive) sourceDigest = sha256FileSync(sourcePath);
  } catch {
    return safeSessionStateFailure('managed-portable-session-source-missing');
  }
  if (!isPathInside(stateRoot, sourcePath)
    || !isPathInside(codexHome, targetPath)
    || !isPathInside(realStateRoot, realSourcePath)
    || !source.isFile()
    || source.isSymbolicLink()
    || (source.mode & 0o077) !== 0
    || (currentArchive && sourceDigest !== manifest.transcript_sha256)) {
    return safeSessionStateFailure('managed-portable-session-state-invalid');
  }
  try {
    ensurePrivateDirectoryChain(root, dirname(targetPath));
  } catch {
    return safeSessionStateFailure('managed-portable-session-target-unsafe');
  }
  try {
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o600);
    return { ok: true, restored: true, transcript_path: targetPath };
  } catch {
    return safeSessionStateFailure('managed-portable-session-copy-failed');
  }
}

export function inspectLocalCodexProviderAbsence({
  root = mcHome(),
  descriptor,
  generation,
} = {}) {
  const owned = resolveOwnedDomainPaths(descriptor);
  const intent = generation?.intent?.data;
  if (!owned
    || owned.root !== resolve(root)
    || !intent
    || intent.tool !== 'codex'
    || !['fresh', 'resume'].includes(intent.mode)) {
    return safeSessionStateFailure('managed-provider-absence-input-invalid');
  }
  const scanned = scanCodexTranscriptTrees(descriptor.codex_home);
  if (!scanned.ok) return scanned;
  if (intent.mode === 'fresh') {
    if (scanned.files.length !== 0) {
      return safeSessionStateFailure('managed-provider-absence-artifact-present');
    }
    return {
      ok: true,
      evidence_digest: sha256(JSON.stringify({
        tool: 'codex',
        coding_session_id: descriptor.session_id,
        mode: 'fresh',
        provider_session_id: null,
        transcript_tree: 'empty',
      })),
    };
  }

  const providerSessionId = intent.resume_provider_session_id;
  if (!boundedProviderId(providerSessionId)) {
    return safeSessionStateFailure('managed-provider-absence-resume-invalid');
  }
  const stateRoot = managedSessionStateRoot(root, descriptor.session_id);
  const projection = readPrivateJsonFile(join(stateRoot, 'current.json'), 4096);
  if (!projection.ok
    || !validManagedSessionProjection(projection.value)
    || projection.value.coding_session_id !== descriptor.session_id
    || projection.value.provider_session_id !== providerSessionId) {
    return safeSessionStateFailure('managed-provider-absence-archive-missing');
  }
  const manifestPath = join(stateRoot, projection.value.relative_manifest_path);
  const manifest = readPrivateJsonFile(manifestPath, 4096);
  if (!manifest.ok
    || !validManagedGenerationArchiveManifest(manifest.value)
    || manifest.value.coding_session_id !== descriptor.session_id
    || manifest.value.provider_session_id !== providerSessionId
    || manifest.value.runtime_generation !== projection.value.runtime_generation
    || sha256(manifest.body) !== projection.value.archive_digest) {
    return safeSessionStateFailure('managed-provider-absence-archive-mismatch');
  }
  const archivedPath = join(dirname(manifestPath), manifest.value.relative_transcript_path);
  const restoredPath = join(descriptor.codex_home, manifest.value.relative_transcript_path);
  try {
    const canonicalRestored = realpathSync(restoredPath);
    if (scanned.files.length !== 1
      || scanned.files[0] !== canonicalRestored
      || !isPrivateOwnedPath(archivedPath, { directory: false })
      || !isPrivateOwnedPath(restoredPath, { directory: false })
      || sha256FileSync(archivedPath) !== manifest.value.transcript_sha256
      || sha256FileSync(restoredPath) !== manifest.value.transcript_sha256) {
      return safeSessionStateFailure('managed-provider-absence-restored-state-changed');
    }
  } catch {
    return safeSessionStateFailure('managed-provider-absence-restored-state-changed');
  }
  return {
    ok: true,
    evidence_digest: sha256(JSON.stringify({
      tool: 'codex',
      coding_session_id: descriptor.session_id,
      mode: 'resume',
      provider_session_id: providerSessionId,
      archive_digest: projection.value.archive_digest,
      transcript_sha256: manifest.value.transcript_sha256,
    })),
  };
}

/**
 * Prove that a pre-journal resume domain contains only the exact transcript
 * restored from the legacy managed archive. This is recovery-only evidence:
 * it does not grant launch authority or claim that the stale runtime produced
 * a provider artifact.
 */
export function inspectLegacyLocalCodexResumeAbsence({
  root = mcHome(),
  descriptor,
  providerSessionId,
} = {}) {
  const owned = resolveOwnedDomainPaths(descriptor);
  if (!owned
    || owned.root !== resolve(root)
    || !boundedProviderId(providerSessionId)) {
    return safeSessionStateFailure('managed-legacy-absence-input-invalid');
  }
  const stateRoot = managedSessionStateRoot(root, descriptor.session_id);
  const manifest = readPrivateJsonFile(join(stateRoot, 'manifest.json'), 4096);
  if (!manifest.ok
    || !validManagedSessionManifest(manifest.value)
    || manifest.value.coding_session_id !== descriptor.session_id
    || manifest.value.provider_session_id !== providerSessionId) {
    return safeSessionStateFailure('managed-legacy-absence-archive-missing');
  }
  const archivedPath = join(stateRoot, manifest.value.relative_transcript_path);
  const restoredPath = join(descriptor.codex_home, manifest.value.relative_transcript_path);
  const scanned = scanCodexTranscriptTrees(descriptor.codex_home);
  if (!scanned.ok) return scanned;
  try {
    const canonicalStateRoot = realpathSync(stateRoot);
    const canonicalCodexHome = realpathSync(descriptor.codex_home);
    const canonicalArchived = realpathSync(archivedPath);
    const canonicalRestored = realpathSync(restoredPath);
    const transcriptSha256 = sha256FileSync(archivedPath);
    if (scanned.files.length !== 1
      || scanned.files[0] !== canonicalRestored
      || !isPathInside(canonicalStateRoot, canonicalArchived)
      || !isPathInside(canonicalCodexHome, canonicalRestored)
      || !isPrivateOwnedPath(archivedPath, { directory: false })
      || !isPrivateOwnedPath(restoredPath, { directory: false })
      || sha256FileSync(restoredPath) !== transcriptSha256) {
      return safeSessionStateFailure('managed-legacy-absence-restored-state-changed');
    }
    return {
      ok: true,
      transcript_path: restoredPath,
      evidence_digest: sha256(JSON.stringify({
        tool: 'codex',
        coding_session_id: descriptor.session_id,
        mode: 'legacy-resume',
        provider_session_id: providerSessionId,
        transcript_sha256: transcriptSha256,
      })),
    };
  } catch {
    return safeSessionStateFailure('managed-legacy-absence-restored-state-changed');
  }
}

export function abortLocalCodexCredentialDomain({ descriptor } = {}) {
  const ownedPaths = resolveOwnedDomainPaths(descriptor);
  if (!ownedPaths) {
    return { ok: false, reason: 'managed-domain-descriptor-invalid' };
  }
  if (!removeDomainPaths(ownedPaths) || !removeDomainLease(ownedPaths.leasePath)) {
    return {
      ok: false,
      quarantined: true,
      reason: 'managed-domain-cleanup-unconfirmed',
    };
  }
  return { ok: true, quarantined: false, reason: 'managed-domain-aborted' };
}

export function confirmLocalCodexCredentialDomainAbsent({
  root = mcHome(),
  codingSessionId,
  domainGeneration,
} = {}) {
  if (!isAbsolute(root || '')
    || typeof codingSessionId !== 'string'
    || !codingSessionId
    || !isUuidV4(domainGeneration)) {
    return safeSessionStateFailure('managed-domain-cleanup-identity-invalid');
  }
  const sessionPart = sessionDirectoryPart(codingSessionId);
  const paths = [
    join(root, 'credential-domains', 'codex', sessionPart, domainGeneration),
    join(root, 'executor-domains', 'codex', sessionPart, domainGeneration),
    join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`),
  ];
  try {
    return paths.every((path) => pathEntryAbsent(path))
      ? { ok: true, absent: true }
      : safeSessionStateFailure('managed-domain-cleanup-descriptor-required');
  } catch {
    return safeSessionStateFailure('managed-domain-cleanup-presence-unreadable');
  }
}

export async function loadCustodyCodexAuth({
  portal,
  deps = {},
} = {}) {
  if (!portal?.apiUrl || !portal?.token) return safeFailure('managed-portable-memoro-auth-missing');
  const cache = await (deps.readCachedVaultKey || readCachedVaultKey)({
    deps: deps.cacheDeps || {},
  }).catch(() => null);
  if (!cache?.vaultKey) return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);

  const api = deps.api || VaultApi;
  const status = await api.getStatus(portal).catch(() => null);
  if (!status?.ok || !status?.vault?.setup) return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  if (cache.authHash) {
    const unlock = await api.unlockVault(portal, {
      authHash: cache.authHash,
      deviceId: cache.deviceId || null,
    }).catch(() => null);
    if (!unlock?.ok) return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  if (!status.vault.wrapped_crk || !status.vault.crk_iv) {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }

  let crk;
  try {
    crk = await unwrapCustodyRoot(
      cache.vaultKey,
      status.vault.wrapped_crk,
      status.vault.crk_iv,
    );
  } catch {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }

  const listed = await api.listSecrets(portal).catch(() => null);
  if (!listed?.ok || !Array.isArray(listed.secrets)) {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  for (const wire of listed.secrets) {
    if (!isEnvelopeSecret(wire) || wire.class !== 'tool-auth') continue;
    try {
      const opened = await decryptEnvelopeSecret(crk, wire);
      if (opened.label !== TOOL_AUTH_LABEL && opened.label !== LEGACY_TOOL_AUTH_LABEL) continue;
      const body = extractCodexAuthBody(opened.data);
      if (!body) continue;
      return {
        ok: true,
        secretId: wire.id,
        authBody: body,
      };
    } catch {
      // A malformed or foreign record is never reflected to the caller.
    }
  }
  return safeFailure(LOCAL_CODEX_AUTH_MISSING);
}

/**
 * Prove that the exact Codex custody record is present without returning its
 * provider credential to readiness callers.
 */
export async function inspectCustodyCodexAuth(options = {}) {
  const loaded = await loadCustodyCodexAuth(options);
  return loaded?.ok
    ? { ok: true, secretId: loaded.secretId }
    : loaded;
}

export async function persistCustodyCodexAuth({
  portal,
  secretId,
  authBody,
  deps = {},
} = {}) {
  const effectivePortal = portal?.token && portal?.apiUrl
    ? portal
    : await resolveTrustedVaultPortal({ deps }).catch(() => null);
  if (!secretId || !effectivePortal?.token || !effectivePortal?.apiUrl) {
    return safeFailure('managed-domain-refresh-context-missing');
  }
  const cache = await (deps.readCachedVaultKey || readCachedVaultKey)({
    deps: deps.cacheDeps || {},
  }).catch(() => null);
  if (!cache?.vaultKey) return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  const api = deps.api || VaultApi;
  const status = await api.getStatus(effectivePortal).catch(() => null);
  if (!status?.vault?.wrapped_crk || !status?.vault?.crk_iv) {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  if (cache.authHash) {
    const unlock = await api.unlockVault(effectivePortal, {
      authHash: cache.authHash,
      deviceId: cache.deviceId || null,
    }).catch(() => null);
    if (!unlock?.ok) return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  let crk;
  try {
    crk = await unwrapCustodyRoot(cache.vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
  } catch {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  const listed = await api.listSecrets(effectivePortal).catch(() => null);
  if (!listed?.ok || !Array.isArray(listed.secrets)) {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  const wire = listed?.secrets?.find((entry) => entry?.id === secretId);
  if (!wire || !isEnvelopeSecret(wire) || wire.class !== 'tool-auth') {
    return safeFailure('managed-domain-custody-record-mismatch');
  }
  let opened;
  try {
    opened = await decryptEnvelopeSecret(crk, wire);
  } catch {
    return safeFailure('managed-domain-custody-record-mismatch');
  }
  if (opened.label !== TOOL_AUTH_LABEL && opened.label !== LEGACY_TOOL_AUTH_LABEL) {
    return safeFailure('managed-domain-custody-record-mismatch');
  }
  const nextData = updateCodexAuthPayload(opened.data, authBody);
  if (!nextData) return safeFailure('managed-domain-refresh-invalid');
  const encrypted = await encryptForWrite({
    vaultKey: cache.vaultKey,
    crk,
    label: opened.label,
    data: nextData,
    secretClass: 'tool-auth',
  });
  const updated = await api.updateSecret(effectivePortal, secretId, {
    secretType: WIRE_SECRET_TYPE,
    ...encrypted,
  }).catch(() => null);
  return updated?.ok
    ? { ok: true, persisted: true }
    : safeFailure('managed-domain-refresh-not-persisted');
}

export function inspectCodexRelease({
  launcherPath,
  deps = {},
} = {}) {
  const platformName = (deps.platform || platform)();
  const architecture = (deps.arch || arch)();
  if (platformName !== 'darwin') {
    return safeFailure('managed-portable-platform-unsupported');
  }
  const resolved = resolveCodexNativeBinary({
    launcherPath,
    platformName,
    architecture,
    deps,
  });
  if (!resolved) return safeFailure(LOCAL_CODEX_RELEASE_UNTRUSTED);
  const spawnCommand = deps.spawnSync || spawnSync;
  const details = spawnCommand('codesign', ['-dv', '--verbose=4', resolved], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const signing = `${details.stdout || ''}\n${details.stderr || ''}`;
  const teamId = signing.match(/\bTeamIdentifier=([A-Z0-9]+)\b/)?.[1] || null;
  const identifier = signing.match(/\bIdentifier=([^\s]+)\b/)?.[1] || null;
  if (details.status !== 0 || teamId !== MANAGED_CODEX_TEAM_ID || identifier !== 'codex') {
    return safeFailure(LOCAL_CODEX_RELEASE_UNTRUSTED);
  }
  const versionProbe = spawnCommand(resolved, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/var/empty',
    },
  });
  const version = String(versionProbe.stdout || '').match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
  if (versionProbe.status !== 0 || version !== MANAGED_CODEX_VERSION) {
    return safeFailure('managed-portable-codex-version-unsupported');
  }
  let digest;
  try {
    digest = sha256(readFileSync(resolved));
  } catch {
    return safeFailure(LOCAL_CODEX_RELEASE_UNTRUSTED);
  }
  const pinnedDigest = (deps.releaseDigests || MANAGED_CODEX_RELEASE_SHA256)[
    `${platformName}-${architecture}`
  ];
  if (!pinnedDigest || digest !== pinnedDigest) {
    return safeFailure(LOCAL_CODEX_RELEASE_UNTRUSTED);
  }
  return {
    ok: true,
    nativeBinary: resolved,
    version,
    teamId,
    sha256: digest,
  };
}

export function resolveCodexNativeBinary({
  launcherPath,
  platformName = platform(),
  architecture = arch(),
  deps = {},
} = {}) {
  if (!launcherPath) return null;
  const realpath = deps.realpathSync || realpathSync;
  const exists = deps.existsSync || existsSync;
  let launcher;
  try {
    launcher = realpath(launcherPath);
  } catch {
    return null;
  }

  const triple = codexTargetTriple(platformName, architecture);
  if (!triple) return null;
  const folder = codexPlatformPackageFolder(platformName, architecture);
  const packageRoot = launcher.endsWith(join('bin', 'codex.js'))
    ? dirname(dirname(launcher))
    : null;
  const candidates = [
    packageRoot
      ? join(packageRoot, 'node_modules', '@openai', folder, 'vendor', triple, 'bin', 'codex')
      : null,
    packageRoot
      ? join(packageRoot, 'vendor', triple, 'bin', 'codex')
      : null,
    packageRoot ? null : launcher,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (exists(candidate) && statSync(candidate).isFile()) return realpath(candidate);
    } catch {}
  }
  return null;
}

export function renderManagedCodexConfig({
  domainPath,
  executorRoot,
  workspaceRoot,
  executorHome,
  executorTmp,
  safePath,
  npmCachePath = null,
  forbiddenPaths = [],
  runtimeReadPaths = [],
  deniedUnixSocketPaths = [],
  allowedUnixSocketPaths = [],
} = {}) {
  const denied = new Set([domainPath, ...forbiddenPaths].filter(Boolean).map((path) => resolve(path)));
  const filesystemRules = [
    '":root" = "write"',
    '":tmpdir" = "write"',
    '":slash_tmp" = "write"',
    `"${tomlString(domainPath)}" = "deny"`,
    ...forbiddenPaths
      .filter((path) => path && path !== domainPath)
      .map((path) => `"${tomlString(path)}" = "deny"`),
    ...runtimeReadPaths
      .filter((path) => path && !denied.has(resolve(path)))
      .map((path) => `"${tomlString(path)}" = "read"`),
  ];
  const workspaceRoots = [...new Set(['/', executorRoot, workspaceRoot].filter(Boolean))]
    .map((path) => `"${tomlString(path)}" = true`);
  // A fresh isolated CODEX_HOME has no saved project decision. Marking the
  // workspace untrusted is conservative and prevents Codex from showing an
  // interactive trust prompt that broker-delivered startup text could answer.
  const projectTrust = workspaceRoot
    ? [
        '[projects]',
        `[projects."${tomlString(workspaceRoot)}"]`,
        'trust_level = "untrusted"',
        '',
      ]
    : [];
  return [
    `default_permissions = "${MANAGED_CODEX_PROFILE}"`,
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    ...projectTrust,
    '[history]',
    'persistence = "save-all"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[features]',
    'network_proxy = true',
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    'ignore_default_excludes = false',
    'exclude = [',
    ...MANAGED_SHELL_SECRET_ENV_NAMES.map((name) => `  "${tomlString(name)}",`),
    ']',
    '',
    '[shell_environment_policy.set]',
    `HOME = "${tomlString(executorHome)}"`,
    `TMPDIR = "${tomlString(executorTmp)}"`,
    `PATH = "${tomlString(safePath)}"`,
    ...(npmCachePath
      ? [`NPM_CONFIG_CACHE = "${tomlString(npmCachePath)}"`]
      : []),
    'LANG = "C.UTF-8"',
    'TERM = "xterm-256color"',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}]`,
    'description = "Memoro managed portable executor boundary"',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.workspace_roots]`,
    ...workspaceRoots,
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.filesystem]`,
    ...filesystemRules,
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.network]`,
    'enabled = true',
    'allow_local_binding = true',
    'dangerously_allow_all_unix_sockets = false',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.network.domains]`,
    '"*" = "allow"',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.network.unix_sockets]`,
    ...deniedUnixSocketPaths.map((path) => `"${tomlString(path)}" = "deny"`),
    ...allowedUnixSocketPaths.map((path) => `"${tomlString(path)}" = "allow"`),
    '',
  ].join('\n');
}

export function compileManagedBoundaryProbe({
  outputPath,
  sourcePath = BOUNDARY_CHILD_SOURCE,
  deps = {},
} = {}) {
  const run = deps.spawnSync || spawnSync;
  if (!outputPath || !isAbsolute(outputPath)) {
    return safeFailure('managed-portable-boundary-compiler-invalid');
  }
  try {
    if (sha256(readFileSync(sourcePath)) !== BOUNDARY_CHILD_SOURCE_SHA256) {
      return safeFailure('managed-portable-boundary-source-untrusted');
    }
  } catch {
    return safeFailure('managed-portable-boundary-source-untrusted');
  }
  const result = run('/usr/bin/clang', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    sourcePath,
    '-o',
    outputPath,
  ], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.status !== 0 || !existsSync(outputPath)) {
    return safeFailure('managed-portable-boundary-compiler-unavailable');
  }
  chmodSync(outputPath, 0o500);
  return { ok: true, outputPath };
}

export async function verifyManagedCodexBoundary({
  cwd,
  codexHome,
  credentialDomainPath,
  executorRoot,
  nativeBinary,
  probeDir,
  socketPath = managedBoundarySocketPath(),
  vaultTarget = null,
  env = process.env,
  deps = {},
} = {}) {
  const canary = `mc_canary_${randomBytes(24).toString('hex')}`;
  const canaryPath = join(credentialDomainPath, 'boundary-canary');
  const childPath = join(probeDir, 'credential-boundary-child');
  const createServerImpl = deps.createServer || createServer;
  const run = deps.runCommand || runCommand;
  const resolvedVaultTarget = vaultTarget
    || (deps.resolveVaultProbeTarget || resolveVaultProbeTarget)();
  let server = null;
  try {
    if (!resolvedVaultTarget) return boundaryFailure('vault-probe-target-unavailable');
    const compile = deps.compileBoundaryProbe || compileManagedBoundaryProbe;
    const compiled = compile({
      outputPath: childPath,
      deps: deps.compilerDeps || {},
    });
    if (!compiled?.ok) return boundaryFailure('boundary-probe-compile-failed');
    writeFileSync(canaryPath, canary, { mode: 0o600, flag: 'wx' });
    server = createServerImpl((socket) => socket.destroy());
    await listenServer(server, socketPath);
    const probeArgs = [
      canaryPath,
      socketPath,
      resolvedVaultTarget.binPath,
      resolvedVaultTarget.nodePath,
      resolvedVaultTarget.entryPath,
    ];
    const probeEnv = {
      PATH: managedSafePath({ executorBin: join(executorRoot, 'bin'), env }),
      HOME: dirname(codexHome),
      CODEX_HOME: codexHome,
      TMPDIR: join(credentialDomainPath, 'tmp'),
      LANG: env.LANG || 'C',
      TERM: 'xterm-256color',
      MC_HOME: credentialDomainPath,
      [BOUNDARY_CANARY_ENV_NAME]: canary,
    };
    const negative = await run(childPath, probeArgs, probeEnv, {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    });
    const negativeReport = parseBoundaryReport(negative);
    if (!negativeReport?.file_readable
      || !negativeReport.canary_in_environment
      || !negativeReport.detached_boundary_reachable
      || !negativeReport.vault_admin_via_bin_callable
      || !negativeReport.vault_admin_via_node_callable
      || negative.output.includes(canary)) {
      return boundaryFailure('boundary-negative-control-failed');
    }
    const result = await run(nativeBinary, [
      '--profile',
      MANAGED_CODEX_PROFILE,
      'sandbox',
      '--include-managed-config',
      '--permission-profile',
      MANAGED_CODEX_PROFILE,
      '--cd',
      cwd,
      childPath,
      ...probeArgs,
    ], probeEnv, {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    });
    if (!result.ok || result.output.includes(canary)) {
      return boundaryFailure('boundary-sandbox-execution-failed');
    }
    const report = parseBoundaryReport(result);
    if (!report) return boundaryFailure('boundary-report-invalid');
    const expected = {
      file_readable: false,
      canary_in_environment: false,
      canary_in_argv: false,
      parent_process_exposes_canary: false,
      detached_boundary_reachable: false,
      credential_socket_reachable: false,
      external_network_reachable: true,
      workspace_write_blocked: false,
      vault_admin_via_bin_callable: false,
      vault_admin_via_node_callable: false,
    };
    const violations = Object.entries(expected)
      .filter(([key, value]) => report[key] !== value)
      .map(([key]) => key);
    if (violations.length) {
      return boundaryFailure(`boundary-violation-${violations[0]}`);
    }
    return {
      ok: true,
      code: 'managed-portable-boundary-verified',
    };
  } catch {
    return boundaryFailure('boundary-probe-error');
  } finally {
    await closeServer(server);
    try { rmSync(socketPath, { force: true }); } catch {}
    try { rmSync(canaryPath, { force: true }); } catch {}
    try { rmSync(childPath, { force: true }); } catch {}
  }
}

export function managedBoundarySocketPath({
  nonce = randomBytes(12).toString('hex'),
} = {}) {
  return join('/tmp', `mccb-${nonce}.sock`);
}

export function managedGitHubSocketPath({
  root = mcHome(),
  codingSessionId,
} = {}) {
  if (!SESSION_OWNER_ID_RE.test(codingSessionId || '')) {
    throw new TypeError('valid codingSessionId is required');
  }
  return join(root, `${codingSessionId}.sock`);
}

function boundaryFailure(diagnosticCode) {
  return {
    ...safeFailure(LOCAL_CODEX_BOUNDARY_UNAVAILABLE),
    diagnostic_code: diagnosticCode,
  };
}

export function validateBoundaryReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  const keys = Object.keys(report).sort();
  const expected = [...BOUNDARY_REPORT_KEYS].sort();
  if (keys.length !== expected.length
    || !keys.every((key, index) => key === expected[index])
    || report.schema !== 1) {
    return false;
  }
  return BOUNDARY_REPORT_KEYS
    .filter((key) => key !== 'schema')
    .every((key) => typeof report[key] === 'boolean');
}

function parseBoundaryReport(result) {
  if (!result?.ok) return null;
  try {
    const report = JSON.parse(result.stdout);
    return validateBoundaryReport(report) ? report : null;
  } catch {
    return null;
  }
}

/**
 * True when a credential boundary cannot be built for this directory because
 * mc's own installation lives inside it.
 *
 * Callers ask before choosing a workspace, not only when a launch has already
 * failed: a session whose only workspace answers true here can never start,
 * and knowing that early is what lets mc pick a different one instead of
 * reporting a sandbox violation.
 */
export function workspaceContainsMcInstallSync(cwd) {
  if (!isAbsolute(cwd || '')) return false;
  const target = resolveVaultProbeTarget();
  if (!target) return false;
  const hostMcRoot = target.entryPath ? resolve(dirname(target.entryPath), '..') : null;
  return [hostMcRoot, target.binPath, target.entryPath]
    .filter(Boolean)
    .some((path) => resolve(path) === resolve(cwd) || isPathInside(cwd, resolve(path)));
}

/**
 * Remove a credential-domain lease whose owning process is gone.
 *
 * Returns true when the lease was reclaimed and the caller may retry. A lease
 * held by a live process, or one mc cannot read well enough to judge, is left
 * exactly where it is: refusing to launch a second runtime into one domain is
 * the whole point of the lease.
 *
 * A lease with no `owner_pid` was written by a build that recorded no owner.
 * There is no process to protect, so it is reclaimable — that is the only
 * reading that lets a machine recover from the builds that created them.
 */
function reclaimAbandonedLeaseSync(leasePath) {
  const lease = readPrivateJsonFile(leasePath, 2048);
  if (!lease.ok || !lease.value || typeof lease.value !== 'object') return false;
  const pid = lease.value.owner_pid;
  if (pid !== undefined && pid !== null) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    try { process.kill(pid, 0); return false; } catch (error) {
      if (error?.code === 'EPERM') return false;
    }
  }
  try { unlinkSync(leasePath); return true; } catch { return false; }
}

const MAX_ADOPTED_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/**
 * Import a conversation's rollout from the user's own Codex home into the
 * managed store, so a session that ran before managed execution can be
 * resumed instead of silently starting over.
 *
 * This is a one-way copy of a file the user already owns, performed by mc and
 * never by the sandboxed tool. The rules are the same ones the managed store
 * applies to everything else it holds: the source must be a regular file the
 * user owns inside their real Codex home, its name must carry the exact
 * conversation id being resumed, and what lands in the store is private,
 * digest-recorded, and never overwritten.
 */
function adoptNativeCodexTranscriptSync({ stateRoot, codingSessionId, providerSessionId }) {
  const userCodexHome = resolveUserCodexHome();
  const sessionsRoot = join(userCodexHome, 'sessions');
  if (!boundedProviderId(providerSessionId)) return { ok: false };
  let sourcePath;
  try {
    sourcePath = findNativeRolloutSync(sessionsRoot, providerSessionId);
  } catch { return { ok: false }; }
  if (!sourcePath) return { ok: false };

  let stat;
  try { stat = lstatSync(sourcePath); } catch { return { ok: false }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_ADOPTED_TRANSCRIPT_BYTES) return { ok: false };
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) return { ok: false };

  const generation = randomUUID();
  const archiveRoot = join(stateRoot, 'generations', generation);
  const relativeTranscriptPath = join('sessions', relative(sessionsRoot, sourcePath));
  const transcriptPath = join(archiveRoot, relativeTranscriptPath);
  const manifestPath = join(archiveRoot, 'manifest.json');
  const projectionPath = join(stateRoot, 'current.json');
  try {
    ensurePrivateDirectoryChain(stateRoot, dirname(transcriptPath));
    const temporary = `${transcriptPath}.${randomUUID()}.tmp`;
    copyFileSync(sourcePath, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    fsyncFileSync(temporary);
    linkSync(temporary, transcriptPath);
    unlinkSync(temporary);
    fsyncDirectorySync(dirname(transcriptPath));
    const manifest = {
      schema: MANAGED_GENERATION_ARCHIVE_SCHEMA,
      coding_session_id: codingSessionId,
      runtime_generation: generation,
      provider_session_id: providerSessionId,
      relative_transcript_path: relativeTranscriptPath,
      transcript_sha256: sha256FileSync(transcriptPath),
    };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    writeFileSync(manifestPath, manifestBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsyncFileSync(manifestPath);
    fsyncDirectorySync(dirname(manifestPath));
    const projection = {
      schema: MANAGED_SESSION_PROJECTION_SCHEMA,
      coding_session_id: codingSessionId,
      runtime_generation: generation,
      provider_session_id: providerSessionId,
      relative_manifest_path: relative(stateRoot, manifestPath),
      archive_digest: sha256(manifestBody),
    };
    const temporaryProjection = `${projectionPath}.${randomUUID()}.tmp`;
    ensurePrivateDirectoryChain(stateRoot, dirname(projectionPath));
    writeFileSync(temporaryProjection, `${JSON.stringify(projection)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    fsyncFileSync(temporaryProjection);
    renameSync(temporaryProjection, projectionPath);
    fsyncDirectorySync(dirname(projectionPath));
    return { ok: true, manifestPath, adopted: true };
  } catch {
    return { ok: false };
  }
}

function findNativeRolloutSync(sessionsRoot, providerSessionId, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try { entries = readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  const suffix = `-${providerSessionId}.jsonl`;
  for (const entry of entries) {
    const path = join(sessionsRoot, entry.name);
    if (entry.isDirectory()) {
      const found = findNativeRolloutSync(path, providerSessionId, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      return path;
    }
  }
  return null;
}

function resolveVaultProbeTarget() {
  for (const binPath of ['/opt/homebrew/bin/mc', '/usr/local/bin/mc']) {
    try {
      if (!existsSync(binPath)) continue;
      const entryPath = realpathSync(binPath);
      const nodeCandidate = join(dirname(binPath), 'node');
      if (!existsSync(nodeCandidate)) continue;
      return {
        binPath,
        nodePath: realpathSync(nodeCandidate),
        entryPath,
      };
    } catch {}
  }
  return null;
}

export function buildManagedCodexProviderEnv({
  providerHome,
  codexHome,
  providerTmp,
  safePath,
  env = process.env,
} = {}) {
  const out = {
    PATH: safePath,
    HOME: providerHome,
    CODEX_HOME: codexHome,
    TMPDIR: providerTmp,
    LANG: env.LANG || 'C.UTF-8',
    TERM: env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color',
    COLORTERM: env.COLORTERM || 'truecolor',
  };
  if (env.NO_COLOR === '1') out.NO_COLOR = '1';
  return out;
}

/**
 * Keep npm's content-addressed cache stable while the managed executor HOME
 * remains isolated per session. Explicit absolute npm cache configuration wins;
 * otherwise use the operating-system account home rather than the rewritten
 * executor HOME inherited by nested managed launches.
 */
export function resolveManagedNpmCachePath({
  env = process.env,
  hostHome = null,
} = {}) {
  for (const name of ['NPM_CONFIG_CACHE', 'npm_config_cache']) {
    const configured = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (configured && isAbsolute(configured)) return resolve(configured);
  }

  let accountHome = hostHome;
  if (!accountHome) {
    try {
      accountHome = userInfo().homedir;
    } catch {
      accountHome = homedir();
    }
  }
  return isAbsolute(accountHome || '') ? join(resolve(accountHome), '.npm') : null;
}

function runCommand(command, args, env, {
  cwd = PACKAGE_ROOT,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = 1024 * 1024,
} = {}) {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let child;
    const finish = (ok, status = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        ok,
        status,
        stdout,
        stderr,
        output: `${stdout}\n${stderr}`,
      });
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(false);
      return;
    }
    const append = (target, chunk) => {
      const next = `${target}${String(chunk || '')}`;
      return next.length > maxBytes ? next.slice(0, maxBytes) : next;
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0, code));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

function listenServer(server, socketPath) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, resolveListen);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolveClose) => {
    try { server.close(resolveClose); } catch { resolveClose(); }
  });
}

function normalizeCodexAuthArtifact(raw) {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > MAX_AUTH_BYTES) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    if (!('auth_mode' in parsed) && !('tokens' in parsed) && !('OPENAI_API_KEY' in parsed)) {
      return { ok: false };
    }
    return { ok: true, body: JSON.stringify(parsed) };
  } catch {
    return { ok: false };
  }
}

function extractCodexAuthBody(data) {
  if (data?.kind === 'tool_auth' && data.tool === 'codex' && typeof data.body === 'string') {
    return data.body;
  }
  if (data?.kind === 'oauth_token'
    && data.target_tool === 'codex'
    && typeof data.token === 'string') {
    return data.token;
  }
  return null;
}

function updateCodexAuthPayload(existing, authBody) {
  const normalized = normalizeCodexAuthArtifact(authBody);
  if (!normalized.ok) return null;
  if (existing?.kind === 'tool_auth' && existing.tool === 'codex') {
    return { ...existing, body: normalized.body };
  }
  if (existing?.kind === 'oauth_token' && existing.target_tool === 'codex') {
    return { ...existing, token: normalized.body };
  }
  return null;
}

function readBoundedText(path, maxBytes) {
  const info = statSync(path);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error('invalid auth artifact');
  return readFileSync(path, 'utf8');
}

function managedForbiddenPaths({
  cwd,
  domainPath,
  root,
  userCodexHome = join(homedir(), '.codex'),
  hostMcRoot = null,
  hostMcBinPath = null,
  hostMcEntryPath = null,
}) {
  const home = homedir();
  const candidates = [
    domainPath,
    join(root, 'credential-domains'),
    join(root, 'state'),
    join(home, '.codex'),
    userCodexHome,
    join(home, '.config', 'gh'),
    join(home, '.ssh'),
    join(home, 'Library', 'Keychains'),
    join(home, '.npmrc'),
    join(home, '.netrc'),
    join(home, '.git-credentials'),
    hostMcRoot,
    hostMcBinPath,
    hostMcEntryPath,
  ];
  return [...new Set(candidates.filter(Boolean).map((path) => resolve(path)))]
    .filter((path) => path !== resolve(cwd))
    .filter((path) => !isPathInside(cwd, path));
}

function resolveUserCodexHome(env = process.env) {
  const configured = typeof env?.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return resolve(configured || join(homedir(), '.codex'));
}

function materializeManagedCodexUserConfiguration({
  sourceHome,
  codexHome,
} = {}) {
  if (!isAbsolute(sourceHome || '') || !isAbsolute(codexHome || '')) {
    return safeFailure('managed-portable-user-config-invalid');
  }
  const source = resolve(sourceHome);
  const target = resolve(codexHome);
  if (source === target || isPathInside(source, target) || isPathInside(target, source)) {
    return safeFailure('managed-portable-user-config-invalid');
  }
  try {
    const sourceConfig = join(source, 'config.toml');
    const targetConfig = join(target, 'config.toml');
    if (existsSync(sourceConfig)) {
      copyBoundedUserConfigFile(sourceConfig, targetConfig);
    } else {
      writeFileSync(targetConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }

    if (existsSync(source)) {
      const profileNames = readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isFile()
          && /^[A-Za-z0-9_.-]+\.config\.toml$/u.test(entry.name)
          && entry.name !== `${MANAGED_CODEX_PROFILE}.config.toml`)
        .map((entry) => entry.name)
        .sort();
      if (profileNames.length > MAX_USER_PROFILE_FILES) {
        return safeFailure('managed-portable-user-config-invalid');
      }
      for (const name of profileNames) {
        copyBoundedUserConfigFile(join(source, name), join(target, name));
      }

      const requirements = join(source, 'requirements.toml');
      if (existsSync(requirements)) {
        copyBoundedUserConfigFile(requirements, join(target, 'requirements.toml'));
      }
      const userHooks = join(source, 'hooks.json');
      if (existsSync(userHooks)) {
        copyManagedCodexHooks(userHooks, join(target, 'hooks.json'));
      }

      const sourceRules = join(source, 'rules');
      if (existsSync(sourceRules)) {
        const info = statSync(sourceRules);
        if (!info.isDirectory()) {
          return safeFailure('managed-portable-user-config-invalid');
        }
        symlinkSync(realpathSync(sourceRules), join(target, 'rules'), 'dir');
      }
    }
    return { ok: true };
  } catch {
    return safeFailure('managed-portable-user-config-unavailable');
  }
}

function copyBoundedUserConfigFile(source, target) {
  const info = statSync(source);
  if (!info.isFile() || info.size > MAX_USER_CONFIG_BYTES) {
    throw new Error('user configuration file is invalid');
  }
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}

function copyManagedCodexHooks(source, target) {
  const info = statSync(source);
  if (!info.isFile() || info.size > MAX_USER_CONFIG_BYTES) {
    throw new Error('user hook configuration is invalid');
  }
  const body = readFileSync(source, 'utf8');
  const parsed = JSON.parse(body);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.hooks)) {
    throw new Error('user hook configuration is invalid');
  }
  let changed = false;
  const hooks = {};
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const retained = groups.filter((group) => {
      const remove = isLegacyMemoroCaptureHook(group);
      changed ||= remove;
      return !remove;
    });
    if (retained.length > 0) hooks[event] = retained;
  }
  if (!changed) {
    copyBoundedUserConfigFile(source, target);
    return;
  }
  writeFileSync(target, `${JSON.stringify({ ...parsed, hooks })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(target, 0o600);
}

function isLegacyMemoroCaptureHook(group) {
  return isPlainObject(group)
    && group._memoro === 'memoro-cli'
    && Array.isArray(group.hooks)
    && group.hooks.length > 0
    && group.hooks.every((hook) => (
      isPlainObject(hook)
      && hook.type === 'command'
      && hook.command === 'memoro-cli provider-artifact capture --tool codex'
    ));
}

function managedSafePath({ executorBin, env = process.env }) {
  const candidates = [
    executorBin,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const inherited = String(env.PATH || '').split(':')
    .filter((path) => path === '/opt/homebrew/bin' || path === '/usr/local/bin');
  return [...new Set([...candidates, ...inherited])].join(':');
}

function removeDomainPaths({ domainPath, executorRoot }) {
  for (const path of [domainPath, executorRoot]) {
    if (!path || !isAbsolute(path)) return false;
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
  return !existsSync(domainPath) && !existsSync(executorRoot);
}

function removeDomainLease(leasePath) {
  if (!leasePath || !isAbsolute(leasePath)) return false;
  try { rmSync(leasePath, { force: true }); } catch {}
  return !existsSync(leasePath);
}

function resolveOwnedDomainPaths(descriptor) {
  if (!descriptor
    || descriptor.schema !== MANAGED_CODEX_DOMAIN_SCHEMA
    || descriptor.provider_adapter !== MANAGED_CODEX_PROVIDER_ID
    || typeof descriptor.session_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(descriptor.generation || '')
    || !isAbsolute(descriptor.domain_path || '')
    || !isAbsolute(descriptor.executor_root || '')
    || !isAbsolute(descriptor.lease_path || '')) {
    return null;
  }
  const sessionPart = sessionDirectoryPart(descriptor.session_id);
  const root = resolve(descriptor.domain_path, '..', '..', '..', '..');
  const domainPath = join(
    root,
    'credential-domains',
    'codex',
    sessionPart,
    descriptor.generation,
  );
  const executorRoot = join(
    root,
    'executor-domains',
    'codex',
    sessionPart,
    descriptor.generation,
  );
  const leasePath = join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`);
  if (resolve(descriptor.domain_path) !== domainPath
    || resolve(descriptor.executor_root) !== executorRoot
    || resolve(descriptor.lease_path) !== leasePath
    || descriptor.provider_home !== join(domainPath, 'home')
    || descriptor.codex_home !== join(domainPath, 'home', '.codex')
    || descriptor.provider_tmp !== join(domainPath, 'tmp')
    || descriptor.executor_home !== join(executorRoot, 'home')
    || descriptor.executor_tmp !== join(executorRoot, 'tmp')) {
    return null;
  }
  return { root, domainPath, executorRoot, leasePath };
}

function managedSessionArtifact({ descriptor, providerArtifact } = {}) {
  if (!descriptor || !providerArtifact
    || providerArtifact.coding_session_id !== descriptor.session_id
    || !boundedProviderId(providerArtifact.provider_session_id)
    || typeof providerArtifact.transcript_path !== 'string'
    || !isAbsolute(providerArtifact.transcript_path)) {
    return safeSessionStateFailure('managed-portable-session-state-unconfirmed');
  }
  const sessionsRoot = join(descriptor.codex_home, 'sessions');
  const archivedRoot = join(descriptor.codex_home, 'archived_sessions');
  const root = isPathInside(sessionsRoot, providerArtifact.transcript_path)
    ? sessionsRoot
    : isPathInside(archivedRoot, providerArtifact.transcript_path)
      ? archivedRoot
      : null;
  if (!root) return safeSessionStateFailure('managed-portable-session-state-invalid');
  const rootName = root === sessionsRoot ? 'sessions' : 'archived_sessions';
  const relativePath = relative(root, providerArtifact.transcript_path);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)
    || !providerArtifact.transcript_path.endsWith(`-${providerArtifact.provider_session_id}.jsonl`)) {
    return safeSessionStateFailure('managed-portable-session-state-invalid');
  }
  return {
    ok: true,
    relativeTranscriptPath: join(rootName, relativePath),
  };
}

function managedSessionStateRoot(root, codingSessionId) {
  return join(
    root,
    'provider-session-state',
    'codex',
    sessionDirectoryPart(codingSessionId),
  );
}

function scanCodexTranscriptTrees(codexHome) {
  const files = [];
  let entries = 0;
  try {
    const canonicalHome = realpathSync(codexHome);
    for (const name of ['sessions', 'archived_sessions']) {
      const transcriptRoot = join(codexHome, name);
      let rootInfo;
      try {
        rootInfo = lstatSync(transcriptRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        return safeSessionStateFailure('managed-provider-absence-tree-unreadable');
      }
      if (!rootInfo.isDirectory()
        || rootInfo.isSymbolicLink()
        || realpathSync(transcriptRoot) !== join(canonicalHome, name)) {
        return safeSessionStateFailure('managed-provider-absence-tree-unsafe');
      }
      const pending = [transcriptRoot];
      while (pending.length) {
        const directory = pending.pop();
        for (const entry of readdirSync(directory)) {
          entries += 1;
          if (entries > MAX_PROVIDER_TRANSCRIPT_ENTRIES) {
            return safeSessionStateFailure('managed-provider-absence-tree-oversized');
          }
          const path = join(directory, entry);
          const info = lstatSync(path);
          if (info.isSymbolicLink()) {
            return safeSessionStateFailure('managed-provider-absence-tree-unsafe');
          }
          if (info.isDirectory()) {
            if (realpathSync(path) !== join(
              canonicalHome,
              relative(codexHome, path),
            )) {
              return safeSessionStateFailure('managed-provider-absence-tree-unsafe');
            }
            pending.push(path);
          } else if (info.isFile()) {
            files.push(realpathSync(path));
          } else {
            return safeSessionStateFailure('managed-provider-absence-tree-unsafe');
          }
        }
      }
    }
    return { ok: true, files: files.sort() };
  } catch {
    return safeSessionStateFailure('managed-provider-absence-tree-unreadable');
  }
}

function validManagedSessionManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    'coding_session_id',
    'provider_session_id',
    'relative_transcript_path',
    'schema',
  ].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.schema === MANAGED_SESSION_STATE_SCHEMA
    && typeof value.coding_session_id === 'string'
    && value.coding_session_id.length > 0
    && boundedProviderId(value.provider_session_id)
    && /^(sessions|archived_sessions)[/\\].+\.jsonl$/u.test(
      value.relative_transcript_path || '',
    )
    && !value.relative_transcript_path.split(/[\\/]+/u).includes('..');
}

function validManagedGenerationArchiveManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    'coding_session_id',
    'provider_session_id',
    'relative_transcript_path',
    'runtime_generation',
    'schema',
    'transcript_sha256',
  ].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.schema === MANAGED_GENERATION_ARCHIVE_SCHEMA
    && typeof value.coding_session_id === 'string'
    && value.coding_session_id.length > 0
    && isUuidV4(value.runtime_generation)
    && boundedProviderId(value.provider_session_id)
    && /^(sessions|archived_sessions)[/\\].+\.jsonl$/u.test(
      value.relative_transcript_path || '',
    )
    && !value.relative_transcript_path.split(/[\\/]+/u).includes('..')
    && /^[a-f0-9]{64}$/u.test(value.transcript_sha256 || '');
}

function validManagedSessionProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    'archive_digest',
    'coding_session_id',
    'provider_session_id',
    'relative_manifest_path',
    'runtime_generation',
    'schema',
  ].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.schema === MANAGED_SESSION_PROJECTION_SCHEMA
    && typeof value.coding_session_id === 'string'
    && value.coding_session_id.length > 0
    && isUuidV4(value.runtime_generation)
    && boundedProviderId(value.provider_session_id)
    && value.relative_manifest_path
      === join('generations', value.runtime_generation, 'manifest.json')
    && /^[a-f0-9]{64}$/u.test(value.archive_digest || '');
}

function validateManagedCloseTransaction({
  descriptor,
  managedTransaction,
  providerArtifact,
  root,
  deps,
} = {}) {
  if (managedTransaction == null) {
    return { ok: true, value: null, generation: null };
  }
  const checked = validateManagedGenerationTransaction(managedTransaction);
  if (!checked.ok
    || checked.value.coding_session_id !== descriptor.session_id
    || (providerArtifact
      && providerArtifact.runtime_generation !== checked.value.runtime_generation)) {
    return safeSessionStateFailure('managed-domain-transaction-invalid');
  }
  const generation = inspectManagedGenerationForClose({
    transaction: checked.value,
    root,
    deps,
  });
  const domainReceipt = generation?.receipts?.['domain-ready'];
  const providerOutcome = providerArtifact
    ? generation?.receipts?.['provider-artifact']
    : generation?.receipts?.['provider-absent'];
  if (generation?.kind !== 'present'
    || generation.intent?.sequence !== checked.value.sequence
    || generation.intent?.intent_digest !== checked.value.intent_digest
    || !generation.receipts?.exited
    || !providerOutcome
    || domainReceipt?.data?.domain_generation !== descriptor.generation
    || domainReceipt?.data?.manifest_digest !== descriptor.manifest_sha256) {
    return safeSessionStateFailure('managed-domain-transaction-unconfirmed');
  }
  return { ok: true, value: checked.value, generation };
}

function inspectManagedGenerationForClose({ transaction, root, deps }) {
  const inspect = deps.inspectManagedGeneration || inspectManagedGenerationSync;
  try {
    return inspect({
      mcHomeDir: root,
      codingSessionId: transaction.coding_session_id,
      runtimeGeneration: transaction.runtime_generation,
    });
  } catch {
    return null;
  }
}

function sha256FileSync(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    let position = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    return hash.digest('hex');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncFileSync(path) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncDirectorySync(path) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function pathEntryAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function boundedProviderId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function ensurePrivateDirectoryChain(root, directory) {
  if (!isAbsolute(root || '') || !isPathInside(root, directory)) {
    throw new Error('managed session state path is invalid');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(root);
  let current = root;
  assertPrivateOwnedDirectory(current, canonicalRoot);
  const rel = relative(root, directory);
  for (const part of rel.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, part);
    assertPrivateOwnedDirectory(
      current,
      join(canonicalRoot, relative(root, current)),
    );
  }
}

function assertPrivateOwnedDirectory(path, expectedRealPath) {
  const info = lstatSync(path);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink()
    || realpathSync(path) !== expectedRealPath
    || (Number.isInteger(expectedUid) && info.uid !== expectedUid)) {
    throw new Error('managed session state directory is unsafe');
  }
  chmodSync(path, 0o700);
}

function safeSessionStateFailure(reason) {
  return { ok: false, reason };
}

function safePathPart(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'session';
}

function sessionDirectoryPart(value) {
  return `${safePathPart(value)}-${sha256(String(value)).slice(0, 12)}`;
}

function readPrivateJsonFile(path, maxBytes) {
  try {
    const info = lstatSync(path);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (Number.isInteger(expectedUid) && info.uid !== expectedUid)) {
      return { ok: false };
    }
    const body = readFileSync(path, 'utf8');
    if (Buffer.byteLength(body, 'utf8') > maxBytes) return { ok: false };
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value, body }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function hasExactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    );
}

function isPrivateOwnedPath(path, { directory }) {
  try {
    const info = lstatSync(path);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
    return (directory ? info.isDirectory() : info.isFile())
      && !info.isSymbolicLink()
      && (info.mode & 0o077) === 0
      && (!Number.isInteger(expectedUid) || info.uid === expectedUid);
  } catch {
    return false;
  }
}

function isUuidV4(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value);
}

function codexTargetTriple(platformName, architecture) {
  if (platformName === 'darwin' && architecture === 'arm64') return 'aarch64-apple-darwin';
  if (platformName === 'darwin' && architecture === 'x64') return 'x86_64-apple-darwin';
  return null;
}

function codexPlatformPackageFolder(platformName, architecture) {
  if (platformName === 'darwin' && architecture === 'arm64') return 'codex-darwin-arm64';
  if (platformName === 'darwin' && architecture === 'x64') return 'codex-darwin-x64';
  return 'unsupported';
}

function tomlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeFailure(reason) {
  return {
    ok: false,
    reason,
    error: 'managed portable Codex credential boundary is unavailable',
  };
}
