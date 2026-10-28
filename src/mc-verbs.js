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
  tidy: './mc/commands/tidy.js',
  layout: './mc/commands/layout.js',
  repos: './mc/commands/repos.js',
  repo: './mc/commands/repo.js',
  merge: './mc/commands/merge.js',
  test: './mc/commands/test.js',
  gate: './mc/commands/gate.js',
  shot: './mc/commands/shot.js',
  hook: './mc/commands/hook.js',
  publish: './mc/commands/publish.js',
  dev: './mc/commands/dev.js',
  docker: './mc/commands/docker.js',
  deploy: './mc/commands/deploy.js',
  build: './mc/commands/build.js',
  language: './mc/commands/language.js',
  deps: './mc/commands/deps.js',
  prs: './mc/commands/prs.js',
  worker: './mc/commands/worker.js',
  brief: './mc/commands/brief.js',
  helper: './mc/commands/helper.js',
  plan: './mc/commands/plan.js',
  run: './mc/commands/run.js',
  roles: './mc/commands/roles.js',
  model: './mc/commands/model.js',
  log: './mc/commands/log.js',
  step: './mc/commands/step.js',
  project: './mc/commands/project.js',
  programme: './mc/commands/programme.js',
  'session-control': './mc/commands/session-control.js',
  'autonomous-project': './mc/commands/autonomous-project.js',
};

/**
 * `--help` or `-h` as a whole word, anywhere after the verb, asks for the
 * usage. Answered here once: a verb's own scanner refuses a `--` word it did
 * not declare, and fifteen verbs each declaring one is fifteen chances to miss.
 */
export const wantsHelp = (argv) => argv.includes('--help') || argv.includes('-h');

/** The streams that already have their closed-reader listener. */
const guarded = new WeakSet();

/**
 * The codes a write gets once the reader has gone. EPIPE on a plain pipe;
 * ENOTCONN on macOS, where node's stdio pipe to a child is a socket.
 */
const READER_GONE = new Set(['EPIPE', 'ENOTCONN']);

/**
 * A reader that goes away early is the caller's choice, not a fault in the
 * verb: `mc project discard x | grep -q 'would remove'` and `mc … | head -1`
 * both close the pipe while the verb is still writing. Node raises that as an
 * `error` event with nothing listening, and the stack trace lands on stderr.
 * So the first EPIPE is noted and dropped, and so are the writes that follow
 * it on the dead pipe. Anything else is thrown again, as it was before.
 *
 * The verb's return value still sets the exit code; nothing here exits.
 */
export function quietOnClosedReader(stream = process.stdout) {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  let readerGone = false;
  stream.on('error', (error) => {
    if (READER_GONE.has(error?.code)) { readerGone = true; return; }
    if (readerGone && error?.code === 'ERR_STREAM_DESTROYED') return;
    throw error;
  });
}

/** Import the module and run it, or print its usage on stdout and exit 0. */
export async function runModule(path, argv, { stdout = process.stdout } = {}) {
  // The guard is on process.stdout even when a caller passes its own stdout:
  // the verbs write to process.stdout themselves.
  quietOnClosedReader(process.stdout);
  const module = await import(path);
  if (wantsHelp(argv)) {
    const text = module.usage();
    stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  return (await module.run(argv)) ?? 0;
}
