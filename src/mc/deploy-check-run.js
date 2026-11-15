#!/usr/bin/env node
/**
 * The check after a deploy, as a process of its own (`deployCheckTick` in
 * `deploy-check.js` starts it, detached, from the runner's chore pass).
 *
 * Its one argument is the job `{ started, sha }` as JSON; its stdout and stderr
 * are `<started>.log`. It is refused to a headless session: a session that ran
 * it would hold the seeded account's token and the admin token the survey
 * script finds, and the verdict is the runner's alone (docs/technical/mc-deploy.md,
 * *The check after a deploy*). It exits 2 before anything is read or written.
 */
if (process.env.MC_HEADLESS === '1') {
  process.stderr.write('deploy-check-run.js is started by the runner and refused to a headless session (MC_HEADLESS=1); nothing was done.\n');
  process.exit(2);
}

const { executeCheck } = await import('./deploy-check.js');

let job = {};
try { job = JSON.parse(process.argv[2] || '{}'); } catch { /* an empty job finds no row */ }
const say = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const result = await executeCheck({ job, env: process.env, say });
if (result.why && result.code) say(result.why);
process.exit(result.code);
