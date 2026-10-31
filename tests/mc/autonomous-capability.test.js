/** The production capability: what it carries, how it fails closed, and a goal
 * build started through `runLoop` with one injected. No test touches perl or sysctl. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CONTROL_PROFILE, productionAutonomy } from '../../src/mc/autonomous-capability.js';
import { projectSessionCheckpoint, readAutonomousState } from '../../src/mc/autonomous-state.js';
import { runLoop } from '../../src/mc/run.js';
import { groupAlive } from '../../src/mc/session-recovery.js';
import { validateControlProfile } from '../../src/mc/session-control.js';
import { programmeWorld, git, COMPLETION, PROFILE, PROGRAMME, PROJECT, CRITERIA } from './autonomy-lifecycle-fixture.js';

const MINUTE = 60_000;
const awakeClock = { platform: 'darwin', read: () => 5000, bootSession: () => 'boot-1', now: () => 9000 };

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-capability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines = [];
  return { root, lines, build: (extra = {}) => productionAutonomy({ root, env: {}, deps: { awakeClock, log: line => lines.push(line), ...extra } }) };
}
const profileFile = (root, text) => {
  mkdirSync(join(root, 'runner'), { recursive: true });
  writeFileSync(join(root, 'runner', 'control-profile.json'), text);
};

test('the capability carries the runner fields and the default profile', t => {
  const f = world(t);
  const { clock, profile, verifier, ...fields } = f.build();
  assert.equal(typeof verifier, 'function', 'the verifier factory is carried');
  assert.deepEqual(fields, { pollMs: 5000, review: true, programmeJobs: true, programmePlan: true, publication: {} });
  assert.deepEqual(profile, { soft_active_ms: 40 * MINUTE, upper_active_ms: 60 * MINUTE, emergency_active_ms: 80 * MINUTE,
    reserve_active_ms: 10 * MINUTE, soft_context: 0.6, upper_context: 0.75, emergency_context: 0.9, reserve_context: 0.05,
    context_stale_ms: 5 * MINUTE, closing_ms: 15 * MINUTE, tool_wait_ms: 30 * MINUTE, lane_wait_ms: 45 * MINUTE,
    total_awake_ms: 180 * MINUTE, no_progress_ms: 45 * MINUTE, max_stagnant_sessions: 3, max_failures: 3 });
  assert.deepEqual(f.lines, []);
  assert.deepEqual(clock(), { at_ms: 9000, awake_ms: 5000 }, 'the clock samples and stores its state under runner/');
  assert.deepEqual(clock(), { at_ms: 9000, awake_ms: 5000 }, 'a second sample reads the state the first one wrote');
});

test('a valid profile file replaces the default', t => {
  const f = world(t);
  const profile = { ...DEFAULT_CONTROL_PROFILE, max_failures: 5 };
  profileFile(f.root, JSON.stringify(profile));
  assert.deepEqual(f.build().profile, profile);
});

test('an awake clock that is not ok means no capability, and the reason is logged once', t => {
  const f = world(t);
  assert.equal(f.build({ awakeClock: { platform: 'linux' } }), null);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /unavailable.*not Darwin \(linux\)/u);
  f.lines.length = 0;
  assert.equal(f.build({ awakeClock: { ...awakeClock, read: () => { throw new Error('no perl'); } } }), null);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /uptime read failed: no perl/u);
});

test('an invalid profile file means no capability, never the default', t => {
  for (const text of ['not json', 'null', '{}', JSON.stringify({ ...DEFAULT_CONTROL_PROFILE, extra: 1 }),
    JSON.stringify({ ...DEFAULT_CONTROL_PROFILE, soft_active_ms: 61 * MINUTE })]) {
    const f = world(t);
    profileFile(f.root, text);
    assert.equal(f.build(), null, text);
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /control profile/u);
  }
});

test('a profile path that cannot be read as a file means no capability', t => {
  const f = world(t);
  mkdirSync(join(f.root, 'runner', 'control-profile.json'), { recursive: true });
  assert.equal(f.build(), null);
  assert.match(f.lines[0], /EISDIR/u);
});

test('the default profile is a valid control profile', () => {
  assert.deepEqual(validateControlProfile({ ...DEFAULT_CONTROL_PROFILE }), { ...DEFAULT_CONTROL_PROFILE });
});

test('runLoop with an injected capability starts a scripted goal build', async t => {
  const w = programmeWorld(t);
  await w.start();
  await w.open(PROJECT, { success_criteria: [CRITERIA[0], CRITERIA[2]] });
  w.build({ criteria: ['first'], files: { 'first.js': 'export const first = 1;\n' } });
  const seen = [];
  const deps = { ...w.deps, productionAutonomy: (options) => { seen.push(options.root); return w.capability; } };
  assert.equal(await runLoop({ once: true, deps }), 0);
  assert.deepEqual(seen, [w.root]);
  assert.equal(w.builds.length, 1, 'the scripted session ran');
  assert.deepEqual(w.builds[0].measured, ['first']);
  assert.equal(w.builds[0].project, PROJECT);
  assert.equal(w.scripts.step.length, 0);
});

// Budgets that no simulated awake time can reach: the check's own limit is what these tests measure.
const SLOW = { ...PROFILE, soft_active_ms: 60_000, upper_active_ms: 120_000, emergency_active_ms: 180_000, total_awake_ms: 600_000, no_progress_ms: 600_000 };

/** The fixture's capability with the production verifier: the real check, lane and gate. Set in place, as the runner reads it. */
function withProductionVerifier(w) {
  w.capability.verifier = productionAutonomy({ root: w.root, env: w.env, deps: { awakeClock } }).verifier;
}

