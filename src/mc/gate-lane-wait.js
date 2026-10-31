#!/usr/bin/env node
/**
 * A session's `mc gate` runs its tests in the gate lane, like every other
 * round on this machine (Martin, 2026-10-24: *"deras anrop går vid sidan av
 * konstruktionen av heavy lane / light lane vilket ska förhindra att flera
 * parallella processer tar datorns kapacitet"*).
 *
 * Until then a session's gate only looked, once at its start, for a deploy, an
 * iOS build or a merge round holding the heavy lane (`await-deploy.js`), and
 * took nothing: five sessions' gates ran beside each other and beside the
 * merge round that started a minute later. Now the gate's detached shell runs
 * this first. It takes the lane's lock (`gate-lock.js`) for the shell's own
 * pid — `$$`, handed in — waiting while anybody holds it, and the tests start
 * once it is held. The merger, a deploy and `mc test` already wait for that
 * lock, so a session's run is one more round in the queue and never one
 * beside it. After the tests the shell runs this again to give it back; a
 * shell that is killed leaves a lock whose pid is gone, which is nobody's.
 *
 * Since 2026-10-31 that queue is the session lane on a heavy repository
 * (`SESSION_LANE`, gate-lock.js), so session gates exclude each other and no
 * longer stand in the way of a merge round or a deploy. A deploy or an iOS
 * build still goes first: a gate in the session lane does not start while
 * either holds the heavy lane (rulings of 2026-10-18 and 2026-10-19 on the
 * bundle). A gate already running is not paused.
 *
 *   node gate-lane-wait.js take <lane> <pid> <repo>
 *   node gate-lane-wait.js release <lane> <pid>
 */
import { SESSION_LANE, describeRunning, releaseGateLock, runningRound, takeGateLock } from './gate-lock.js';
import { DEPLOY_MODE, IOS_BUILD_MODE, holdName } from './await-deploy.js';
import { mcHome } from './paths.js';

/** The `mode` a session's `mc gate` writes into the lane's lock. */
export const SESSION_GATE_MODE = 'session-gate';

/** How often a waiting gate looks again. */
export const LANE_POLL_MS = 3 * 1000;

/** What holds the lane, in the words a waiting line uses. */
function holder(running) {
  if (running?.mode === SESSION_GATE_MODE) return `another session's mc gate (${running.repo || '?'}, pid ${running.pid})`;
  if (['deploy', 'ios-build', 'merge'].includes(running?.mode)) return `the ${holdName(running)} (pid ${running.pid}${running.since ? `, since ${running.since}` : ''})`;
  return describeRunning(running, running?.lane).replace(/^another gate round is running on this machine/u, 'a gate round');
}

/** The deploy or iOS build a gate in the session lane does not start beside, or null. */
export function buildHolding({ root = mcHome(), read = runningRound } = {}) {
  const round = read({ root, lane: 'heavy' });
  return [DEPLOY_MODE, IOS_BUILD_MODE].includes(round?.mode) ? round : null;
}

/**
 * Wait until the lane is free, then hold it for `pid`. Says once what it
 * waits for and once that it starts. Resolves with how many polls it slept.
 */
export async function takeLane({
  lane = 'heavy', pid = process.pid, repo = null, root = mcHome(), mode = SESSION_GATE_MODE,
  take = takeGateLock,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  write = (line) => process.stdout.write(line),
  signal,
  build = (at) => buildHolding({ root: at }),
} = {}) {
  let polls = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('waiting for the gate lane was interrupted');
    const building = lane === SESSION_LANE ? build(root) : null;
    const held = building ? { ok: false, running: building } : take({ repo, pr: null, mode, root, lane, pid });
    if (held.ok) break;
    if (held.error) throw new Error(held.error);
    if (!polls) write(`mc gate: waiting for ${holder(held.running)} in the ${lane} lane — the tests start when it is done\n`);
    polls += 1;
    await sleep(LANE_POLL_MS);
  }
  if (polls) write(`mc gate: the ${lane} lane is free — starting\n`);
  return polls;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [verb, lane, pid, repo] = process.argv.slice(2);
  if (verb === 'take') await takeLane({ lane, pid: Number(pid), repo: repo || null });
  else if (verb === 'release') releaseGateLock({ lane, pid: Number(pid) });
}
