/**
 * Legacy vault lifecycle cleanup plus credential-blind startup containment.
 *
 * `mc new` / `mc open` / `mc resume` never decrypt or materialise vault
 * plaintext. `mc end` retains the old manifest/shred path so artifacts created
 * by older mc versions can still be removed.
 *
 * The unreachable legacy implementation is retained until the metadata audit
 * and migration in credential-blind-capabilities S2/S5. It must not be
 * re-enabled. Historically this module was responsible for
 *   (a) deciding *which* secrets feed *which* adapter,
 *   (b) calling the adapter's materializeToken / shredToken,
 *   (c) persisting a per-session manifest at
 *       ${MC_HOME}/state/<session-id>-materialised.json so `mc end`
 *       can reverse the operation without re-reading the vault.
 *
 * Phase 3 will install a PreToolUse hook that denies model reads of
 * the materialised paths. We don't do that here.
 *
 * No-leak invariant: tokens travel only through the
 *   vault → decryptSecretPayload → adapter.materializeToken
 * path. We never log a token value; tests assert this via the
 * "secret-bytes-never-leak" suite.
 *
 * Soft-degrade: if the vault is locked OR there's no Memoro token,
 * `materialiseForSession` returns
 *   { ok: false, reason: 'vault-locked', materialised: [], hint: <string> }
 * and the lifecycle prints the hint to stderr but continues. The
 * session just starts without tokens — same UX as today.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { mcHome } from '../paths.js';
import { readCachedVaultKey } from './key-cache.js';
import { deriveVaultKeys, decryptSecretPayload } from './client-crypto.js';
import * as VaultApi from './api.js';
import { normaliseSecretPayload } from './types.js';
import { installHook, uninstallHook } from './hook.js';
import { SECRET_BINDINGS_RELATIVE_PATH, collectBoundLabels, readSecretBindings } from './bindings.js';
import {
  REPO_SECRET_TOOL,
  materialiseRepoBoundSecrets,
  shredRepoMaterialisation,
  verifyRepoMaterialisationShredded,
} from './repo-materialise.js';
import { detectInstalled } from '../../adapters/index.js';
import { getSecret as keychainGet } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';

const PASSPHRASE_ENV = 'MC_VAULT_PASSPHRASE';

/**
 * Per-adapter → vault-provider mapping. The `provider` metadata stored
 * on each vault secret is what links a vault entry to an adapter.
 *
 * This map is INTENTIONALLY narrow: matching is by provider string,
 * not by adapter probing. If a user stores a secret with
 *   --provider anthropic
 * then any installed adapter whose `TOOL_NAME` is in the matching list
 * gets it materialised. Multiple adapters can claim the same provider
 * (e.g. a future "anthropic" matches both claude-code and another).
 */
const ADAPTER_PROVIDERS = {
  claude:  ['anthropic'],
  // Codex commonly authenticates through ChatGPT/Pro, stored in Codex's own
  // auth file. A generic `provider=openai` vault secret may be for mc/dev use,
  // not for Codex itself, so do not auto-materialise it into ~/.codex/auth.json.
  // Add an explicit per-tool secret selection contract before enabling this.
  codex:   [],
  // gemini stub — once the adapter lands, add ['google']
};

/**
 * State directory + per-session manifest file path. The manifest is a
 * JSON file the lifecycle writes at session start and reads at end.
 */
function stateDir() { return join(mcHome(), 'state'); }
export function manifestPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('manifestPath: sessionId required');
  }
  return join(stateDir(), `${sessionId}-materialised.json`);
}

/**
 * Resolve the vault-key for this lifecycle call.
 *
 * Precedence:
 *   1. Cached key in OS keychain (set by `mc vault unlock`).
 *   2. MC_VAULT_PASSPHRASE env — derive on the fly for CI.
 *   3. Neither → return null (caller surfaces the hint).
 *
 * Returns:
 *   { vaultKey, authHash, source } | null
 */
export async function resolveVaultKeyForLifecycle({ portal, deps = {} } = {}) {
  // 1. Try the keychain cache first.
  const cached = await readCachedVaultKey({ deps: deps.cacheDeps }).catch(() => null);
  if (cached) {
    return { vaultKey: cached.vaultKey, authHash: null, source: 'cache' };
  }

  // 2. MC_VAULT_PASSPHRASE → derive against the server's salt.
  const passphrase = (deps.env || process.env)[PASSPHRASE_ENV];
  if (passphrase) {
    if (!portal) return null;
    const status = await VaultApi.getStatus(portal).catch(() => null);
    if (!status?.vault?.setup) return null;
    const { vaultKey, authHash } = await deriveVaultKeys(
      passphrase, status.vault.salt, status.vault.iterations || 600_000,
    );
    return { vaultKey, authHash, source: 'env' };
  }
  return null;
}

