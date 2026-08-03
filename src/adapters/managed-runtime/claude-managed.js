import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  CLAUDE_C1_ARTIFACT_PINS,
  verifyInstalledClaudeC1Artifacts,
} from '../../runtime/broker/c1-artifacts.js';
import {
  managedClaudeC1SourceClosureDigest,
} from './claude-managed-certification.js';

export const MANAGED_CLAUDE_PROVIDER_ID = 'claude-managed-local-v1';
export const MANAGED_CLAUDE_DOMAIN_SCHEMA =
  'mc-local-claude-credential-domain/v1';
export const MANAGED_CLAUDE_PROFILE = 'mc-managed-portable';

const DESCRIPTOR_KEYS = Object.freeze([
  'allowed_unix_socket_paths',
  'c1_certification_path',
  'c1_certification_sha256',
  'c1_source_closure_sha256',
  'claude_config_dir',
  'claude_version',
  'custody_secret_id',
  'denied_read_paths',
  'denied_write_paths',
  'domain_path',
  'executor_bin',
  'executor_home',
  'executor_root',
  'executor_tmp',
  'generation',
  'launch_nonce',
  'lease_path',
  'manifest_path',
  'manifest_sha256',
  'native_binary',
  'native_binary_sha256',
  'profile',
  'provider_adapter',
  'provider_hook_node_path',
  'provider_hook_node_sha256',
  'provider_hook_runner_path',
  'provider_hook_runner_sha256',
  'provider_settings_path',
  'provider_settings_sha256',
  'runtime_host_path',
  'runtime_host_sha256',
  'runtime_node_path',
  'runtime_node_sha256',
  'safe_path',
  'schema',
  'session_id',
  'srt_module',
  'srt_tree_sha256',
  'srt_version',
  'state',
  'workspace',
]);
const MANIFEST_KEYS = Object.freeze(
  DESCRIPTOR_KEYS.filter((key) => !['manifest_path', 'manifest_sha256'].includes(key)),
);
const FORBIDDEN_ARGS = new Set([
  '--settings',
  '--plugin-dir',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--setting-sources',
]);
const MANAGED_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
]);
const SESSION_OWNER_ID_RE = /^(?:sess_[A-Za-z0-9_-]{6,}|mcs_[a-f0-9]{24})$/u;
const MANAGED_PERMISSION_RULE_KEYS = Object.freeze([
  'allow',
  'ask',
  'deny',
]);
const MAX_MANAGED_PERMISSION_RULES = 512;
const MAX_MANAGED_PERMISSION_RULE_BYTES = 4096;
const SAFE_ENV_NAMES = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_ALL',
  'MC_CODING_SESSION_ID',
  'MC_GITHUB_BROKER_SOCKET',
  'MC_PROVIDER_ARTIFACT_SOCKET',
  'MC_RUNTIME_GENERATION',
  'MC_SESSION_CAPABILITIES',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
]);

