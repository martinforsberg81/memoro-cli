/** Programme metadata is context, never goal assignment authority.
 * status/autonomy are the operator's; autonomy on records a preference only
 * where the installation supports every control capability. phase and stop are
 * ordinary planning verbs for foreground and leased sessions alike. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { autonomousPaths, mutateProgramme, readProgrammeState } from '../autonomous-state.js';
import { autonomousCommandContext, operationArguments } from './autonomous-project.js';
import { reviewCommandRefusal } from '../autonomous-review-guard.js';
import { operatorRefusal, programmeAutonomyOff, programmeAutonomyOn } from '../programme-control.js';
import { cancelProgrammeOperation, holdProgrammePlan, listProgrammeEvents, reachProgrammeStop } from '../programme-jobs.js';
import { acknowledgePlanningEvents, planningOperationId } from '../programme-plan.js';
import { capabilityReport, programmeStatus, renderCapabilities, renderProgrammeStatus } from '../programme-status.js';
import { scanArgs } from './flags.js';

const CONTROL = ['status', 'autonomy'];
const PLANNING = ['phase', 'stop', 'wait', 'events', 'operation'];
const REVISION_RE = /^(0|[1-9][0-9]*)$/u;
const revisionFlag = raw => {
  if (raw !== null && (!REVISION_RE.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new Error('--expected-revision is a state revision');
  return raw === null ? null : Number(raw);
};

/** `capabilities [--json]`: a read of this installation, no programme. */
function capabilities(argv, deps, { stdout, stderr }) {
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  if (scanned.error || scanned.positional.length) { stderr.write(`mc: ${scanned.error || 'capabilities takes only --json'}\n`); return 2; }
  const report = capabilityReport(deps);
  stdout.write(scanned.flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderCapabilities(report));
  return 0;
}

/** `status <programme> [--json]`, `autonomy <programme> on|off
 * [--stop <prose>] [--expected-revision <n>] [--by <name>]`. */
function controlArguments(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--expected-revision', '--stop', '--by'] });
  if (scanned.error) throw new Error(scanned.error);
  const [operation, target, setting, ...extra] = scanned.positional;
  if (!target || extra.length) throw new Error('an operation and target are required');
  const { json, stop, by } = scanned.flags;
  const revision = revisionFlag(scanned.flags['expected-revision']);
  if (operation === 'status') {
    if (setting || stop || by || revision !== null) throw new Error('status takes only a programme and --json');
    return { operation, target, json };
  }
  if (!['on', 'off'].includes(setting) || json) throw new Error('autonomy takes <programme> on|off');
  if (setting === 'off' && stop) throw new Error('--stop belongs to autonomy on');
  if (setting === 'on' && revision === null) throw new Error('--expected-revision is required: read mc programme status first');
  return { operation, target, setting, stop: stop ?? null, by, revision };
}

/** `phase add <programme> <n> <name> --purpose <text>`, `phase close <programme> <n>
 * --reference <ref>`, `stop <programme> --reference <ref>`; revision optional. */
