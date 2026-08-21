/**
 * The loop around the round.
 *
 * Kept apart from the round itself and from the process that runs it, for the
 * reason `repo-watch-loop.js` gives: a pass is a plain async function, so a
 * test can run three of them back to back and read what they wrote without
 * spawning anything and without waiting ninety minutes for a rule that is
 * counted in passes.
 */
import { mcHome } from './paths.js';
import { DEFAULT_INTERVAL_MS, pmRound } from './watch-pm-round.js';

/**
 * Pass, wait, pass.
 *
 * A pass that throws is logged and the loop goes on. The round exists so PM
 * hears about the inbox; a git command that failed this half hour is not a
 * reason to stop counting for the rest of the day.
 */
export async function pmWatchLoop({
  intervalMs = DEFAULT_INTERVAL_MS,
  root = mcHome(),
  env = process.env,
  area = 'pm',
  rounds = Infinity,
  shouldStop = () => false,
  log = () => {},
  round = pmRound,
  now = () => new Date(),
} = {}) {
  for (let pass = 0; pass < rounds && !shouldStop(); pass += 1) {
    try {
      await round({ root, env, area, now: now(), log });
    } catch (error) {
      log(`round failed: ${error?.message || String(error)}`);
    }
    if (shouldStop()) break;
    // The next pass starts an interval after this one finished, not on a
    // fixed clock: a pass that ran long must not queue another behind itself.
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