/**
 * Build the default portal — same shape `vault.js` uses. Lets the
 * lifecycle hook the existing API surface without duplicating
 * keychain/config plumbing.
 *
 * Returns null when there's no Memoro token (vault is unreachable).
 */
export async function loadDefaultPortal() {
  let token = null;
  try { token = await keychainGet(ACCOUNTS.TOKEN); } catch { token = null; }
  if (!token) return null;
  let config = {};
  try { config = await readConfig(); } catch { /* OK — readConfig soft-degrades */ }
  const apiUrl = getApiUrl([]) || config.apiUrl;
  if (!apiUrl) return null;
  return { apiUrl, token };
}

/**
 * Decrypt all token-shaped secrets in the vault using the given vault-key.
 * Matching to adapters happens after decrypt so explicit `target_tool`
 * can win over legacy provider matching.
 */
async function pullMatchingSecrets({ portal, vaultKey }) {
  // Need an unlocked server-side session to list secrets. The cache
  // tells us the user already unlocked at some point, so re-unlock
  // here using the same authHash (we don't have it from cache → we
  // have to skip this when cache-derived). For the env path we DO
  // have authHash. For the cache path, attempt the list and trust
  // the server to error helpfully if the session expired.
  const listRes = await VaultApi.listSecrets(portal).catch((err) => ({ ok: false, error: err.message }));
  if (!listRes?.ok) {
    return { ok: false, reason: 'list-failed', error: listRes?.error || 'unknown', matches: [] };
  }
  const matches = [];
  for (const wire of (listRes.secrets || [])) {
    try {
      const { label, data } = await decryptSecretPayload(vaultKey, wire);
      const norm = normaliseSecretPayload(data);
      if (!norm) continue;
      if (norm.kind !== 'api_token' && norm.kind !== 'oauth_token') continue;
      if (!norm.token) continue;
      matches.push({ id: wire.id, label, payload: norm });
    } catch { /* skip undecryptable */ }
  }
  return { ok: true, matches };
}

async function hasVaultLookupSignal({ deps = {} } = {}) {
  const cached = await readCachedVaultKey({ deps: deps.cacheDeps }).catch(() => null);
  if (cached) return true;
  return !!(deps.env || process.env)[PASSPHRASE_ENV];
}

/**
 * Re-unlock the vault server-side using a freshly-derived auth hash.
 * Required before /api/vault/secrets returns rows.
 *
 * For the keychain-cached path we don't have authHash, so we just
 * try the list and let the server's response carry the truth.
 * `mc vault unlock` already issued the unlock; the session lifetime
 * on the server is also 15 min so this usually works.
 */
async function ensureUnlocked({ portal, authHash }) {
  if (!authHash) return; // cache path — we trust the existing session
  await VaultApi.unlockVault(portal, { authHash }).catch(() => {});
}

/**
 * Top-level: materialise vault tokens for a session.
 *
 * @param {object} arg
 * @param {string} arg.sessionId       - session name (registry entry name)
 * @param {string} [arg.worktreePath]  - absolute path to the session
 *   worktree. When present AND at least one secret materialises, a
 *   per-session PreToolUse hook is installed at
 *   `<worktree>/.claude/hooks/mc-vault-block-<sid>.sh` and registered
 *   in `<worktree>/.claude/settings.json`. Without `worktreePath` the
 *   lifecycle still materialises but skips hook install (used by tests
 *   that exercise the materialise path in isolation).
 * @param {object} [arg.portal]        - optional injected portal (tests)
 * @param {Array}  [arg.adapters]      - optional list of installed adapters
 *   (tests inject; production uses detectInstalled())
 * @param {object} [arg.deps]          - test injection for keychain + fs
 *
 * Result:
 *   {
 *     ok: true,
 *     materialised: [ { tool, label, materializedPath } ],
 *     skipped: [ { reason, ... } ],
 *     hook?: { installedSettingsPath, hookScriptPath, settingsCreated },
 *   }
 *
 * Or {ok:false, reason:'vault-locked', hint:string} if no key is
 * available.
 */
