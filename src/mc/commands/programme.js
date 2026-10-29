/** Programme contract drafts are separate from approved immutable revisions.
 * status/start/pause/resume are the operator's; start records an activation
 * only where the installation supports every control capability. */
import { readFileSync } from 'node:fs';
import { mutateProgramme, readProgrammeState } from '../autonomous-state.js';
import { autonomousCommandContext, operationArguments } from './autonomous-project.js';
import { reviewCommandRefusal } from '../autonomous-review-guard.js';
import { decideProgrammePlan } from '../programme-plan.js';
import { completeProgrammePlan, cancelProgrammeOperation } from '../programme-jobs.js';
import { operatorRefusal, pauseProgramme, resumeProgramme, startProgramme } from '../programme-control.js';
import { capabilityReport, programmeStatus, renderCapabilities, renderProgrammeStatus } from '../programme-status.js';
import { readModels } from '../model-config.js';
import { scanArgs } from './flags.js';

const CONTROL = ['status', 'start', 'pause', 'resume'];

/** `capabilities [--json]`: a read of this installation, no programme. */
function capabilities(argv, deps, { stdout, stderr }) {
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  if (scanned.error || scanned.positional.length) { stderr.write(`mc: ${scanned.error || 'capabilities takes only --json'}\n`); return 2; }
  const report = capabilityReport(deps);
  stdout.write(scanned.flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderCapabilities(report));
  return 0;
}

/** `status [--json]`, `start --expected-revision --stop --input-file`,
 * `pause [--expected-revision]`, `resume --expected-revision`. */
function controlArguments(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--expected-revision', '--input-file', '--stop', '--by'] });
  if (scanned.error) throw new Error(scanned.error);
  const [operation, target, ...extra] = scanned.positional;
  if (!target || extra.length) throw new Error('an operation and target are required');
  const { json, stop, by } = scanned.flags;
  const raw = scanned.flags['expected-revision'];
  const file = scanned.flags['input-file'];
  if (raw !== null && (!/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new Error('--expected-revision is a state revision');
  const allowed = { status: ['json'], start: ['revision', 'input', 'stop'], pause: ['revision', 'by'], resume: ['revision', 'by'] }[operation];
  const given = { json, revision: raw !== null, input: !!file, stop: !!stop, by: !!by };
  if (Object.entries(given).some(([key, value]) => value && !allowed.includes(key))) throw new Error(`${operation} takes only ${allowed.map(key => `--${key === 'revision' ? 'expected-revision' : key === 'input' ? 'input-file' : key}`).join(', ') || 'a programme'}`);
  if (['start', 'resume'].includes(operation) && raw === null) throw new Error('--expected-revision is required: read mc programme status first');
  if (operation === 'start' && (!file || !stop)) throw new Error('start needs --stop <planned stop> and --input-file <profiles json>');
  return { operation, target, json, stop, by, file, revision: raw === null ? null : Number(raw) };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  const refusal = reviewCommandRefusal(['programme', ...argv], deps);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  const env = deps.env || process.env;
  if (argv[0] === 'capabilities') return capabilities(argv.slice(1), deps, { stdout, stderr });
  if (CONTROL.includes(argv[0])) return control(argv, deps, { stdout, stderr, env });
  let args;
  try { args = operationArguments(argv, ['show', 'draft', 'approve', 'decide', 'complete', 'cancel']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
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

async function control(argv, deps, { stdout, stderr, env }) {
  let args;
  try { args = controlArguments(argv); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root } = autonomousCommandContext(deps);
    if (args.operation === 'status') {
      const status = programmeStatus(root, args.target, deps);
      stdout.write(args.json ? `${JSON.stringify(status, null, 2)}\n` : renderProgrammeStatus(status));
      return status.problem ? 1 : 0;
    }
    const denied = operatorRefusal(env);
    if (denied) throw new Error(denied);
    const now = deps.now ? Number(deps.now()) : Date.now();
    const by = args.by || env.USER || 'operator';
    const options = { root, programme: args.target, revision: args.revision, now,
      deps: { ...deps, catalog: deps.catalog || (() => readModels(env)) } };
    if (args.operation === 'start') {
      const input = JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file));
      startProgramme({ ...options, stop: args.stop }, input);
    } else if (args.operation === 'pause') pauseProgramme({ ...options, by });
    else resumeProgramme({ ...options, by });
    const status = programmeStatus(root, args.target, deps);
    stdout.write(`${JSON.stringify({ programme: args.target, mode: status.mode, state_revision: status.state_revision,
      in_flight: status.in_flight, next_action: status.next_action }, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export function usage() {
  return 'usage — mc programme show <programme>\n'
    + '        mc programme capabilities [--json]\n'
    + '        mc programme status <programme> [--json]\n'
    + '        mc programme start <programme> --expected-revision <n> --stop <planned stop> --input-file <json>\n'
    + '        mc programme pause <programme> [--expected-revision <n>] [--by <name>]\n'
    + '        mc programme resume <programme> --expected-revision <n> [--by <name>]\n'
    + '        mc programme draft|approve <programme> --expected-revision <n> --input-file <json>\n'
    + '        mc programme decide|complete|cancel <programme> --expected-revision <n> --input-file <json> (active planner lease only)\n'
    + '        start input: { "by", "build": { "class", "profile" }, "review": { "model" } }; start refuses\n'
    + '        unless this installation supports every control capability — mc programme capabilities says\n'
    + '        what it has and lacks; the installed runner supports none\n';
}
