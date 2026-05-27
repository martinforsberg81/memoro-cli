/**
 * `mc resume <name> [--no-launch] [--json] [--emit-shell-directives]`
 *
 * §2 + §2b: emit `cd <worktree>` on fd 3 *before* the tool launches, so
 * the launched tool's cwd is the worktree. In `--no-launch` mode (tests
 * + when the user just wants to cd), we emit the directive and exit.
 */
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

  // Real tool spawn lands when the adapter layer's resume hook is wired
  // up. For now, surface a hint so the user can drop into the worktree
  // manually if they're outside the wrapper.
  console.log(`mc: cd ${entry.worktree_path} && ${entry.tool || 'claude'} --resume`);
  return 0;
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
