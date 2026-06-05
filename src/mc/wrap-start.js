/**
 * Start-path helpers for bare `mc` / wrap mode.
 *
 * Keep these decisions outside `bin-mc.js`: the bin owns the PTY, sockets,
 * and process lifecycle; this module owns the small contracts that must be
 * stable across bare `mc`, `mc new`, and `mc resume`.
 */
import { findEntry } from './registry.js';
import { readRepoPolicy, resolveEffectivePolicy } from './policy.js';

export function resolveRequestedToolForWrap({ env = process.env, config = {} } = {}) {
  return env.MC_GROUNDING_TOOL || config.defaultTool || 'claude-code';
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
  const entry = sessionName ? (lookupEntry(sessionName) || {}) : {};
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
  if (!parts || typeof parts !== 'object') return null;
  if (typeof parts.map === 'string' && parts.map.trim()) return null;
  const lifecycle = typeof parts.lifecycle === 'string' ? parts.lifecycle : '';
  if (!/no `MEMORO\.md`|no MEMORO\.md/i.test(lifecycle)) return null;
  return [
    'This repo is missing `MEMORO.md`.',
    '',
    'Before doing any other work, ask me whether you should create it. Do not create or overwrite the file before I explicitly agree.',
    '',
    'If I say yes, build the first `MEMORO.md` inside this coding session: inspect the repo evidence first (README, package/manifest files, docs, plans, tests, git status/log where useful), then write a concise first draft using the grounding skeleton. Do not stop at an empty skeleton and do not ask broad discovery questions before making that first evidence-based draft. Use placeholders only for facts the repo does not support, and after writing the file, summarize the assumptions/gaps for me to correct.',
  ].join('\n');
}
