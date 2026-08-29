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
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}

async function routeV1Command(args) {
  const command = args[0];
  if (command === 'sessions') {
    const subcommand = args[1];
    const rest = args.slice(2);
    if (subcommand === 'list') return moved('mc sessions list');
    if (subcommand === 'send') {
      if (!rest[0] || rest.length < 2) {
        console.error('mc: usage — mc sessions send <session> <message>');
        return 2;
      }
      return runModule('./cli/dispatch.js', [rest[0], '--message', rest.slice(1).join(' ')]);
    }
    if (subcommand === 'read') return runModule('./cli/read.js', rest);
    return null;
  }
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
    new: './cli/new.js',
    open: './cli/open.js',
    resume: './cli/resume.js',
    status: './cli/status.js',
    rename: './cli/rename.js',
    cd: './cli/cd.js',
    attach: './cli/attach.js',
    dispatch: './cli/dispatch.js',
    read: './cli/read.js',
    end: './mc/commands/end.js',
    delete: './mc/commands/delete.js',
    cleanup: './mc/commands/cleanup.js',
    gc: './mc/commands/gc.js',
    storage: './mc/commands/storage.js',
    doctor: './mc/commands/doctor.js',
    worktrees: './mc/commands/worktrees.js',
    worktree: './mc/commands/worktree.js',
    work: './mc/commands/work.js',
    task: './mc/commands/task.js',
    repo: './mc/commands/repo.js',
    merge: './mc/commands/merge.js',
    suite: './mc/commands/suite.js',
    worker: './mc/commands/worker.js',
    brief: './mc/commands/brief.js',
    helper: './mc/commands/helper.js',
    plan: './mc/commands/plan.js',
    run: './mc/commands/run.js',
    roles: './mc/commands/roles.js',
    pm: './mc/commands/pm.js',
    'pm-helper': './mc/commands/pm-helper.js',
    restart: './cli/restart.js',
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
