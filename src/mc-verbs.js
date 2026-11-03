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
  tidy: './mc/commands/tidy.js',
  layout: './mc/commands/layout.js',
  repos: './mc/commands/repos.js',
  repo: './mc/commands/repo.js',
  merge: './mc/commands/merge.js',
  test: './mc/commands/test.js',
  gate: './mc/commands/gate.js',
  keys: './mc/commands/keys.js',
  shot: './mc/commands/shot.js',
  hook: './mc/commands/hook.js',
  publish: './mc/commands/publish.js',
  dev: './mc/commands/dev.js',
  docker: './mc/commands/docker.js',
  deploy: './mc/commands/deploy.js',
  asc: './mc/commands/asc.js',
  language: './mc/commands/language.js',
  deps: './mc/commands/deps.js',
  prs: './mc/commands/prs.js',
  brief: './mc/commands/brief.js',
  helper: './mc/commands/helper.js',
  plan: './mc/commands/plan.js',
  run: './mc/commands/run.js',
  roles: './mc/commands/roles.js',
  skills: './mc/commands/skills.js',
  model: './mc/commands/model.js',
  log: './mc/commands/log.js',
  step: './mc/commands/step.js',
  project: './mc/commands/project.js',
  goal: './mc/commands/goal.js',
  programs: './mc/commands/programs.js',
};

/**
 * The verbs that went on 2026-11-03 (goal mc/no-work): every session belongs
 * to a programme (plan, build, review) or a desk (brief, helper), and there is
 * no third kind. The dispatcher answers either with `retiredLines` and exit 2.
 */
export const RETIRED_VERBS = Object.freeze(['work', 'worker']);

/** What a retired verb says, whatever follows it: where each kind of session starts now. */
export function retiredLines(verb) {
  return [
    `mc: mc ${verb} is gone — every session belongs to a programme or a desk`,
    '    mc                    the page; a project\'s number opens its runner area',
    '    mc plan <programme>   plan a programme',
    '    mc brief · mc helper  the two desks',
    '    mc tidy               what is left under ~/mc/work/, and whether it can go',
  ];
}

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
  if (wantsHelp(argv) && !module.handlesHelp?.(argv)) {
    const text = module.usage();
    stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  return (await module.run(argv)) ?? 0;
}

/**
 * The binary's own routing: the page, the verbs that moved, and the verbs in
 * `VERB_MODULES`; `null` for anything it declines, which `mc-cli.js` hands to
 * the capability dispatcher. Here rather than there for the reason the table
 * is: a test can call it without running a command line.
 */
export async function routeV1Command(args, { stderr = process.stderr, run = runModule } = {}) {
  const command = args[0];
  // `mc sessions …` went with the session verbs (2026-08-30).
  if (command === 'sessions') return moved('mc sessions', stderr);
  // The workarea verbs went on 2026-11-03: every session belongs to a
  // programme or a desk, and there is no third kind (`RETIRED_VERBS`).
  if (RETIRED_VERBS.includes(command)) return retired(command, stderr);
  // Bare `mc` is the page: the runner, the queue, the decisions, the intake
  // and every workarea, and at a terminal the way in underneath it. It was
  // the V1 sessions table until 2026-08-29 (decision mc-3) — the front door
  // of the whole system, saying nothing true about it.
  if (args.length === 0) return run('./mc/commands/home.js', []);
  // The page's own flags, and only those: anything else that starts with a
  // dash keeps falling through to the capability dispatcher, which is where
  // it was answered before.
  const pageFlags = new Set(['--json', '--fresh', '--offline']);
  if (pageFlags.has(command)
    && args.every((arg) => pageFlags.has(arg) || /^\d+$/u.test(arg))) {
    return run('./mc/commands/home.js', args);
  }
  if (command === 'list') return moved('mc list', stderr);
  // The surface, and nothing beside it. `mc doctor` and `mc migrate` went on
  // 2026-09-03: both answer questions about the V1 session store — session
  // homes, generation journals, the pre-V1 move — and that store is what
  // `mc-cut` is removing. A verb that reports on machinery nobody runs is a
  // second product's front door left standing in this one's hallway.
  return Object.hasOwn(VERB_MODULES, command)
    ? run(VERB_MODULES[command], args.slice(1))
    : null;
}

/**
 * A verb that has become part of `mc` itself. It says where it went rather
 * than printing a second list beside the first one — a wrong answer given
 * confidently is worse than none, and silence is worse than both.
 */
function moved(verb, stderr) {
  stderr.write(`mc: ${verb} is now mc — one page, and it is what mc prints\n`);
  stderr.write('    mc                  the page, and at a terminal a way in\n');
  stderr.write('    mc status <name>    one project\n');
  return 2;
}

/** A retired verb, whatever follows it: `retiredLines` says where things went. */
function retired(verb, stderr) {
  for (const line of retiredLines(verb)) stderr.write(`${line}\n`);
  return 2;
}
