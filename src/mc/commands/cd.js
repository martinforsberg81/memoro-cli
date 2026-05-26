/**
 * `mc cd <name>` (§2 + §2b) — emit `cd <worktree>` on fd 3.
 *
 * Without `--emit-shell-directives` the command still succeeds but
 * prints a one-line tip about the shell wrapper. The user's wrapper
 * sets the flag automatically.
 */
import { findEntry } from '../registry.js';
import { emitCd, parseDirectiveFlag } from '../shell-directives.js';

export async function run(rawArgv) {
  const { args: argv, enabled: emitDirectives } = parseDirectiveFlag(rawArgv);
  const name = argv[0];
  if (!name) {
    console.error('mc: usage — `mc cd <name>` (name required)');
    return 2;
  }
  if (name.startsWith('--')) {
    console.error(`mc: unknown flag: ${name}`);
    return 2;
  }
  const entry = findEntry(name);
  if (!entry) {
    console.error(`mc: no such session "${name}"`);
    return 1;
  }
  if (!entry.worktree_path) {
    console.error(`mc: session "${name}" has no worktree_path on record`);
    return 1;
  }

  const emitted = emitCd(entry.worktree_path, {
    enabled: emitDirectives,
    tipIfDisabled: false, // tip handled below so it's visible on stdout for tests
  });
  if (!emitted) {
    process.stdout.write(
      `mc: tip — run \`mc install-shell\` to enable auto-cd via the shell wrapper.\n`,
    );
  }
  return 0;
}
