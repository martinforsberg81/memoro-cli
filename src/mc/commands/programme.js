/** Programme contract drafts are separate from approved immutable revisions. */
import { readFileSync } from 'node:fs';
import { mutateProgramme, readProgrammeState } from '../autonomous-state.js';
import { autonomousCommandContext, operationArguments } from './autonomous-project.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  let args;
  try { args = operationArguments(argv, ['show', 'draft', 'approve']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
    const result = args.operation === 'show' ? readProgrammeState(root, args.target, deps)
      : mutateProgramme(root, args.target, args.operation, input, { ...deps, actor, revision: args.revision });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export function usage() {
  return 'usage — mc programme show <programme>\n'
    + '        mc programme draft|approve <programme> --expected-revision <n> --input-file <json>\n'
    + '        contracts only; programme start is not available\n';
}
