#!/usr/bin/env node
/**
 * A deploy holds memoro's lane (Martin, 2026-10-18: *"Deploy ska ta tung
 * lease"*).
 *
 * On 2026-10-18 a deploy took 40 minutes instead of two: session `mc gate` runs
 * went on beside the bundle on a machine at load 34–59. So the deployer holds
 * the lane for as long as it builds (`ship` in `commands/deploy.js`), and a
 * gate on memoro started meanwhile waits here, in its own log. An iOS build
 * does the same (`buildIos` in `ios-build.js`). This is the only thing a
 * session's gate waits for: a build is minutes long and pins every core. A
 * merge round is not waited for: the session's gate runs at low priority
 * beside it (session-gate-run.js).
 */
import { BUILD_LANE, runningRound } from './gate-lock.js';
import { mcHome } from './paths.js';

/** The `mode` a deployer writes into the heavy gate lock. */
export const DEPLOY_MODE = 'deploy';

/** The `mode` an iOS builder writes into the gate lock. */
export const IOS_BUILD_MODE = 'ios-build';

/** The `mode` the merger writes into the gate lock for a merge round. */
export const MERGE_MODE = 'merge';

/** The holds a session's gate waits for: a deploy's and an iOS build's. */
export const BUILD_MODES = [DEPLOY_MODE, IOS_BUILD_MODE];

/** What holds the lane, in the words a waiting line uses. */
export function holdName(round) {
  return round?.mode === IOS_BUILD_MODE ? 'iOS build' : round?.mode === MERGE_MODE ? 'merge round' : 'deploy';
}

/** How often the waiting gate looks again. */
export const DEPLOY_POLL_MS = 5 * 1000;

/** The deploy or iOS build holding memoro's lane now, or null. A dead holder's lock is nobody's. */
export function deployHolding({ root = mcHome(), alive } = {}) {
  const round = runningRound({ root, lane: BUILD_LANE, ...(alive ? { alive } : {}) });
  return BUILD_MODES.includes(round?.mode) ? round : null;
}

/** Wait until no deploy or iOS build holds memoro's lane; say so once. Resolves with how many polls it slept. */
export async function awaitDeploy({
  holding = () => deployHolding(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  write = (line) => process.stdout.write(line),
} = {}) {
  let polls = 0;
  let name = 'deploy';
  for (let held = holding(); held; held = holding()) {
    if (!polls) {
      name = holdName(held);
      write(`mc gate: waiting for the ${name} (pid ${held.pid}${held.since ? `, since ${held.since}` : ''}) — the tests start when it is done\n`);
    }
    polls += 1;
    await sleep(DEPLOY_POLL_MS);
  }
  if (polls) write(`mc gate: the ${name} is done — starting\n`);
  return polls;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await awaitDeploy();
}
