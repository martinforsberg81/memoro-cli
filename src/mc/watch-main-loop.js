/**
 * Pass, wait, pass — the main-watch's loop.
 *
 * The same daemon form as the other legs (watch-daemon.js): a plain async
 * loop so the round is a function a test can call. No inbox watch here —
 * the base branch moves on git's clock, not the filesystem's, and the pass
 * itself is what asks git whether it moved. A pass that throws is logged
 * and the loop goes on: the watch exists so main's colour is known, and one
 * failed fetch is not a reason to stop knowing it for the rest of the day.
 */
import { mainRound } from './watch-main-round.js';
import { mcHome } from './paths.js';
import { sendToArea } from './work-send.js';
import { WATCHERS } from './watch-senders.js';

export const DEFAULT_INTERVAL_MS = 5 * 60_000;

export async function mainWatchLoop({
  repoPath,
  base = 'origin/main',
  intervalMs = DEFAULT_INTERVAL_MS,
  root = mcHome(),
  env = process.env,
  rounds = Infinity,
  shouldStop = () => false,
  log = () => {},
  round = mainRound,
  knock = null,
  now = () => new Date(),
} = {}) {
  const deliver = knock || ((message) => sendToArea({ name: 'pm', message, sender: WATCHERS.main, wake: true }));
  for (let pass = 0; pass < rounds && !shouldStop(); pass += 1) {
    try {
      await round({ repoPath, base, root, env, now: now(), log, knock: deliver });
    } catch (error) {
      log(`round failed: ${error?.message || String(error)}`);
    }
    if (shouldStop() || pass + 1 >= rounds) break;
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
