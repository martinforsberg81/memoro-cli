/**
 * `mc restart <name>` — replace the session's runtime, keep everything else.
 *
 * The missing verb of the upgrade story: every mc update changes the host
 * identity (a sha256 of the source closure), so a running session's host
 * becomes incompatible and the way forward used to be user homework —
 * "exit the tool, then run mc open". Restart owns both steps: stop the
 * session's broker runtime gracefully (the same primitive `mc end` uses —
 * it touches ONLY the runtime, never worktree, registry, transcript, or
 * vault), then run the open path, which already knows how to replace a
 * verified-empty incompatible host, reconcile a managed generation, and
 * attach.
 *
 * This is NOT `mc end` + `mc new`: nothing is removed. A session that is
 * not running simply skips the stop and opens.
 */
import {
  formatEntryResolutionError,
  readRegistry,
  resolveEntry,
} from '../mc/registry.js';
import { removeBrokerSessionForEntry } from '../runtime/broker/session-cleanup.js';
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

  let registry;
  try {
    registry = (deps.readRegistry || readRegistry)();
  } catch (err) {
    stderr.write(`mc: registry unreadable (${err.message})\n`);
    return 1;
  }
  const resolved = resolveEntry(names[0], {
    registry,
    cwd: deps.cwd || process.cwd(),
    fallbackGlobal: true,
  });
  if (!resolved.ok) {
    stderr.write(`mc: ${formatEntryResolutionError(names[0], resolved)}\n`);
    return 1;
  }

  const stop = await (deps.removeBrokerSessionForEntry || removeBrokerSessionForEntry)(
    resolved.entry,
    deps.brokerDeps || {},
  );
  // Nothing running is not a failure — restart of a stopped session is
  // just open. Only a runtime that EXISTS but cannot be stopped refuses,
  // with the broker's own reason.
  const nothingToStop = stop?.reason === 'not-found' || stop?.reason === 'broker-unavailable';
  if (stop?.ok !== true && !nothingToStop) {
    stderr.write(
      `mc: could not stop the running session "${resolved.entry.name}" `
      + `(${stop?.reason || 'unknown'}${stop?.error ? `: ${stop.error}` : ''}); nothing was changed\n`,
    );
    return 1;
  }
  if (stop?.ok === true) {
    stdout.write(`mc: stopped ${resolved.entry.name}\n`);
  }

  return (deps.runOpen || runOpen)([names[0], ...passthrough], deps);
}
