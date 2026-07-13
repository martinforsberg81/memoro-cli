import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ACCOUNTS } from '../commands/auth.js';
import { getSecret as keychainGet } from '../lib/keychain.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { encryptSecretPayload, decryptSecretPayload } from './vault/client-crypto.js';
import { readCachedVaultKey } from './vault/key-cache.js';
import { deriveVaultKeys } from './vault/client-crypto.js';
import { mcHome } from './paths.js';
import * as VaultApi from './vault/api.js';
import {
  buildSecretPayload,
  normaliseSecretPayload,
  WIRE_SECRET_TYPE,
} from './vault/types.js';

export const TOOL_AUTH_SCHEMA = 'mc-tool-auth-v1';
export const TOOL_AUTH_MODE = 'native_auth_file';

const PASSPHRASE_ENV = 'MC_VAULT_PASSPHRASE';
const DEFAULT_API_URL = 'https://meetmemoro.app';
const SUPPORTED_TOOLS = new Set(['codex', 'claude']);

export function normalizeToolAuthTool(tool) {
  const value = String(tool || '').trim().toLowerCase();
  if (value === 'claude-code') return 'claude';
  if (value === 'codex-cli') return 'codex';
  return value;
}

export function toolAuthProfileLabel(tool) {
  const normalized = normalizeToolAuthTool(tool);
  if (!SUPPORTED_TOOLS.has(normalized)) return null;
  return `tool_auth.${normalized}`;
}

export function resolveToolAuthSpec({
  tool,
  cloudSessionId = null,
  env = process.env,
} = {}) {
  const normalized = normalizeToolAuthTool(tool);
  const label = toolAuthProfileLabel(normalized);
  if (!label) {
    return { ok: false, reason: 'unsupported-tool', tool: normalized || null };
  }
  const sessionPart = safePathPart(cloudSessionId || env.MC_CLOUD_SESSION_ID || 'default');
  if (normalized === 'codex') {
    const runtimeMcHome = stringOrNull(env.MC_HOME) || mcHome();
    const codexHome = stringOrNull(env.CODEX_HOME)
      || join(runtimeMcHome, 'tool-auth', 'codex', sessionPart);
    return {
      ok: true,
      tool: 'codex',
      label,
      provider: 'openai',
      authPath: join(codexHome, 'auth.json'),
      locationId: 'codex.auth.json',
      shape: 'codex-auth-json-v1',
      launchEnv: { CODEX_HOME: codexHome },
    };
  }
  const claudeHome = stringOrNull(env.CLAUDE_HOME)
    || join(env.HOME || homedir(), '.claude');
  return {
    ok: true,
    tool: 'claude',
    label,
    provider: 'anthropic',
    authPath: join(claudeHome, '.credentials.json'),
    locationId: 'claude.credentials.json',
    shape: 'claude-credentials-json-v1',
    launchEnv: {},
  };
}

export async function hydrateToolAuth({
  tool,
  cloudSessionId = null,
  env = process.env,
  portal = null,
  deps = {},
} = {}) {
  const spec = resolveToolAuthSpec({ tool, cloudSessionId, env });
  if (!spec.ok) return publicResult({ ok: false, ...spec });

  const context = await resolveVaultContext({ portal, env, deps });
  if (!context.ok) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: false,
      hydrated: false,
      repair_required: true,
      repair_action: context.repair_action || 'unlock_vault',
      reason: context.reason,
      env: spec.launchEnv,
    });
  }

  const found = await findToolAuthSecret({
    portal: context.portal,
    vaultKey: context.vaultKey,
    label: spec.label,
  });
  if (!found) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: false,
      hydrated: false,
      repair_required: true,
      repair_action: 'complete_tool_login',
      reason: 'profile-missing',
      env: spec.launchEnv,
    });
  }

  const payload = normaliseSecretPayload(found.data);
  const raw = payload?.token;
  const normalized = normalizeAuthArtifact(raw, spec);
  if (!normalized.ok) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: true,
      hydrated: false,
      repair_required: true,
      repair_action: 'reauthorize_tool',
      reason: normalized.reason,
      env: spec.launchEnv,
    });
  }

  const write = deps.writeAuthFile || writeAuthFile;
  await write(spec.authPath, normalized.body, deps);
  return publicResult({
    ok: true,
    tool: spec.tool,
    label: spec.label,
    present: true,
    hydrated: true,
    repair_required: false,
    repair_action: null,
    reason: null,
    env: spec.launchEnv,
  });
}

