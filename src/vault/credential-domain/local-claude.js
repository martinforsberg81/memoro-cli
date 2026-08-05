import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionHostPaths } from '../../runtime/broker/paths.js';
import {
  appendManagedGenerationReceiptSync,
  inspectManagedGenerationSync,
  validateManagedGenerationTransaction,
} from '../../mc/managed-generation-journal.js';
import {
  persistManagedProviderArchive,
  restoreManagedProviderArchive,
} from '../../mc/managed-provider-archive.js';
import { mcHome } from '../../mc/paths.js';
import {
  inspectManagedClaudeCertificationSync,
  managedClaudeC1SourceClosureDigest,
} from '../../adapters/managed-runtime/claude-managed-certification.js';
import {
  inspectManagedClaudeCustody,
} from '../../adapters/managed-runtime/claude-managed-custody.js';
import {
  MANAGED_CLAUDE_DOMAIN_SCHEMA,
  MANAGED_CLAUDE_PROFILE,
  MANAGED_CLAUDE_PROVIDER_ID,
  renderManagedClaudeSettings,
  sanitizeManagedClaudePermissions,
  validateManagedClaudeDescriptor,
} from '../../adapters/managed-runtime/claude-managed.js';
import {
  CLAUDE_C1_ARTIFACT_PINS,
  verifyInstalledClaudeC1Artifacts,
} from '../../runtime/broker/c1-artifacts.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNTIME_HOST = join(
  PACKAGE_ROOT,
  'src',
  'adapters',
  'managed-runtime',
  'claude-managed-runtime-host.js',
);
const PROVIDER_HOOK_RUNNER = join(
  PACKAGE_ROOT,
  'src',
  'mc',
  'provider-artifact-hook-runner.js',
);
const TOOL = 'claude-code';
const LEASE_SCHEMA = 'mc-managed-provider-domain-lease/v1';
const MAX_USER_SETTINGS_BYTES = 1024 * 1024;
const SESSION_OWNER_ID_RE = /^(?:sess_[A-Za-z0-9_-]{6,}|mcs_[a-f0-9]{24})$/u;

