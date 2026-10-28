/** Typed v2 operations; none starts execution. */
import { readFileSync } from 'node:fs';
import { workRoot } from '../paths.js';
import { createAutonomousDraft, mutateAutonomousProject, readAutonomousState, sendAutonomousProject } from '../autonomous-state.js';
import { scanArgs } from './flags.js';

export function autonomousCommandContext(deps) {
  const env = deps.env || process.env;
  return { root: deps.root || workRoot(env), actor: deps.actor || { run_id: env.MC_AUTONOMOUS_RUN, role: env.MC_AUTONOMOUS_ROLE } };
}
export function operationArguments(argv, verbs) {
  const scanned = scanArgs(argv, { strictValues: ['--expected-revision', '--input-file'] });
  if (scanned.error) throw new Error(scanned.error);
  const [operation, target, ...extra] = scanned.positional;
  if (!verbs.includes(operation) || !target || extra.length) throw new Error('an operation and target are required');
  const raw = scanned.flags['expected-revision'];
  if (operation !== 'show' && (raw === null || !/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new Error('--expected-revision is required');
  const needsInput = !['show', 'release', 'recover', 'send'].includes(operation);
  if (needsInput !== !!scanned.flags['input-file'] || (operation === 'show' && raw !== null)) throw new Error('this operation needs exactly its revision and input flags');
  return { operation, target, revision: raw === null ? null : Number(raw), file: scanned.flags['input-file'] };
}
export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  let args;
  try { args = operationArguments(argv, ['show', 'create', 'revise', 'progress', 'report', 'confirm', 'attempt', 'release', 'recover', 'send']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const parts = args.target.split('/');
    if (parts.length !== 2) throw new Error('target must be <programme>/<project>');
    const [programme, project] = parts;
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
    const options = { ...deps, actor, revision: args.revision };
    const result = args.operation === 'show' ? readAutonomousState(root, programme, project, deps)
      : args.operation === 'create' ? createAutonomousDraft(root, programme, project, input, options)
        : args.operation === 'send' ? sendAutonomousProject(root, programme, project, options)
        : mutateAutonomousProject(root, programme, project, args.operation, input, options);
    stdout.write(`${JSON.stringify(args.operation === 'send' ? { contract: result, execution_enabled: false } : result, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export function usage() {
  return 'usage — mc autonomous-project show <programme>/<project>\n'
    + '        mc autonomous-project create|revise|progress|report|confirm|attempt <programme>/<project> --expected-revision <n> --input-file <json>\n'
    + '        mc autonomous-project send|release|recover <programme>/<project> --expected-revision <n>\n'
    + '        send publishes an inactive contract; autonomous execution is disabled\n';
}
