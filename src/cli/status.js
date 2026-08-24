/**
 * `mc status` — the board of every piece of work and what each is doing.
 *
 * It once also took a name, to report on a single pre-V1 session
 * (`resolveLocalSession`/`sessionStatus`); that whole surface is gone with
 * the rest of the portable-session code (2026-08-24, mc is for memoro me
 * only). What remains is the one question worth asking — what is the fleet
 * doing right now — answered by the board.
 */
import { run as runBoard } from '../mc/commands/status-board.js';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  // A name is no longer a question mc can answer: there are no standalone
  // sessions any more, only work areas the board already shows. Say so
  // rather than silently ignoring it.
  const name = argv.find((arg) => !arg.startsWith('--'));
  if (name) {
    stderr.write(`mc: mc status takes no name — it shows every work area at once (you asked for "${name}")\n`);
    return 2;
  }
  return runBoard(argv, deps);
}
