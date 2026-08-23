/**
 * `mc watch pm` — the process control for the round.
 *
 * The daemon form is `watch-daemon.js`, shared with the session guard. What
 * is particular to this leg is here: which script the detached process runs,
 * what counts as its last write (the round's own bookkeeping), and the
 * half-hour default.
 *
 * It is explicit, like the repository watcher: no command starts it for you.
 * A background process that appears because somebody read a page is a process
 * nobody remembers starting.
 */
import { fileURLToPath } from 'node:url';

import { mcHome } from './paths.js';
import { daemonState, startDaemon, stopDaemon } from './watch-daemon.js';
import { DEFAULT_INTERVAL_MS, readState } from './watch-pm-round.js';

export const TARGET = 'pm';

const RUNNER = fileURLToPath(new URL('./watch-pm-run.js', import.meta.url));

export function pmWatcherState({ root = mcHome(), now = Date.now() } = {}) {
  const state = readState(root);
  return {
    ...daemonState({
      target: TARGET,
      runner: RUNNER,
      root,
      now,
      lastWriteAt: state.at || null,
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
    }),
    last_round: state.last_round || null,
    // The last time a knock was tried, apart from the last round: six quiet
    // passes and a refused knock read the same on the board for a day (B5).
    last_knock: state.last_knock || null,
    // How many items the last pass counted, so `status` can answer the
    // question people actually open it for without a second read.
    unprocessed: countItems(state.items),
  };
}

export function startPmWatcher({ intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env } = {}) {
  return startDaemon({
    target: TARGET,
    runner: RUNNER,
    args: ['--interval-ms', String(intervalMs)],
    intervalMs,
    root,
    env,
    lastWriteAt: readState(root).at || null,
  });
}

export async function stopPmWatcher({ root = mcHome() } = {}) {
  return stopDaemon({ target: TARGET, runner: RUNNER, root });
}

function countItems(items) {
  return items && typeof items === 'object' ? Object.keys(items).length : null;
}