export async function persistToolAuth({
  tool,
  cloudSessionId = null,
  env = process.env,
  portal = null,
  deps = {},
} = {}) {
  const spec = resolveToolAuthSpec({ tool, cloudSessionId, env });
  if (!spec.ok) return publicResult({ ok: false, ...spec });

  const read = deps.readAuthFile || readAuthFile;
  const artifact = await read(spec.authPath, spec, deps);
  if (!artifact.exists) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: false,
      persisted: false,
      changed: false,
      repair_required: false,
      repair_action: 'complete_tool_login',
      reason: 'auth-file-missing',
      env: spec.launchEnv,
    });
  }
  if (!artifact.ok) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: true,
      persisted: false,
      changed: false,
      repair_required: true,
      repair_action: 'reauthorize_tool',
      reason: artifact.reason,
      env: spec.launchEnv,
    });
  }

  const context = await resolveVaultContext({ portal, env, deps });
  if (!context.ok) {
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: true,
      persisted: false,
      changed: false,
      repair_required: true,
      repair_action: context.repair_action || 'unlock_vault',
      reason: context.reason,
      env: spec.launchEnv,
    });
  }

  const found = await findToolAuthSecret({
    portal: context.portal,
    vaultKey: context.vaultKey,
    label: spec.label,
  });
  const nextPayload = toolAuthPayload(spec, artifact.body);
  if (found) {
    const existing = normaliseSecretPayload(found.data);
    const existingArtifact = normalizeAuthArtifact(existing?.token, spec);
    if (existingArtifact.ok && existingArtifact.body === artifact.body) {
      return publicResult({
        ok: true,
        tool: spec.tool,
        label: spec.label,
        present: true,
        persisted: true,
        changed: false,
        repair_required: false,
        repair_action: null,
        reason: 'unchanged',
        env: spec.launchEnv,
      });
    }
    const enc = await encryptSecretPayload(context.vaultKey, spec.label, nextPayload);
    await VaultApi.updateSecret(context.portal, found.id, vaultWriteBody(enc));
    return publicResult({
      ok: true,
      tool: spec.tool,
      label: spec.label,
      present: true,
      persisted: true,
      changed: true,
      action: 'updated',
      repair_required: false,
      repair_action: null,
      reason: null,
      env: spec.launchEnv,
    });
  }

  const enc = await encryptSecretPayload(context.vaultKey, spec.label, nextPayload);
  await VaultApi.createSecret(context.portal, vaultWriteBody(enc));
  return publicResult({
    ok: true,
    tool: spec.tool,
    label: spec.label,
    present: true,
    persisted: true,
    changed: true,
    action: 'created',
    repair_required: false,
    repair_action: null,
    reason: null,
    env: spec.launchEnv,
  });
}

export function startToolAuthPersistWatcher({
  tool,
  cloudSessionId = null,
  env = process.env,
  portal = null,
  deps = {},
  intervalMs = 5_000,
  onResult = null,
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await persistToolAuth({ tool, cloudSessionId, env, portal, deps });
      if (typeof onResult === 'function') await onResult(result);
      if (result.persisted || result.repair_required) {
        stopped = true;
        if (timer) clearInterval(timer);
      }
    } catch (err) {
      if (typeof onResult === 'function') {
        await onResult(publicResult({
          ok: false,
          tool: normalizeToolAuthTool(tool),
          reason: safeReason(err),
          repair_required: true,
          repair_action: 'retry',
        }));
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, Math.max(500, Number(intervalMs) || 5_000));
  timer.unref?.();
  tick();
  return async ({ flush = false } = {}) => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (flush && !running) {
      const result = await persistToolAuth({ tool, cloudSessionId, env, portal, deps });
      if (typeof onResult === 'function') await onResult(result);
      return result;
    }
    return null;
  };
}

export function publicToolAuthResult(result) {
  return publicResult(result);
}

async function resolveVaultContext({ portal, env = process.env, deps = {} } = {}) {
  const cached = await readCachedVaultKey({ deps: deps.cacheDeps }).catch(() => null);
  const passphrase = stringOrNull(env[PASSPHRASE_ENV]);
  if (!cached && !passphrase) {
    return { ok: false, reason: 'vault-key-missing', repair_action: 'unlock_vault' };
  }

  const resolvedPortal = portal || await loadToolAuthPortal({ env, deps });
  if (!resolvedPortal) {
    return { ok: false, reason: 'memoro-token-missing', repair_action: 'sign_in' };
  }
  if (cached) return { ok: true, portal: resolvedPortal, vaultKey: cached.vaultKey };

  const status = await VaultApi.getStatus(resolvedPortal).catch((err) => ({ ok: false, error: err.message }));
  if (!status?.vault?.setup) {
    return { ok: false, reason: 'vault-not-setup', repair_action: 'setup_vault' };
  }
  const { vaultKey, authHash } = await deriveVaultKeys(
    passphrase,
    status.vault.salt,
    status.vault.iterations || 600_000,
  );
  await VaultApi.unlockVault(resolvedPortal, { authHash }).catch(() => {});
  return { ok: true, portal: resolvedPortal, vaultKey };
}

