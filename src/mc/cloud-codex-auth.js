import { join } from 'node:path';

export const CLOUD_CODEX_AUTH_MISSING = 'cloud-codex-auth-missing';
export const CLOUD_CODEX_AUTH_INTERACTIVE_LOGIN = 'cloud-codex-interactive-login';
export const CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE = 'cloud-codex-auth-isolation-unavailable';

const AUTH_ENV_NAMES = Object.freeze([
  'MC_CODEX_API_KEY',
  'OPENAI_API_KEY',
]);

export async function prepareCloudCodexAuth({
  codingSessionId,
  env = process.env,
} = {}) {
  scrubCodexAuthEnv(env);

  if (!codingSessionId) {
    return {
      ok: false,
      reason: CLOUD_CODEX_AUTH_MISSING,
      error: 'Codex cloud auth requires a coding session id.',
    };
  }

  return {
    ok: false,
    reason: CLOUD_CODEX_AUTH_ISOLATION_UNAVAILABLE,
    error: 'Codex cloud auth is disabled until provider credentials are isolated from model-directed execution.',
  };
}

export function codexAuthPath(codexHome) {
  return join(codexHome, 'auth.json');
}

function scrubCodexAuthEnv(env) {
  if (!env || typeof env !== 'object') return;
  for (const name of AUTH_ENV_NAMES) delete env[name];
}
