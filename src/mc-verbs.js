/**
 * The verbs `mc` routes to a module, and the one door they are run through.
 *
 * Here rather than in `mc-cli.js` because that file runs the command line the
 * moment it is imported; a test that wants to walk the table cannot import it.
 * The paths are relative to this file, which sits beside `mc-cli.js`.
 */

/** Every verb the dispatcher routes, and the module that answers it. */
export const VERB_MODULES = {
  status: './cli/status.js',
  work: './mc/commands/work.js',
  repo: './mc/commands/repo.js',
  merge: './mc/commands/merge.js',
  test: './mc/commands/test.js',
  gate: './mc/commands/gate.js',
  publish: './mc/commands/publish.js',
  dev: './mc/commands/dev.js',
  deploy: './mc/commands/deploy.js',
  worker: './mc/commands/worker.js',
  brief: './mc/commands/brief.js',
  helper: './mc/commands/helper.js',
  plan: './mc/commands/plan.js',
  run: './mc/commands/run.js',
  roles: './mc/commands/roles.js',
  log: './mc/commands/log.js',
  step: './mc/commands/step.js',
};

/**
 * `--help` or `-h` as a whole word, anywhere after the verb, asks for the
 * usage. Answered here once: a verb's own scanner refuses a `--` word it did
 * not declare, and fifteen verbs each declaring one is fifteen chances to miss.
 */
export const wantsHelp = (argv) => argv.includes('--help') || argv.includes('-h');

/** Import the module and run it, or print its usage on stdout and exit 0. */
export async function runModule(path, argv, { stdout = process.stdout } = {}) {
  const module = await import(path);
  if (wantsHelp(argv)) {
    const text = module.usage();
    stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  return (await module.run(argv)) ?? 0;
}
