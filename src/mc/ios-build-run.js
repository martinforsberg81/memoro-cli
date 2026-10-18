#!/usr/bin/env node
/**
 * The iOS builder process itself (`buildIos` in `ios-build.js`).
 *
 * Started detached by `mc build ios --device` or `--testflight`, never by hand, the way
 * `deploy-run.js` is. Its one argument is the job as JSON; its stdout and
 * stderr are `ios-build.log`, which the terminal that asked reads as it
 * grows. A signal it receives is passed on to the command running now, and
 * the row is completed after.
 */
import { buildIos, makeStep } from './ios-build.js';

const job = JSON.parse(process.argv[2] || '{}');
const step = makeStep({ stdout: process.stdout });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => step.stop(signal));
const code = await buildIos(job, {
  stdout: process.stdout, stderr: process.stderr, env: process.env, step,
});
process.exit(typeof code === 'number' ? code : 1);
