/**
 * Waiting for a repository's lane (gate-lock.js), for a docs gate, which runs
 * its tests beside the merger's rounds and in the same line. Nothing a session
 * runs waits here: its gate takes no lane.
 */
import { describeRunning, takeGateLock } from './gate-lock.js';
import { mcHome } from './paths.js';

/** How often a waiting gate looks again. */
export const LANE_POLL_MS = 3 * 1000;

/**
 * Wait until the lane is free, then hold it for `pid`. Says once what it
 * waits for and once that it starts. Resolves with how many polls it slept.
 */
export async function takeLane({
  lane, pid = process.pid, repo = null, root = mcHome(), mode,
  take = takeGateLock,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  write = (line) => process.stdout.write(line),
  signal,
} = {}) {
  let polls = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('waiting for the gate lane was interrupted');
    const held = take({ repo, pr: null, mode, root, lane, pid });
    if (held.ok) break;
    if (held.error) throw new Error(held.error);
    if (!polls) write(`mc gate: waiting — ${describeRunning(held.running, lane)}\n`);
    polls += 1;
    await sleep(LANE_POLL_MS);
  }
  if (polls) write(`mc gate: the ${lane} lane is free — starting\n`);
  return polls;
}