export async function prepareLocalClaudeCredentialDomain({
  codingSessionId,
  domainGeneration = null,
  providerSessionId = null,
  resumeConversation = true,
  githubCapability = false,
  githubSocketPath = null,
  cwd,
  tool,
  portal,
  env = process.env,
  root = mcHome(),
  deps = {},
} = {}) {
  const certifiedGitHubSocketPath = join(
    root || '/',
    'run',
    'sessions',
    codingSessionId || 'invalid',
    'github.sock',
  );
  if (tool !== TOOL
    || !SESSION_OWNER_ID_RE.test(codingSessionId || '')
    || !isAbsolute(cwd || '')
    || !isAbsolute(root || '')
    || (domainGeneration != null && !uuidV4(domainGeneration))
    || (githubSocketPath !== null && githubSocketPath !== certifiedGitHubSocketPath)) {
    return failure('managed-claude-request-invalid');
  }
  const certified = (deps.inspectCertification
    || inspectManagedClaudeCertificationSync)({ root });
  if (!certified?.ok) {
    return failure(certified?.reason || 'managed-claude-certification-required');
  }
  const verified = await Promise.resolve()
    .then(() => (deps.verifyArtifacts || verifyInstalledClaudeC1Artifacts)())
    .catch(() => null);
  if (!verified?.ok) {
    return failure(verified?.code || 'managed-claude-artifact-untrusted');
  }
  const custody = await (deps.inspectCustody || inspectManagedClaudeCustody)({
    portal,
    deps: deps.custodyDeps || {},
  }).catch(() => null);
  if (!custody?.ok) {
    return failure(custody?.reason || 'managed-claude-custody-missing');
  }

  const generation = domainGeneration || randomUUID();
  const sessionPart = safePart(codingSessionId);
  const domainPath = join(
    root,
    'credential-domains',
    'claude-code',
    sessionPart,
    generation,
  );
  const executorRoot = join(
    root,
    'executor-domains',
    'claude-code',
    sessionPart,
    generation,
  );
  const leaseDirectory = join(
    root,
    'credential-domain-leases',
    'claude-code',
  );
  const leasePath = join(leaseDirectory, `${sessionPart}.json`);
  const manifestPath = join(domainPath, 'manifest.json');
  const executorHome = join(executorRoot, 'home');
  const executorTmp = join(executorRoot, 'tmp');
  const executorBin = join(executorRoot, 'bin');
  const claudeConfigDir = join(executorHome, '.claude');
  const providerSettingsPath = join(claudeConfigDir, 'settings.json');
  const runtimeNodePath = realpathSync(process.execPath);
  const runtimeHostPath = realpathSync(RUNTIME_HOST);
  const providerHookNodePath = runtimeNodePath;
  const providerHookRunnerPath = realpathSync(PROVIDER_HOOK_RUNNER);
  const workspace = realpathSync(cwd);
  const safePath = managedSafePath({ executorBin, env });
  const deniedReadPaths = managedClaudeForbiddenPaths({
    root,
    domainPath,
    cwd: workspace,
  });
  const deniedWritePaths = [...deniedReadPaths];
  const allowedUnixSocketPaths = [
    sessionHostPaths(codingSessionId, { root }).artifactSocketPath,
    ...(githubCapability === true
      ? [githubSocketPath || join(root, `${codingSessionId}.sock`)]
      : []),
  ];
  const launchNonce = randomBytes(32).toString('base64url');
  let leaseAcquired = false;
  let manifestWritten = false;
  try {
    ensurePrivateDirectory(root, leaseDirectory);
    writeFileSync(leasePath, `${JSON.stringify({
      schema: LEASE_SCHEMA,
      provider_adapter: MANAGED_CLAUDE_PROVIDER_ID,
      session_id: codingSessionId,
      generation,
    })}\n`, { mode: 0o600, flag: 'wx' });
    leaseAcquired = true;
    for (const path of [
      domainPath,
      executorRoot,
      executorHome,
      executorTmp,
      executorBin,
      claudeConfigDir,
    ]) {
      ensurePrivateDirectory(root, path);
    }
    let restored = restoreManagedProviderArchive({
      root,
      tool: TOOL,
      codingSessionId,
      providerSessionId,
      providerRoot: claudeConfigDir,
    });
    // A session that ran before managed execution left its transcript in the
    // user's own Claude home and nowhere mc controls, so the archive is
    // genuinely absent and resuming would silently start over. The transcript
    // is on the same disk; adopting it is what makes the session continue.
    if (providerSessionId != null && !restored.ok && resumeConversation) {
      const adopted = adoptNativeClaudeTranscript({
        root,
        codingSessionId,
        providerSessionId,
      });
      if (adopted.ok) {
        restored = restoreManagedProviderArchive({
          root,
          tool: TOOL,
          codingSessionId,
          providerSessionId,
          providerRoot: claudeConfigDir,
        });
      }
    }
    if (providerSessionId != null && resumeConversation && !restored.ok) return restored;

    const loadedPermissions = (deps.loadUserClaudePermissions
      || loadManagedClaudeUserPermissions)();
    if (!loadedPermissions?.ok) {
      return failure(
        loadedPermissions?.reason || 'managed-provider-user-permissions-invalid',
      );
    }
    const settingsBody = renderManagedClaudeSettings({
      nodePath: providerHookNodePath,
      hookRunnerPath: providerHookRunnerPath,
      permissions: loadedPermissions.permissions,
    });
    writeFileSync(providerSettingsPath, settingsBody, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const manifest = {
      allowed_unix_socket_paths: allowedUnixSocketPaths,
      c1_certification_path: certified.path,
      c1_certification_sha256: sha256(readFileSync(certified.path)),
      c1_source_closure_sha256: managedClaudeC1SourceClosureDigest(),
      claude_config_dir: claudeConfigDir,
      claude_version: verified.artifacts.claudeVersion,
      custody_secret_id: custody.secretId,
      denied_read_paths: deniedReadPaths,
      denied_write_paths: deniedWritePaths,
      domain_path: domainPath,
      executor_bin: executorBin,
      executor_home: executorHome,
      executor_root: executorRoot,
      executor_tmp: executorTmp,
      generation,
      launch_nonce: launchNonce,
      lease_path: leasePath,
      native_binary: verified.artifacts.claudeBinary,
      native_binary_sha256: verified.artifacts.claudeSha256,
      profile: MANAGED_CLAUDE_PROFILE,
      provider_adapter: MANAGED_CLAUDE_PROVIDER_ID,
      provider_hook_node_path: providerHookNodePath,
      provider_hook_node_sha256: sha256(readFileSync(providerHookNodePath)),
      provider_hook_runner_path: providerHookRunnerPath,
      provider_hook_runner_sha256: sha256(readFileSync(providerHookRunnerPath)),
      provider_settings_path: providerSettingsPath,
      provider_settings_sha256: sha256(settingsBody),
      runtime_host_path: runtimeHostPath,
      runtime_host_sha256: sha256(readFileSync(runtimeHostPath)),
      runtime_node_path: runtimeNodePath,
      runtime_node_sha256: sha256(readFileSync(runtimeNodePath)),
      safe_path: safePath,
      schema: MANAGED_CLAUDE_DOMAIN_SCHEMA,
      session_id: codingSessionId,
      srt_module: verified.artifacts.srtModule,
      srt_tree_sha256: verified.artifacts.srtTreeSha256,
      srt_version: verified.artifacts.srtVersion,
      state: 'ready',
      workspace,
    };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    writeFileSync(manifestPath, manifestBody, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    manifestWritten = true;
    return {
      ok: true,
      descriptor: {
        ...manifest,
        manifest_path: manifestPath,
        manifest_sha256: sha256(manifestBody),
      },
      env: buildManagedClaudeProviderEnv({
        claudeConfigDir,
        executorHome,
        executorTmp,
        safePath,
        env,
      }),
      state: 'managed-ready',
      portable: true,
    };
  } catch {
    return failure('managed-claude-domain-prepare-failed');
  } finally {
    if (!manifestWritten) {
      removeDomainPaths({ domainPath, executorRoot });
      if (leaseAcquired) removeLease(leasePath);
    }
  }
}

export async function closeLocalClaudeCredentialDomain({
  descriptor,
  providerArtifact = null,
  portal,
  managedTransaction = null,
  deps = {},
} = {}) {
  const owned = resolveOwnedPaths(descriptor);
  if (!owned) return closeFailure('managed-domain-descriptor-invalid');
  const transaction = validateCloseTransaction({
    descriptor,
    providerArtifact,
    managedTransaction,
    root: owned.root,
    deps,
  });
  if (!transaction.ok) return closeFailure(transaction.reason, { quarantined: true });
  const append = deps.appendManagedGenerationReceipt
    || appendManagedGenerationReceiptSync;
  const providerAbsent = transaction.value != null && providerArtifact == null;
  const receipt = (phase, data) => {
    if (!transaction.value) return null;
    return append({
      mcHomeDir: owned.root,
      phase,
      codingSessionId: transaction.value.coding_session_id,
      runtimeGeneration: transaction.value.runtime_generation,
      intentDigest: transaction.value.intent_digest,
      recordedAt: new Date().toISOString(),
      data,
    });
  };
  let generation = transaction.generation;
  if (!generation?.receipts?.['custody-persisted']) {
    const custody = await (deps.inspectCustody || inspectManagedClaudeCustody)({
      portal,
      deps: deps.custodyDeps || {},
    }).catch(() => null);
    if (!custody?.ok || custody.secretId !== descriptor.custody_secret_id) {
      return closeFailure(
        custody?.reason || 'managed-claude-custody-unconfirmed',
        { quarantined: true },
      );
    }
    try {
      receipt('custody-persisted', {
        record_digest: sha256(JSON.stringify({
          coding_session_id: descriptor.session_id,
          custody_secret_id: descriptor.custody_secret_id,
          revision: custody.revision,
        })),
      });
      generation = inspectGeneration(transaction.value, owned.root, deps);
    } catch {
      return closeFailure('managed-domain-custody-receipt-unconfirmed', {
        persisted: true,
        quarantined: true,
      });
    }
  }
  let archive = null;
  if (!providerAbsent) {
    archive = persistManagedProviderArchive({
      root: owned.root,
      tool: TOOL,
      descriptor,
      providerArtifact,
      providerRoot: descriptor.claude_config_dir,
    });
    if (!archive.ok) {
      return closeFailure(archive.reason, {
        persisted: true,
        quarantined: true,
      });
    }
    const durableArchive = generation?.receipts?.['archive-ready']?.data;
    if (durableArchive
      && (durableArchive.provider_session_id !== archive.state.provider_session_id
        || durableArchive.archive_digest !== archive.state.archive_digest)) {
      return closeFailure('managed-domain-archive-integrity-lost', {
        persisted: true,
        quarantined: true,
      });
    }
    if (transaction.value && !durableArchive) {
      try {
        receipt('archive-ready', {
          provider_session_id: archive.state.provider_session_id,
          archive_digest: archive.state.archive_digest,
        });
      } catch {
        return closeFailure('managed-domain-archive-receipt-unconfirmed', {
          persisted: true,
          quarantined: true,
        });
      }
    }
  }
  if (!removeDomainPaths(owned) || !removeLease(owned.leasePath)) {
    return closeFailure('managed-domain-cleanup-unconfirmed', {
      persisted: true,
      quarantined: true,
    });
  }
  if (transaction.value) {
    try {
      receipt('domain-cleaned', { domain_generation: descriptor.generation });
      receipt('ready', {
        provider_session_id: archive?.state?.provider_session_id || null,
        archive_digest: archive?.state?.archive_digest || null,
      });
    } catch {
      return closeFailure('managed-domain-ready-receipt-unconfirmed', {
        persisted: true,
      });
    }
  }
  return {
    ok: true,
    persisted: true,
    quarantined: false,
    reason: 'managed-domain-closed',
    provider_session_state: archive?.state || null,
  };
}

export function inspectPreparedLocalClaudeCredentialDomain({
  root = mcHome(),
  codingSessionId,
  deps = {},
} = {}) {
  if (!isAbsolute(root || '') || !SESSION_OWNER_ID_RE.test(codingSessionId || '')) {
    return failure('managed-recovery-request-invalid');
  }
  const leasePath = join(
    root,
    'credential-domain-leases',
    'claude-code',
    `${safePart(codingSessionId)}.json`,
  );
  const lease = readPrivateJson(leasePath, 2048);
  if (!lease.ok
    || !exactRecord(lease.value, [
      'schema',
      'provider_adapter',
      'session_id',
      'generation',
    ])
    || lease.value.schema !== LEASE_SCHEMA
    || lease.value.provider_adapter !== MANAGED_CLAUDE_PROVIDER_ID
    || lease.value.session_id !== codingSessionId
    || !uuidV4(lease.value.generation)) {
    return failure('managed-recovery-lease-invalid');
  }
  const domainPath = join(
    root,
    'credential-domains',
    'claude-code',
    safePart(codingSessionId),
    lease.value.generation,
  );
  const manifestPath = join(domainPath, 'manifest.json');
  const manifest = readPrivateJson(manifestPath, 64 * 1024);
  if (!manifest.ok) return failure('managed-recovery-manifest-invalid');
  const descriptor = {
    ...manifest.value,
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifest.body),
  };
  const checked = validateManagedClaudeDescriptor(descriptor, {
    verifyArtifacts: deps.verifyArtifacts || verifyInstalledClaudeC1Artifacts,
  });
  return checked.ok
    ? { ok: true, descriptor }
    : failure(checked.reason);
}

export function inspectLocalClaudeCredentialDomainPresence({
  root = mcHome(),
  codingSessionId,
  deps = {},
} = {}) {
  if (!isAbsolute(root || '') || !SESSION_OWNER_ID_RE.test(codingSessionId || '')) {
    return { kind: 'unknown', reason: 'managed-recovery-request-invalid' };
  }
  const sessionPart = safePart(codingSessionId);
  const leasePath = join(
    root,
    'credential-domain-leases',
    'claude-code',
    `${sessionPart}.json`,
  );
  if (existsSync(leasePath)) {
    const prepared = inspectPreparedLocalClaudeCredentialDomain({
      root,
      codingSessionId,
      deps,
    });
    return prepared.ok
      ? { kind: 'present', descriptor: prepared.descriptor }
      : { kind: 'unknown', reason: prepared.reason };
  }
  try {
    const roots = [
      join(root, 'credential-domains', 'claude-code', sessionPart),
      join(root, 'executor-domains', 'claude-code', sessionPart),
    ];
    return roots.some((path) => existsSync(path) && readdirSync(path).length > 0)
      ? { kind: 'unknown', reason: 'managed-domain-generation-without-lease' }
      : { kind: 'absent' };
  } catch {
    return { kind: 'unknown', reason: 'managed-domain-presence-unreadable' };
  }
}

export function abortLocalClaudeCredentialDomain({ descriptor } = {}) {
  const owned = resolveOwnedPaths(descriptor);
  if (!owned) return failure('managed-domain-descriptor-invalid');
  if (!removeDomainPaths(owned) || !removeLease(owned.leasePath)) {
    return {
      ok: false,
      quarantined: true,
      reason: 'managed-domain-cleanup-unconfirmed',
    };
  }
  return { ok: true, quarantined: false, reason: 'managed-domain-aborted' };
}

export function confirmLocalClaudeCredentialDomainAbsent({
  root = mcHome(),
  codingSessionId,
  domainGeneration,
} = {}) {
  if (!isAbsolute(root || '')
    || !SESSION_OWNER_ID_RE.test(codingSessionId || '')
    || !uuidV4(domainGeneration)) {
    return failure('managed-domain-cleanup-identity-invalid');
  }
  const sessionPart = safePart(codingSessionId);
  const paths = [
    join(root, 'credential-domains', 'claude-code', sessionPart, domainGeneration),
    join(root, 'executor-domains', 'claude-code', sessionPart, domainGeneration),
    join(root, 'credential-domain-leases', 'claude-code', `${sessionPart}.json`),
  ];
  return paths.every(pathAbsent)
    ? { ok: true, absent: true }
    : failure('managed-domain-cleanup-descriptor-required');
}

export function importManagedClaudeRecovery() {
  return {
    ok: false,
    attempted: false,
    reason: 'managed-provider-no-legacy-recovery',
  };
}

export function buildManagedClaudeProviderEnv({
  claudeConfigDir,
  executorHome,
  executorTmp,
  safePath,
  env = process.env,
} = {}) {
  return {
    HOME: executorHome,
    TMPDIR: executorTmp,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    PATH: safePath,
    LANG: env.LANG || 'C.UTF-8',
    LC_ALL: env.LC_ALL || env.LANG || 'C.UTF-8',
    SHELL: '/bin/bash',
    TERM: env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color',
    COLORTERM: env.COLORTERM || 'truecolor',
    ...(env.NO_COLOR === '1' ? { NO_COLOR: '1' } : {}),
  };
}

export function loadManagedClaudeUserPermissions({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  deps = {},
} = {}) {
  const exists = deps.exists || existsSync;
  if (!exists(settingsPath)) {
    return sanitizeManagedClaudePermissions(null);
  }
  try {
    const info = (deps.lstat || lstatSync)(settingsPath);
    if (!info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0
      || info.size > MAX_USER_SETTINGS_BYTES) {
      return failure('managed-provider-user-permissions-invalid');
    }
    const parsed = JSON.parse((deps.readFile || readFileSync)(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return failure('managed-provider-user-permissions-invalid');
    }
    return sanitizeManagedClaudePermissions(parsed.permissions || null);
  } catch {
    return failure('managed-provider-user-permissions-invalid');
  }
}

function validateCloseTransaction({
  descriptor,
  providerArtifact,
  managedTransaction,
  root,
  deps,
}) {
  if (managedTransaction == null) return { ok: true, value: null, generation: null };
  const checked = validateManagedGenerationTransaction(managedTransaction);
  if (!checked.ok
    || checked.value.coding_session_id !== descriptor.session_id
    || (providerArtifact
      && providerArtifact.runtime_generation !== checked.value.runtime_generation)) {
    return failure('managed-domain-transaction-invalid');
  }
  const generation = inspectGeneration(checked.value, root, deps);
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
    return failure('managed-domain-transaction-unconfirmed');
  }
  return { ok: true, value: checked.value, generation };
}

function inspectGeneration(transaction, root, deps) {
  try {
    return (deps.inspectManagedGeneration || inspectManagedGenerationSync)({
      mcHomeDir: root,
      codingSessionId: transaction.coding_session_id,
      runtimeGeneration: transaction.runtime_generation,
    });
  } catch {
    return null;
  }
}

function resolveOwnedPaths(descriptor) {
  if (!descriptor
    || descriptor.schema !== MANAGED_CLAUDE_DOMAIN_SCHEMA
    || descriptor.provider_adapter !== MANAGED_CLAUDE_PROVIDER_ID
    || !uuidV4(descriptor.generation)
    || !SESSION_OWNER_ID_RE.test(descriptor.session_id || '')
    || !isAbsolute(descriptor.domain_path || '')
    || !isAbsolute(descriptor.executor_root || '')
    || !isAbsolute(descriptor.lease_path || '')) return null;
  const sessionPart = safePart(descriptor.session_id);
  const suffix = join('credential-domains', 'claude-code', sessionPart, descriptor.generation);
  const executorSuffix = join('executor-domains', 'claude-code', sessionPart, descriptor.generation);
  const domainPath = resolve(descriptor.domain_path);
  const executorRoot = resolve(descriptor.executor_root);
  const root = domainPath.slice(0, -(suffix.length + 1));
  if (!root
    || domainPath !== join(root, suffix)
    || executorRoot !== join(root, executorSuffix)
    || resolve(descriptor.lease_path)
      !== join(root, 'credential-domain-leases', 'claude-code', `${sessionPart}.json`)) {
    return null;
  }
  return { root, domainPath, executorRoot, leasePath: descriptor.lease_path };
}

function managedClaudeForbiddenPaths({ root, domainPath, cwd }) {
  const home = homedir();
  return [...new Set([
    domainPath,
    join(root, 'credential-domains'),
    join(root, 'state'),
    join(root, 'security'),
    join(home, '.claude'),
    join(home, '.config', 'gh'),
    join(home, '.ssh'),
    join(home, 'Library', 'Keychains'),
    join(home, '.npmrc'),
    join(home, '.netrc'),
    join(home, '.git-credentials'),
  ].map((path) => resolve(path)))]
    .filter((path) => path !== resolve(cwd))
    .filter((path) => !insideOrSame(cwd, path));
}

function managedSafePath({ executorBin, env }) {
  const candidates = [
    executorBin,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const inherited = String(env?.PATH || '').split(':')
    .filter((path) => ['/opt/homebrew/bin', '/usr/local/bin'].includes(path));
  return [...new Set([...candidates, ...inherited])].join(':');
}

function ensurePrivateDirectory(root, path) {
  if (!isAbsolute(root || '') || !insideOrSame(root, path)) {
    throw new Error('managed Claude directory escaped root');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const info = statSync(path);
  if (!info.isDirectory()
    || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || realpathSync(path) !== resolve(path)) {
    throw new Error('managed Claude directory is unsafe');
  }
}

function readPrivateJson(path, maxBytes) {
  try {
    const info = lstatSync(path);
    if (!info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0
      || info.size > maxBytes
      || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || realpathSync(path) !== resolve(path)) return { ok: false };
    const body = readFileSync(path, 'utf8');
    return { ok: true, body, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function removeDomainPaths({ domainPath, executorRoot }) {
  for (const path of [domainPath, executorRoot]) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
  return !existsSync(domainPath) && !existsSync(executorRoot);
}

function removeLease(path) {
  try { unlinkSync(path); } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return !existsSync(path);
}

function pathAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function safePart(value) {
  const prefix = String(value || '').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80);
  return `${prefix || 'unknown'}-${sha256(String(value)).slice(0, 12)}`;
}

function insideOrSame(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function uuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value || '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function closeFailure(reason, extra = {}) {
  return {
    ok: false,
    persisted: extra.persisted === true,
    quarantined: extra.quarantined === true,
    reason,
  };
}

function failure(reason) {
  return { ok: false, reason, error: reason };
}

const MAX_ADOPTED_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/**
 * Import a conversation's transcript from the user's own Claude home into the
 * managed archive, so a session that ran before managed execution resumes its
 * work instead of starting over.
 *
 * Every rule the archive already enforces still applies — it is the same
 * writer, given the user's Claude home as the provider root. What is new is
 * only where the file is read from: a regular file the user owns, named for
 * the exact conversation being resumed, copied by mc and never by the
 * sandboxed tool.
 */
function adoptNativeClaudeTranscript({ root, codingSessionId, providerSessionId }) {
  const userClaudeHome = join(homedir(), '.claude');
  const projectsRoot = join(userClaudeHome, 'projects');
  let sourcePath;
  try {
    sourcePath = findNativeClaudeTranscript(projectsRoot, `${providerSessionId}.jsonl`);
  } catch { return { ok: false }; }
  if (!sourcePath) return { ok: false };
  let stat;
  try { stat = lstatSync(sourcePath); } catch { return { ok: false }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_ADOPTED_TRANSCRIPT_BYTES) return { ok: false };
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) return { ok: false };
  return persistManagedProviderArchive({
    root,
    tool: TOOL,
    descriptor: { session_id: codingSessionId },
    providerArtifact: {
      tool: TOOL,
      coding_session_id: codingSessionId,
      runtime_generation: randomUUID(),
      provider_session_id: providerSessionId,
      transcript_path: sourcePath,
    },
    providerRoot: userClaudeHome,
  });
}

function findNativeClaudeTranscript(directory, fileName, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findNativeClaudeTranscript(path, fileName, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name === fileName) {
      return path;
    }
  }
  return null;
}
