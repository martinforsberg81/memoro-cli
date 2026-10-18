#!/usr/bin/env node
/**
 * A deploy holds the heavy lane (Martin, 2026-10-18: *"Deploy ska ta tung
 * lease"*).
 *
 * On 2026-10-18 a deploy took 40 minutes instead of two: the merger waited
 * behind it as it should, but session `mc gate` runs went on beside the
 * bundle on a machine at load 34–59, and `Build the app bundle and shell`
 * alone took 15m23s. So the deployer takes the heavy gate lock for as long as
 * it builds (`ship` in `commands/deploy.js`), which `mc test` and the merger
 * already respect, and a `mc gate` started while it is held runs this first:
 * its detached child waits here, in the gate's own log, and the tests start
 * when the deploy is done. The verb's budget and `mc gate --wait` are
 * unchanged — a gate that waited is a gate that is still running.
 *
 * An iOS build holds the lane the same way (`buildIos` in `ios-build.js`,
 * `mode: 'ios-build'`): `xcodebuild` and a cold `npm ci` pin the cores as the
 * bundle does, so a gate waits for either. Only those holds are waited for. A
 * merge round in the heavy lane is not: sessions have always gated beside the
 * merger.
 */
import { runningRound } from './gate-lock.js';
import { mcHome } from './paths.js';

/** The `mode` a deployer writes into the heavy gate lock. */
export const DEPLOY_MODE = 'deploy';

/** The `mode` an iOS builder writes into the heavy gate lock. */
export const IOS_BUILD_MODE = 'ios-build';

/** The holds of the heavy lane a gate waits for: a deploy's and an iOS build's. */
export const HEAVY_HOLD_MODES = [DEPLOY_MODE, IOS_BUILD_MODE];

/** What holds the lane, in the words a waiting line uses. */
export function holdName(round) {
  return round?.mode === IOS_BUILD_MODE ? 'iOS build' : 'deploy';
}

/** How often the waiting gate looks again. */
export const DEPLOY_POLL_MS = 5 * 1000;

/** The deploy or iOS build holding the heavy lane now, or null. A dead holder's lock is nobody's. */
export function deployHolding({ root = mcHome(), alive } = {}) {
  const round = runningRound({ root, lane: 'heavy', ...(alive ? { alive } : {}) });
  return HEAVY_HOLD_MODES.includes(round?.mode) ? round : null;
}

/** Wait until no deploy or iOS build holds the heavy lane; say so once. Resolves with how many polls it slept. */
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