export async function materialiseForSession({
  sessionId,
  worktreePath,
  portal: portalOverride,
  adapters: adaptersOverride,
  deps = {},
} = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'sessionId-required', materialised: [], hint: 'internal: sessionId missing' };
  }

  // Credential-blind containment boundary. Do not resolve a vault key, fetch
  // ciphertext, decrypt a payload, inspect adapter locations, or create a
  // materialisation manifest. Legacy manifests remain readable by
  // shredForSession so already-owned artifacts can still be cleaned up.
  return {
    ok: true,
    policy: 'credential-blind-v1',
    materialised: [],
    skipped: [{ reason: 'plaintext-materialisation-disabled' }],
  };

  // Exit-before-side-effect: don't even build a portal if state dir
  // can't be created. Throws here propagate to callers as "abort
  // materialisation".
  const writeStateFile = deps.writeFile || writeFile;
  const ensureDir = deps.mkdir || mkdir;
  await ensureDir(stateDir(), { recursive: true, mode: 0o700 }).catch(() => {});

  const installed = adaptersOverride || detectInstalled();
  if (!installed.length) {
    return { ok: true, materialised: [], skipped: [{ reason: 'no-adapters' }] };
  }

  const repoBindingScope = worktreePath
    ? await readRepoBindingScope({ worktreePath, deps })
    : { present: false, labels: new Set() };
  if (repoBindingScope.error) {
    return {
      ok: false,
      reason: 'repo-bindings-invalid',
      materialised: [],
      skipped: [],
      hint: `vault bindings invalid at ${SECRET_BINDINGS_RELATIVE_PATH}: ${repoBindingScope.error}`,
    };
  }

  const explicitTargetLookup = await hasVaultLookupSignal({ deps });
  const skipped = [];
  const candidates = [];
  for (const adapter of installed) {
    const providers = ADAPTER_PROVIDERS[adapter.TOOL_NAME] || [];
    if (typeof adapter.tokenLocations !== 'function') {
      skipped.push({ tool: adapter.TOOL_NAME, reason: 'no-tokenLocations' });
      continue;
    }
    const locations = adapter.tokenLocations();
    if (!locations.length) {
      skipped.push({ tool: adapter.TOOL_NAME, reason: 'empty-locations' });
      continue;
    }
    if (!providers.length && !explicitTargetLookup) {
      skipped.push({ tool: adapter.TOOL_NAME, reason: 'no-provider-mapping' });
      continue;
    }
    candidates.push({ adapter, providers, locations });
  }

  // Nothing in this session's selected tool needs vault materialisation.
  // Return before touching Memoro auth or prompting for vault unlock.
  const needsRepoMaterialisation = !!(worktreePath && repoBindingScope.present && repoBindingScope.labels.size > 0);

  if (!candidates.length && !needsRepoMaterialisation) {
    return { ok: true, materialised: [], skipped };
  }
  if (repoBindingScope.present && repoBindingScope.labels.size === 0 && !needsRepoMaterialisation) {
    for (const { adapter } of candidates) {
      skipped.push({ tool: adapter.TOOL_NAME, reason: 'no-repo-bound-secret' });
    }
    return { ok: true, materialised: [], skipped };
  }

  const portal = portalOverride || await loadDefaultPortal();
  if (!portal) {
    return {
      ok: false, reason: 'no-memoro-token',
      materialised: [], skipped,
      hint: 'vault locked — tokens not materialised for this session; run `mc` to sign in first',
    };
  }

  const resolved = await resolveVaultKeyForLifecycle({ portal, deps });
  if (!resolved) {
    return {
      ok: false, reason: 'vault-locked',
      materialised: [], skipped,
      hint: `vault locked — tokens not materialised for this session; run \`mc vault unlock\` then \`mc open ${sessionId}\``,
    };
  }
  await ensureUnlocked({ portal, authHash: resolved.authHash });

  const pull = await pullMatchingSecrets({
    portal, vaultKey: resolved.vaultKey,
  });
  if (!pull.ok) {
    return {
      ok: false, reason: pull.reason, materialised: [], skipped,
      hint: `vault list failed (${pull.error}); session starting without materialised tokens`,
    };
  }
  const matches = repoBindingScope.present
    ? pull.matches.filter((m) => repoBindingScope.labels.has(m.label))
    : pull.matches;

  // For each adapter, materialise the FIRST matching secret per location.
  // Multi-account / per-session selection is §12h (deferred to phase 4).
  const materialised = [];

  if (needsRepoMaterialisation) {
    const repoRes = await materialiseRepoBoundSecrets({
      bindings: repoBindingScope.bindings,
      matches,
      worktreePath,
      sessionId,
      deps,
    });
    materialised.push(...repoRes.materialised);
    skipped.push(...repoRes.skipped);
  }

  for (const { adapter, providers, locations } of candidates) {
    const match = matches.find((m) => secretMatchesAdapter(m.payload, adapter, providers));
    if (!match) {
      skipped.push({
        tool: adapter.TOOL_NAME,
        reason: repoBindingScope.present ? 'no-repo-bound-secret' : providers.length ? 'no-matching-secret' : 'no-provider-mapping',
      });
      continue;
    }
    for (const location of locations) {
      const res = await adapter.materializeToken({
        token: match.payload.token,
        location,
        sessionId,
      }).catch((err) => ({ ok: false, reason: err.message }));
      if (res?.ok) {
        materialised.push({
          tool: adapter.TOOL_NAME,
          label: match.label,
          location: { type: location.type, path: location.path || null, name: location.name || null },
          materializedPath: res.materializedPath || null,
        });
      } else {
        skipped.push({
          tool: adapter.TOOL_NAME,
          location: { type: location.type, path: location.path || null },
          reason: res?.reason || 'materialize-failed',
        });
      }
    }
  }

  // Manifest: persist materialised list so `mc end` can shred without
  // re-reading the vault. We do NOT persist the token value — only
  // which path was written, by which adapter, for which label.
  //
  // Phase 3: extend the manifest shape with an optional `hooks` block.
  // Backward-compat: drev-4 manifests (no `hooks` key) are still valid;
  // shredForSession just skips the hook-uninstall step.
  const manifest = {
    schema: 1,
    sessionId,
    createdAt: new Date().toISOString(),
    materialised: materialised.map((m) => ({
      tool: m.tool,
      label: m.label,
      location: m.location,
    })),
  };
  const sessionManifestPath = manifestPath(sessionId);
  await writeStateFile(sessionManifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    .catch(() => { /* best-effort; lifecycle continues */ });

  // Phase-3 hook install. Skip when:
  //   - worktreePath wasn't provided (lifecycle-only test path)
  //   - nothing materialised (no paths to block — leaving the worktree
  //     without an mc hook entry is the right outcome)
  let hookResult = null;
  if (worktreePath && materialised.length > 0) {
    try {
      const r = await installHook({
        worktreePath,
        sessionId,
        manifestPath: sessionManifestPath,
        deps,
      });
      if (r.ok) {
        hookResult = {
          installedSettingsPath: r.installedSettingsPath,
          hookScriptPath: r.hookScriptPath,
          settingsCreated: !!r.settingsCreated,
        };
        // Re-write manifest with the hook block so `shredForSession`
        // knows what to unwind.
        const withHooks = { ...manifest, hooks: hookResult };
        await writeStateFile(sessionManifestPath, JSON.stringify(withHooks, null, 2), { mode: 0o600 })
          .catch(() => { /* best-effort */ });
      } else {
        // Hook install failed; surface as skipped but don't fail the
        // whole materialisation. The materialised files exist — the
        // user just doesn't get the LLM-blindness guard for them.
        skipped.push({ reason: 'hook-install-failed', hint: r.reason || null });
      }
    } catch (err) {
      skipped.push({ reason: 'hook-install-threw', hint: err.message });
    }
  }

  return { ok: true, materialised, skipped, hook: hookResult };
}

