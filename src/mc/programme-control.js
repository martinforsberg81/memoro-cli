/** Operator start/pause/resume of one programme. Recording an activation is not
 * a launch: the runner still dispatches v2 only through its injected capability,
 * and this installation reports none. Headless roles cannot change the mode. */
import { createHash } from 'node:crypto';
import { updateProgrammeJobs, enqueueProgrammeEvent } from './programme-jobs.js';
import { validateControlProfile } from './session-control.js';
import { autonomousModelIdentity, independentModel } from './autonomous-models.js';
import { CLASSES, DEFAULT_CATALOG } from './model-config.js';

export const CONTROL_CAPABILITIES = Object.freeze(['programme-jobs', 'programme-plan', 'build', 'review', 'control-signals', 'interrupt']);
const UNSUPPORTED = Object.freeze({ supported: Object.freeze([]), reason: 'autonomous execution is not activated in this installation' });
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** What this installation can control. Nothing until the activation work
 * supplies a verified report; tests inject one. Fixtures are not support. */
export function installationCapabilities(deps = {}) {
  return deps.capabilities || UNSUPPORTED;
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
    const agreement = state.approved.at(-1);
    if (!agreement) throw new Error('start needs an approved programme revision');
    if (journal.mode !== 'inactive') throw new Error(`programme is already ${journal.mode}; ${journal.mode === 'paused' ? 'resume it' : 'start applies once'}`);
    if (!agreement.planned_stops.some(item => item.id === stop)) throw new Error('start names one of the approved planned stops');
    const at = stamp(now);
    const id = `activation-${createHash('sha256').update(JSON.stringify([programme, agreement.revision, stop, at])).digest('hex').slice(0, 40)}`;
    enqueueProgrammeEvent(state, journal, { id, type: 'activation', programme_revision: agreement.revision,
      reference: `${paths.programme}#planner_jobs/activation` });
    journal.activation = { id, programme_revision: agreement.revision, stop, by: input.by, at,
      profiles: { build: structuredClone(input.build), review: structuredClone(input.review) }, capabilities };
    journal.mode = 'active'; journal.wait = null; journal.stop = null; journal.exception = null;
    logged(journal, { operation: 'start', by: input.by, at, state_revision: state.revision });
  });
}

/** Stops new claims, builds, reviews and merge submissions. Work already
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
    if (!state.approved.at(-1).planned_stops.some(item => item.id === activation.stop)) throw new Error('the approved programme no longer has the planned stop this start runs to; agree a new start');
    const previous = journal.pause?.previous || { mode: 'active', wait: null };
    // A due wait becomes active at reconciliation, with its retry event.
    if (previous.mode === 'waiting' && previous.wait) { journal.mode = 'waiting'; journal.wait = previous.wait; }
    else if (previous.mode === 'exception' && journal.exception) journal.mode = 'exception';
    else { journal.mode = 'active'; journal.wait = null; }
    journal.pause = null;
    logged(journal, { operation: 'resume', by, at: stamp(now), state_revision: state.revision, capabilities });
  });
}
