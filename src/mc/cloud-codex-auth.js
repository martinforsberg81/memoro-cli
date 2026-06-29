import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import * as codexAdapter from '../adapters/codex.js';
import { mcHome } from './paths.js';

export const CLOUD_CODEX_AUTH_MISSING = 'cloud-codex-auth-missing';

const AUTH_ENV_NAMES = Object.freeze([
  'MC_CODEX_API_KEY',
  'OPENAI_API_KEY',
]);

export async function prepareCloudCodexAuth({
  codingSessionId,
  env = process.env,
  deps = {},
} = {}) {
  if (!codingSessionId) {
    return {
      ok: false,
      reason: CLOUD_CODEX_AUTH_MISSING,
      error: 'Codex cloud auth requires a coding session id.',
    };
  }

  const existsSync = deps.existsSync || fsExistsSync;
  const existingAuthPath = codexAuthPath(env.CODEX_HOME || join(homedir(), '.codex'));
  const token = firstAuthToken(env);
  if (!token && existsSync(existingAuthPath)) {
    return { ok: true, source: 'existing-auth-file', codexHome: env.CODEX_HOME || join(homedir(), '.codex') };
  }

  if (!token) {
    return {
      ok: false,
      reason: CLOUD_CODEX_AUTH_MISSING,
      error: 'Codex cloud auth missing. Browser login cannot run inside an mc cloud runtime; provide MC_CODEX_API_KEY for the cloud runtime.',
    };
  }

  const codexHome = env.CODEX_HOME || join(mcHome(), 'codex', codingSessionId);
  env.CODEX_HOME = codexHome;
  const location = {
    type: 'file',
    path: codexAuthPath(codexHome),
    format: 'json',
    shape: 'codex-api-key-v1',
  };
  const materializeToken = deps.materializeToken || codexAdapter.materializeToken;
  const materialized = await materializeToken({
    token: token.value,
    location,
    sessionId: codingSessionId,
    deps: deps.materializeDeps || {},
  });
  scrubCodexAuthEnv(env);

  if (!materialized?.ok) {
    return {
      ok: false,
      reason: 'cloud-codex-auth-materialise-failed',
      error: `Codex cloud auth could not be materialised: ${materialized?.reason || 'unknown'}`,
    };
  }

  return {
    ok: true,
    source: token.source,
    codexHome,
    materializedPath: materialized.materializedPath || location.path,
  };
}

export function codexAuthPath(codexHome) {
  return join(codexHome, 'auth.json');
}

function firstAuthToken(env) {
  for (const name of AUTH_ENV_NAMES) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (value) return { value, source: name };
  }
  return null;
}

function scrubCodexAuthEnv(env) {
  if (!env || typeof env !== 'object') return;
  for (const name of AUTH_ENV_NAMES) delete env[name];
}