async function readRepoBindingScope({ worktreePath, deps = {} }) {
  try {
    const bindings = await readSecretBindings({ cwd: worktreePath, deps });
    if (!bindings) return { present: false, labels: new Set() };
    return { present: true, labels: collectBoundLabels(bindings), bindings };
  } catch (err) {
    return { present: true, labels: new Set(), error: err.message };
  }
}

function secretMatchesAdapter(payload, adapter, providers) {
  const targetTool = normaliseTool(payload.target_tool);
  if (targetTool) return targetTool === normaliseTool(adapter.TOOL_NAME);
  return providers.includes(payload.provider);
}

function normaliseTool(tool) {
  if (!tool) return null;
  if (tool === 'claude-code') return 'claude';
  if (tool === 'gemini-cli') return 'gemini';
  return String(tool);
}

/**
 * Shred everything that materialiseForSession wrote. Idempotent —
 * missing manifest / already-shredded files are not errors.
 *
 * Phase 3: also uninstall the PreToolUse hook (if the manifest carries
 * a `hooks` block). The hook lives inside the worktree's `.claude/`,
 * so `worktreePath` is required to reach it. The caller (`mc end`)
 * shreds BEFORE removing the worktree, so the path is still live.
 *
 * Backward-compat: drev-4 manifests (no `hooks` block) skip hook
 * uninstall — they never installed one.
 */
