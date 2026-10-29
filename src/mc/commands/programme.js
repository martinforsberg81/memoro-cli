/** Programme contract drafts are separate from approved immutable revisions. */
import { readFileSync } from 'node:fs';
import { mutateProgramme, readProgrammeState } from '../autonomous-state.js';
import { autonomousCommandContext, operationArguments } from './autonomous-project.js';
import { reviewCommandRefusal } from '../autonomous-review-guard.js';
import { decideProgrammePlan } from '../programme-plan.js';
import { completeProgrammePlan, cancelProgrammeOperation } from '../programme-jobs.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  const refusal = reviewCommandRefusal(['programme', ...argv], deps);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  let args;
  try { args = operationArguments(argv, ['show', 'draft', 'approve', 'decide', 'complete', 'cancel']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
    const env = deps.env || process.env;
    if (actor.role === 'plan' && env.MC_PROGRAMME && env.MC_PROGRAMME !== args.target) throw new Error('planner target must match the owning programme');
    const options = { root, programme: args.target, actor, token: deps.token || env.MC_PROGRAMME_LEASE,
      revision: args.revision, now: deps.now ? Number(deps.now()) : Date.now(), deps };
    const result = args.operation === 'decide' ? decideProgrammePlan(options, input)
      : args.operation === 'complete' ? completeProgrammePlan(options, input)
        : args.operation === 'cancel' ? cancelProgrammeOperation(options, input)
          : args.operation === 'show' ? readProgrammeState(root, args.target, deps)
      : mutateProgramme(root, args.target, args.operation, input, { ...deps, actor, revision: args.revision });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export function usage() {
  return 'usage — mc programme show <programme>\n'
    + '        mc programme draft|approve <programme> --expected-revision <n> --input-file <json>\n'
    + '        mc programme decide|complete|cancel <programme> --expected-revision <n> --input-file <json> (active planner lease only)\n'
    + '        contracts only; programme start is not available\n';
}
