import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mcHome } from './paths.js';

export const RUNTIME_SECRET_ENV_NAMES = Object.freeze([
  'MEMORO_TOKEN',
  'MEMORO_BROKER_TOKEN',
  'MC_VAULT_PASSPHRASE',
  'MC_CLOUD_GIT_TOKEN',
  'MC_CLOUD_GIT_SECRET_CAPABILITY',
  'MC_GIT_CLONE_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
  'MC_CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_PROFILE',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'WRANGLER_API_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'NETRC',
]);

export const PROVIDER_API_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY',
  'OPENAI_API_KEY', 'MC_CODEX_API_KEY',
]);

export function scrubProviderApiKeysFromEnv(env = process.env) {
  const next = { ...(env || {}) };
  for (const name of [...PROVIDER_API_ENV_NAMES, ...registeredRuntimeSecretNames(env)]) delete next[name];
  return next;
}

export function scrubRuntimeSecretsFromEnv(env = process.env) {
  const next = { ...(env || {}) };
  for (const name of [...RUNTIME_SECRET_ENV_NAMES, ...registeredRuntimeSecretNames(env)]) {
    delete next[name];
  }
  return next;
}

export function scrubRuntimeSecretsInPlace(env) {
  if (!env || typeof env !== 'object') return env;
  for (const name of [...RUNTIME_SECRET_ENV_NAMES, ...registeredRuntimeSecretNames(env)]) {
    delete env[name];
  }
  return env;
}

/** Nonsecret, global name metadata: no worktree setup, and no vault decrypt at launch. */
function runtimeNamesDirectory(env) { return join(mcHome({ ...process.env, ...env }), 'runtime-secret-names'); }
export function rememberRuntimeSecretNames(names, env = process.env) {
  const directory = runtimeNamesDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error('invalid runtime secret name');
    // A hash filename also supports long dotenv names. Contents are names only.
    const file = join(directory, createHash('sha256').update(name).digest('hex'));
    try { writeFileSync(file, name, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
function registeredRuntimeSecretNames(env) {
  const directory = runtimeNamesDirectory(env);
  let files;
  try { files = readdirSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('cannot read script-key name registry');
  }
  try {
    return files.map(file => {
      const name = readFileSync(join(directory, file), 'utf8');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
        || createHash('sha256').update(name).digest('hex') !== file) throw new Error('invalid registry');
      return name;
    });
  }
  catch { throw new Error('cannot read script-key name registry'); }
}