export async function shredForSession({
  sessionId,
  worktreePath,
  adapters: adaptersOverride,
  retainManifestOnFailure = false,
  deps = {},
} = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'sessionId-required', shredded: [] };
  }
  const path = manifestPath(sessionId);
  const readManifest = deps.readFile || readFile;
  const unlinkManifest = deps.unlink || unlink;
  const exists = deps.existsSync || existsSync;

  if (!exists(path)) {
    return {
      ok: true,
      shredded: [],
      reason: 'no-manifest',
      verification: { manifest_path: path, manifest_absent: true, leftovers: [] },
    };
  }

  let manifest;
  try {
    const raw = await readManifest(path, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    // Compatibility default: historically an unreadable manifest was
    // discarded. Permanent teardown opts into retaining it so repair/retry
    // cannot falsely report success while materialised secrets may remain.
    if (!retainManifestOnFailure) {
      try { await unlinkManifest(path); } catch { /* best effort */ }
    }
    return { ok: false, reason: `manifest-unreadable: ${err.message}`, shredded: [] };
  }

  const adapterByTool = new Map();
  for (const a of (adaptersOverride || detectInstalled())) {
    adapterByTool.set(a.TOOL_NAME, a);
  }

  // Phase-3: uninstall the PreToolUse hook BEFORE we remove the
  // adapter files. If anything went wrong we still proceed with shred —
  // the hook ceasing to deny on a path that no longer exists is benign.
  if (worktreePath && manifest.hooks && typeof manifest.hooks === 'object') {
    try {
      await uninstallHook({
        worktreePath,
        sessionId,
        settingsCreatedByMc: !!manifest.hooks.settingsCreated,
        deps,
      });
    } catch { /* best effort */ }
  }

  const shredded = [];
  const failures = [];
  const verificationLeftovers = [];
  for (const m of (manifest.materialised || [])) {
    if (m.tool === REPO_SECRET_TOOL) {
      const res = await shredRepoMaterialisation({ location: m.location, deps })
        .catch((err) => ({ ok: false, reason: err.message }));
      if (res?.ok) {
        shredded.push({ tool: m.tool, location: m.location, removed: !!res.removed });
        const verified = await verifyRepoMaterialisationShredded({
          location: m.location,
          deps,
        });
        if (!verified.ok) {
          failures.push({
            tool: m.tool,
            location: m.location,
            reason: verified.reason || 'shred-verification-failed',
          });
          verificationLeftovers.push({ tool: m.tool, location: m.location });
        }
      } else {
        failures.push({ tool: m.tool, location: m.location, reason: res?.reason || 'shred-failed' });
      }
      continue;
    }
    const adapter = adapterByTool.get(m.tool);
    if (!adapter || typeof adapter.shredToken !== 'function') {
      failures.push({ tool: m.tool, reason: 'adapter-missing' });
      continue;
    }
    // Reconstruct the location shape from the manifest. We persisted
    // type + path + name only, which is enough for shredFile to work.
    const location = {
      type: m.location?.type,
      path: m.location?.path,
      name: m.location?.name,
    };
    const res = await adapter.shredToken({ location, sessionId })
      .catch((err) => ({ ok: false, reason: err.message }));
    if (res?.ok) {
      shredded.push({ tool: m.tool, location, removed: !!res.removed });
      if (location.type === 'file' && location.path && exists(location.path)) {
        failures.push({ tool: m.tool, location, reason: 'materialised-file-leftover' });
        verificationLeftovers.push({ tool: m.tool, location });
      }
    } else {
      failures.push({ tool: m.tool, location, reason: res?.reason || 'shred-failed' });
    }
  }

  // In repair mode, a failed shred keeps the manifest as the exact retry
  // recipe. The default preserves the historical best-effort cleanup.
  if (failures.length === 0 || !retainManifestOnFailure) {
    try {
      await unlinkManifest(path);
    } catch (err) {
      if (retainManifestOnFailure && err?.code !== 'ENOENT') {
        failures.push({ tool: 'manifest', reason: `manifest-unlink-failed: ${err.message}` });
      }
    }
  }

  const manifestAbsent = !exists(path);
  if (!manifestAbsent && failures.length === 0) {
    failures.push({ tool: 'manifest', reason: 'manifest-leftover' });
    verificationLeftovers.push({ tool: 'manifest', location: { type: 'file', path } });
  }
  return {
    ok: failures.length === 0,
    shredded,
    failures,
    verification: {
      manifest_path: path,
      manifest_absent: manifestAbsent,
      leftovers: verificationLeftovers,
    },
  };
}
