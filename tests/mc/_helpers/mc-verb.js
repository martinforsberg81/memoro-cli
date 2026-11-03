/**
 * `mc <verb> …` as the binary runs it, in this process.
 *
 * The module `VERB_MODULES` dispatches the word to — the binary's own table —
 * its `run` with the arguments after it, and what it wrote to stdout and
 * stderr. A process per call (`runMcCli`) costs a node start and every import
 * each time; the grammar and the work are the verb's own either way.
 *
 * The verbs read where they stand from `process.env` (MC_HOME, MC_WORK_ROOT,
 * PATH), so `env` is laid over it for the call and taken off afterwards, with
 * the same two pins `runMcCli` sets. Tests in one file run one after another,
 * so no other test sees the overlay; a test that runs concurrently with
 * another must not use this. `deps` goes to the verb's `run` beside the two
 * streams: the seams a verb takes (a clock, a sleep); `deps.cwd` is where
 * the call stands (`process.chdir`, put back afterwards), for a verb that
 * reads who asks from where they are.
 */
import { VERB_MODULES } from '../../../src/mc-verbs.js';

const PINNED = { MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1' };

const PAGE_FLAGS = new Set(['--json', '--fresh', '--offline']);

const moduleOf = (path) => import(new URL(path.replace('./', '../../../src/'), import.meta.url));

/**
 * The verbs' modules, loaded now: a file calls it at its top, so its first
 * test does not pay every import the verb makes (0.4-0.7 s, 2026-11-03).
 */
export async function preloadVerbs(...names) {
  await Promise.all(names.map((name) => moduleOf(VERB_MODULES[name])));
}

export async function runVerb(args, env = {}, { cwd = null, ...deps } = {}) {
  // Bare `mc`, and `mc` with only the page's flags, is the page, as
  // `routeV1Command` in src/mc-cli.js routes it; anything else is a verb.
  const page = args.every((arg) => PAGE_FLAGS.has(arg) || /^\d+$/u.test(arg)) && (!args.length || PAGE_FLAGS.has(args[0]));
  const [path, argv] = page ? ['./mc/commands/home.js', args] : [VERB_MODULES[args[0]], args.slice(1)];
  if (!path) throw new Error(`runVerb: ${args[0]} is not a verb in VERB_MODULES`);
  const module = await moduleOf(path);
  const overlay = { ...PINNED, ...env };
  const saved = {};
  for (const [key, value] of Object.entries(overlay)) {
    saved[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
    process.env[key] = value;
  }
  const out = [];
  const err = [];
  const was = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const status = await module.run(argv, {
      ...deps,
      stdout: { write: (text) => { out.push(text); } },
      stderr: { write: (text) => { err.push(text); } },
    });
    return { status: status ?? 0, stdout: out.join(''), stderr: err.join('') };
  } finally {
    if (cwd) process.chdir(was);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
