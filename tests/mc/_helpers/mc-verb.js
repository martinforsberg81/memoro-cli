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

export async function runVerb([name, ...argv], env = {}, { cwd = null, ...deps } = {}) {
  const module = await import(new URL(VERB_MODULES[name].replace('./', '../../../src/'), import.meta.url));
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
