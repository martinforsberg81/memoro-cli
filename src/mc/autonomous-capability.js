/**
 * The capability `createRunner({ autonomous })` takes in production: the awake
 * clock, the session control profile and the switches that let v2 goals build,
 * be reviewed and be planned, and the verifier that measures what a session asks.
 *
 * It fails closed. A machine whose awake clock cannot be read, or a profile
 * file that is not a valid profile, means no capability, so v2 goals are skipped
 * as they are without one; nothing falls back to a clock that counts suspend or
 * to the default profile. The reason is logged once, by the one call `runLoop`
 * makes at start.
 *
 * Main conflicts are resolved here too: `integrateConflicts` is one headless
 * session on the build's launch path, under the same supervision, that resolves
 * the merge and starts no implementation.
 *
 * Deps: `log` (a line), `awakeClock` (the injectable deps of `createAwakeClock`
 * and `probeAwakeClock`, so a test never touches perl or sysctl), `session` (the
 * runner's process launch).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAwakeClock, probeAwakeClock } from './awake-clock.js';
import { createCheckpointVerifier } from './checkpoint-verifier.js';
import { validateControlProfile } from './session-control.js';
import { SESSION_START_MAX_BYTES } from './session-handoff.js';
import { projectSessionObserver } from './session-supervision.js';

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

const MAIN_INTEGRATION = Object.freeze({ kind: 'tool', id: 'main-integration' });

/** The build's start payload, then the integration request (canon/roles/_step-autonomous.md). */
function integrationPrompt(prompt, conflicts) {
  return `${prompt}\n\nIntegration request. Merging main left these files in conflict:\n`
    + `${conflicts.map(file => `- ${file}`).join('\n')}\n\n`
    + 'Resolve conflicts only: keep both intents, regenerate generated files with the repository\'s scripts, '
    + 'finish the merge with a commit. Do not start implementation; a fresh session builds after this one exits.\n';
}

/** One session that finishes the merge in `worktree`. The dispatcher verifies the result; a non-normal exit throws. */
function conflictIntegrator({ deps, clock }) {
  return async ({ root, programme, project, actor, worktree, conflicts, instructions, prompt, launch, observeResult }) => {
    const request = integrationPrompt(prompt, conflicts);
    if (Buffer.byteLength(request) > SESSION_START_MAX_BYTES) throw new Error('main integration exceeds bounded start context');
    const tool = launch.command({ instructions, prompt: request });
    const result = await deps.session({ bin: tool.bin, args: tool.args, cwd: worktree, prompt: request,
      env: launch.env, unsetEnv: launch.unsetEnv,
      autonomous: { version: 1, tool: launch.tool, ...projectSessionObserver({ root, programme, project, actor }), clock,
        directory: launch.directory, pollMs: POLL_MS, activity: () => MAIN_INTEGRATION } });
    observeResult?.(result);
    if (!result.normal_exit || !result.recovery_ready || !result.control_persisted) {
      throw new Error(`main integration session ended abnormally: ${result.reason || 'incomplete autonomous process'}`);
    }
  };
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
  // A factory, not an instance: each run measures in its own worktree and closes its own measurement.
  const verifier = options => createCheckpointVerifier(options);
  const integrateConflicts = conflictIntegrator({ deps, clock });
  return { clock, pollMs: POLL_MS, review: true, programmeJobs: true, programmePlan: true, publication: {}, profile, verifier, integrateConflicts };
}
