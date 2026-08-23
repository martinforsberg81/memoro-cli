/**
 * The guard — a watchman, not a session.
 *
 * The process control is `watch-daemon.js`, shared with the round: a detached
 * node process, a pid file checked against the process table, a log beside it.
 * One daemon form, not two (design note §2). This file is the guard's half of
 * that arrangement — its runner, its target name, and what it can say about
 * itself beyond "running or not".
 *
 * It is off until somebody starts it. It does not auto-start, and nothing in
 * mc starts it as a side effect of being asked something else. What its
 * default should be at launch is Martin's decision after a day of live
 * running, so nothing here anticipates it.
 */
import { fileURLToPath } from 'node:url';

import { mcHome } from './paths.js';
import { daemonState, startDaemon, stopDaemon } from './watch-daemon.js';
import { pendingNotices } from './watch-notices.js';
import { DEFAULT_INTERVAL_MS, readMemory } from './watch-sessions-store.js';

export const TARGET = 'sessions';
export const RUNNER = fileURLToPath(new URL('./watch-sessions-run.js', import.meta.url));

/**
 * Is a guard running, when did it last look, and what is standing?
 *
 * The daemon half is the shared one. Everything after it is the guard's own:
 * how many conversations it is watching, which patterns are true right now,
 * and what the ledger is still holding for the round to carry.
 *
 * `flags_standing` counts patterns, never orders them. The guard does not rank
 * and neither does anything that reads it.
 */
export function sessionsWatcherState({ root = mcHome(), now = Date.now() } = {}) {
  const memory = readMemory({ root });
  const pending = pendingNotices({ root });
  const standing = standingFlags(memory.sessions);
  return {
    ...daemonState({
      target: TARGET,
      runner: RUNNER,
      root,
      now,
      lastWriteAt: memory.at,
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
    }),
    last_round: memory.last_round,
    sessions_seen: Object.keys(memory.sessions).length,
    flags_standing: standing,
    // What the shared renderer prints under the round's own sentence: what is
    // true right now, then the flags the round has not carried yet.
    //
    // The standing line is alphabetical and the pending ones are in arrival
    // order. Neither is sorted by anything that could be read as importance,
    // because the guard has no opinion about importance and a page that
    // invented one would be inventing it on the guard's behalf.
    detail: detailLines(standing, pending),
    notices_pending: pending.length,
  };
}

export function startSessionsWatcher({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env, model = null, idleMs = null, groups = [],
} = {}) {
  return startDaemon({
    target: TARGET,
    runner: RUNNER,
    args: [
      '--interval-ms', String(intervalMs),
      ...(model ? ['--model', model] : []),
      ...(idleMs ? ['--idle-ms', String(idleMs)] : []),
      ...(groups || []).flatMap((group) => ['--group', group]),
    ],
    intervalMs,
    root,
    env,
    lastWriteAt: readMemory({ root }).at,
  });
}

export function stopSessionsWatcher({ root = mcHome() } = {}) {
  return stopDaemon({ target: TARGET, runner: RUNNER, root });
}

function detailLines(standing, pending) {
  const names = Object.keys(standing).sort();
  const lines = names.length
    ? [`standing  ${names.map((name) => `${name} ${standing[name]}`).join('   ')}`]
    : ['standing  nothing flagged'];
  for (const notice of pending) {
    lines.push(`${notice.session}  ${notice.pattern}${notice.detail ? `  ${notice.detail}` : ''}`);
  }
  return lines;
}

/** Which patterns are true right now, and for how many conversations each. */
function standingFlags(sessions) {
  const counts = {};
  for (const session of Object.values(sessions || {})) {
    for (const pattern of session.active || []) counts[pattern] = (counts[pattern] || 0) + 1;
  }
  return counts;
}
