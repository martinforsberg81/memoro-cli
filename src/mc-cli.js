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
    if (subcommand === 'list') return runModule('./cli/list.js', rest);
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
  const modules = {
    new: './cli/new.js',
    open: './cli/open.js',
    resume: './cli/resume.js',
    list: './cli/list.js',
    status: './cli/status.js',
    rename: './cli/rename.js',
    cd: './cli/cd.js',
    attach: './cli/attach.js',
    dispatch: './cli/dispatch.js',
    read: './cli/read.js',
  };
  return Object.hasOwn(modules, command)
    ? runModule(modules[command], args.slice(1))
    : null;
}

async function runModule(path, argv) {
  const module = await import(path);
  return (await module.run(argv)) ?? 0;
}
