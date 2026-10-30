/** Operator start/pause/resume of one programme, and the installation's
 * capability report. Recording an activation is not a launch: the runner still
 * dispatches v2 only through its injected capability, and this installation
 * supports none. Headless roles cannot change the mode. */
import { createHash } from 'node:crypto';
import { updateProgrammeJobs, enqueueProgrammeEvent } from './programme-jobs.js';
import { validateControlProfile } from './session-control.js';
import { autonomousModelIdentity, independentModel } from './autonomous-models.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { CLASSES, DEFAULT_CATALOG } from './model-config.js';

export const CONTROL_CAPABILITIES = Object.freeze(['programme-jobs', 'programme-plan', 'build', 'review', 'control-signals', 'interrupt']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

// The installed runner is `runLoop`'s `createRunner({ merge, deps })`: no
// autonomous capability, so it skips every v2 goal.
const NOT_WIRED = 'the installed runner (runLoop, src/mc/run.js) passes no autonomous capability';
const NO_CLOCK = 'no production awake clock that excludes machine suspend';
const NO_PROVIDER = 'not observed with a provider (model) process';

/** What this installation has, capability by capability: what is built, what
 * proved it and what is still missing. Built and proven by fixtures is not
 * supported, so `supported` is empty and start refuses. Transport facts are
 * the 2026-10-28 version/help probes (docs/technical/mc-session-observation.md);
 * no model session was launched to measure them. */
const INSTALLATION = Object.freeze({
  supported: Object.freeze([]),
  reason: 'autonomous execution is not activated in this installation',
  capabilities: Object.freeze([
    { name: 'programme-jobs', built: 'plan events, lease, intents, waits and reconciliation (src/mc/programme-jobs.js)',
      proven: 'temporary state and repositories: tests/mc/programme-jobs.test.js, tests/mc/autonomy-lifecycle.test.js', missing: NOT_WIRED },
    { name: 'programme-plan', built: 'headless plan sessions and their decisions (src/mc/programme-plan-run.js, src/mc/programme-plan.js)',
      proven: 'scripted plan sessions: tests/mc/programme-plan.test.js, tests/mc/autonomy-lifecycle.test.js', missing: NOT_WIRED },
    { name: 'build', built: 'fresh build sessions on one branch and PR, green publication (src/mc/autonomous-run.js, src/mc/autonomous-publish.js)',
      proven: 'scripted sessions on real temporary repositories: tests/mc/autonomous-run.test.js, tests/mc/autonomy-lifecycle.test.js', missing: `${NOT_WIRED}; ${NO_CLOCK}` },
    { name: 'review', built: 'independent review, report and routing to plan or merge (src/mc/autonomous-review.js, src/mc/autonomous-outcomes.js)',
      proven: 'scripted review sessions: tests/mc/autonomous-review.test.js, tests/mc/autonomy-lifecycle.test.js', missing: NOT_WIRED },
    { name: 'control-signals', built: 'durable mc session-control status|checkpoint|criterion, the one path both tools read',
      proven: 'real fixture processes in both prompt shapes read the actual status command (tests/mc/session-observation.test.js)', missing: NO_PROVIDER },
    { name: 'interrupt', built: 'process-group SIGTERM, then SIGKILL after a bounded grace (src/mc/session-supervision.js)',
      proven: 'a real fixture process that ignores finish-session and SIGTERM is closed with its child (tests/mc/session-observation.test.js)', missing: `${NO_PROVIDER}; ${NO_CLOCK}` },
  ].map(Object.freeze)),
  transport: Object.freeze([
    { tool: 'codex', prompt: 'positional argument; stdin ignored', live_control: 'none; durable session-control only',
      context: 'unavailable: turn usage is cumulative, so context reads unknown and time/checkpoint limits apply',
      measured: 'codex-cli 0.164.0 --version and exec --help; no model session' },
    { tool: 'claude', prompt: 'first stream-json user message on stdin', live_control: 'none added; durable session-control only',
      context: 'estimated from the last request input, a fraction only with a trusted window size; otherwise unknown',
      measured: 'Claude Code 2.1.312 --version and --help; no model session' },
  ].map(Object.freeze)),
});

/** What this installation can control: the report above. Tests inject one;
 * fixtures are not support. */
export function installationCapabilities(deps = {}) {
  return deps.capabilities || INSTALLATION;
}
export function missingCapabilities(report) {
  const supported = Array.isArray(report?.supported) ? report.supported : [];
  return CONTROL_CAPABILITIES.filter(name => !supported.includes(name));
}
function supportedCapabilities(deps) {
  const report = installationCapabilities(deps);
  const missing = missingCapabilities(report);
  if (missing.length) throw new Error(`${report.reason || 'unsupported control capabilities'} — missing ${missing.join(', ')}`);
  return [...CONTROL_CAPABILITIES];
}

/** A headless plan, step or review session never starts, pauses or resumes. */
export function operatorRefusal(env = process.env) {
  const role = env.MC_AUTONOMOUS_ROLE;
  return role && role !== 'foreground-plan' ? 'programme start, pause and resume belong to the operator, not a headless session' : null;
}

/** `{ by, build: { class, profile }, review: { model } }`: the builder class
 * must keep a model after the reviewer is reserved from it. */
export function startInputProblems(input, catalog = DEFAULT_CATALOG) {
  const problems = [];
  if (!plain(input)) return ['start input is { by, build, review }'];
  for (const key of Object.keys(input)) if (!['by', 'build', 'review'].includes(key)) problems.push(`${key}: unknown key`);
  if (!text(input.by)) problems.push('by: the person starting the programme');
  if (!plain(input.build) || Object.keys(input.build).some(key => !['class', 'profile'].includes(key))) problems.push('build: { class, profile }');
  else {
    if (!CLASSES.includes(input.build.class)) problems.push(`build.class: one of ${CLASSES.join(', ')}`);
    try { validateControlProfile(input.build.profile); } catch (error) { problems.push(`build.profile: ${error.message}`); }
  }
  if (!plain(input.review) || Object.keys(input.review).some(key => key !== 'model')) problems.push('review: { model }');
  else {
    try {
      autonomousModelIdentity(input.review.model);
      const pool = catalog[input.build?.class] || [];
      if (CLASSES.includes(input.build?.class) && !pool.some(model => independentModel(input.review.model, [model]))) {
        problems.push('review.model: no builder remains in the class after reserving the reviewer');
      }
    } catch (error) { problems.push(`review.model: ${error.message}`); }
  }
  return problems;
}

const stamp = now => new Date(now).toISOString();
const logged = (journal, entry) => { journal.control = [...(journal.control || []), entry]; };

/** Inactive → active, once, with the activation trigger persisted in the same
 * write. The approved revision, the stop and the profiles are recorded. */
export function startProgramme({ root, programme, revision, stop, now = Date.now(), deps = {} }, input) {
  const capabilities = supportedCapabilities(deps);
  const problems = startInputProblems(input, deps.catalog ? deps.catalog() : DEFAULT_CATALOG);
  if (problems.length) throw new Error(problems.join('; '));
  return updateProgrammeJobs({ root, programme, revision, deps }, (state, journal, paths) => {
    if (journal.mode !== 'inactive') throw new Error(`programme is already ${journal.mode}; ${journal.mode === 'paused' ? 'resume it' : 'start applies once'}`);
    if (typeof stop !== 'string' || !STABLE_ID_RE.test(stop)) throw new Error('start names an explicit stable stop ID');
    const at = stamp(now);
    const id = `activation-${createHash('sha256').update(JSON.stringify([programme, stop, at])).digest('hex').slice(0, 40)}`;
    enqueueProgrammeEvent(state, journal, { id, type: 'activation',
      reference: `${paths.programme}#planner_jobs/activation` });
    journal.activation = { id, stop, by: input.by, at,
      profiles: { build: structuredClone(input.build), review: structuredClone(input.review) }, capabilities };
    journal.mode = 'active'; journal.wait = null; journal.stop = null; journal.exception = null;
    logged(journal, { operation: 'start', by: input.by, at, state_revision: state.revision });
  });
}

/** Stops only new headless planner claims. Sent goals and work already
 * started finishes and is recorded; nothing is signalled or reverted. A
 * repeated pause is a read, not another revision. */
export function pauseProgramme({ root, programme, revision = null, by, now = Date.now(), deps = {} }) {
  if (!text(by)) throw new Error('pause names who paused it');
  return updateProgrammeJobs({ root, programme, revision, anyRevision: revision === null, deps }, (state, journal) => {
    if (journal.mode === 'paused') return state;
    if (journal.mode === 'inactive') throw new Error('programme was never started; nothing to pause');
    if (journal.mode === 'stopped') throw new Error(`programme already rests at planned stop ${journal.stop}`);
    const at = stamp(now);
    journal.pause = { by, at, previous: { mode: journal.mode, wait: journal.wait } };
    journal.mode = 'paused'; journal.wait = null;
    logged(journal, { operation: 'pause', by, at, state_revision: state.revision });
  });
}

/** Paused → what it was: an unexpired wait keeps waiting, an exception stays an
 * exception for plan. Rechecks support and the activation's stop. */
export function resumeProgramme({ root, programme, revision, by, now = Date.now(), deps = {} }) {
  if (!text(by)) throw new Error('resume names who resumed it');
  const capabilities = supportedCapabilities(deps);
  return updateProgrammeJobs({ root, programme, revision, deps }, (state, journal) => {
    if (journal.mode !== 'paused') throw new Error(`programme is ${journal.mode}; resume applies to a paused programme`);
    const activation = journal.activation;
    if (!activation) throw new Error('programme was never started here; start it with mc programme start');
    const previous = journal.pause?.previous || { mode: 'active', wait: null };
    // A due wait becomes active at reconciliation, with its retry event.
    if (previous.mode === 'waiting' && previous.wait) { journal.mode = 'waiting'; journal.wait = previous.wait; }
    else if (previous.mode === 'exception' && journal.exception) journal.mode = 'exception';
    else { journal.mode = 'active'; journal.wait = null; }
    journal.pause = null;
    logged(journal, { operation: 'resume', by, at: stamp(now), state_revision: state.revision, capabilities });
  });
}
