/**
 * `mc project` — mc's own verbs over a project (ruling 48, `docs/project/mc/mc-project.md`).
 *
 * For now it records whether a success criterion is met: the register's, never
 * a pull request's. Whoever measured a criterion by its check says so here.
 *
 *   mc project criterion met [<project>] <n>     record that success criterion <n> holds
 *   mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold
 *
 * The project defaults to MC_STEP's in a runner session, so a step session
 * names only the criterion number.
 */
import { parseStepEnv, readEntry, updateCriterion } from '../register.js';
import { workRoot } from '../paths.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  const scanned = scanArgs(argv, { booleans: [], strictValues: [] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [noun, verb, ...rest] = scanned.positional;
  if (noun !== 'criterion' || (verb !== 'met' && verb !== 'unmet') || rest.length < 1 || rest.length > 2) {
    stderr.write(usage());
    return 2;
  }
  const [project, number] = rest.length === 2 ? rest : [parseStepEnv(env.MC_STEP)?.project, rest[0]];
  if (!project) { stderr.write('mc: which project? mc project criterion met <project> <n>, or MC_STEP in a runner session\n'); return 2; }
  if (!/^\d+$/u.test(number)) { stderr.write(`mc: ${number} is not a criterion number — 1 is the plan's first\n`); return 2; }
  const entry = readEntry(root, project, io);
  if (!entry) { stderr.write(`mc: ${project} is not in the register\n`); return 1; }

  try {
    updateCriterion({ root, project, number: Number(number), met: verb === 'met', now, ...io });
    stdout.write(`mc: ${project} criterion ${number} — ${verb === 'met' ? 'met' : 'not met'}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
}

export function usage() {
  return [
    'usage — mc project criterion met [<project>] <n>     record that success criterion <n> holds — it was measured by its check\n',
    '        mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold\n',
    '        the project defaults to MC_STEP\'s in a runner session\n',
  ].join('');
}
