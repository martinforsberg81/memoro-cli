/**
 * Start-path helpers for bare `mc` / wrap mode.
 *
 * Keep these decisions outside `bin-mc.js`: the bin owns the PTY, sockets,
 * and process lifecycle; this module owns the small contracts that must be
 * stable across bare `mc`, `mc new`, and `mc resume`.
 */
import { findEntry } from './registry.js';
import { readRepoPolicy, resolveEffectivePolicy } from './policy.js';
import { DEFAULT_TOOL } from '../lib/config.js';

export function resolveRequestedToolForWrap({ env = process.env, config = {} } = {}) {
  return env.MC_GROUNDING_TOOL || config.defaultTool || DEFAULT_TOOL;
}

export function resolveWrapFocus({ label = null, env = process.env } = {}) {
  return label || env.MC_GROUNDING_FOCUS || null;
}

export function resolvePolicyForWrap({
  sessionName = null,
  cwd = process.cwd(),
  tool = null,
  config = {},
  deps = {},
} = {}) {
  const lookupEntry = deps.findEntry || findEntry;
  const readPolicy = deps.readRepoPolicy || readRepoPolicy;
  const resolvePolicy = deps.resolveEffectivePolicy || resolveEffectivePolicy;
  const entry = sessionName
    ? (deps.findEntry
      ? (lookupEntry(sessionName) || {})
      : (lookupEntry(sessionName, { cwd }) || {}))
    : {};
  const repoPolicy = readPolicy({ worktreePath: cwd, cwd });
  return resolvePolicy({ entry, tool, repoPolicy, config });
}

export async function materialiseVaultForWrap({
  codingSessionId,
  cwd,
  launchAdapter,
  env = process.env,
  stderr = process.stderr,
  deps = {},
} = {}) {
  if (env.MC_VAULT_STARTUP_DONE === '1') {
    return {
      ok: true,
      materialised: [],
      skipped: [{ reason: 'already-materialised' }],
      sessionId: null,
      shouldShredOnExit: false,
    };
  }

  const sessionId = env.MC_SESSION_NAME || codingSessionId;
  if (!sessionId) {
    return {
      ok: false,
      reason: 'sessionId-required',
      materialised: [],
      hint: 'internal: session id missing for vault materialisation',
      sessionId: null,
      shouldShredOnExit: false,
    };
  }

  const materialise = deps.materialiseVaultBeforeLaunch
    || (await import('./vault/startup.js')).materialiseVaultBeforeLaunch;
  const res = await materialise({
    sessionId,
    worktreePath: cwd,
    adapters: launchAdapter ? [launchAdapter] : undefined,
  });
  if (!res.ok && res.hint) {
    stderr.write(`mc: ${res.hint}\n`);
  }
  return {
    ...res,
    sessionId,
    shouldShredOnExit: !env.MC_SESSION_NAME,
  };
}

export function startupMessageFromGroundingParts(parts) {
  void parts;
  // PR3 context cleanup: normal startup must not send a missing-MEMORO prompt.
  // Startup messages remain available for adapter-delivered grounding, but
  // repo-map lifecycle heuristics are no longer a separate fallback prompt.
  return null;
}
