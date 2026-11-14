#!/usr/bin/env node
/**
 * The deploy's preparation process itself (`prepare` in `deploy-prepare.js`).
 *
 * Started detached by `mc deploy`, never by hand. Its one argument is the job
 * as JSON; its stdout and stderr are `deploy-prepare.log`, which the terminals
 * and the page that ask read as it grows. Losing a terminal does not reach it:
 * it has a process group of its own and no terminal to lose.
 */
import { prepare } from './deploy-prepare.js';

const job = JSON.parse(process.argv[2] || '{}');
const code = await prepare(job, { stdout: process.stdout, env: process.env });
process.exit(typeof code === 'number' ? code : 1);
