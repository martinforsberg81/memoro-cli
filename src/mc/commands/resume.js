/**
 * `mc resume <name> [--no-launch] [--json] [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 *
 * Grounding (Phase 2 — entry parity): resume re-execs into wrap mode the
 * same way `mc new` does, so it grounds through the SAME `groundSession`
 * seam in `runWrap` — no forked grounding logic here. The session's label
 * (if any) is threaded across the re-exec as the soft `focus` pointer via
 * `MC_GROUNDING_FOCUS`, matching `mc new`'s `<task>` plumbing.
 */
import { spawnSync } from 'node:child_process';
import { findEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';
import { resolveToolInput } from '../../adapters/index.js';

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    return 2;
  }
  if (!opts.name) {
    console.error('mc: usage — `mc resume <name>` (name required)');
    return 2;
  }
  const entry = findEntry(opts.name);
  if (!entry) {
    console.error(`mc: no such session "${opts.name}"`);
    return 1;
  }

  if (entry.worktree_path) {
    emitCd(entry.worktree_path, { enabled: emitDirectives || undefined });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      name: entry.name,
      tool: entry.tool || 'claude',
      worktree_path: entry.worktree_path || null,
    }, null, 2));
    return 0;
  }

  if (opts.noLaunch || process.env.MC_TEST_MODE === '1') {
    return 0;
  }

  // §12d: pre-launch vault unlock grind BEFORE re-exec. Same contract as
  // `mc new` — if the vault is locked, ask to unlock now (default Y) so the
  // resumed session starts CONNECTED; decline → degraded launch as an
  // explicit choice. Soft-degrades on every error; never blocks the launch.
  try {
    const { ensureVaultUnlockedForLaunch } = await import('../vault/unlock-grind.js');
    await ensureVaultUnlockedForLaunch({
      sessionId: entry.name,
      worktreePath: entry.worktree_path || undefined,
    });
  } catch (err) {
    process.stderr.write(`mc: vault unlock grind failed (${err.message}); continuing without tokens\n`);
  }

  // Re-exec mc in wrap mode with --resume so claude opens its resume
  // picker. Same approach as `mc new`: same binary, cwd=worktree,
  // inherited stdio. Adapter routing for non-claude tools follows §5.
  //
  // Thread the session label as the soft grounding focus across the
  // re-exec (argv is dropped by the wrap path), so the resumed session
  // grounds with the same standing-context pointer through the ONE
  // groundSession seam in runWrap.
  const reexecEnv = { ...process.env };
  if (entry.label) reexecEnv.MC_GROUNDING_FOCUS = entry.label;
  // We already ran the vault unlock grind above (before re-exec). Tell the
  // re-exec'd runWrap not to grind again so the user isn't prompted twice.
  reexecEnv.MC_VAULT_GRIND_DONE = '1';
  // Relaunch under the tool the session was created with, routing the
  // wrap-mode launcher to that adapter (same seam as `mc new`). The
  // wrapper-injected `--resume` is dropped by adapters that have no resume
  // picker (codex); claude consumes it verbatim.
  if (entry.tool) {
    const launchTool = resolveToolInput(entry.tool);
    reexecEnv.MC_GROUNDING_TOOL = launchTool?.id || entry.tool;
  }
  const result = spawnSync(process.execPath, [process.argv[1], '--resume'], {
    stdio: 'inherit',
    cwd: entry.worktree_path,
    env: reexecEnv,
  });
  return result.status ?? 0;
}

function parseArgs(argv) {
  const opts = { name: null, noLaunch: false, json: false };
  for (const a of argv) {
    if (a === '--no-launch') { opts.noLaunch = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}
