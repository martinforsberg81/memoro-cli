/** Operator autonomy on/off for one programme, and the installation's
 * capability report. Recording a preference is not a launch: the runner still
 * dispatches v2 only through its injected capability, and support comes only
 * from observed provider runs. A sent goal consults none of this. Headless
 * roles cannot change the preference. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLaunch } from '../adapters/index.js';
import { productionAutonomy } from './autonomous-capability.js';
import { AUTONOMOUS_STATE_FILE, PROGRAMME_STATE_FILE, readAutonomousState } from './autonomous-state.js';
import { STABLE_ID_RE } from './goal-contract.js';
import { readModels } from './model-config.js';
import { PROGRAMS_HOME, workRoot } from './paths.js';
import { updateProgrammeJobs, enqueueProgrammeEvent } from './programme-jobs.js';
import { observationGaps, readObservations, toolVersion } from './provider-observations.js';

export const CONTROL_CAPABILITIES = Object.freeze(['programme-jobs', 'programme-plan', 'build', 'review', 'control-signals', 'interrupt']);
const text = value => typeof value === 'string' && value.trim().length > 0;

const NOT_ACTIVATED = 'autonomous execution is not activated in this installation';

/** What is built and what proved it, capability by capability. Fixtures prove
 * code, not support: support and `missing` are measured per call. Transport
 * facts are the 2026-10-28 version/help probes
 * (docs/technical/mc-session-observation.md); no model session was launched to
 * measure them. */
const INSTALLATION = Object.freeze({
  capabilities: Object.freeze([
    { name: 'programme-jobs', built: 'plan events, lease, intents, waits and reconciliation (src/mc/programme-jobs.js)',
      proven: 'temporary state and repositories: tests/mc/programme-jobs.test.js, tests/mc/autonomy-lifecycle.test.js' },
    { name: 'programme-plan', built: 'durable planner journal, event queue and queue consumer (src/mc/programme-plan-run.js)',
      proven: 'journal effects, recovery and scripted sessions through the consumer: tests/mc/programme-plan.test.js, tests/mc/autonomy-lifecycle.test.js' },
    { name: 'build', built: 'fresh build sessions on one branch and PR, green publication (src/mc/autonomous-run.js, src/mc/autonomous-publish.js)',
      proven: 'scripted sessions on real temporary repositories: tests/mc/autonomous-run.test.js, tests/mc/autonomy-lifecycle.test.js' },
    { name: 'review', built: 'independent review, report and routing to plan or merge (src/mc/autonomous-review.js, src/mc/autonomous-outcomes.js)',
      proven: 'scripted review sessions: tests/mc/autonomous-review.test.js, tests/mc/autonomy-lifecycle.test.js' },
    { name: 'control-signals', built: 'durable mc session-control status|checkpoint|criterion, the one path both tools read',
      proven: 'real fixture processes in both prompt shapes read the actual status command (tests/mc/session-observation.test.js)' },
    { name: 'interrupt', built: 'process-group SIGTERM, then SIGKILL after a bounded grace (src/mc/session-supervision.js)',
      proven: 'a real fixture process that ignores finish-session and SIGTERM is closed with its child (tests/mc/session-observation.test.js)' },
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

const subdirectories = (dir, file) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
  .filter(item => item.isDirectory() && STABLE_ID_RE.test(item.name) && existsSync(join(dir, item.name, file)))
  .map(item => item.name);

/** The reviewer each goal that has not landed reserved, by tool. Unreadable goal state throws. */
function unlandedReviewers(root) {
  const reviewers = [];
  for (const programme of subdirectories(join(root, PROGRAMS_HOME), PROGRAMME_STATE_FILE)) {
    for (const project of subdirectories(join(root, PROGRAMS_HOME, programme), AUTONOMOUS_STATE_FILE)) {
      const state = readAutonomousState(root, programme, project);
      if (state.reviewer_model && state.phase !== 'landed') reviewers.push(state.reviewer_model.tool);
    }
  }
  return reviewers;
}

/** Every tool the catalog can launch or a goal reserved, at the version installed now.
 * `reviewer` marks the tools that can review: catalog.review's, and any reserved one. */
function installedTools(deps, env, root) {
  const catalog = deps.catalog ? deps.catalog() : readModels(env);
  const reserved = unlandedReviewers(root);
  const reviewers = new Set([catalog.review.tool, ...reserved]);
  const names = [...new Set([...catalog.fast, ...catalog.large, catalog.review].map(item => item.tool).concat(reserved))];
  const launch = deps.launch || resolveLaunch;
  const version = deps.toolVersion || toolVersion;
  return names.map(tool => {
    const resolved = launch(tool);
    return { tool, version: resolved?.ok ? version(resolved.spec.bin) : null, reviewer: reviewers.has(tool) };
  });
}

/** A capability is supported when the runner can build its capability here and
 * every catalog tool, at its installed version, has the observation it needs.
 * Anything unreadable supports nothing. */
function observedCapabilities(deps) {
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  let refusal = null;
  const built = (deps.productionAutonomy || productionAutonomy)({ root, env,
    deps: { awakeClock: deps.awakeClock, log: line => { refusal = line; } } });
  let tools = []; let observations = []; let unreadable = null;
  try {
    tools = installedTools(deps, env, root);
    observations = readObservations(root);
  } catch (error) { unreadable = error.message; }
  const blockers = [built ? null : refusal || 'autonomous capability unavailable', unreadable].filter(Boolean);
  const capabilities = INSTALLATION.capabilities.map(item => {
    const missing = [...blockers, ...observationGaps(item.name, tools, observations)];
    return Object.freeze({ ...item, ...(missing.length ? { missing: missing.join('; ') } : {}) });
  });
  return { supported: capabilities.filter(item => !item.missing).map(item => item.name), reason: NOT_ACTIVATED,
    capabilities, transport: INSTALLATION.transport };
}

/** What this installation can control, measured now. Tests inject one. */
export function installationCapabilities(deps = {}) {
  return deps.capabilities || observedCapabilities(deps);
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
  const capabilities = supportedCapabilities({ root, ...deps });
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
