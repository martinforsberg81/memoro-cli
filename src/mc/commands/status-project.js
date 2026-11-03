/**
 * `mc status <name>` — one project. See status-project.js for what it reads;
 * this file parses the two flags and prints.
 */
import { commandUsage } from '../command-help.js';
import { phaseOpen, programsGoals } from '../goals.js';
import { programsHome } from '../paths.js';
import { collectProject, renderProject } from '../status-project.js';

export function usage() {
  return commandUsage('status');
}

/**
 * The first goal called `name` under the programmes home, or null, with
 * `held`: whether a lower phase of its programme is still to finish (`phaseOpen`).
 */
function goalNamed(name, env) {
  const goals = programsGoals({ home: programsHome(env) });
  const goal = goals.find((each) => each.goal === name);
  return goal ? { ...goal, held: goal.problems.length === 0 && !phaseOpen(goal, goals) } : null;
}

/** The one form, a project's name and two flags (help-routes.test.js walks the help with it). */
export const ROUTES = { '*': { booleans: ['--json', '--offline'] } };

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const names = [];
  for (const arg of argv) {
    if (ROUTES['*'].booleans.includes(arg)) continue;
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
      const where = goal.stage ? `${goal.stage} · ${goal.status}` : null;
      const state = goal.held ? `${where}, phase ${goal.phase} — after phase ${goal.phase - 1}` : where;
      stderr.write(`${goal.goal} is a goal${state ? ` · ${state}` : ''} — mc goal show ${goal.programme}/${goal.goal}\n`);
      return 1;
    }
    stderr.write(`mc: no project or workarea "${names[0]}" — mc lists them\n`);
    return 1;
  }
  if (argv.includes('--json')) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else stdout.write(renderProject(data));
  return 0;
}
