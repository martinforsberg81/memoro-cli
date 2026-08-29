/**
 * The work model, asked directly.
 *
 * This was `mc status --sessions --json` in a subprocess until decision mc-3
 * removed the board. The model behind it did not go — `mc repo status` groups
 * its worktree facts by repository and the lease liveness check asks it
 * whether a holder is still working — so the tests that used the board as a
 * probe ask the model instead. Same data, one process fewer.
 */
import { workStatus } from '../../../src/mc/work-status.js';

/**
 * `env` is applied to the process for the length of the call, not only handed
 * to `workStatus`: the open-task count reads `MC_HOME` ambiently, as it did
 * when this ran in a subprocess. Restored afterwards, always.
 */
export async function board(env) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await workStatus({ env: { ...process.env } });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The areas by name, which is how every caller used the board's JSON. */
export async function areasByName(env) {
  const report = await board(env);
  return Object.fromEntries(report.areas.map((area) => [area.name, area]));
}
