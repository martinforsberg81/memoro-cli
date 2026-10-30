/** Typed v2 operations; none starts execution. */
import { readFileSync } from 'node:fs';
import { workRoot } from '../paths.js';
import { createAutonomousDraft, mutateAutonomousProject, readAutonomousState, sendAutonomousProject } from '../autonomous-state.js';
import { controlResponse } from '../session-control.js';
import { scanArgs } from './flags.js';
import { reviewCommandRefusal } from '../autonomous-review-guard.js';

export function autonomousCommandContext(deps) {
  const env = deps.env || process.env;
  return { root: deps.root || workRoot(env), actor: deps.actor || (env.MC_AUTONOMOUS_ROLE && env.MC_AUTONOMOUS_ROLE !== 'foreground-plan' ? { run_id: env.MC_AUTONOMOUS_RUN, role: env.MC_AUTONOMOUS_ROLE } : undefined) };
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
  if ((deps.env || process.env).MC_AUTONOMOUS_ROLE === 'plan') {
    const refusal = reviewCommandRefusal(['goal', ...argv], deps);
    if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  }
  let args;
  try { args = operationArguments(argv, ['show', 'create', 'revise', 'progress', 'report', 'confirm', 'attempt', 'release', 'recover', 'send', 'finish']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const parts = args.target.split('/');
    if (parts.length !== 2) throw new Error('target must be <programme>/<project>');
    const [programme, project] = parts;
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
    const options = { ...deps, actor, revision: args.revision };
    if (args.operation === 'finish') {
      const { finishAutonomousPublication } = await import('../autonomous-publish.js');
      const publication = await finishAutonomousPublication({ root, programme, project, actor, revision: args.revision,
        cwd: deps.cwd || process.cwd(), env: deps.env || process.env }, input, { ...deps, stdout, stderr });
      stdout.write(`${JSON.stringify({ phase: publication.phase, head: publication.head, pr: publication.pr,
        next_action: 'exit-session', normal_exit: false, queued: false })}\n`);
      return 0;
    }
    const result = args.operation === 'show' ? readAutonomousState(root, programme, project, deps)
      : args.operation === 'create' ? createAutonomousDraft(root, programme, project, input, options)
        : args.operation === 'send' ? sendAutonomousProject(root, programme, project, options)
        : mutateAutonomousProject(root, programme, project, args.operation, input, options);
    const response = result.session_control && ['show', 'progress'].includes(args.operation)
      ? { ...result, control: controlResponse(result.session_control) } : result;
    stdout.write(`${JSON.stringify(args.operation === 'send' ? { contract: result, execution_enabled: false } : response, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}
