import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TOOL } from '../lib/config.js';

export const PACKAGE_DEFAULTS = Object.freeze({
  defaultTool: DEFAULT_TOOL,
  grounding: Object.freeze({
    includeMcContext: true,
    includeRoadmap: false,
    includeCoordinatorRole: false,
    includeMapLifecycle: false,
    includeLens: false,
  }),
  permissions: Object.freeze({
    profile: 'default',
    workspace: 'worktree',
    network: 'tool-default',
    approval: 'tool-default',
    secrets: 'mc-vault-explicit',
  }),
  dataAccess: Object.freeze({
    cloudflare: Object.freeze({
      guard: 'block-sensitive',
      approvedScripts: Object.freeze([]),
      allowLocalWeakening: false,
    }),
  }),
  instructions: Object.freeze({
    mode: 'preserve',
  }),
});

const SOURCE_PACKAGE = 'package-defaults';
const SOURCE_GLOBAL = '~/.memoro/config.json';
const SOURCE_REPO = '.mc/policy.json';
const SOURCE_LOCAL = '.mc/local.json';
const SOURCE_SESSION = 'session';
const SOURCE_ENV = 'env';
const SOURCE_CLI = 'cli';

const PREFERENCE_PATHS = Object.freeze([
  'defaultTool',
  'language',
  'worktreeRoot',
  'grounding.includeMcContext',
  'grounding.includeRoadmap',
  'grounding.includeCoordinatorRole',
  'grounding.includeMapLifecycle',
  'grounding.includeLens',
  'permissions.profile',
  'dataAccess.cloudflare.approvedScripts',
  'dataAccess.cloudflare.allowLocalWeakening',
  'instructions.mode',
]);

const SAFETY_SPECS = Object.freeze({
  'permissions.workspace': Object.freeze({
    rank: Object.freeze({ full: 0, worktree: 1, 'read-only': 2 }),
  }),
  'permissions.network': Object.freeze({
    rank: Object.freeze({ enabled: 0, 'tool-default': 1, disabled: 2 }),
  }),
  'permissions.approval': Object.freeze({
    rank: Object.freeze({ never: 0, 'tool-default': 1, 'on-request': 2, untrusted: 3 }),
  }),
  'permissions.secrets': Object.freeze({
    rank: Object.freeze({ 'tool-default': 0, 'mc-vault-explicit': 1, disabled: 2 }),
  }),
  'dataAccess.cloudflare.guard': Object.freeze({
    rank: Object.freeze({ off: 0, warn: 1, 'block-sensitive': 2, 'block-all': 3 }),
    allowLocalWeakeningPath: 'dataAccess.cloudflare.allowLocalWeakening',
  }),
});

export function resolveEffectiveConfig({
  globalConfig = {},
  repoPolicy = null,
  localConfig = null,
  entry = {},
  envConfig = null,
  cliConfig = null,
  warnings = [],
} = {}) {
  const layers = [
    { source: SOURCE_PACKAGE, config: normalisePackageConfig(PACKAGE_DEFAULTS) },
    { source: SOURCE_GLOBAL, config: normaliseGlobalConfig(globalConfig) },
    { source: SOURCE_REPO, config: normaliseRepoConfig(repoPolicy) },
    { source: SOURCE_LOCAL, config: normaliseRepoConfig(localConfig) },
    { source: SOURCE_SESSION, config: normaliseSessionConfig(entry) },
    { source: SOURCE_ENV, config: normaliseRepoConfig(envConfig) },
    { source: SOURCE_CLI, config: normaliseRepoConfig(cliConfig) },
  ];
  const result = { warnings: [...warnings] };

  for (const path of PREFERENCE_PATHS) {
    const selected = lastDefined(layers, path);
    if (selected) setPath(result, path, selected);
  }

  for (const [path, spec] of Object.entries(SAFETY_SPECS)) {
    const selected = strictestDefined(layers, path, spec, result.warnings);
    if (selected) setPath(result, path, selected);
  }

  return result;
}

