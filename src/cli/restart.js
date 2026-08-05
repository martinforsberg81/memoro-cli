/**
 * `mc restart <name>` — replace the session's runtime, keep everything else.
 *
 * The missing verb of the upgrade story: every mc update changes the host
 * identity, so a running session's host becomes incompatible and the way
 * forward was user homework — "exit the tool, then run mc open". Restart owns
 * both steps: stop the session's runtime, then open, which already knows how
 * to plan a fresh generation and attach.
 *
 * This is not `mc end` + `mc new`. Nothing is removed: not the session home,
 * not a workspace, not a conversation, not a Git resource. A session whose
 * runtime is already gone simply skips the stop and opens.
 */
import { resolveLocalSessionSync } from '../mc/session-v1.js';
import { stopLocalSessionRuntime } from '../runtime/session-host/terminal-client.js';
import { run as runOpen } from './open.js';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  const stdout = deps.stdout || process.stdout;
  const names = argv.filter((arg) => !arg.startsWith('-'));
  const passthrough = argv.filter((arg) => arg.startsWith('-'));
  if (names.length !== 1) {
    stderr.write('mc: usage — `mc restart <name> [open flags…]`\n');
    return 2;
  }
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(names[0], {
    mcHomeDir: deps.mcHomeDir,
  });
  if (!resolved.ok) {
    stderr.write(`mc: local session "${names[0]}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const stopped = await (deps.stopRuntime || stopLocalSessionRuntime)({
    mcHomeDir: deps.mcHomeDir,
    mcSessionId: resolved.session.mc_session_id,
  });
  // A session that was not running is not a failure — restarting it is just
  // opening it. Only a runtime that exists and refuses to stop is.
  if (!stopped.ok) {
    stderr.write(`mc: could not stop the runtime for "${names[0]}" (${stopped.reason})\n`);
    return 1;
  }
  if (stopped.stopped) stdout.write(`mc: stopped the runtime for ${names[0]}\n`);
  return (deps.openSession || runOpen)([names[0], ...passthrough], deps);
}
