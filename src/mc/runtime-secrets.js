export const RUNTIME_SECRET_ENV_NAMES = Object.freeze([
  'MEMORO_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

export function scrubRuntimeSecretsFromEnv(env = process.env) {
  const next = { ...(env || {}) };
  for (const name of RUNTIME_SECRET_ENV_NAMES) {
    delete next[name];
  }
  return next;
}

export function scrubRuntimeSecretsInPlace(env) {
  if (!env || typeof env !== 'object') return env;
  for (const name of RUNTIME_SECRET_ENV_NAMES) {
    delete env[name];
  }
  return env;
}