/** The session's own observation, as its supervisor makes it. Awake time advances only as the test says. */
function observer(w, call) {
  let awake = 0;
  return () => {
    awake += 10;
    const sequence = readAutonomousState(w.root, PROGRAMME, PROJECT).session_control.observation.sequence + 1;
    call.autonomous.observe({ sequence, at_ms: 1000 + awake, awake_ms: awake, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null });
  };
}

/** The builder asks for a criterion through its callback; the runner measures it on its next observation. */
function askFor(w, criterion_id) {
  const state = readAutonomousState(w.root, PROGRAMME, PROJECT);
  projectSessionCheckpoint(w.root, PROGRAMME, PROJECT, 'criterion', { criterion_id, reference: `evidence/${criterion_id}.json` },
    { actor: state.active_run, revision: state.revision });
  return state;
}

test('a scripted build session requests a criterion, the check passes, and last_progress holds the measured reference', async t => {
  const w = programmeWorld(t, { profile: SLOW });
  withProductionVerifier(w);
  assert.equal((await w.start()).code, 0);
  await w.open(PROJECT, { success_criteria: [{ ...CRITERIA[0], check: 'true' }] });
  const seen = {};
  w.scripts.step.push(async call => {
    const asked = askFor(w, 'first');
    const observe = observer(w, call);
    for (let i = 0; i < 500 && !readAutonomousState(w.root, PROGRAMME, PROJECT).session_control.history.last_progress; i++) {
      observe();
      await delay(20);
    }
    seen.progress = readAutonomousState(w.root, PROGRAMME, PROJECT).session_control.history.last_progress;
    seen.run = asked.active_run.run_id;
    seen.reference = `first passed at ${git(call.cwd, 'rev-parse', 'HEAD')} on goal revision ${asked.goal_revision}`;
    return COMPLETION;
  });
  assert.equal(await w.run(), 'ran');
  assert.ok(seen.progress, 'the runner delivered a measured progress');
  assert.equal(seen.progress.criterion_id, 'first');
  assert.equal(seen.progress.run_id, seen.run, 'the progress belongs to the session that asked');
  assert.equal(seen.progress.reference, seen.reference, 'the reference names the check, the head it passed at and the goal revision');
  assert.match(seen.progress.id, /^measured-/u);
});

test('a session that ends during a measurement leaves no check process behind', async t => {
  const w = programmeWorld(t, { profile: SLOW });
  withProductionVerifier(w);
  assert.equal((await w.start()).code, 0);
  const pidFile = join(w.root, 'check.pid');
  // The check writes its shell's pid, then waits: the session ends while it runs.
  await w.open(PROJECT, { success_criteria: [{ ...CRITERIA[0], check: `echo $$ > '${pidFile}'; sleep 1000` }] });
  let pid = null; let running = null;
  w.scripts.step.push(async call => {
    askFor(w, 'first');
    const observe = observer(w, call);
    for (let i = 0; i < 500; i++) {
      const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
      if (text) { pid = Number(text); break; }
      observe();
      await delay(20);
    }
    running = pid ? groupAlive(pid) : null;
    return COMPLETION;
  });
  assert.equal(await w.run(), 'ran');
  assert.equal(running, true, 'the check was running when the session ended');
  assert.equal(groupAlive(pid), false, 'the runner closed the measurement and its process group is gone');
});
