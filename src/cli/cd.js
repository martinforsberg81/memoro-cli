/**
 * `mc cd <name>` (§2 + §2b) — emit `cd <worktree>` on fd 3.
 *
 * Without `--emit-shell-directives` the command still succeeds but
 * prints a one-line tip about the shell wrapper. The user's wrapper
 * sets the flag automatically.
 */
import { formatEntryResolutionError, resolveEntry } from '../mc/registry.js';
import { emitCd, parseDirectiveFlag } from '../mc/shell-directives.js';

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
  const resolved = resolveEntry(name);
  if (!resolved.ok) {
    console.error(`mc: ${formatEntryResolutionError(name, resolved)}`);
    return 1;
  }
  const entry = resolved.entry;
  if (!entry.worktree_path) {
    console.error(`mc: session "${name}" has no worktree_path on record`);
    return 1;
  }

  // Note: `emitDirectives` from parseDirectiveFlag will always be false
  // here because bin-mc.js strips the flag before dispatch. emitCd
  // picks up the dispatcher's MC_EMIT_SHELL_DIRECTIVES env var via its
  // built-in default. parseDirectiveFlag is still useful in case
  // someone calls run() directly with the flag in argv (tests).
  const emitted = emitCd(entry.worktree_path, {
    enabled: emitDirectives || undefined, // fall through to env-var default when false
    tipIfDisabled: false, // tip handled below so it's visible on stdout for tests
  });
  if (!emitted) {
    process.stdout.write(
      `mc: tip — run \`mc install-shell\` to enable auto-cd via the shell wrapper.\n`,
    );
  }
  return 0;
}
