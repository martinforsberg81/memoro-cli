/**
 * The main-watch — the third leg of the loop (D-0190/D-0199).
 *
 * The same daemon form as `mc watch pm` and `mc watch sessions`
 * (watch-daemon.js): a detached node process, a pid file checked against the
 * process table, a log beside it. This file is its half of that arrangement —
 * its runner, its target name, and what it can say about itself.
 *
 * The repository it watches is remembered at start, like the session guard's
 * flags: a start that names one records it, a bare start repeats the last.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { mcHome } from './paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import { daemonState, startDaemon, stopDaemon } from './watch-daemon.js';
import { watchRoot } from './watch-paths.js';
import { DEFAULT_INTERVAL_MS, mainWatchLoop } from './watch-main-loop.js';
import { readMainState } from './watch-main-store.js';

export const TARGET = 'main';
export const RUNNER = fileURLToPath(new URL('./watch-main-run.js', import.meta.url));

export { DEFAULT_INTERVAL_MS, mainWatchLoop };

function startPath(root = mcHome()) {
  return `${watchRoot(root)}/main-start.json`;
}

export function readStartFlags(root = mcHome()) {
  try {
    const value = JSON.parse(readFileSync(startPath(root), 'utf8'));
    if (value?.schema !== 'mc-watch-main-start') return null;
    return { repo: value.repo || null };
  } catch { return null; }
}

export function startMainWatcher({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env, repo = null,
} = {}) {
  const remembered = repo ? null : readStartFlags(root);
  const flags = { repo: repo || remembered?.repo || null };
  if (!flags.repo) return { ok: false, reason: 'no-repo' };
  const started = startDaemon({
    target: TARGET,
    runner: RUNNER,
    args: ['--interval-ms', String(intervalMs), '--repo', flags.repo],
    intervalMs,
    root,
    env,
    lastWriteAt: readMainState({ root }).at,
  });
  if (started.ok) {
    writeJsonAtomic(startPath(root), { schema: 'mc-watch-main-start', version: 1, repo: flags.repo });
    return { ...started, flags, remembered: Boolean(remembered) };
  }
  return started;
}

export function stopMainWatcher({ root = mcHome() } = {}) {
  return stopDaemon({ target: TARGET, runner: RUNNER, root });
}

export function mainWatcherState({ root = mcHome(), now = Date.now() } = {}) {
  const state = readMainState({ root });
  const flags = readStartFlags(root);
  return {
    ...daemonState({
      target: TARGET,
      runner: RUNNER,
      root,
      now,
      lastWriteAt: state.at,
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
    }),
    last_round: state.last_round,
    watching: flags?.repo || null,
    commit: state.commit,
    red: state.red.length,
    measured_at: state.measured_at,
    detail: detailLines(state, flags),
  };
}

function detailLines(state, flags) {
  const lines = [];
  lines.push(`watching  ${flags?.repo || '(no repo — mc watch main start --repo <name>)'}`);
  if (state.commit) {
    lines.push(`base  ${String(state.commit).slice(0, 7)}  ${state.red.length} red${state.source ? ` (${state.source})` : ''}`);
  } else {
    lines.push('base  not measured yet');
  }
  return lines;
}
