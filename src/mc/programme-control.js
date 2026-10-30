/** Operator autonomy on/off for one programme, and the installation's
 * capability report. Recording a preference is not a launch: the runner still
 * dispatches v2 only through its injected capability, and this installation
 * supports none. Headless roles cannot change the preference. */
import { createHash } from 'node:crypto';
import { updateProgrammeJobs, enqueueProgrammeEvent } from './programme-jobs.js';

export const CONTROL_CAPABILITIES = Object.freeze(['programme-jobs', 'programme-plan', 'build', 'review', 'control-signals', 'interrupt']);
const text = value => typeof value === 'string' && value.trim().length > 0;

// The installed runner is `runLoop`'s `createRunner({ merge, deps })`: no
// autonomous capability, so it skips every v2 goal.
const NOT_WIRED = 'the installed runner (runLoop, src/mc/run.js) passes no autonomous capability';
const NO_CLOCK = 'no production awake clock that excludes machine suspend';
const NO_PROVIDER = 'not observed with a provider (model) process';
const NO_PLANNER = 'headless planner queue consumption is not implemented';

/** What this installation has, capability by capability: what is built, what
 * proved it and what is still missing. Built and proven by fixtures is not
 * supported, so `supported` is empty and autonomy on refuses. Transport facts are
 * the 2026-10-28 version/help probes (docs/technical/mc-session-observation.md);
 * no model session was launched to measure them. */
const INSTALLATION = Object.freeze({
  supported: Object.freeze([]),
  reason: 'autonomous execution is not activated in this installation',
  capabilities: Object.freeze([
    { name: 'programme-jobs', built: 'plan events, lease, intents, waits and reconciliation (src/mc/programme-jobs.js)',
      proven: 'temporary state and repositories: tests/mc/programme-jobs.test.js, tests/mc/autonomy-lifecycle.test.js', missing: NOT_WIRED },
    { name: 'programme-plan', built: 'durable planner journal and event queue; no queue consumer',
      proven: 'journal effects and recovery: tests/mc/programme-plan.test.js, tests/mc/autonomy-lifecycle.test.js', missing: NO_PLANNER },
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

/** Autonomy is the operator's; a headless plan, step or review never sets it. */
export function operatorRefusal(env = process.env) {
  const role = env.MC_AUTONOMOUS_ROLE;
  return role && role !== 'foreground-plan' ? 'programme autonomy on and off belong to the operator, not a headless session' : null;
}

const stamp = now => new Date(now).toISOString();
const logged = (journal, entry) => { journal.control = [...(journal.control || []), entry]; };

/** The user's preference, with an optional stop condition in prose read by the
 * planner. Each `on` states the whole preference. A first or post-stop `on`
 * persists the activation trigger in the same write; a wait or an exception
 * stays what it was. A repeated `on` is a read. */
export function programmeAutonomyOn({ root, programme, revision, stop = null, by, now = Date.now(), deps = {} }) {
  if (!text(by)) throw new Error('autonomy names who set it');
  if (stop !== null && !text(stop)) throw new Error('--stop is a condition in prose');
  const capabilities = supportedCapabilities(deps);
  return updateProgrammeJobs({ root, programme, revision, deps }, (state, journal, paths) => {
    if (state.autonomy?.enabled && state.autonomy.stop === stop && journal.mode !== 'stopped') return state;
    const at = stamp(now);
    state.autonomy = { enabled: true, stop, by, at };
    if (['inactive', 'stopped'].includes(journal.mode)) {
      const id = `activation-${createHash('sha256').update(JSON.stringify([programme, state.revision])).digest('hex').slice(0, 40)}`;
      enqueueProgrammeEvent(state, journal, { id, type: 'activation', reference: `${paths.programme}#planner_jobs/activation` });
      journal.activation = { id, by, at };
      journal.mode = 'active'; journal.wait = null; journal.stop = null; journal.reached_stop = null; journal.exception = null;
    }
    logged(journal, { operation: 'autonomy-on', by, at, state_revision: state.revision, capabilities });
  });
}

/** Stops only new headless planner claims. Sent goals, reviews, admitted merges
 * and a held lease finish; nothing is signalled or reverted, and the queue
 * keeps filling. A repeated off is a read. */
export function programmeAutonomyOff({ root, programme, revision = null, by, now = Date.now(), deps = {} }) {
  if (!text(by)) throw new Error('autonomy names who set it');
  return updateProgrammeJobs({ root, programme, revision, anyRevision: revision === null, deps }, (state, journal) => {
    if (!state.autonomy?.enabled) return state;
    const at = stamp(now);
    state.autonomy = { ...state.autonomy, enabled: false, by, at };
    logged(journal, { operation: 'autonomy-off', by, at, state_revision: state.revision });
  });
}
