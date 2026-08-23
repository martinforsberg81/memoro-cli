/**
 * The watchers, as the board sees them — the last silent link in the chain.
 *
 * PM is woken by a file (`mc watch pm`), queued wakes are retried by the
 * session guard (`mc watch sessions`), the repository page is kept fresh by
 * `mc repo watch`. If any of them quietly dies, the chain breaks and the only
 * trace is that nothing happens. The board showed everything downstream of
 * them — unreachable since, queued, overdue — and never whether anybody was
 * still trying. One row, three watchers, each saying one of four things:
 * never started · alive (last round N ago) · alive but stale (no round in
 * three intervals) · NOT RUNNING — stopped without telling anyone (a pid
 * file whose process is gone).
 *
 * Read from the same state files the `status` verbs read, never a second
 * opinion. Imported by the status command only: the watchers themselves
 * import the channel, which imports the board, and a cycle there would be a
 * board that cannot load.
 */
import { mcHome } from './paths.js';
import { watcherState as repoWatcherState } from './repo-watch.js';
import { pmWatcherState } from './watch-pm.js';
import { sessionsWatcherState } from './watch-sessions.js';

export const WATCHERS = Object.freeze(['pm', 'sessions', 'repo']);

/** `{ pm, sessions, repo }`, each `{ running, abandoned, stale, last_write_age_ms, interval_ms, pid }`. */
export function watchersState({ root = mcHome(), now = Date.now() } = {}) {
  const pick = (state) => ({
    running: Boolean(state?.running),
    abandoned: Boolean(state?.abandoned),
    stale: state?.stale ?? null,
    last_write_age_ms: state?.last_write_age_ms ?? null,
    interval_ms: state?.interval_ms ?? null,
    pid: state?.pid ?? null,
  });
  const safely = (read) => { try { return pick(read()); } catch { return pick(null); } };
  return {
    pm: safely(() => pmWatcherState({ root, now })),
    sessions: safely(() => sessionsWatcherState({ root, now })),
    repo: safely(() => repoWatcherState({ root, now })),
  };
}

/** One word per watcher, for the row and for anyone reading `--json`. */
export function watcherWord(state) {
  if (!state) return 'unknown';
  if (state.running && state.stale) return 'stale';
  if (state.running) return 'alive';
  if (state.abandoned) return 'not-running';
  return 'never-started';
}
