#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rawArgv = process.argv.slice(2);
const argv = [];
for (const arg of rawArgv) {
  if (arg === '--emit-shell-directives') process.env.MC_EMIT_SHELL_DIRECTIVES = '1';
  else argv.push(arg);
}
const first = argv[0];

// Every invocation, at its two ends.
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
  const logger = await import('./mc/logger.js');
  log = logger.log;
  shape = logger.invocationShape(argv);
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

async function routeV1Command(args) {
  const command = args[0];
  // `mc sessions …` went with the session verbs (2026-08-30). What a person
  // means by it now is a work area, and `mc work` is where that lives.
  if (command === 'sessions') return moved('mc sessions');
  // Bare `mc` is the page: the runner, the queue, the decisions, the intake
  // and every workarea, and at a terminal the way in underneath it. It was
  // the V1 sessions table until 2026-08-29 (decision mc-3) — the front door
  // of the whole system, saying nothing true about it.
  if (args.length === 0) return runModule('./mc/commands/home.js', []);
  // The page's own flags, and only those: anything else that starts with a
  // dash keeps falling through to the capability dispatcher, which is where
  // it was answered before.
  const pageFlags = new Set(['--json', '--fresh', '--offline']);
  if (pageFlags.has(command)
    && args.every((arg) => pageFlags.has(arg) || /^\d+$/u.test(arg))) {
    return runModule('./mc/commands/home.js', args);
  }
  if (command === 'list') return moved('mc list');
  const modules = {
    status: './cli/status.js',
    doctor: './mc/commands/doctor.js',
    work: './mc/commands/work.js',
    repo: './mc/commands/repo.js',
    merge: './mc/commands/merge.js',
    test: './mc/commands/test.js',
    worker: './mc/commands/worker.js',
    brief: './mc/commands/brief.js',
    helper: './mc/commands/helper.js',
    plan: './mc/commands/plan.js',
    run: './mc/commands/run.js',
    roles: './mc/commands/roles.js',
    log: './mc/commands/log.js',
    migrate: './mc/commands/migrate.js',
  };
  return Object.hasOwn(modules, command)
    ? runModule(modules[command], args.slice(1))
    : null;
}

/**
 * A verb that has become part of `mc` itself. It says where it went rather
 * than printing a second list beside the first one — a wrong answer given
 * confidently is worse than none, and silence is worse than both.
 */
function moved(verb) {
  console.error(`mc: ${verb} is now mc — one page, and it is what mc prints`);
  console.error('    mc                  the page, and at a terminal a way in');
  console.error('    mc status <name>    one project');
  return 2;
}

async function runModule(path, argv) {
  const module = await import(path);
  return (await module.run(argv)) ?? 0;
}
