#!/usr/bin/env node
/**
 * The deployer process itself (`ship` in `commands/deploy.js`).
 *
 * Started detached by `mc deploy` after the yes, never by hand. Its one
 * argument is the job as JSON; its stdout and stderr are `deploy.log`, which
 * the terminal that asked reads as it grows. SIGINT and SIGTERM are passed on
 * to the script by `spawnDeployDefault` — it restores its stamps and says
 * what production runs — and the row is completed after.
 */
import { ship } from './commands/deploy.js';

const job = JSON.parse(process.argv[2] || '{}');
const code = await ship(job, { stdout: process.stdout, stderr: process.stderr, env: process.env });
process.exit(typeof code === 'number' ? code : 1);
