/**
 * The loop around the round.
 *
 * Kept apart from the round itself and from the process that runs it, for the
 * reason `repo-watch-loop.js` gives: a pass is a plain async function, so a
 * test can run three of them back to back and read what they wrote without
 * spawning anything and without waiting ninety minutes for a rule that is
 * counted in passes.
 *
 * The wait between passes is not only a clock. A new file in the role's
 * `inbox/` ends it early (D-0013): four reports landed one evening and PM sat
 * on them until somebody asked "status?", because the half hour had not come
 * round. The file is the event the round exists for, so the file is what
 * wakes the round. The clock stays as the floor underneath — a watch that
 * missed an event, or an inbox that did not exist when the loop started, is
 * still caught on the next tick.
 */
import { watch } from 'node:fs';
import { join } from 'node:path';

import { mcHome, workAreaPath } from './paths.js';
import { DEFAULT_INTERVAL_MS, pmRound } from './watch-pm-round.js';

/**
 * How long after the first change before the pass runs. A message is written
 * atomically, but a sender may write several, and one pass over all of them
 * is better than one pass each.
 */
export const SETTLE_MS = 2000;

/**
 * Pass, wait, pass — where the wait ends at the interval or at a new inbox
 * file, whichever comes first.
 *
 * A pass that throws is logged and the loop goes on. The round exists so PM
 * hears about the inbox; a git command that failed this half hour is not a
 * reason to stop counting for the rest of the day.
 */
export async function pmWatchLoop({
  intervalMs = DEFAULT_INTERVAL_MS,
  settleMs = SETTLE_MS,
  root = mcHome(),
  env = process.env,
  area = 'pm',
  rounds = Infinity,
  shouldStop = () => false,
  log = () => {},
  round = pmRound,
  now = () => new Date(),
  watchInbox = watchDirectory,
} = {}) {
  const inbox = join(workAreaPath(area, env), 'inbox');
  let changed = false;
  const watcher = watchInbox(inbox, () => { changed = true; });
  if (!watcher) log(`not watching ${inbox} for new files — the clock is the only wake`);
  try {
    for (let pass = 0; pass < rounds && !shouldStop(); pass += 1) {
      changed = false;
      try {
        await round({ root, env, area, now: now(), log });
      } catch (error) {
        log(`round failed: ${error?.message || String(error)}`);
      }
      if (shouldStop() || pass + 1 >= rounds) break;
      // The next pass starts an interval after this one finished, not on a
      // fixed clock: a pass that ran long must not queue another behind itself.
      const early = await sleep(intervalMs, shouldStop, () => changed);
      if (early && !shouldStop()) {
        log(`new file in ${area}/inbox/ — a pass now rather than at the interval`);
        await sleep(settleMs, shouldStop);
      }
    }
  } finally {
    watcher?.close?.();
  }
}

/**
 * An `fs.watch` on the inbox, or `null` when there is nothing to watch. A
 * watcher that errors later is closed and forgotten: the loop logs nothing
 * per event, and the clock still runs underneath.
 */
function watchDirectory(directory, onChange) {
  try {
    const watcher = watch(directory, { persistent: false }, () => onChange());
    watcher.on('error', () => { try { watcher.close(); } catch { /* already gone */ } });
    return watcher;
  } catch {
    return null;
  }
}

/** Resolves `true` when `wakeUp` ended the wait, `false` when the clock did. */
async function sleep(ms, shouldStop, wakeUp = () => false) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (wakeUp()) return true;
    await new Promise((resolve) => { setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now()))); });
  }
  return false;
}
