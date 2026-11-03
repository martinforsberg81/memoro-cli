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
 *
 * The word is routed by the binary's own `routeV1Command`, with the module
 * run here instead of through `runModule`: bare `mc` and its page flags are
 * the page, `mc list` and `mc sessions` say where they went, and a word the
 * binary hands to the capability dispatcher is not one this runs.
 */
import { VERB_MODULES, routeV1Command } from '../../../src/mc-verbs.js';

const PINNED = { MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1' };

const moduleOf = (path) => import(new URL(path.replace('./', '../../../src/'), import.meta.url));

/**
 * The verbs' modules, loaded now: a file calls it at its top, so its first
 * test does not pay every import the verb makes (0.4-0.7 s, 2026-11-03).
 */
export async function preloadVerbs(...names) {
  await Promise.all(names.map((name) => moduleOf(VERB_MODULES[name])));
}

export async function runVerb(args, env = {}, { cwd = null, ...deps } = {}) {
  const overlay = { ...PINNED, ...env };
  const saved = {};
  for (const [key, value] of Object.entries(overlay)) {
    saved[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
    process.env[key] = value;
  }
  const out = [];
  const err = [];
  const stdout = { write: (text) => { out.push(text); } };
  const stderr = { write: (text) => { err.push(text); } };
  const was = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const status = await routeV1Command(args, {
      stderr,
      run: async (path, argv) => ((await moduleOf(path)).run(argv, { ...deps, stdout, stderr })) ?? 0,
    });
    if (status === null) throw new Error(`runVerb: ${args[0]} is not a word routeV1Command routes`);
    return { status, stdout: out.join(''), stderr: err.join('') };
  } finally {
    if (cwd) process.chdir(was);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
