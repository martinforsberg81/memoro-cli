/** The production capability: what it carries, how it fails closed, and a goal
 * build started through `runLoop` with one injected. No test touches perl or sysctl. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONTROL_PROFILE, productionAutonomy } from '../../src/mc/autonomous-capability.js';
import { runLoop } from '../../src/mc/run.js';
import { validateControlProfile } from '../../src/mc/session-control.js';
import { programmeWorld, PROJECT, CRITERIA } from './autonomy-lifecycle-fixture.js';

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
  const { clock, profile, ...fields } = f.build();
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
