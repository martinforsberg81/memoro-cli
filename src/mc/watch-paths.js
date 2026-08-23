/**
 * Where the watchers keep their own files.
 *
 * `mc watch pm` and `mc watch sessions` are two legs of one mechanism
 * (designnote §2), and they are one daemon form rather than two: a pid file
 * checked against the process table, a log beside it, a freshness rule. So
 * the paths are named once, here, and both legs read them — a second copy is
 * the day the two disagree about where a pid file lives.
 *
 * Everything is under `<mc home>/watch/`. Nothing is ever written inside a
 * repository or inside a role's home; the round versions PM's home from the
 * outside and keeps its own bookkeeping here.
 */
import { join } from 'node:path';

import { mcHome } from './paths.js';

/** Every watcher file lives under this one directory. */
export function watchRoot(root = mcHome()) {
  return join(root, 'watch');
}

/** The pid file for one target: `pm`, `sessions`. */
export function watchStatePath(target, root = mcHome()) {
  return join(watchRoot(root), `${target}.json`);
}

/** The log the detached process writes its stdout and stderr into. */
export function watchLogPath(target, root = mcHome()) {
  return join(watchRoot(root), `${target}.log`);
}

/** What the round remembers between passes — see `watch-pm-round.js`. */
export function pmRoundStatePath(root = mcHome()) {
  return join(watchRoot(root), 'pm-round.json');
}

/**
 * What the guard remembers between rounds — see `watch-sessions-store.js`.
 *
 * The guard's equivalent of the round's memory, and the reason it is
 * affordable: the size and mtime of every transcript at the end of the last
 * round, so a conversation that has not moved costs a stat instead of a model
 * turn.
 */
export function sessionsSeenPath(root = mcHome()) {
  return join(watchRoot(root), 'sessions-seen.json');
}

/**
 * How the guard was last started — its flags — so that `mc watch sessions
 * start` after a stop, a reboot or a new PM session is the same guard and
 * not a plainer one (B4, 2026-08-23: the flags lived only in the pid file,
 * and the pid file goes with the process).
 */
export function sessionsStartPath(root = mcHome()) {
  return join(watchRoot(root), 'sessions-start.json');
}