export function resolveManagedClaudeLaunch({
  launch,
  input,
  deps = {},
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
  if (launch?.id !== 'claude-code' || launch?.shortName !== 'claude') {
    return failure('managed-provider-tool-unsupported');
  }
  const checked = validateManagedClaudeDescriptor(descriptor, deps);
  if (!checked.ok) return checked;
  const argv = validateManagedClaudeArgv(input?.argv);
  if (!argv.ok) return argv;
  const env = sanitizeManagedClaudeProviderEnv(input?.env, descriptor);
  if (!env) return failure('managed-provider-capability-env-invalid');

  const providerArgs = (options = {}) => {
    const rendered = launch.spec.args(argv.argv, options);
    const validated = validateManagedClaudeArgv(rendered);
    if (!validated.ok) throw new Error(validated.reason);
    return [
      descriptor.runtime_host_path,
      '--manifest',
      descriptor.manifest_path,
      '--',
      ...validated.argv,
    ];
  };
  const spec = {
    ...launch.spec,
    bin: descriptor.runtime_node_path,
    args: (_ignored, options = {}) => providerArgs(options),
    spawn: (_ignored, options = {}) => ({
      bin: descriptor.runtime_node_path,
      args: providerArgs(options),
    }),
  };
  return {
    ok: true,
    launch: { ...launch, spec },
    environmentMode: 'replace',
    env,
    descriptor,
  };
}

export function validateManagedClaudeDescriptor(descriptor, {
  readFile = readFileSync,
  realpath = realpathSync,
  stat = statSync,
  verifyArtifacts = verifyInstalledClaudeC1Artifacts,
} = {}) {
  if (!plain(descriptor)
    || !exactKeys(descriptor, DESCRIPTOR_KEYS)
    || descriptor.schema !== MANAGED_CLAUDE_DOMAIN_SCHEMA
    || descriptor.provider_adapter !== MANAGED_CLAUDE_PROVIDER_ID
    || descriptor.state !== 'ready'
    || descriptor.profile !== MANAGED_CLAUDE_PROFILE
    || descriptor.claude_version !== CLAUDE_C1_ARTIFACT_PINS.version
    || descriptor.srt_version !== CLAUDE_C1_ARTIFACT_PINS.srtVersion
    || descriptor.srt_tree_sha256 !== CLAUDE_C1_ARTIFACT_PINS.srtTreeSha256
    || descriptor.c1_source_closure_sha256
      !== managedClaudeC1SourceClosureDigest()
    || !SESSION_OWNER_ID_RE.test(descriptor.session_id || '')
    || !uuidV4(descriptor.generation)
    || !/^[A-Za-z0-9_-]{43}$/u.test(descriptor.launch_nonce || '')
    || typeof descriptor.custody_secret_id !== 'string'
    || !descriptor.custody_secret_id
    || !digest(descriptor.manifest_sha256)
    || !digest(descriptor.c1_certification_sha256)
    || !digest(descriptor.native_binary_sha256)
    || !digest(descriptor.provider_hook_node_sha256)
    || !digest(descriptor.provider_hook_runner_sha256)
    || !digest(descriptor.provider_settings_sha256)
    || !digest(descriptor.runtime_host_sha256)
    || !digest(descriptor.runtime_node_sha256)
    || !pathList(descriptor.denied_read_paths)
    || !pathList(descriptor.denied_write_paths)
    || !pathList(descriptor.allowed_unix_socket_paths)
    || typeof descriptor.safe_path !== 'string'
    || !descriptor.safe_path) {
    return failure('managed-provider-descriptor-invalid');
  }
  const paths = [
    descriptor.c1_certification_path,
    descriptor.claude_config_dir,
    descriptor.domain_path,
    descriptor.executor_bin,
    descriptor.executor_home,
    descriptor.executor_root,
    descriptor.executor_tmp,
    descriptor.lease_path,
    descriptor.manifest_path,
    descriptor.native_binary,
    descriptor.provider_hook_node_path,
    descriptor.provider_hook_runner_path,
    descriptor.provider_settings_path,
    descriptor.runtime_host_path,
    descriptor.runtime_node_path,
    descriptor.srt_module,
    descriptor.workspace,
    ...descriptor.denied_read_paths,
    ...descriptor.denied_write_paths,
    ...descriptor.allowed_unix_socket_paths,
  ];
  if (paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
    return failure('managed-provider-descriptor-invalid');
  }
  if (!inside(descriptor.domain_path, descriptor.manifest_path)
    || !inside(descriptor.executor_root, descriptor.executor_home)
    || !inside(descriptor.executor_root, descriptor.executor_tmp)
    || !inside(descriptor.executor_root, descriptor.executor_bin)
    || !inside(descriptor.executor_home, descriptor.claude_config_dir)
    || !inside(descriptor.claude_config_dir, descriptor.provider_settings_path)
    || inside(descriptor.domain_path, descriptor.executor_root)
    || inside(descriptor.executor_root, descriptor.domain_path)
    || !descriptor.denied_read_paths.includes(descriptor.domain_path)
    || !descriptor.denied_write_paths.includes(descriptor.domain_path)) {
    return failure('managed-provider-domain-path-invalid');
  }

  let manifestBody;
  try {
    const rebound = paths.slice(0, 17).map((path) => realpath(path));
    if (rebound.some((path, index) => path !== resolve(paths[index]))) {
      return failure('managed-provider-domain-path-invalid');
    }
    for (const path of [
      descriptor.domain_path,
      descriptor.executor_bin,
      descriptor.executor_home,
      descriptor.executor_root,
      descriptor.executor_tmp,
      descriptor.claude_config_dir,
    ]) {
      if (!privateOwned(stat(path), { directory: true })) {
        return failure('managed-provider-domain-permissions-invalid');
      }
    }
    for (const path of [
      descriptor.lease_path,
      descriptor.manifest_path,
      descriptor.provider_settings_path,
      descriptor.c1_certification_path,
    ]) {
      if (!privateOwned(stat(path), { directory: false })) {
        return failure('managed-provider-domain-permissions-invalid');
      }
    }
    manifestBody = readFile(descriptor.manifest_path, 'utf8');
    if (sha256(manifestBody) !== descriptor.manifest_sha256) {
      return failure('managed-provider-manifest-mismatch');
    }
    const manifest = JSON.parse(manifestBody);
    if (!plain(manifest)
      || !exactKeys(manifest, MANIFEST_KEYS)
      || MANIFEST_KEYS.some((key) => !sameValue(manifest[key], descriptor[key]))) {
      return failure('managed-provider-manifest-mismatch');
    }
    if (sha256(readFile(descriptor.c1_certification_path))
        !== descriptor.c1_certification_sha256
      || sha256(readFile(descriptor.provider_settings_path))
        !== descriptor.provider_settings_sha256
      || sha256(readFile(descriptor.provider_hook_node_path))
        !== descriptor.provider_hook_node_sha256
      || sha256(readFile(descriptor.provider_hook_runner_path))
        !== descriptor.provider_hook_runner_sha256
      || sha256(readFile(descriptor.runtime_host_path))
        !== descriptor.runtime_host_sha256
      || sha256(readFile(descriptor.runtime_node_path))
        !== descriptor.runtime_node_sha256) {
      return failure('managed-provider-runtime-mismatch');
    }
  } catch {
    return failure('managed-provider-domain-unavailable');
  }
  const artifacts = verifyArtifacts();
  if (!artifacts?.ok
    || artifacts.artifacts?.claudeBinary !== descriptor.native_binary
    || artifacts.artifacts?.srtModule !== descriptor.srt_module
    || artifacts.artifacts?.claudeSha256 !== descriptor.native_binary_sha256
    || artifacts.artifacts?.srtTreeSha256 !== descriptor.srt_tree_sha256) {
    return failure(artifacts?.code || 'managed-provider-release-untrusted');
  }
  return { ok: true };
}

export function validateManagedClaudeArgv(value) {
  if (!Array.isArray(value)
    || value.length > 512
    || value.some((part) => typeof part !== 'string'
      || Buffer.byteLength(part, 'utf8') > 128 * 1024
      || /[\u0000]/u.test(part))) {
    return failure('managed-provider-argv-invalid');
  }
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    const option = part.includes('=') ? part.slice(0, part.indexOf('=')) : part;
    if (FORBIDDEN_ARGS.has(option)) {
      return failure('managed-provider-argv-forbidden');
    }
  }
  return { ok: true, argv: [...value] };
}

