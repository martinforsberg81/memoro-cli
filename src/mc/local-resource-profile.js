import { totalmem } from 'node:os';

export const LOCAL_RESOURCE_PROFILE_NAMES = Object.freeze([
  'unlimited',
  'balanced',
  'conservative',
  'custom',
]);

export const LOCAL_RESOURCE_PROFILES = Object.freeze({
  unlimited: Object.freeze({
    profile: 'unlimited',
    enabled: false,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    enabled: true,
    maxConcurrent: 1,
    maxThreads: 4,
    maxRssMb: 4096,
    maxSwapMb: 1024,
    minFreeDiskGb: 15,
  }),
  conservative: Object.freeze({
    profile: 'conservative',
    enabled: true,
    maxConcurrent: 1,
    maxThreads: 2,
    maxRssMb: 2560,
    maxSwapMb: 512,
    minFreeDiskGb: 20,
  }),
});

const CUSTOM_LIMITS = Object.freeze({
  maxConcurrent: Object.freeze({ min: 1, max: 8 }),
  maxThreads: Object.freeze({ min: 1, max: 64 }),
  maxRssMb: Object.freeze({ min: 512, max: 131072 }),
  maxSwapMb: Object.freeze({ min: 0, max: 131072 }),
  minFreeDiskGb: Object.freeze({ min: 0, max: 4096 }),
});

export function resolveLocalResourceProfile(config = {}) {
  const stored = config?.resources?.localHeavyJobs;
  return normaliseLocalResourceProfile(stored);
}

export function normaliseLocalResourceProfile(value = null) {
  const raw = typeof value === 'string' ? { profile: value } : value;
  const profile = String(raw?.profile || 'unlimited').toLowerCase();
  if (profile === 'unlimited') return { ...LOCAL_RESOURCE_PROFILES.unlimited };
  if (profile === 'balanced') return { ...LOCAL_RESOURCE_PROFILES.balanced };
  if (profile === 'conservative') return { ...LOCAL_RESOURCE_PROFILES.conservative };
  if (profile !== 'custom') return { ...LOCAL_RESOURCE_PROFILES.unlimited };

  const custom = { profile: 'custom', enabled: true };
  for (const [field, limits] of Object.entries(CUSTOM_LIMITS)) {
    const parsed = integerInRange(raw?.[field], limits);
    if (parsed == null) return { ...LOCAL_RESOURCE_PROFILES.unlimited };
    custom[field] = parsed;
  }
  return custom;
}

export function buildLocalResourceProfile(profile, custom = {}) {
  const name = String(profile || '').toLowerCase();
  if (!LOCAL_RESOURCE_PROFILE_NAMES.includes(name)) {
    throw new Error(`unknown resource profile: ${profile}`);
  }
  if (name !== 'custom') return normaliseLocalResourceProfile({ profile: name });

  const value = { profile: 'custom' };
  for (const [field, limits] of Object.entries(CUSTOM_LIMITS)) {
    const parsed = integerInRange(custom[field], limits);
    if (parsed == null) {
      throw new Error(`${field} must be an integer between ${limits.min} and ${limits.max}`);
    }
    value[field] = parsed;
  }
  return normaliseLocalResourceProfile(value);
}

export function resourceProfileConfigValue(profile) {
  const resolved = normaliseLocalResourceProfile(profile);
  if (resolved.profile !== 'custom') return { profile: resolved.profile };
  const { enabled: _enabled, ...stored } = resolved;
  return stored;
}

export function withLocalResourceProfile(config = {}, profile = LOCAL_RESOURCE_PROFILES.unlimited) {
  return {
    ...config,
    resources: {
      ...(config.resources && typeof config.resources === 'object' ? config.resources : {}),
      localHeavyJobs: resourceProfileConfigValue(profile),
    },
  };
}

export function recommendLocalResourceProfile({ totalMemoryBytes = totalmem() } = {}) {
  const gib = Number(totalMemoryBytes) / (1024 ** 3);
  if (!Number.isFinite(gib) || gib <= 12) return 'conservative';
  if (gib <= 32) return 'balanced';
  return 'unlimited';
}

export function describeLocalResourceProfile(value) {
  const profile = normaliseLocalResourceProfile(value);
  if (!profile.enabled) return 'unlimited (no local limits)';
  return `${profile.profile} (${profile.maxConcurrent} job, ${profile.maxThreads} threads, ${profile.maxRssMb} MB memory guard)`;
}

export function customResourceLimits() {
  return Object.fromEntries(Object.entries(CUSTOM_LIMITS).map(([key, value]) => [key, { ...value }]));
}

function integerInRange(value, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}
