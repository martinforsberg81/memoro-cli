import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { resolveToolInput } from '../adapters/index.js';

function vaultAdaptersForTool(launchTool) {
  return launchTool?.adapter ? [launchTool.adapter] : undefined;
}

export function buildReexecEnv({
  baseEnv = process.env,
  sessionName,
  tool,
  launchTool,
  focus = null,
} = {}) {
  const reexecEnv = { ...baseEnv };
  if (focus) reexecEnv.MC_GROUNDING_FOCUS = focus;
  reexecEnv.MC_SESSION_NAME = sessionName;
  reexecEnv.MC_VAULT_STARTUP_DONE = '1';
  if (tool) {
    reexecEnv.MC_GROUNDING_TOOL = launchTool?.id || tool;
  }
  return reexecEnv;
}

/**
 * Shared prelaunch path for `mc new` and `mc resume`.
 *
 * This keeps the high-risk part testable without spawning a real TUI:
 * selected-tool-scoped vault startup, reexec env construction, and the
 * final same-binary `mc` reexec.
 */
export async function launchWithPreflight({
  sessionName,
  worktreePath,
  tool,
  focus = null,
  resume = false,
  env = process.env,
  execPath = process.execPath,
  mcBin = process.argv[1],
  stderr = process.stderr,
  deps = {},
} = {}) {
  const launchTool = tool ? resolveToolInput(tool) : null;
  const materialise = deps.materialiseVaultBeforeLaunch
    || (await import('../vault/engine/startup.js')).materialiseVaultBeforeLaunch;

  try {
    const res = await materialise({
      sessionId: sessionName,
      worktreePath: worktreePath || undefined,
      adapters: vaultAdaptersForTool(launchTool),
    });
    if (!res.ok && res.hint) {
      stderr.write(`mc: ${res.hint}\n`);
    }
  } catch (err) {
    stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }

  const reexecEnv = buildReexecEnv({
    baseEnv: env,
    sessionName,
    tool,
    launchTool,
    focus,
  });
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const args = resume && launchTool?.id === 'claude-code'
    ? [mcBin, '--resume']
    : [mcBin];
  const result = spawnSync(execPath, args, {
    stdio: 'inherit',
    cwd: worktreePath,
    env: reexecEnv,
  });
  return result.status ?? 0;
}
