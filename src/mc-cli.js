#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routeV1Command } from './mc-verbs.js';
import { forbidCredentialPrompts } from './mc/no-prompts.js';

forbidCredentialPrompts();

const rawArgv = process.argv.slice(2);
const argv = [];
for (const arg of rawArgv) {
  if (arg === '--emit-shell-directives') process.env.MC_EMIT_SHELL_DIRECTIVES = '1';
  else argv.push(arg);
}
const first = argv[0];

// Every invocation except the strictly read-only decisions report, at its two ends.
//
// This is the only place that sees all of them: `routeV1Command` covers the
// V1 verbs and everything it declines falls through to the capability
// dispatcher, so a line written here cannot miss a command the way seven
// hand-placed call sites did. The pair matters more than either half — a
// start with no end is a command that died, and that is the shape of the
// failure this was built for. Nothing here can throw into the command: the
// logger swallows its own errors by contract.
// Loading it is guarded for the same reason writing to it is: the promise is
// that no command ever fails because of the record it keeps.
let log = () => {};
let shape = { verb: first || '(page)' };
try {
  if (first !== 'decisions') {
    const logger = await import('./mc/logger.js');
    log = logger.log;
    shape = logger.invocationShape(argv);
  }
} catch { /* no record is bad; a broken command is worse */ }

const startedAt = Date.now();
let ended = false;
log('mc.start', { ...shape, cwd: process.cwd(), holder: await holderName() });

try {
  if (first === '--help' || first === '-h' || first === 'help') {
    const { HELP_TEXT } = await import('./mc/help-text.js');
    console.log(HELP_TEXT);
    process.exitCode = 0;
  } else if (first === '--version' || first === '-v') {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
    console.log(pkg.version || 'dev');
    process.exitCode = 0;
  } else {
    const routed = await routeV1Command(argv);
    if (routed === null) {
      const { main } = await import('./bin-mc.js');
      process.exitCode = (await main()) ?? 0;
    } else {
      process.exitCode = routed;
    }
  }
} catch (error) {
  // The message, not the stack: a stack is a path into somebody's home
  // directory and the console already has it. `threw` is what separates a
  // crash from a verb that returned a nonzero code on purpose.
  log('mc.end', {
    verb: shape.verb, exit_code: 1, duration_ms: Date.now() - startedAt, threw: true,
    error: error?.message || String(error),
  });
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
  ended = true;
}
if (!ended) {
  log('mc.end', { verb: shape.verb, exit_code: process.exitCode ?? 0, duration_ms: Date.now() - startedAt, threw: false });
}

/**
 * Which work area is asking, or the person's own shell.
 *
 * The same derivation the lease and the message channel use, so the name in
 * `mc.log` is the name in `leases.log` and the two join without a mapping.
 * Loaded lazily and never fatally: identity is a nicety here, and the module
 * reads the filesystem.
 */
async function holderName() {
  try {
    const { currentHolder } = await import('./mc/work-identity.js');
    return currentHolder().name;
  } catch { return null; }
}
