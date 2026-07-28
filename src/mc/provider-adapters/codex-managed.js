import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANAGED_CODEX_PROVIDER_ID = 'codex-managed-local-v1';
export const MANAGED_CODEX_DOMAIN_SCHEMA = 'mc-local-codex-credential-domain/v1';
export const MANAGED_CODEX_PROFILE = 'mc-managed-portable';
export const MANAGED_CODEX_VERSION = '0.145.0';
export const MANAGED_CODEX_TEAM_ID = '2DC432GLL2';
export const MANAGED_CODEX_RELEASE_SHA256 = Object.freeze({
  'darwin-arm64': '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
});
export const MANAGED_CODEX_RELEASE_PROVENANCE = Object.freeze({
  tag: 'rust-v0.145.0',
  asset: 'codex-package-aarch64-apple-darwin.tar.gz',
  archive_sha256: 'ece937169d4c9e910d60826a6ea4ae7848a16c089403d122e70e7da4ac41ba34',
});
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANAGED_HOOK_RUNNER = join(PACKAGE_ROOT, 'src', 'mc', 'provider-artifact-hook-runner.js');

const SAFE_RESUME_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const MANIFEST_KEYS = Object.freeze([
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
const DESCRIPTOR_KEYS = Object.freeze([
  ...MANIFEST_KEYS,
  'manifest_path',
  'manifest_sha256',
]);

/**
 * Resolve the broker-side launch plan for a managed Codex session.
 *
 * The descriptor contains paths and release evidence only. It never contains
 * an auth artifact, vault key, provider token, or reusable provider bearer.
 * The manifest is re-read from the credential domain so a caller cannot point
 * the broker at an arbitrary CODEX_HOME or replace the verified config.
 */
export function resolveManagedCodexLaunch({
  launch,
  input,
  readFile = readFileSync,
  realpath = realpathSync,
  stat = statSync,
  inspectRelease = inspectManagedCodexNativeRelease,
} = {}) {
  const descriptor = input?.credential_domain;
  if (!descriptor) {
    return {
      ok: true,
      launch,
      environmentMode: 'inherit',
      env: input?.env || {},
    };
  }

  if (launch?.id !== 'codex' || launch?.shortName !== 'codex') {
    return managedFailure('managed-provider-tool-unsupported');
  }
  const checked = validateManagedCodexDescriptor(descriptor, {
    readFile,
    realpath,
    stat,
    inspectRelease,
  });
  if (!checked.ok) return checked;

  const argv = validateManagedCodexArgv(input?.argv);
  if (!argv.ok) return argv;

  const spec = {
    ...launch.spec,
    bin: checked.nativeBinary,
    args: () => ['--strict-config', '--dangerously-bypass-hook-trust', ...argv.argv],
    spawn: () => ({
      bin: checked.nativeBinary,
      args: ['--strict-config', '--dangerously-bypass-hook-trust', ...argv.argv],
    }),
  };

  return {
    ok: true,
    launch: { ...launch, spec },
    environmentMode: 'replace',
    env: sanitizeManagedProviderEnv(input?.env, descriptor),
    descriptor,
  };
}

export function validateManagedCodexDescriptor(descriptor, {
  readFile = readFileSync,
  realpath = realpathSync,
  stat = statSync,
  inspectRelease = inspectManagedCodexNativeRelease,
} = {}) {
  if (!isPlainObject(descriptor)
    || !hasExactKeys(descriptor, DESCRIPTOR_KEYS)
    || descriptor.schema !== MANAGED_CODEX_DOMAIN_SCHEMA
    || descriptor.provider_adapter !== MANAGED_CODEX_PROVIDER_ID
    || descriptor.profile !== MANAGED_CODEX_PROFILE
    || descriptor.codex_version !== MANAGED_CODEX_VERSION
    || !nonEmptyString(descriptor.session_id)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(descriptor.generation || '')
    || !/^[a-zA-Z0-9_-]{43}$/.test(descriptor.launch_nonce || '')
    || !nonEmptyString(descriptor.custody_secret_id)
    || !/^[a-f0-9]{64}$/.test(descriptor.provider_config_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(descriptor.provider_hook_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(descriptor.provider_hook_node_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(descriptor.provider_hook_runner_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(descriptor.manifest_sha256 || '')) {
    return managedFailure('managed-provider-descriptor-invalid');
  }

  const requiredPaths = [
    descriptor.domain_path,
    descriptor.codex_home,
    descriptor.provider_home,
    descriptor.provider_tmp,
    descriptor.executor_root,
    descriptor.executor_home,
    descriptor.executor_tmp,
    descriptor.lease_path,
    descriptor.manifest_path,
    descriptor.native_binary,
    descriptor.provider_config_path,
    descriptor.provider_hook_path,
    descriptor.provider_hook_node_path,
    descriptor.provider_hook_runner_path,
  ];
  if (requiredPaths.some((value) => typeof value !== 'string' || !isAbsolute(value))) {
    return managedFailure('managed-provider-descriptor-invalid');
  }
  if (!isPathInside(descriptor.domain_path, descriptor.codex_home)
    || !isPathInside(descriptor.domain_path, descriptor.provider_home)
    || !isPathInside(descriptor.domain_path, descriptor.provider_tmp)
    || !isPathInside(descriptor.domain_path, descriptor.manifest_path)
    || !isPathInside(descriptor.codex_home, descriptor.provider_config_path)
    || !isPathInside(descriptor.codex_home, descriptor.provider_hook_path)
    || !isPathInside(descriptor.executor_root, descriptor.executor_home)
    || !isPathInside(descriptor.executor_root, descriptor.executor_tmp)
    || isPathInside(descriptor.domain_path, descriptor.executor_root)
    || isPathInside(descriptor.executor_root, descriptor.domain_path)) {
    return managedFailure('managed-provider-descriptor-invalid');
  }

  let manifestBody;
  let manifest;
  let nativeBinary;
  try {
    const resolvedPaths = Object.fromEntries(requiredPaths.map((path) => [path, realpath(path)]));
    if (requiredPaths.some((path) => resolvedPaths[path] !== resolve(path))) {
      return managedFailure('managed-provider-domain-path-invalid');
    }
    const domainPath = resolvedPaths[descriptor.domain_path];
    const executorRoot = resolvedPaths[descriptor.executor_root];
    if (!isPathInside(domainPath, resolvedPaths[descriptor.codex_home])
      || !isPathInside(domainPath, resolvedPaths[descriptor.provider_home])
      || !isPathInside(domainPath, resolvedPaths[descriptor.provider_tmp])
      || !isPathInside(domainPath, resolvedPaths[descriptor.manifest_path])
      || !isPathInside(executorRoot, resolvedPaths[descriptor.executor_home])
      || !isPathInside(executorRoot, resolvedPaths[descriptor.executor_tmp])) {
      return managedFailure('managed-provider-domain-path-invalid');
    }
    const expectedLayout = expectedManagedLayout(descriptor);
    if (!expectedLayout
      || descriptor.domain_path !== expectedLayout.domainPath
      || descriptor.executor_root !== expectedLayout.executorRoot
      || descriptor.provider_tmp !== join(descriptor.domain_path, 'tmp')
      || descriptor.manifest_path !== join(descriptor.domain_path, 'manifest.json')
      || descriptor.executor_home !== join(descriptor.executor_root, 'home')
      || descriptor.executor_tmp !== join(descriptor.executor_root, 'tmp')
      || descriptor.provider_home !== join(descriptor.domain_path, 'home')
      || descriptor.codex_home !== join(descriptor.provider_home, '.codex')
      || descriptor.provider_config_path !== join(descriptor.codex_home, 'config.toml')
      || descriptor.provider_hook_path !== join(descriptor.codex_home, 'hooks.json')
      || descriptor.lease_path !== expectedLayout.leasePath) {
      return managedFailure('managed-provider-domain-path-invalid');
    }
    manifestBody = readFile(descriptor.manifest_path, 'utf8');
    if (sha256(manifestBody) !== descriptor.manifest_sha256) {
      return managedFailure('managed-provider-manifest-mismatch');
    }
    manifest = JSON.parse(manifestBody);
    if (!isPlainObject(manifest) || !hasExactKeys(manifest, MANIFEST_KEYS)) {
      return managedFailure('managed-provider-manifest-mismatch');
    }
    nativeBinary = realpath(descriptor.native_binary);
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
      descriptor.manifest_path,
      join(descriptor.codex_home, 'auth.json'),
      descriptor.provider_config_path,
      descriptor.provider_hook_path,
      descriptor.lease_path,
    ];
    if (privateDirectories.some((path) => !isPrivateOwnedPath(stat(path), { directory: true }))
      || privateFiles.some((path) => !isPrivateOwnedPath(stat(path), { directory: false }))) {
      return managedFailure('managed-provider-domain-permissions-invalid');
    }
  } catch {
    return managedFailure('managed-provider-domain-unavailable');
  }

  const expected = {
    schema: descriptor.schema,
    provider_adapter: descriptor.provider_adapter,
    session_id: descriptor.session_id,
    generation: descriptor.generation,
    launch_nonce: descriptor.launch_nonce,
    profile: descriptor.profile,
    codex_version: descriptor.codex_version,
    codex_team_id: descriptor.codex_team_id,
    native_binary: descriptor.native_binary,
    native_binary_sha256: descriptor.native_binary_sha256,
    domain_path: descriptor.domain_path,
    codex_home: descriptor.codex_home,
    provider_home: descriptor.provider_home,
    provider_tmp: descriptor.provider_tmp,
    executor_root: descriptor.executor_root,
    executor_home: descriptor.executor_home,
    executor_tmp: descriptor.executor_tmp,
    lease_path: descriptor.lease_path,
    custody_secret_id: descriptor.custody_secret_id,
    provider_config_path: descriptor.provider_config_path,
    provider_config_sha256: descriptor.provider_config_sha256,
    provider_hook_path: descriptor.provider_hook_path,
    provider_hook_sha256: descriptor.provider_hook_sha256,
    provider_hook_node_path: descriptor.provider_hook_node_path,
    provider_hook_node_sha256: descriptor.provider_hook_node_sha256,
    provider_hook_runner_path: descriptor.provider_hook_runner_path,
    provider_hook_runner_sha256: descriptor.provider_hook_runner_sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest?.[key] !== value) {
      return managedFailure('managed-provider-manifest-mismatch');
    }
  }
  if (manifest?.state !== 'ready'
    || descriptor.codex_team_id !== MANAGED_CODEX_TEAM_ID
    || !/^[a-f0-9]{64}$/.test(descriptor.native_binary_sha256 || '')
    || !existsSync(join(descriptor.codex_home, 'auth.json'))
    || !existsSync(descriptor.provider_config_path)
    || !existsSync(descriptor.provider_hook_path)) {
    return managedFailure('managed-provider-domain-unavailable');
  }
  try {
    const configBody = readFile(descriptor.provider_config_path, 'utf8');
    const hookBody = readFile(descriptor.provider_hook_path, 'utf8');
    const nodePath = realpath(descriptor.provider_hook_node_path);
    const runnerPath = realpath(descriptor.provider_hook_runner_path);
    if (sha256(configBody) !== descriptor.provider_config_sha256
      || sha256(hookBody) !== descriptor.provider_hook_sha256
      || nodePath !== realpath(process.execPath)
      || runnerPath !== realpath(MANAGED_HOOK_RUNNER)
      || sha256(readFile(nodePath)) !== descriptor.provider_hook_node_sha256
      || sha256(readFile(runnerPath)) !== descriptor.provider_hook_runner_sha256
      || hookBody !== renderManagedCodexProviderHook({
        nodePath,
        runnerPath,
      })) {
      return managedFailure('managed-provider-hook-mismatch');
    }
  } catch {
    return managedFailure('managed-provider-hook-mismatch');
  }
  try {
    if (sha256(readFile(nativeBinary)) !== descriptor.native_binary_sha256) {
      return managedFailure('managed-provider-binary-mismatch');
    }
  } catch {
    return managedFailure('managed-provider-binary-mismatch');
  }
  const release = inspectRelease({
    nativeBinary,
    expectedSha256: descriptor.native_binary_sha256,
  });
  if (!release?.ok) {
    return managedFailure(release?.reason || 'managed-provider-release-untrusted');
  }

  return { ok: true, manifest, nativeBinary };
}

export function inspectManagedCodexNativeRelease({
  nativeBinary,
  expectedSha256,
  deps = {},
} = {}) {
  const platformName = (deps.platform || platform)();
  if (platformName !== 'darwin') {
    return managedFailure('managed-provider-platform-unsupported');
  }
  const target = `${platformName}-${(deps.arch || arch)()}`;
  const pinnedSha256 = (deps.releaseDigests || MANAGED_CODEX_RELEASE_SHA256)[target];
  if (!pinnedSha256 || expectedSha256 !== pinnedSha256) {
    return managedFailure('managed-provider-release-untrusted');
  }
  const run = deps.spawnSync || spawnSync;
  const details = run('codesign', ['-dv', '--verbose=4', nativeBinary], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const signing = `${details.stdout || ''}\n${details.stderr || ''}`;
  const teamId = signing.match(/\bTeamIdentifier=([A-Z0-9]+)\b/)?.[1] || null;
  const identifier = signing.match(/\bIdentifier=([^\s]+)\b/)?.[1] || null;
  if (details.status !== 0 || teamId !== MANAGED_CODEX_TEAM_ID || identifier !== 'codex') {
    return managedFailure('managed-provider-release-untrusted');
  }
  const versionProbe = run(nativeBinary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/var/empty',
    },
  });
  const version = String(versionProbe.stdout || '').match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
  if (versionProbe.status !== 0 || version !== MANAGED_CODEX_VERSION) {
    return managedFailure('managed-provider-version-unsupported');
  }
  try {
    if (sha256(readFileSync(nativeBinary)) !== expectedSha256) {
      return managedFailure('managed-provider-binary-mismatch');
    }
  } catch {
    return managedFailure('managed-provider-binary-mismatch');
  }
  return { ok: true, version, teamId };
}

export function validateManagedCodexArgv(argv = []) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    return managedFailure('managed-provider-argv-invalid');
  }
  if (argv.length === 0) return { ok: true, argv: [] };
  if (argv.length === 2 && argv[0] === 'resume' && SAFE_RESUME_ID.test(argv[1])) {
    return { ok: true, argv: [...argv] };
  }
  return managedFailure('managed-provider-argv-invalid');
}

export function sanitizeManagedProviderEnv(env = {}, descriptor = {}) {
  const allowed = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR']) {
    if (typeof env?.[name] === 'string' && env[name]) allowed[name] = env[name];
  }
  allowed.HOME = descriptor.provider_home;
  allowed.CODEX_HOME = descriptor.codex_home;
  allowed.TMPDIR = descriptor.provider_tmp;
  return allowed;
}

