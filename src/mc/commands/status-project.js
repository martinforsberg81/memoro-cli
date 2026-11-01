/**
 * `mc status <name>` — one project. See status-project.js for what it reads;
 * this file parses the two flags and prints.
 */
import { programsGoals } from '../goals.js';
import { programsHome } from '../paths.js';
import { collectProject, renderProject } from '../status-project.js';

export function usage() {
  return 'usage — mc status <name> [--json] [--offline]\n';
}

/** The first goal called `name` under the programmes home, or null. */
function goalNamed(name, env) {
  return programsGoals({ home: programsHome(env) }).find((goal) => goal.goal === name) ?? null;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const names = [];
  for (const arg of argv) {
    if (arg === '--json' || arg === '--offline') continue;
    if (arg.startsWith('--')) {
      stderr.write(`mc: unknown argument ${arg}\n`);
      stderr.write(usage());
      return 2;
    }
    names.push(arg);
  }
  if (names.length !== 1) {
    stderr.write(usage());
    return 2;
  }
  const data = await (deps.collect || collectProject)(names[0], { ...deps, offline: argv.includes('--offline') });
  if (!data) {
    // A goal is not a project, and `mc status` does not read one: it says where
    // the goal is shown, and that is the answer to the question asked.
    const goal = goalNamed(names[0], deps.env || process.env);
    if (goal) {
      stderr.write(`${goal.goal} is a goal — mc goal show ${goal.programme}/${goal.goal}\n`);
      return 1;
    }
    stderr.write(`mc: no project or workarea "${names[0]}" — mc lists them\n`);
    return 1;
  }
  if (argv.includes('--json')) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else stdout.write(renderProject(data));
  return 0;
}
