import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { arch, homedir, platform } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCachedVaultKey } from '../vault/key-cache.js';
import {
  decryptEnvelopeSecret,
  isEnvelopeSecret,
  unwrapCustodyRoot,
} from '../vault/custody-crypto.js';
import { encryptForWrite } from '../vault/custody-session.js';
import * as VaultApi from '../vault/api.js';
import { WIRE_SECRET_TYPE } from '../vault/types.js';
import { mcHome } from '../paths.js';
import { resolveRealCodexBinary } from '../../lib/codex.js';
import { getSecret as keychainGet } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { memoroFetch } from '../../lib/api.js';
import { getApiUrl, readConfig } from '../../lib/config.js';
import {
  MANAGED_CODEX_DOMAIN_SCHEMA,
  MANAGED_CODEX_PROFILE,
  MANAGED_CODEX_PROVIDER_ID,
  MANAGED_CODEX_RELEASE_SHA256,
  MANAGED_CODEX_TEAM_ID,
  MANAGED_CODEX_VERSION,
} from '../provider-adapters/codex-managed.js';

export const LOCAL_CODEX_BOUNDARY_UNAVAILABLE = 'managed-portable-boundary-unavailable';
export const LOCAL_CODEX_CUSTODY_LOCKED = 'managed-portable-custody-locked';
export const LOCAL_CODEX_AUTH_MISSING = 'managed-portable-codex-auth-missing';
export const LOCAL_CODEX_RELEASE_UNTRUSTED = 'managed-portable-codex-release-untrusted';

const TOOL_AUTH_LABEL = 'tool-auth:codex';
const LEGACY_TOOL_AUTH_LABEL = 'tool_auth.codex';
const PROBE_TIMEOUT_MS = 20_000;
const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BOUNDARY_CHILD_SOURCE = join(
  PACKAGE_ROOT,
  'scripts',
  'security',
  'credential-boundary-child.c',
);
const BOUNDARY_CHILD_SOURCE_SHA256 = 'e0e3f521b38e32d6242e7111d584f9778738f5f27513c24199de1e8d0ac05f03';
const BOUNDARY_REPORT_KEYS = Object.freeze([
  'schema',
  'file_readable',
  'canary_in_environment',
  'canary_in_argv',
  'parent_process_exposes_canary',
  'credential_socket_reachable',
  'external_network_reachable',
  'workspace_write_blocked',
  'vault_admin_via_bin_callable',
  'vault_admin_via_node_callable',
  'memoro_keychain_secret_readable',
]);

/**
 * Prepare a per-session provider credential domain. Every platform and release
 * check, plus the hostile canary probe, completes before custody is opened.
 */
