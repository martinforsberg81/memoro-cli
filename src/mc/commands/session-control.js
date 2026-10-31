/** Durable v2 checkpoint responses for either tool; never a start switch. */
import { readFileSync } from 'node:fs';
import { projectSessionCheckpoint } from '../autonomous-state.js';
import { goalCommandContext as autonomousCommandContext } from './goal.js';
import { scanArgs } from './flags.js';
import { markControlRead } from '../provider-observations.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  try {
    const args = scanArgs(argv, { strictValues: ['--expected-revision', '--input-file'] });
    if (args.error) throw new Error(args.error);
    const [operation, target, ...extra] = args.positional;
    const revision = args.flags['expected-revision']; const file = args.flags['input-file'];
    if (!['status', 'criterion', 'checkpoint'].includes(operation) || !target || extra.length
      || !/^[1-9][0-9]*$/u.test(revision || '') || !Number.isSafeInteger(Number(revision))
      || (operation === 'status' ? !!file : !file)) throw new Error('callback needs a target, expected revision and (except status) input file');
    const parts = target.split('/'); if (parts.length !== 2) throw new Error('target must be <programme>/<project>');
    const input = file ? JSON.parse((deps.readInput || (path => readFileSync(path, 'utf8')))(file)) : {};
    const { root, actor } = autonomousCommandContext(deps);
    const result = projectSessionCheckpoint(root, ...parts, operation, input,
      { ...deps, actor, revision: Number(revision) });
    // A read leaves no state; a lost mark costs an observation, never the session's answer.
    const directory = (deps.env || process.env).MC_SCRATCH;
    if (operation === 'status' && directory) { try { markControlRead(directory, actor.run_id); } catch { /* unobserved */ } }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}
export function usage() {
  return 'usage — mc session-control status <programme>/<project> --expected-revision <n>\n'
    + '        mc session-control criterion|checkpoint <programme>/<project> --expected-revision <n> --input-file <json>\n'
    + '        Reads runner-owned durable control; does not launch autonomous execution.\n';
}