async function loadToolAuthPortal({ env = process.env, deps = {} } = {}) {
  const token = stringOrNull(env.MEMORO_TOKEN)
    || await (deps.getSecret || keychainGet)(ACCOUNTS.TOKEN).catch(() => null);
  if (!token) return null;
  const config = await (deps.readConfig || readConfig)().catch(() => ({}));
  const apiUrl = safeUrl(env.MEMORO_API_URL)
    || safeUrl(getApiUrl([]))
    || safeUrl(config.apiUrl)
    || DEFAULT_API_URL;
  return {
    apiUrl,
    token,
    ...(deps.memoroFetch ? { memoroFetch: deps.memoroFetch } : {}),
  };
}

async function findToolAuthSecret({ portal, vaultKey, label }) {
  const listRes = await VaultApi.listSecrets(portal).catch((err) => ({ ok: false, error: err.message }));
  if (!listRes?.ok) return null;
  for (const wire of (listRes.secrets || [])) {
    try {
      const { label: decryptedLabel, data } = await decryptSecretPayload(vaultKey, wire);
      if (decryptedLabel === label) return { id: wire.id, label: decryptedLabel, data, raw: wire };
    } catch {
      // Skip secrets encrypted for another key or with an older malformed shape.
    }
  }
  return null;
}

async function readAuthFile(path, spec, deps = {}) {
  const exists = deps.existsSync || existsSync;
  if (!exists(path)) return { exists: false, ok: false, reason: 'auth-file-missing' };
  try {
    const raw = await (deps.readFile || readFile)(path, 'utf8');
    const normalized = normalizeAuthArtifact(raw, spec);
    return { exists: true, ...normalized };
  } catch (err) {
    return { exists: true, ok: false, reason: safeReason(err) };
  }
}

async function writeAuthFile(path, body, deps = {}) {
  await (deps.mkdir || mkdir)(dirname(path), { recursive: true, mode: 0o700 });
  await (deps.writeFile || writeFile)(path, body, { mode: 0o600 });
  return path;
}

function normalizeAuthArtifact(raw, spec) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'auth-artifact-empty' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'auth-artifact-not-object' };
    }
    if (spec.tool === 'codex' && !('auth_mode' in parsed) && !('tokens' in parsed) && !('OPENAI_API_KEY' in parsed)) {
      return { ok: false, reason: 'codex-auth-shape-unrecognized' };
    }
    return { ok: true, body: JSON.stringify(parsed) };
  } catch {
    return { ok: false, reason: 'auth-artifact-invalid-json' };
  }
}

function toolAuthPayload(spec, token) {
  return buildSecretPayload({
    kind: 'oauth_token',
    token,
    provider: spec.provider,
    targetTool: spec.tool,
    targetAuthMode: TOOL_AUTH_MODE,
    targetLocation: spec.locationId,
    extra: {
      tool_auth_schema: TOOL_AUTH_SCHEMA,
      artifact_format: 'json',
      artifact_shape: spec.shape,
    },
  });
}

function vaultWriteBody(enc) {
  return {
    secretType: WIRE_SECRET_TYPE,
    encryptedLabel: enc.encryptedLabel,
    encryptedData: enc.encryptedData,
    iv: enc.iv,
    labelIv: enc.labelIv,
  };
}

function publicResult(result = {}) {
  const out = {
    ok: result.ok !== false,
    tool: result.tool || null,
    label: result.label || null,
    present: result.present === true,
    hydrated: result.hydrated === true,
    persisted: result.persisted === true,
    changed: result.changed === true,
    repair_required: result.repair_required === true,
    repair_action: result.repair_action || null,
    reason: result.reason || null,
    action: result.action || null,
    secret_boundary: 'status_only',
  };
  if (result.env && typeof result.env === 'object') {
    Object.defineProperty(out, 'env', {
      value: result.env,
      enumerable: false,
      configurable: true,
    });
  }
  return out;
}

function safePathPart(value) {
  return String(value || 'default')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
}

function safeReason(err) {
  return String(err?.message || err || 'unknown').slice(0, 120);
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