export async function prepareLocalCodexCredentialDomain({
  codingSessionId,
  cwd,
  tool,
  portal,
  env = process.env,
  root = mcHome(),
  deps = {},
} = {}) {
  if (tool !== 'codex') {
    return safeFailure('managed-portable-tool-unsupported');
  }
  if (!codingSessionId || typeof codingSessionId !== 'string' || !isAbsolute(cwd || '')) {
    return safeFailure('managed-portable-request-invalid');
  }

  const inspectRelease = deps.inspectCodexRelease || inspectCodexRelease;
  const release = await Promise.resolve(inspectRelease({
    launcherPath: deps.codexBinary || resolveRealCodexBinary(),
    deps: deps.releaseDeps || {},
  })).catch(() => null);
  if (!release?.ok) {
    return safeFailure(release?.reason || LOCAL_CODEX_RELEASE_UNTRUSTED);
  }

  const generation = randomUUID();
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
  const manifestPath = join(domainPath, 'manifest.json');
  const safePath = managedSafePath({ executorBin, env });
  const forbiddenPaths = managedForbiddenPaths({ cwd, domainPath, root });
  const configBody = renderManagedCodexConfig({
    domainPath,
    executorRoot,
    workspaceRoot: cwd,
    executorHome,
    executorTmp,
    safePath,
    forbiddenPaths,
  });
  const launchNonce = randomBytes(32).toString('base64url');
  let custody = null;
  let leaseAcquired = false;

  try {
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    chmodSync(leaseDir, 0o700);
    try {
      writeFileSync(leasePath, `${JSON.stringify({
        schema: 1,
        provider_adapter: MANAGED_CODEX_PROVIDER_ID,
        session_id: codingSessionId,
        generation,
      })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      return safeFailure('managed-portable-domain-quarantined');
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
    writeFileSync(join(codexHome, 'config.toml'), configBody, { mode: 0o600 });
    writeRestrictedMcShim(join(executorBin, 'mc'));

    const probe = deps.verifyBoundary || verifyManagedCodexBoundary;
    const boundary = await probe({
      cwd,
      codexHome,
      credentialDomainPath: domainPath,
      executorRoot,
      nativeBinary: release.nativeBinary,
      probeDir,
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
  portal,
  deps = {},
} = {}) {
  const ownedPaths = resolveOwnedDomainPaths(descriptor);
  if (!ownedPaths) {
    return { ok: false, persisted: false, reason: 'managed-domain-descriptor-invalid' };
  }
  const { domainPath, executorRoot, leasePath } = ownedPaths;
  let persisted = false;
  let reason = 'managed-domain-closed';
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
  if (!persisted) {
    return { ok: false, persisted: false, quarantined: true, reason };
  }
  if (!removeDomainPaths({ domainPath, executorRoot }) || !removeDomainLease(leasePath)) {
    return {
      ok: false,
      persisted: true,
      quarantined: true,
      reason: 'managed-domain-cleanup-unconfirmed',
    };
  }
  return { ok: true, persisted: true, quarantined: false, reason };
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

export async function persistCustodyCodexAuth({
  portal,
  secretId,
  authBody,
  deps = {},
} = {}) {
  const effectivePortal = portal?.token && portal?.apiUrl
    ? portal
    : await resolveTrustedPortal({ deps }).catch(() => null);
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
  let crk;
  try {
    crk = await unwrapCustodyRoot(cache.vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
  } catch {
    return safeFailure(LOCAL_CODEX_CUSTODY_LOCKED);
  }
  const listed = await api.listSecrets(effectivePortal).catch(() => null);
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

async function resolveTrustedPortal({ deps = {} } = {}) {
  const token = await (deps.getSecret || keychainGet)(ACCOUNTS.TOKEN).catch(() => null);
  if (!token) return null;
  const config = await (deps.readConfig || readConfig)().catch(() => ({}));
  const apiUrl = getApiUrl([]) || config.apiUrl || 'https://meetmemoro.app';
  return {
    apiUrl,
    token,
    memoroFetch: deps.memoroFetch || memoroFetch,
  };
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
  forbiddenPaths = [],
  runtimeReadPaths = [],
} = {}) {
  const denied = new Set([domainPath, ...forbiddenPaths].filter(Boolean).map((path) => resolve(path)));
  const filesystemRules = [
    `"${tomlString(domainPath)}" = "deny"`,
    ...forbiddenPaths
      .filter((path) => path && path !== domainPath)
      .map((path) => `"${tomlString(path)}" = "deny"`),
    ...runtimeReadPaths
      .filter((path) => path && !denied.has(resolve(path)))
      .map((path) => `"${tomlString(path)}" = "read"`),
    '":minimal" = "read"',
    '":tmpdir" = "deny"',
    '":slash_tmp" = "deny"',
    '":root" = "deny"',
  ];
  const workspaceRoots = [...new Set([executorRoot, workspaceRoot].filter(Boolean))]
    .map((path) => `"${tomlString(path)}" = true`);
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
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'allow_login_shell = false',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    'web_search = "disabled"',
    '',
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
    'apps = false',
    'browser_use = false',
    'computer_use = false',
    'hooks = false',
    'image_generation = false',
    'multi_agent = false',
    'network_proxy = false',
    'remote_plugin = false',
    'shell_snapshot = false',
    'skill_mcp_dependency_install = false',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.set]',
    `HOME = "${tomlString(executorHome)}"`,
    `TMPDIR = "${tomlString(executorTmp)}"`,
    `PATH = "${tomlString(safePath)}"`,
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
    '"**/*.env" = "deny"',
    '"**/.env*" = "deny"',
    '"**/*credentials*" = "deny"',
    '"**/*secret*" = "deny"',
    '',
    `[permissions.${MANAGED_CODEX_PROFILE}.network]`,
    'enabled = false',
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
  env = process.env,
  deps = {},
} = {}) {
  const canary = `mc_canary_${randomBytes(24).toString('hex')}`;
  const canaryPath = join(credentialDomainPath, 'boundary-canary');
  const socketPath = managedBoundarySocketPath();
  const childPath = join(probeDir, 'credential-boundary-child');
  const createServerImpl = deps.createServer || createServer;
  const run = deps.runCommand || runCommand;
  const vaultTarget = (deps.resolveVaultProbeTarget || resolveVaultProbeTarget)();
  let server = null;
  try {
    if (!vaultTarget) return boundaryFailure('vault-probe-target-unavailable');
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
      vaultTarget.binPath,
      vaultTarget.nodePath,
      vaultTarget.entryPath,
    ];
    const probeEnv = {
      PATH: managedSafePath({ executorBin: join(executorRoot, 'bin'), env }),
      HOME: dirname(codexHome),
      CODEX_HOME: codexHome,
      TMPDIR: join(credentialDomainPath, 'tmp'),
      LANG: env.LANG || 'C',
      TERM: 'xterm-256color',
      MC_HOME: credentialDomainPath,
      MC_BOUNDARY_CANARY: canary,
    };
    const negative = await run(childPath, probeArgs, probeEnv, {
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    });
    const negativeReport = parseBoundaryReport(negative);
    if (!negativeReport?.file_readable
      || !negativeReport.canary_in_environment
      || !negativeReport.vault_admin_via_bin_callable
      || !negativeReport.vault_admin_via_node_callable
      || negative.output.includes(canary)) {
      return boundaryFailure('boundary-negative-control-failed');
    }
    const result = await run(nativeBinary, [
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
    const violations = BOUNDARY_REPORT_KEYS
      .filter((key) => key !== 'schema' && report[key] !== false);
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

function managedForbiddenPaths({ cwd, domainPath, root }) {
  const home = homedir();
  const candidates = [
    domainPath,
    root,
    home,
    join(home, '.memoro'),
    join(home, '.codex'),
    join(home, '.config', 'gh'),
    join(home, '.ssh'),
    join(home, 'Library', 'Keychains'),
    PACKAGE_ROOT,
  ];
  return [...new Set(candidates.map((path) => resolve(path)))]
    .filter((path) => path !== resolve(cwd))
    .filter((path) => !isPathInside(cwd, path));
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

function writeRestrictedMcShim(path) {
  writeFileSync(path, [
    '#!/bin/sh',
    'printf "%s\\n" "mc: only the restricted managed-session client is available" >&2',
    'exit 126',
    '',
  ].join('\n'), { mode: 0o500, flag: 'wx' });
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
  return { domainPath, executorRoot, leasePath };
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
