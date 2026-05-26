/**
 * Shell-directive emission (§2b).
 *
 * The user's shell wrapper (installed by `mc install-shell`) runs the CLI
 * with `--emit-shell-directives` and pipes fd 3 → eval. The CLI writes
 * `cd <path>` lines on fd 3 *only* when that flag is set; otherwise the
 * commands still work, but no cd happens and we print a one-line tip
 * about installing the wrapper.
 *
 * fd 3 is opened by the wrapper as a pipe. When called outside the
 * wrapper (interactive terminal, `node bin-mc.js cd foo`), fd 3 isn't
 * attached — write attempts would fail with EBADF, hence the guard.
 */
import { writeSync } from 'node:fs';

/**
 * Args parsing: split `--emit-shell-directives` out of argv. Returns
 * `{ args, enabled }` where args is the original list with the flag
 * removed.
 */
export function parseDirectiveFlag(argv) {
  const args = [];
  let enabled = false;
  for (const a of argv) {
    if (a === '--emit-shell-directives') { enabled = true; continue; }
    args.push(a);
  }
  return { args, enabled };
}

/**
 * Write a `cd <path>` directive on fd 3 if `enabled`. Falls back to a
 * one-line tip to stderr if not enabled (only when `tipIfDisabled`).
 *
 * Returns true if a directive was actually emitted.
 */
export function emitCd(path, { enabled, tipIfDisabled = false } = {}) {
  if (!enabled) {
    if (tipIfDisabled) {
      process.stderr.write(
        'mc: tip — run `mc install-shell` to enable auto-cd via the shell wrapper.\n',
      );
    }
    return false;
  }
  try {
    writeSync(3, `cd ${path}\n`);
    return true;
  } catch {
    // fd 3 not attached (running outside the wrapper); silently skip so
    // the command still succeeds on its other side effects.
    return false;
  }
}
