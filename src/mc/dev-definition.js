import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { readConfig } from '../lib/config.js';
import { getRepoContext } from '../lib/git-context.js';
import {
  readRepoLocalConfig,
  resolveEffectiveConfig,
} from './config-model.js';

export const DEV_DEFINITION_RELATIVE_PATH = '.mc/dev.json';
export const DEV_DEFINITION_NOT_FOUND = 'DEV_DEFINITION_NOT_FOUND';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const RESOURCE_CLASSES = new Set(['standard', 'heavy']);

export function loadDevDefinition({
  worktreePath,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  if (!worktreePath) throw new TypeError('worktreePath is required');
  const path = join(worktreePath, DEV_DEFINITION_RELATIVE_PATH);
  if (!exists(path)) {
    const error = new Error(`no ${DEV_DEFINITION_RELATIVE_PATH} found in ${worktreePath}`);
    error.code = DEV_DEFINITION_NOT_FOUND;
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(readFile(path, 'utf8'));
  } catch (error) {
    throw definitionError(`contains invalid JSON: ${error.message}`);
  }
  const definition = validateDefinition(raw);
  const fingerprint = `sha256:${createHash('sha256').update(stableStringify(definition)).digest('hex')}`;
  return { path, definition, fingerprint };
}

export async function resolveDevPlan({
  cwd = process.cwd(),
  worktreePath = null,
  serviceName = null,
  profileName = null,
  globalConfig,
  localConfig,
  deps = {},
} = {}) {
  let root = worktreePath;
  if (!root) {
    const repoContext = await (deps.getRepoContext || getRepoContext)(cwd);
    if (!repoContext?.toplevel) throw new Error('not inside a git repository');
    root = repoContext.toplevel;
  }

  const loaded = loadDevDefinition({
    worktreePath: root,
    exists: deps.exists || existsSync,
    readFile: deps.readFile || readFileSync,
  });
  const selectedServiceName = serviceName || loaded.definition.default_service;
  const service = loaded.definition.services[selectedServiceName];
  if (!service) {
    throw definitionError(`service "${selectedServiceName}" is not declared`);
  }

  const resolvedGlobalConfig = globalConfig === undefined
    ? await (deps.readConfig || readConfig)()
    : globalConfig;
  let resolvedLocalConfig = localConfig;
  let warnings = [];
  if (localConfig === undefined) {
    const local = (deps.readRepoLocalConfig || readRepoLocalConfig)({ worktreePath: root });
    resolvedLocalConfig = local.config;
    warnings = local.warnings || [];
  }
  const effective = (deps.resolveEffectiveConfig || resolveEffectiveConfig)({
    globalConfig: resolvedGlobalConfig,
    localConfig: resolvedLocalConfig,
    cliConfig: profileName ? { dev: { profile: profileName } } : null,
    warnings,
  });
  const configuredProfile = effective.dev?.profile || null;
  const selectedProfileName = configuredProfile?.value || service.default_profile;
  const profile = service.profiles[selectedProfileName];
  if (!profile) {
    throw definitionError(`profile "${selectedProfileName}" is not declared for service "${selectedServiceName}"`);
  }

  return {
    schema_version: loaded.definition.schema_version,
    worktree_path: root,
    definition_path: loaded.path,
    definition_fingerprint: loaded.fingerprint,
    service: {
      name: selectedServiceName,
      source: serviceName ? 'cli' : DEV_DEFINITION_RELATIVE_PATH,
    },
    profile: {
      name: selectedProfileName,
      source: configuredProfile?.source || DEV_DEFINITION_RELATIVE_PATH,
    },
    start: profile.start,
    readiness: profile.readiness,
    resource_class: profile.resource_class,
    dependencies: service.dependencies,
    managed_argv_prefixes: service.managed_argv_prefixes,
    warnings: effective.warnings || [],
  };
}

export async function resolveDevSessionEnvironment({
  worktreePath,
  globalConfig,
  stderr = process.stderr,
  resolvePlan = resolveDevPlan,
} = {}) {
  try {
    const plan = await resolvePlan({ worktreePath, globalConfig });
    return {
      MC_DEV_SERVICE: plan.service.name,
      MC_DEV_PROFILE: plan.profile.name,
      MC_DEV_DEFINITION_FINGERPRINT: plan.definition_fingerprint,
    };
  } catch (error) {
    if (error?.code !== DEV_DEFINITION_NOT_FOUND) {
      stderr.write(`mc: dev definition ignored (${error?.message || String(error)}); continuing\n`);
    }
    return {};
  }
}

function validateDefinition(value) {
  assertObject(value, 'root');
  assertKnownFields(value, ['schema_version', 'default_service', 'services'], 'root');
  if (value.schema_version !== 1) {
    throw definitionError('schema_version must be 1');
  }
  assertName(value.default_service, 'default_service');
  assertObject(value.services, 'services');
  if (!Object.keys(value.services).length) throw definitionError('services must not be empty');

  const services = {};
  for (const [serviceName, service] of Object.entries(value.services)) {
    assertName(serviceName, 'service name');
    services[serviceName] = validateService(service, `services.${serviceName}`);
  }
  if (!services[value.default_service]) {
    throw definitionError(`default_service "${value.default_service}" is not declared`);
  }
  return {
    schema_version: 1,
    default_service: value.default_service,
    services,
  };
}

function validateService(value, path) {
  assertObject(value, path);
  assertKnownFields(value, [
    'default_profile',
    'profiles',
    'dependencies',
    'managed_argv_prefixes',
  ], path);
  assertName(value.default_profile, `${path}.default_profile`);
  assertObject(value.profiles, `${path}.profiles`);
  if (!Object.keys(value.profiles).length) throw definitionError(`${path}.profiles must not be empty`);

  const profiles = {};
  for (const [profileName, profile] of Object.entries(value.profiles)) {
    assertName(profileName, `${path} profile name`);
    profiles[profileName] = validateProfile(profile, `${path}.profiles.${profileName}`);
  }
  if (!profiles[value.default_profile]) {
    throw definitionError(`${path}.default_profile "${value.default_profile}" is not declared`);
  }

  if (!Array.isArray(value.managed_argv_prefixes) || !value.managed_argv_prefixes.length) {
    throw definitionError(`${path}.managed_argv_prefixes must be a non-empty array`);
  }
  const managedArgvPrefixes = value.managed_argv_prefixes.map((argv, index) => (
    validateArgv(argv, `${path}.managed_argv_prefixes[${index}]`)
  ));

  return {
    default_profile: value.default_profile,
    profiles,
    dependencies: validateDependencies(value.dependencies, `${path}.dependencies`),
    managed_argv_prefixes: managedArgvPrefixes,
  };
}

function validateProfile(value, path) {
  assertObject(value, path);
  assertKnownFields(value, ['start', 'readiness', 'resource_class'], path);
  assertObject(value.start, `${path}.start`);
  assertKnownFields(value.start, ['argv'], `${path}.start`);
  assertObject(value.readiness, `${path}.readiness`);
  assertKnownFields(value.readiness, ['kind', 'path', 'timeout_ms'], `${path}.readiness`);
  if (value.readiness.kind !== 'runtime-manifest') {
    throw definitionError(`${path}.readiness.kind must be "runtime-manifest"`);
  }
  assertSafeRelativePath(value.readiness.path, `${path}.readiness.path`);
  if (!Number.isInteger(value.readiness.timeout_ms)
    || value.readiness.timeout_ms < 1_000
    || value.readiness.timeout_ms > 600_000) {
    throw definitionError(`${path}.readiness.timeout_ms must be an integer from 1000 to 600000`);
  }
  const resourceClass = value.resource_class ?? 'standard';
  if (!RESOURCE_CLASSES.has(resourceClass)) {
    throw definitionError(`${path}.resource_class must be "standard" or "heavy"`);
  }
  return {
    start: { argv: validateArgv(value.start.argv, `${path}.start`) },
    readiness: {
      kind: 'runtime-manifest',
      path: value.readiness.path,
      timeout_ms: value.readiness.timeout_ms,
    },
    resource_class: resourceClass,
  };
}

function validateDependencies(value, path) {
  assertObject(value, path);
  assertKnownFields(value, ['manager', 'fingerprint_files', 'install'], path);
  if (value.manager !== 'npm') throw definitionError(`${path}.manager must be "npm"`);
  if (!Array.isArray(value.fingerprint_files) || !value.fingerprint_files.length) {
    throw definitionError(`${path}.fingerprint_files must be a non-empty array`);
  }
  const fingerprintFiles = value.fingerprint_files.map((file, index) => {
    assertSafeRelativePath(file, `${path}.fingerprint_files[${index}]`);
    return file;
  });
  assertObject(value.install, `${path}.install`);
  assertKnownFields(value.install, ['argv'], `${path}.install`);
  return {
    manager: 'npm',
    fingerprint_files: fingerprintFiles,
    install: { argv: validateArgv(value.install.argv, `${path}.install`) },
  };
}

function validateArgv(value, path) {
  if (!Array.isArray(value)) throw definitionError(`${path}.argv must be an array`);
  if (!value.length) throw definitionError(`${path}.argv must not be empty`);
  for (const arg of value) {
    if (typeof arg !== 'string' || !arg.length || arg.includes('\0')) {
      throw definitionError(`${path}.argv must contain non-empty strings`);
    }
  }
  return [...value];
}

function assertSafeRelativePath(value, path) {
  const unsafeWindowsAbsolute = typeof value === 'string' && /^[a-zA-Z]:[\\/]/.test(value);
  const segments = typeof value === 'string' ? value.split(/[\\/]+/) : [];
  if (typeof value !== 'string'
    || !value
    || value.includes('\0')
    || isAbsolute(value)
    || unsafeWindowsAbsolute
    || segments.includes('..')
    || segments.includes('')) {
    throw definitionError(`${path} must be a safe relative path`);
  }
}

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw definitionError(`${path} must be an object`);
  }
}

function assertKnownFields(value, fields, path) {
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw definitionError(`${path} has unknown field "${key}"`);
  }
}

function assertName(value, path) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw definitionError(`${path} must be a non-empty name containing letters, numbers, dot, dash, or underscore`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function definitionError(message) {
  const error = new Error(`${DEV_DEFINITION_RELATIVE_PATH} ${message}`);
  error.code = 'DEV_DEFINITION_INVALID';
  return error;
}
