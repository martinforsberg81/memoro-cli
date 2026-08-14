/**
 * The watcher's round, and the loop around it.
 *
 * Kept apart from the process control (`repo-watch.js`) and from the runner
 * that starts it: a round is a plain async function, so a test can run one
 * and look at what it wrote without spawning anything.
 */
import { mcHome } from './paths.js';
import { DEFAULT_INTERVAL_MS, writeSnapshot } from './repo-snapshot.js';
import { repoStatus } from './repo-status.js';

/**
 * One round: ask for everything, write it down.
 *
 * The gathering is the ordinary one-shot view — the same aggregator a person
 * gets when no watcher runs, so the two answers cannot disagree about what a
 * repository is.
 */
export async function watchRound({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env,
} = {}) {
  const started = Date.now();
  const report = await repoStatus({ env });
  const written = writeSnapshot(report, { intervalMs, root });
  return {
    at: written.at,
    repos: report.repos.length,
    took_ms: Date.now() - started,
    files: written.written.length,
  };
}

/**
 * Round, wait, round.
 *
 * A round that throws is logged and the loop goes on. The watcher exists to
 * keep an answer fresh; a repository that cannot be read this minute is a
 * degraded section in the snapshot, never a reason to stop watching the
 * others.
 */
export async function watchLoop({
  intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env,
  rounds = Infinity, shouldStop = () => false, log = () => {},
} = {}) {
  for (let round = 0; round < rounds && !shouldStop(); round += 1) {
    try {
      const outcome = await watchRound({ intervalMs, root, env });
      log(`wrote ${outcome.repos} repositories in ${Math.round(outcome.took_ms / 100) / 10}s`);
    } catch (error) {
      log(`round failed: ${error?.message || String(error)}`);
    }
    if (shouldStop()) break;
    // The next round starts an interval after this one finished, not on a
    // fixed clock: a round that takes longer than the interval must not queue
    // another behind itself.
    await sleep(intervalMs, shouldStop);
  }
}

async function sleep(ms, shouldStop) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return;
    await new Promise((resolve) => { setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now()))); });
  }
}
