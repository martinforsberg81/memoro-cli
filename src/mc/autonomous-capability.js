/**
 * The capability `createRunner({ autonomous })` takes in production: the awake
 * clock, the session control profile and the switches that let v2 goals build,
 * be reviewed and be planned.
 *
 * It fails closed. A machine whose awake clock cannot be read, or a profile
 * file that is not a valid profile, means no capability, so v2 goals are skipped
 * as they are without one; nothing falls back to a clock that counts suspend or
 * to the default profile. The reason is logged once, by the one call `runLoop`
 * makes at start.
 *
 * Deps: `log` (a line), `awakeClock` (the injectable deps of `createAwakeClock`
 * and `probeAwakeClock`, so a test never touches perl or sysctl).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAwakeClock, probeAwakeClock } from './awake-clock.js';
import { validateControlProfile } from './session-control.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const POLL_MS = 5000;

export const DEFAULT_CONTROL_PROFILE = Object.freeze({
  soft_active_ms: 40 * MINUTE_MS,
  upper_active_ms: 60 * MINUTE_MS,
  emergency_active_ms: 80 * MINUTE_MS,
  reserve_active_ms: 10 * MINUTE_MS,
  soft_context: 0.6,
  upper_context: 0.75,
  emergency_context: 0.9,
  reserve_context: 0.05,
  context_stale_ms: 5 * MINUTE_MS,
  closing_ms: 15 * MINUTE_MS,
  tool_wait_ms: 30 * MINUTE_MS,
  lane_wait_ms: 45 * MINUTE_MS,
  total_awake_ms: 3 * HOUR_MS,
  no_progress_ms: 45 * MINUTE_MS,
  max_stagnant_sessions: 3,
  max_failures: 3,
});

/** The profile in `path`, or a copy of the default when no such file exists. Anything else throws. */
function readControlProfile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return validateControlProfile({ ...DEFAULT_CONTROL_PROFILE });
  }
  return validateControlProfile(JSON.parse(text));
}

/** The production capability, or null with the reason logged. Never throws. */
export function productionAutonomy({ root, deps = {} }) {
  const refuse = (reason) => {
    deps.log?.(`autonomous capability unavailable — v2 goals are skipped: ${reason}`);
    return null;
  };
  const clockDeps = deps.awakeClock ?? {};
  const probe = probeAwakeClock(clockDeps);
  if (!probe.ok) return refuse(`awake clock: ${probe.reason}`);
  const profilePath = join(root, 'runner', 'control-profile.json');
  let profile;
  try {
    profile = readControlProfile(profilePath);
  } catch (error) {
    return refuse(`control profile ${profilePath}: ${error.message}`);
  }
  let clock;
  try {
    clock = createAwakeClock({ statePath: join(root, 'runner', 'awake-clock.json'), ...clockDeps });
  } catch (error) {
    return refuse(error.message);
  }
  return { clock, pollMs: POLL_MS, review: true, programmeJobs: true, programmePlan: true, publication: {}, profile };
}