export function renderManagedClaudeSettings({
  nodePath,
  hookRunnerPath,
  permissions = null,
} = {}) {
  if (![nodePath, hookRunnerPath]
    .every((path) => typeof path === 'string' && isAbsolute(path))) {
    throw new TypeError('managed Claude hook paths are invalid');
  }
  const checkedPermissions = sanitizeManagedClaudePermissions(permissions);
  if (!checkedPermissions.ok) {
    throw new TypeError('managed Claude permissions are invalid');
  }
  return `${JSON.stringify({
    permissions: checkedPermissions.permissions,
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{
          type: 'command',
          command: [
            shellQuote(nodePath),
            shellQuote(hookRunnerPath),
            '--tool',
            'claude-code',
          ].join(' '),
        }],
      }],
    },
  })}\n`;
}

/**
 * Project only Claude's declarative permission policy into the isolated
 * provider home. User hooks, environment, plugins, bypass toggles, and every
 * other setting remain outside the managed credential domain.
 */
export function sanitizeManagedClaudePermissions(value) {
  if (value != null && !plain(value)) {
    return failure('managed-provider-user-permissions-invalid');
  }
  const source = value || {};
  const permissions = {};
  if (source.defaultMode != null) {
    if (!MANAGED_PERMISSION_MODES.has(source.defaultMode)) {
      return failure('managed-provider-user-permissions-invalid');
    }
    permissions.defaultMode = source.defaultMode;
  }
  let ruleCount = 0;
  for (const key of MANAGED_PERMISSION_RULE_KEYS) {
    if (source[key] == null) continue;
    if (!Array.isArray(source[key])) {
      return failure('managed-provider-user-permissions-invalid');
    }
    const rules = [];
    const seen = new Set();
    for (const rule of source[key]) {
      if (typeof rule !== 'string'
        || !rule.trim()
        || Buffer.byteLength(rule) > MAX_MANAGED_PERMISSION_RULE_BYTES
        || /[\u0000\r\n]/u.test(rule)) {
        return failure('managed-provider-user-permissions-invalid');
      }
      const normalized = rule.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      rules.push(normalized);
      ruleCount += 1;
      if (ruleCount > MAX_MANAGED_PERMISSION_RULES) {
        return failure('managed-provider-user-permissions-invalid');
      }
    }
    permissions[key] = rules;
  }
  // The managed adapter never permits a settings or argv path to disable the
  // permission layer. C1 remains the hard boundary; this is defense in depth.
  permissions.disableBypassPermissionsMode = 'disable';
  return { ok: true, permissions };
}

function sanitizeManagedClaudeProviderEnv(value, descriptor) {
  if (!plain(value)) return null;
  const out = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof value[name] === 'string' && value[name]) out[name] = value[name];
  }
  if (out.CLAUDE_CONFIG_DIR !== descriptor.claude_config_dir
    || out.HOME !== descriptor.executor_home
    || out.TMPDIR !== descriptor.executor_tmp
    || typeof out.PATH !== 'string'
    || !out.PATH.split(':').includes(descriptor.executor_bin)) return null;
  return out;
}

function privateOwned(info, { directory }) {
  return (directory ? info?.isDirectory?.() : info?.isFile?.())
    && !info?.isSymbolicLink?.()
    && (info.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || info.uid === process.getuid());
}

function sameValue(left, right) {
  return plain(left) || Array.isArray(left)
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;
}

function pathList(value) {
  return Array.isArray(value)
    && value.every((path) => typeof path === 'string' && isAbsolute(path));
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function digest(value) {
  return /^[a-f0-9]{64}$/u.test(value || '');
}

function uuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value || '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function failure(reason) {
  return { ok: false, reason, error: reason };
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}
