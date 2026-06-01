/**
 * `mc resume <name> [--no-launch] [--json] [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 */
import { spawnSync } from 'node:child_process';
import { findEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';

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

  // §12d: materialise vault tokens for the session BEFORE re-exec.
  // Same contract as `mc new` — soft-degrade on vault-locked.
  try {
    const { materialiseForSession } = await import('../vault/lifecycle.js');
    const res = await materialiseForSession({ sessionId: entry.name });
    if (!res.ok && res.hint) {
      process.stderr.write(`mc: ${res.hint}\n`);
    }
  } catch (err) {
    process.stderr.write(`mc: vault materialise failed (${err.message}); continuing without tokens\n`);
  }

  // Re-exec mc in wrap mode with --resume so claude opens its resume
  // picker. Same approach as `mc new`: same binary, cwd=worktree,
  // inherited stdio. Adapter routing for non-claude tools follows §5.
  const result = spawnSync(process.execPath, [process.argv[1], '--resume'], {
    stdio: 'inherit',
    cwd: entry.worktree_path,
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