export function readRepoLocalConfig({
  worktreePath = null,
  cwd = process.cwd(),
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  return readOptionalJsonConfig({
    root: worktreePath || cwd,
    relativePath: '.mc/local.json',
    source: SOURCE_LOCAL,
    exists,
    readFile,
  });
}

export function readRepoPolicyConfig({
  worktreePath = null,
  cwd = process.cwd(),
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  return readOptionalJsonConfig({
    root: worktreePath || cwd,
    relativePath: '.mc/policy.json',
    source: SOURCE_REPO,
    exists,
    readFile,
  });
}

export function effectiveConfigValues(effectiveConfig = {}) {
  const out = {};
  copyValue(out, effectiveConfig, 'defaultTool');
  copyValue(out, effectiveConfig, 'language');
  copyValue(out, effectiveConfig, 'worktreeRoot');
  copyValue(out, effectiveConfig, 'grounding.includeMcContext');
  copyValue(out, effectiveConfig, 'grounding.includeRoadmap');
  copyValue(out, effectiveConfig, 'grounding.includeCoordinatorRole');
  copyValue(out, effectiveConfig, 'grounding.includeMapLifecycle');
  copyValue(out, effectiveConfig, 'grounding.includeLens');
  copyValue(out, effectiveConfig, 'permissions.profile');
  copyValue(out, effectiveConfig, 'permissions.workspace');
  copyValue(out, effectiveConfig, 'permissions.network');
  copyValue(out, effectiveConfig, 'permissions.approval');
  copyValue(out, effectiveConfig, 'permissions.secrets');
  copyValue(out, effectiveConfig, 'dataAccess.cloudflare.guard');
  copyValue(out, effectiveConfig, 'dataAccess.cloudflare.approvedScripts');
  copyValue(out, effectiveConfig, 'dataAccess.cloudflare.allowLocalWeakening');
  copyValue(out, effectiveConfig, 'instructions.mode');
  return out;
}

function readOptionalJsonConfig({ root, relativePath, source, exists, readFile }) {
  if (!root) return { config: null, warnings: [] };
  const path = join(root, relativePath);
  if (!exists(path)) return { config: null, warnings: [] };
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: null,
        warnings: [{ code: 'invalid-config-shape', source, path: relativePath }],
      };
    }
    return { config: parsed, warnings: [] };
  } catch (err) {
    return {
      config: null,
      warnings: [{
        code: 'invalid-config-json',
        source,
        path: relativePath,
        message: err.message,
      }],
    };
  }
}

function normalisePackageConfig(config) {
  return config && typeof config === 'object' ? config : {};
}

function normaliseGlobalConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const policy = config.policy && typeof config.policy === 'object' ? config.policy : {};
  return {
    ...config,
    permissions: {
      ...(policy.permissions && typeof policy.permissions === 'object' ? policy.permissions : {}),
      ...(config.permissions && typeof config.permissions === 'object' ? config.permissions : {}),
    },
    dataAccess: {
      ...(policy.dataAccess && typeof policy.dataAccess === 'object' ? policy.dataAccess : {}),
      ...(config.dataAccess && typeof config.dataAccess === 'object' ? config.dataAccess : {}),
    },
  };
}

function normaliseRepoConfig(config) {
  return config && typeof config === 'object' ? config : {};
}

function normaliseSessionConfig(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const policy = entry.policy && typeof entry.policy === 'object' ? entry.policy : {};
  return {
    permissions: policy.permissions && typeof policy.permissions === 'object'
      ? policy.permissions
      : undefined,
    dataAccess: policy.dataAccess && typeof policy.dataAccess === 'object'
      ? policy.dataAccess
      : undefined,
    grounding: policy.grounding && typeof policy.grounding === 'object'
      ? policy.grounding
      : undefined,
    instructions: policy.instructions && typeof policy.instructions === 'object'
      ? policy.instructions
      : undefined,
  };
}

function lastDefined(layers, path) {
  let selected = null;
  for (const layer of layers) {
    const value = getPath(layer.config, path);
    if (value !== undefined) selected = field(value, layer.source);
  }
  return selected ? field(selected.value, selected.source) : null;
}

function strictestDefined(layers, path, spec, warnings) {
  let selected = null;
  let packageFloorRank = null;
  for (const layer of layers) {
    const value = getPath(layer.config, path);
    if (value === undefined) continue;
    const rank = spec.rank[value];
    if (rank === undefined) {
      warnings.push({
        code: 'unknown-config-value',
        path,
        source: layer.source,
        value,
      });
      continue;
    }
    if (!selected) {
      selected = field(value, layer.source, { rank });
      if (layer.source === SOURCE_PACKAGE) packageFloorRank = rank;
      continue;
    }
    if (rank >= selected.rank) {
      selected = field(value, layer.source, { rank });
      continue;
    }
    if (canWeakenSafety({ layer, layers, path, spec, rank, packageFloorRank })) {
      selected = field(value, layer.source, { rank });
      continue;
    }
    warnings.push({
      code: 'safety-weakening-ignored',
      path,
      source: layer.source,
      attempted: value,
      kept: selected.value,
      keptSource: selected.source,
    });
  }
  return selected ? field(selected.value, selected.source) : null;
}

function canWeakenSafety({ layer, layers, spec, rank, packageFloorRank }) {
  if (!spec.allowLocalWeakeningPath) return false;
  if (![SOURCE_LOCAL, SOURCE_SESSION, SOURCE_ENV, SOURCE_CLI].includes(layer.source)) return false;
  if (packageFloorRank != null && rank < packageFloorRank) return false;
  const repoLayer = layers.find((candidate) => candidate.source === SOURCE_REPO);
  return getPath(repoLayer?.config || {}, spec.allowLocalWeakeningPath) === true;
}

function field(value, source, extra = {}) {
  return { value, source, ...extra };
}

function getPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function copyValue(out, effectiveConfig, path) {
  const fieldValue = getPath(effectiveConfig, path);
  if (!fieldValue || !Object.prototype.hasOwnProperty.call(fieldValue, 'value')) return;
  setPath(out, path, fieldValue.value);
}