function planningArguments(argv) {
  const scanned = scanArgs(argv, { strictValues: ['--expected-revision', '--purpose', '--reference', '--condition', '--kind', '--reason', '--until'], repeatable: ['--event'] });
  if (scanned.error) throw new Error(scanned.error);
  const { purpose, reference, condition, kind, reason, until, event } = scanned.flags;
  const revision = revisionFlag(scanned.flags['expected-revision']);
  const [verb, ...rest] = scanned.positional;
  if (verb === 'events') {
    const [action, target, ...extra] = rest;
    if (!target || extra.length || purpose || condition || kind || reason || until) throw new Error('events takes list|ack <programme>');
    if (action === 'list' && !reference && !event.length && revision === null) return { operation: 'events-list', target };
    if (action === 'ack' && reference && event.length) return { operation: 'events-ack', target, input: { event_ids: event, reference }, revision };
    throw new Error('events list takes only <programme>; events ack needs --event and --reference');
  }
  if (verb === 'wait') {
    if (rest.length !== 1 || !condition || !kind || !reason || !reference || purpose || event.length) throw new Error('wait takes <programme> --condition <id> --kind <kind> --reason <text> --reference <evidence> [--until <time>]');
    const instant = until === null ? null : /^[0-9]+$/u.test(until) ? Number(until) : Date.parse(until);
    if (Number.isNaN(instant)) throw new Error('--until is a time');
    return { operation: 'wait', target: rest[0], input: { condition, reference, wait: { kind, reason, until: instant } }, revision };
  }
  if (verb === 'operation') {
    const [action, target, id, ...extra] = rest;
    if (action !== 'cancel' || !target || !id || extra.length || !reason) throw new Error('operation takes cancel <programme> <id> --reason <text>');
    return { operation: 'operation-cancel', target, input: { id, reason }, revision };
  }
  if (verb === 'stop') {
    if (rest.length !== 1 || !reference || purpose) throw new Error('stop takes <programme> --reference <evidence>');
    return { operation: 'stop', target: rest[0], reference, revision };
  }
  const [action, target, number, name, ...extra] = rest;
  if (!/^[1-9][0-9]*$/u.test(number || '') || !Number.isSafeInteger(Number(number)) || extra.length) throw new Error('phase takes add|close <programme> <n>');
  const n = Number(number);
  if (action === 'add' && name && purpose && !reference) return { operation: 'phase-add', target, input: { n, name, purpose }, revision };
  if (action === 'close' && !name && reference && !purpose) return { operation: 'phase-close', target, input: { n, reference }, revision };
  throw new Error('phase add needs <name> and --purpose; phase close needs --reference');
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  const refusal = reviewCommandRefusal(['programme', ...argv], deps);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  const env = deps.env || process.env;
  if (argv[0] === 'capabilities') return capabilities(argv.slice(1), deps, { stdout, stderr });
  if (CONTROL.includes(argv[0])) return control(argv, deps, { stdout, stderr, env });
  if (PLANNING.includes(argv[0])) return planning(argv, deps, { stdout, stderr, env });
  let args;
  try { args = operationArguments(argv, ['show', 'metadata']); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root, actor } = autonomousCommandContext(deps);
    const input = args.file ? JSON.parse((deps.readInput || (file => readFileSync(file, 'utf8')))(args.file)) : null;
    if (actor?.role === 'plan' && env.MC_PROGRAMME && env.MC_PROGRAMME !== args.target) throw new Error('planner target must match the owning programme');
    const options = { root, programme: args.target, actor, token: deps.token || env.MC_PROGRAMME_LEASE,
      revision: args.revision, now: deps.now ? Number(deps.now()) : Date.now(), deps };
    const result = args.operation === 'show' ? readProgrammeState(root, args.target, deps)
      : mutateProgramme(root, args.target, args.operation, input, { ...deps, actor, revision: args.revision,
        operation: { id: planningOperationId('metadata', args.target, args.revision, input), kind: 'programme-metadata', input } });
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
    const options = { root, programme: args.target, revision: args.revision, by: args.by || env.USER || 'operator', now, deps };
    if (args.setting === 'on') programmeAutonomyOn({ ...options, stop: args.stop });
    else programmeAutonomyOff(options);
    const status = programmeStatus(root, args.target, deps);
    stdout.write(`${JSON.stringify({ programme: args.target, mode: status.mode, autonomy: status.autonomy, state_revision: status.state_revision,
      in_flight: status.in_flight, next_action: status.next_action }, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

async function planning(argv, deps, { stdout, stderr, env }) {
  let args;
  try { args = planningArguments(argv); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
  try {
    const { root, actor } = autonomousCommandContext(deps);
    if (actor && actor.role !== 'plan') throw new Error('only planning roles may change the programme');
    if (actor && env.MC_PROGRAMME && env.MC_PROGRAMME !== args.target) throw new Error('planner target must match the owning programme');
    const token = deps.token || env.MC_PROGRAMME_LEASE;
    const revision = args.revision ?? (existsSync(autonomousPaths(root, args.target).programme) ? readProgrammeState(root, args.target, deps).revision : 0);
    const now = deps.now ? Number(deps.now()) : Date.now();
    const options = { root, programme: args.target, revision, actor, token, now, deps: { ...deps, env } };
    const journaled = { id: planningOperationId(args.operation, args.target, revision, args.input), kind: `programme-${args.operation}`, input: args.input };
    const result = args.operation === 'stop' ? reachProgrammeStop(options, { id: `stop-${createHash('sha256').update(args.reference).digest('hex').slice(0, 40)}`, reference: args.reference })
      : args.operation === 'events-list' ? listProgrammeEvents(options)
        : args.operation === 'events-ack' ? acknowledgePlanningEvents({ ...options, revision: args.revision }, args.input)
          : args.operation === 'operation-cancel' ? cancelProgrammeOperation(options, args.input)
            : args.operation === 'wait' ? holdProgrammePlan(options, { ...args.input, id: `wait-${createHash('sha256').update(JSON.stringify(args.input)).digest('hex').slice(0, 40)}`, kind: 'wait-programme' })
              : mutateProgramme(root, args.target, args.operation, args.input, { ...deps, env, actor, token, revision, now: () => now, operation: journaled });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

export function usage() {
  return 'usage — mc programme show <programme>\n'
    + '        mc programme capabilities [--json]\n'
    + '        mc programme status <programme> [--json]\n'
    + '        mc programme autonomy <programme> on --expected-revision <n> [--stop "<condition>"] [--by <name>]\n'
    + '        mc programme autonomy <programme> off [--expected-revision <n>] [--by <name>]\n'
    + '        mc programme phase add <programme> <n> <name> --purpose <text> [--expected-revision <n>]\n'
    + '        mc programme phase close <programme> <n> --reference <evidence> [--expected-revision <n>]\n'
    + '        mc programme stop <programme> --reference <evidence> [--expected-revision <n>]\n'
    + '        mc programme wait <programme> --condition <id> --kind quota|network|resource|external --reason <text> --reference <evidence> [--until <time>]\n'
    + '        mc programme events list <programme>\n'
    + '        mc programme events ack <programme> --event <id>... --reference <evidence> [--expected-revision <n>]\n'
    + '        mc programme operation cancel <programme> <id> --reason <text>\n'
    + '        mc programme metadata <programme> --expected-revision <n> --input-file <json>\n'
    + '        Autonomy controls only new headless planner claims: sent goals, reviews and admitted merges continue.\n'
    + '        autonomy on refuses unless this installation supports every control capability —\n'
    + '        mc programme capabilities says what it has and lacks; the installed runner supports none.\n'
    + '        Phases close explicitly, in order; only the earliest unclosed phase dispatches. Use mc goal for assignments.\n'
    + '        Events persist with autonomy on or off; only a named ack consumes one, never a process exit.\n';
}