/**
 * The managed CODEX_HOME contains only this generated user hook. The
 * hash-bound config marks the workspace project layer untrusted, so Codex
 * does not load repo-local hooks; the one-shot bypass therefore applies only
 * to the exact hook source verified below.
 */
export function renderManagedCodexProviderHook({
  nodePath = process.execPath,
  runnerPath = MANAGED_HOOK_RUNNER,
} = {}) {
  const command = [
    shellQuote(resolve(nodePath)),
    shellQuote(resolve(runnerPath)),
    '--tool',
    'codex',
  ].join(' ');
  return `${JSON.stringify({
    description: 'Memoro broker-owned provider artifact capture.',
    hooks: {
      SessionStart: [{
        _memoro: 'memoro-cli',
        matcher: 'startup|resume',
        hooks: [{
          type: 'command',
          command,
          timeout: 3,
        }],
      }],
    },
  }, null, 2)}\n`;
}

export function managedFailure(reason) {
  return {
    ok: false,
    reason,
    error: 'managed Codex provider boundary is unavailable',
  };
}

function isPathInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPrivateOwnedPath(stat, { directory }) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) return false;
  if ((stat.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function expectedManagedLayout(descriptor) {
  if (!descriptor?.domain_path || !descriptor?.session_id || !descriptor?.generation) return null;
  const root = resolve(descriptor.domain_path, '..', '..', '..', '..');
  const sessionPart = `${safePathPart(descriptor.session_id)}-${
    sha256(String(descriptor.session_id)).slice(0, 12)
  }`;
  return {
    domainPath: join(
      root,
      'credential-domains',
      'codex',
      sessionPart,
      descriptor.generation,
    ),
    executorRoot: join(
      root,
      'executor-domains',
      'codex',
      sessionPart,
      descriptor.generation,
    ),
    leasePath: join(root, 'credential-domain-leases', 'codex', `${sessionPart}.json`),
  };
}

function safePathPart(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'session';
}
