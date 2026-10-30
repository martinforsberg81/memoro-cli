/** Ordinary assignment verbs for autonomous goals; fixed-step projects stay separate. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { autonomousPaths, createAutonomousDraft, mutateAutonomousProject, mutateProgramme, readAutonomousState, readProgrammeState, sendAutonomousProject } from '../autonomous-state.js';
import { validateAutonomousProject } from '../autonomous-project.js';
import { STABLE_ID_RE } from '../goal-contract.js';
import { goalCompletion } from '../goal-followup.js';
import { workRoot } from '../paths.js';
import { scanArgs } from './flags.js';
import { autonomousCommandContext, run as legacyOperations } from './autonomous-project.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const output = (stream, value) => stream.write(`${JSON.stringify(value, null, 2)}\n`);
export const goalCommandContext = autonomousCommandContext;
const splitTarget = target => {
  const parts = target?.split('/');
  if (!parts || parts.length !== 2 || parts.some(part => !STABLE_ID_RE.test(part))) throw new Error('target must be <programme>/<goal>');
  return parts;
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout; const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const context = autonomousCommandContext(deps);
  const root = deps.root || workRoot(env);
  const scanned = scanArgs(argv, {
    strictValues: ['--phase', '--repo', '--class', '--id', '--criterion', '--instruction', '--check', '--verify', '--expected-revision', '--input-file', '--reference', '--integrated-sha', '--outcome'],
    repeatable: ['--goal', '--contract', '--out-of-scope', '--after'],
  });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [operation, suboperation, ...tail] = scanned.positional;
  try {
    if (operation === 'new') return createGoal(scanned, [suboperation, ...tail].filter(Boolean), { ...deps, context, root, env, stdout, stderr });
    if (operation === 'criterion' && suboperation === 'add') return addCriterion(scanned, tail, { ...deps, context, root, env, stdout, stderr });
    if (operation === 'criterion' && suboperation === 'evidence') return evidence(scanned, tail, { ...deps, context, root, env, stdout, stderr });
    const allowed = ['send', 'revise', 'show', 'done', 'finish', 'report', 'recover', 'attempt', 'release'];
    if (!allowed.includes(operation) || !suboperation) throw new Error('an operation and <programme>/<goal> are required');
    const [programme, goal] = splitTarget(suboperation);
    if (['finish', 'report', 'recover', 'attempt', 'release'].includes(operation)) {
      const flags = ['--expected-revision', ...(operation === 'finish' || operation === 'report' || operation === 'attempt' ? ['--input-file'] : [])];
      rejectFlags(scanned, flags);
      return legacyOperations([operation, `${programme}/${goal}`, ...(scanned.flags['expected-revision'] ? ['--expected-revision', scanned.flags['expected-revision']] : []), ...(scanned.flags['input-file'] ? ['--input-file', scanned.flags['input-file']] : [])], deps);
    }
    rejectFlags(scanned, operation === 'send' ? ['--expected-revision', '--after'] : operation === 'revise' ? ['--expected-revision', '--input-file'] : []);
    if (operation === 'show') {
      if (tail.length) throw new Error('show takes one target');
      output(stdout, readAutonomousState(root, programme, goal, deps)); return 0;
    }
    if (operation === 'send') {
      if (tail.length) throw new Error('send takes one target');
      const state = readAutonomousState(root, programme, goal, deps);
      const revision = revisionOrCurrent(scanned, state);
      const contract = sendAutonomousProject(root, programme, goal, { ...deps, ...context, revision, after: scanned.flags.after });
      output(stdout, { contract, execution_enabled: false }); return 0;
    }
    if (operation === 'revise') {
      if (tail.length) throw new Error('revise takes one target');
      const revision = expectedRevision(scanned);
      const input = inputFile(scanned, deps);
      const result = mutateAutonomousProject(root, programme, goal, 'revise', input, { ...deps, ...context, revision });
      output(stdout, result); return 0;
    }
    if (operation === 'done') {
      if (tail.length) throw new Error('done takes one target');
      const state = readAutonomousState(root, programme, goal, deps);
      const completion = goalCompletion(state);
      if (completion.pending_follow_ups.length) throw new Error(`follow-ups need successful current measurements: ${completion.pending_follow_ups.join(', ')}`);
      output(stdout, { goal, phase: state.phase, ...completion });
      return 0;
    }
    throw new Error('unknown goal operation');
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
}

function rejectFlags(scanned, allowed) {
  const set = new Set(allowed);
  for (const [key, value] of Object.entries(scanned.flags)) {
    if (Array.isArray(value) ? value.length > 0 : value !== null && value !== false) {
      const flag = `--${key}`;
      if (!set.has(flag)) throw new Error(`${flag} is not accepted here`);
    }
  }
}
function expectedRevision(scanned) {
  const raw = scanned.flags['expected-revision'];
  if (raw === null || !/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--expected-revision <n> is required');
  return Number(raw);
}
function revisionOrCurrent(scanned, state) {
  const raw = scanned.flags['expected-revision'];
  if (raw === null) return state.revision;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--expected-revision must be a nonnegative safe integer');
  return Number(raw);
}
function inputFile(scanned, deps) {
  const file = scanned.flags['input-file'];
  if (!file) throw new Error('--input-file <json> is required');
  return JSON.parse((deps.readInput || (path => readFileSync(path, 'utf8')))(file));
}
function parseTarget(args) {
  if (args.length !== 1) throw new Error('one <programme>/<goal> target is required');
  return splitTarget(args[0]);
}
function programmeSetup(root, programme, env, deps) {
  const paths = autonomousPaths(root, programme, null);
  if (existsSync(paths.programme)) return readProgrammeState(root, programme, deps);
  return mutateProgramme(root, programme, 'metadata', { id: programme, brief: `docs/project/${programme}/` }, { ...deps, revision: 0, env });
}
function createGoal(scanned, tail, deps) {
  rejectFlags(scanned, ['--phase', '--repo', '--class', '--goal', '--contract', '--out-of-scope']);
  const [programme, goal] = parseTarget(tail);
  const { root, env, context } = deps;
  const phase = scanned.flags.phase; const repo = scanned.flags.repo; const workClass = scanned.flags.class;
  if (!phase || !/^[1-9][0-9]*$/u.test(phase) || !Number.isSafeInteger(Number(phase))) throw new Error('--phase <n> is required');
  if (!repo || !STABLE_ID_RE.test(repo)) throw new Error('--repo <repo> must be a stable repository name');
  if (!['fast', 'large'].includes(workClass)) throw new Error('--class must be fast or large');
  const goalText = scanned.flags.goal;
  const contract = scanned.flags.contract;
  const outOfScope = scanned.flags['out-of-scope'];
  if (!goalText.length || goalText.some(value => !text(value))) throw new Error('--goal needs at least one text value');
  if (!contract.length || contract.some(value => !text(value))) throw new Error('--contract needs at least one text value');
  if (!outOfScope.length || outOfScope.some(value => !text(value))) throw new Error('--out-of-scope needs at least one text value');
  const programmeState = programmeSetup(root, programme, env, deps);
  const assignment = { schema: 'mc-plan', version: 2, project_id: goal, repo, execution: { kind: 'autonomous' },
    programme: { id: programme }, goal_revision: 1, work_class: workClass, programme_phase: Number(phase), goal: goalText,
    instruction: contract, contract, out_of_scope: outOfScope, success_criteria: [], documents: [] };
  const validation = validateAutonomousProject(assignment, { allowEmptyCriteria: true });
  if (!validation.ok) throw new Error(validation.problems.join('; '));
  const result = createAutonomousDraft(root, programme, goal, assignment, { ...deps, ...context, revision: programmeState.revision, env });
  output(deps.stdout, result); return 0;
}
function addCriterion(scanned, tail, deps) {
  rejectFlags(scanned, ['--id', '--criterion', '--instruction', '--check', '--verify', '--expected-revision']);
  const [programme, goal] = parseTarget(tail);
  const criterion = { id: scanned.flags.id, criterion: scanned.flags.criterion, instruction: [scanned.flags.instruction], check: scanned.flags.check, verification: scanned.flags.verify };
  const state = readAutonomousState(deps.root, programme, goal, deps);
  const stateRevision = revisionOrCurrent(scanned, state);
  if (state.revision !== stateRevision) throw new Error('stale state revision — read the current state');
  if (!criterion.id || !criterion.criterion || !criterion.instruction[0] || !criterion.check || !criterion.verification) throw new Error('criterion add needs --id, --criterion, --instruction, --check and --verify');
  const assignment = { ...state.contract, goal_revision: state.goal_revision + 1, success_criteria: [...state.contract.success_criteria, criterion] };
  const result = mutateAutonomousProject(deps.root, programme, goal, 'revise', assignment, { ...deps, ...deps.context, revision: stateRevision, env: deps.env });
  output(deps.stdout, result); return 0;
}
function evidence(scanned, tail, deps) {
  rejectFlags(scanned, ['--id', '--reference', '--expected-revision', '--integrated-sha', '--outcome']);
  const [programme, goal] = parseTarget(tail);
  const revision = expectedRevision(scanned); const state = readAutonomousState(deps.root, programme, goal, deps);
  if (state.revision !== revision) throw new Error('stale state revision — read the current state');
  const criterion = state.contract.success_criteria.find(item => item.id === scanned.flags.id);
  if (!criterion) throw new Error('unknown criterion ID');
  if (!text(scanned.flags.reference)) throw new Error('--reference <evidence> is required');
  if (criterion.verification === 'after-integration') {
    if (!scanned.flags['integrated-sha'] || !scanned.flags.outcome) throw new Error('after-integration evidence needs --integrated-sha and --outcome passed|failed|unknown');
    const result = mutateAutonomousProject(deps.root, programme, goal, 'follow-up', {
      id: `follow-up-${randomUUID()}`, criterion_id: criterion.id, goal_revision: state.goal_revision,
      integrated_sha: scanned.flags['integrated-sha'], reference: scanned.flags.reference, outcome: scanned.flags.outcome,
    }, { ...deps, ...deps.context, revision });
    output(deps.stdout, result); return 0;
  }
  if (scanned.flags['integrated-sha'] || scanned.flags.outcome) throw new Error('--integrated-sha and --outcome are only for after-integration measurements');
  const actor = deps.context.actor || { run_id: `foreground-${process.pid}`, role: 'step' };
  const result = mutateAutonomousProject(deps.root, programme, goal, 'progress', { id: `evidence-${randomUUID()}`, criterion_id: scanned.flags.id, status: 'verified', reference: scanned.flags.reference }, { ...deps, actor, revision });
  output(deps.stdout, result); return 0;
}
export function usage() {
  return 'usage — mc goal new <programme>/<goal> --phase <n> --repo <repo> --class fast|large --goal <text>... --contract <text>... --out-of-scope <text>...\n'
    + '        mc goal criterion add <programme>/<goal> --id <id> --criterion <text> --instruction <text> --check <command> --verify premerge|after-integration\n'
    + '        mc goal send <programme>/<goal> [--after <goal>]\n'
    + '        mc goal revise <programme>/<goal> --input-file <assignment.json> --expected-revision <n>\n'
    + '        mc goal show|done <programme>/<goal>\n'
    + '        mc goal criterion evidence <programme>/<goal> --id <id> --reference <evidence> --expected-revision <n> [--integrated-sha <sha> --outcome passed|failed|unknown]\n'
    + '        mc goal finish|report|recover|attempt|release <programme>/<goal> [role-specific flags]\n';
}
