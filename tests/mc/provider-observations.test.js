/** Support follows observed provider runs, per tool version, and a sent goal needs none. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autonomousPaths, readAutonomousState } from '../../src/mc/autonomous-state.js';
import { run as sessionControl } from '../../src/mc/commands/session-control.js';
import { CONTROL_CAPABILITIES, installationCapabilities, missingCapabilities, programmeAutonomyOn } from '../../src/mc/programme-control.js';
import { capabilityReport } from '../../src/mc/programme-status.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { markControlRead, observationGaps, observationsPath, providerObserver, readObservations, recordObservations, sessionSignals, toolVersion } from '../../src/mc/provider-observations.js';
import { programmeWorld, cleanReview, COMPLETION, CRITERIA, PROGRAMME, PROJECT } from './autonomy-lifecycle-fixture.js';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-provider-observations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const AWAKE = { platform: 'darwin', read: () => 1000, bootSession: () => 'boot-1' };
const observation = (tool, tool_version, role, signal, run_id = 'build-1') => ({ tool, tool_version, role, signal, run_id, project: 'p', at: '2026-10-31T00:00:00.000Z' });
const FULL = version => ['claude', 'codex'].flatMap(tool => [observation(tool, version[tool], 'step', 'session'),
  observation(tool, version[tool], 'review', 'session'), observation(tool, version[tool], 'step', 'control'), observation(tool, version[tool], 'step', 'interrupt')]);

/** The installation report on a temporary root, every tool at `versions`. */
function installation(root, versions = { claude: '2.0.0', codex: '1.0.0' }, extra = {}) {
  return { root, env: { MC_WORK_ROOT: root }, awakeClock: AWAKE, catalog: () => DEFAULT_CATALOG,
    launch: tool => ({ ok: true, spec: { bin: tool } }), toolVersion: bin => versions[bin] ?? null, ...extra };
}

test('toolVersion is the first line of a successful --version', t => {
  const bin = join(scratch(t), 'tool');
  writeFileSync(bin, '#!/bin/sh\necho "2.1.312 (Claude Code)"\necho more\n'); chmodSync(bin, 0o755);
  assert.equal(toolVersion(bin), '2.1.312 (Claude Code)');
  assert.equal(toolVersion(join(bin, 'absent')), null);
  assert.equal(toolVersion('x', { spawn: () => ({ status: 1, stdout: '1.0.0' }) }), null);
  assert.equal(toolVersion('x', { spawn: () => ({ status: 0, stdout: '\n' }) }), null);
});

test('observations append, and a file that is not ours is refused', t => {
  const root = scratch(t);
  assert.deepEqual(readObservations(root), []);
  recordObservations(root, []);
  assert.equal(existsSync(observationsPath(root)), false, 'nothing to record writes nothing');
  recordObservations(root, [observation('claude', '1', 'step', 'session')]);
  recordObservations(root, [observation('codex', '2', 'review', 'session')]);
  assert.deepEqual(readObservations(root).map(item => item.tool), ['claude', 'codex']);
  assert.equal(observationsPath(root), join(root, 'runner', 'provider-observations.json'));
  writeFileSync(observationsPath(root), '{"version":2}');
  assert.throws(() => readObservations(root), /invalid provider observations/u);
});

test('the three signals follow what the process showed', () => {
  const step = { normal_exit: true, control_persisted: true };
  assert.deepEqual(sessionSignals({ role: 'step', result: step }), ['session']);
  assert.deepEqual(sessionSignals({ role: 'step', result: { ...step, normal_exit: false } }), []);
  assert.deepEqual(sessionSignals({ role: 'step', result: { ...step, control_persisted: false } }), []);
  assert.deepEqual(sessionSignals({ role: 'step', result: { normal_exit: false, signalled: true }, controlCalled: true }), ['control', 'interrupt']);
  assert.deepEqual(sessionSignals({ role: 'review', result: { normal_exit: true } }), ['session'], 'a review has no session control');
  assert.deepEqual(sessionSignals({ role: 'step', result: { normal_exit: false, interrupted: true } }), [], 'a process no signal reached is no interrupt');
});

test('an observer names the version that started, records nothing for a fixture, and never fails the session', t => {
  const root = scratch(t); const said = [];
  const options = { root, tool: 'claude', bin: 'claude', role: 'step', runId: 'build-1', project: 'p', say: line => said.push(line) };
  providerObserver({ ...options, capability: { fixture: true }, deps: { toolVersion: () => assert.fail('a fixture probes nothing') } })(COMPLETION);
  assert.equal(existsSync(observationsPath(root)), false);

  let version = '1.0.0';
  const observe = providerObserver({ ...options, capability: {}, deps: { toolVersion: () => version, now: () => 0 } });
  version = '2.0.0';
  observe(COMPLETION);
  assert.deepEqual(readObservations(root), [{ tool: 'claude', tool_version: '1.0.0', role: 'step', signal: 'session', run_id: 'build-1', project: 'p', at: '1970-01-01T00:00:00.000Z' }]);

  providerObserver({ ...options, capability: {}, deps: { toolVersion: () => null } })(COMPLETION);
  assert.match(said.join(), /no version from claude --version/u);
  assert.equal(readObservations(root).length, 1);
  writeFileSync(observationsPath(root), 'not json');
  providerObserver({ ...options, capability: {}, deps: { toolVersion: () => '1.0.0' } })(COMPLETION);
  assert.equal(said.length, 2, 'a damaged file is said, not thrown');
  assert.equal(readFileSync(observationsPath(root), 'utf8'), 'not json', 'and is left as found');
});

test('control is seen in the run\'s own request or status mark, not an earlier run\'s', t => {
  const root = scratch(t); const directory = join(root, 'attempt'); mkdirSync(directory);
  const options = { root, capability: {}, tool: 'claude', bin: 'claude', role: 'step', runId: 'build-2', project: 'p', deps: { toolVersion: () => '1' } };
  const signals = () => readObservations(root).map(item => item.signal);
  providerObserver({ ...options, control: () => ({ binding: { run_id: 'build-1' }, request: { operation: 'checkpoint' } }) })({ normal_exit: false });
  assert.deepEqual(signals(), []);
  providerObserver({ ...options, control: () => ({ binding: { run_id: 'build-2' }, request: null }) })({ normal_exit: false });
  assert.deepEqual(signals(), []);
  providerObserver({ ...options, control: () => ({ binding: { run_id: 'build-2' }, request: { operation: 'checkpoint' } }) })({ normal_exit: false });
  assert.deepEqual(signals(), ['control']);
  writeFileSync(join(directory, 'session-control-read.json'), '{}');
  providerObserver({ ...options, directory })({ normal_exit: false });
  assert.deepEqual(signals(), ['control', 'control']);
});

test('mc session-control status marks the session directory; a failed read marks nothing', async t => {
  const w = programmeWorld(t);
  await w.open(PROJECT, { success_criteria: [CRITERIA[0]] });
  const directory = join(w.root, 'attempt'); mkdirSync(directory);
  w.build({ during: async session => {
    const state = readAutonomousState(w.root, PROGRAMME, PROJECT);
    const env = { MC_WORK_ROOT: w.root, MC_AUTONOMOUS_ROLE: 'step', MC_AUTONOMOUS_RUN: session.run_id, MC_SCRATCH: directory };
    const quiet = { env, root: w.root, stdout: { write() {} }, stderr: { write() {} } };
    const target = `${PROGRAMME}/${PROJECT}`;
    assert.equal(await sessionControl(['status', target, '--expected-revision', String(state.revision + 7)], quiet), 1);
    assert.equal(existsSync(join(directory, 'session-control-read.json')), false);
    assert.equal(await sessionControl(['status', target, '--expected-revision', String(state.revision)], quiet), 0);
    assert.equal(existsSync(join(directory, 'session-control-read.json')), true);
    assert.equal(readAutonomousState(w.root, PROGRAMME, PROJECT).revision, state.revision, 'a read changes no state');
  }, criteria: ['first'], files: { 'first.js': 'export const first = 1;\n' } });
  assert.equal(await w.run(), 'ran');
  assert.equal(w.builds.length, 1);
});

test('gaps name the tool, version and observation lacking; a new version has none', () => {
  const tools = [{ tool: 'claude', version: '2.0.0' }, { tool: 'codex', version: null }];
  assert.deepEqual(observationGaps('build', tools, [observation('claude', '1.0.0', 'step', 'session')]),
    ['claude 2.0.0: a step session not observed', 'codex (version unknown): a step session not observed']);
  assert.deepEqual(observationGaps('review', [{ ...tools[0], reviewer: true }], [observation('claude', '2.0.0', 'step', 'session')]), ['claude 2.0.0: a review session not observed']);
  assert.deepEqual(observationGaps('review', [tools[0]], []), [], 'a tool that cannot review owes no review');
  assert.deepEqual(observationGaps('programme-plan', [tools[0]], [observation('claude', '2.0.0', 'review', 'session')]), [], 'the same transport and process path');
  assert.deepEqual(observationGaps('interrupt', [tools[0]], [observation('claude', '2.0.0', 'step', 'interrupt')]), []);
  assert.deepEqual(observationGaps('control-signals', [tools[0]], []), ['claude 2.0.0: a control not observed']);
});

test('support needs the observations each capability owes at its installed version, and autonomy on follows it', t => {
  const root = scratch(t);
  const deps = installation(root);
  let report = installationCapabilities(deps);
  assert.deepEqual(report.supported, []);
  assert.deepEqual(missingCapabilities(report), [...CONTROL_CAPABILITIES]);
  assert.match(report.capabilities.find(item => item.name === 'build').missing, /claude 2\.0\.0: a step session not observed; codex 1\.0\.0: a step session not observed/u);
  assert.deepEqual(report.transport.map(item => item.tool), ['codex', 'claude']);
  assert.throws(() => programmeAutonomyOn({ root, programme: 'x', revision: 0, by: 'Martin', deps }), /not activated in this installation — missing programme-jobs/u);

  // Codex neither interrupted nor reviewed: review owes only claude, the rest still owe codex.
  recordObservations(root, FULL({ claude: '2.0.0', codex: '1.0.0' }).filter(item => !(item.tool === 'codex' && (item.signal === 'interrupt' || item.role === 'review'))));
  report = installationCapabilities(deps);
  assert.deepEqual(missingCapabilities(report), ['interrupt']);
  assert.equal(report.capabilities.find(item => item.name === 'build').missing, undefined);
  assert.equal(report.capabilities.find(item => item.name === 'review').missing, undefined);
  assert.equal(report.capabilities.find(item => item.name === 'interrupt').missing, 'codex 1.0.0: an interrupt not observed');

  recordObservations(root, FULL({ claude: '2.0.0', codex: '1.0.0' }));
  assert.deepEqual(installationCapabilities(deps).supported, [...CONTROL_CAPABILITIES]);
  assert.equal(capabilityReport(deps).supported, true);

  const upgraded = installation(root, { claude: '2.0.1', codex: '1.0.0' });
  assert.deepEqual(installationCapabilities(upgraded).supported, [], 'a new version clears support until observed again');
  assert.match(installationCapabilities(upgraded).capabilities[0].missing, /claude 2\.0\.1: a session not observed/u);
});

test('review support needs only the tools that can review', async t => {
  const reported = (name, deps) => capabilityReport(deps).capabilities.find(item => item.name === name);
  const claude = [observation('claude', '2.0.0', 'step', 'session'), observation('claude', '2.0.0', 'review', 'session'),
    observation('claude', '2.0.0', 'step', 'control'), observation('claude', '2.0.0', 'step', 'interrupt')];

  // The default catalog reviews with claude; no codex review is owed.
  const root = scratch(t);
  recordObservations(root, claude);
  const deps = installation(root);
  assert.equal(capabilityReport(deps).missing.includes('review'), false, 'a claude review at 2.0.0 is review support');
  assert.equal(reported('review', deps).missing, undefined);
  for (const name of ['build', 'control-signals', 'interrupt']) assert.match(reported(name, deps).missing, /codex 1\.0\.0/u, name);

  // A missing claude review is a gap, whatever codex shows.
  const bare = scratch(t);
  recordObservations(bare, claude.filter(item => item.role !== 'review'));
  assert.match(reported('review', installation(bare)).missing, /claude 2\.0\.0: a review session not observed/u);
  assert.equal(capabilityReport(installation(bare)).missing.includes('review'), true);

  // A goal that has not landed and reserved codex as reviewer brings the codex review gap back.
  const w = programmeWorld(t);
  await w.open(PROJECT, { success_criteria: [CRITERIA[0]] });
  recordObservations(w.root, claude);
  const paths = autonomousPaths(w.root, PROGRAMME, PROJECT);
  const reserve = (reviewer_model, phase) => {
    const state = JSON.parse(readFileSync(paths.project, 'utf8'));
    writeFileSync(paths.project, JSON.stringify({ ...state, reviewer_model, phase }));
  };
  reserve({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, 'ready');
  const reserved = installation(w.root);
  assert.equal(capabilityReport(reserved).missing.includes('review'), true);
  assert.match(reported('review', reserved).missing, /codex 1\.0\.0: a review session not observed/u);

  reserve({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, 'landed');
  assert.equal(capabilityReport(installation(w.root)).missing.includes('review'), false, 'a landed goal reserves nothing');
});

test('support needs the capability built here, and anything unreadable supports nothing', t => {
  const root = scratch(t);
  recordObservations(root, FULL({ claude: '2.0.0', codex: '1.0.0' }));
  const noClock = installationCapabilities(installation(root, undefined, { awakeClock: { platform: 'linux' } }));
  assert.deepEqual(noClock.supported, []);
  assert.match(noClock.capabilities[0].missing, /awake clock: not Darwin/u);

  // Codex with no version blocks every capability that owes it, but review owes only claude.
  const noVersion = installationCapabilities(installation(root, { claude: '2.0.0' }));
  assert.deepEqual(noVersion.supported, ['review']);
  assert.match(noVersion.capabilities[0].missing, /codex \(version unknown\)/u);

  const noLaunch = installationCapabilities(installation(root, undefined, { launch: () => ({ ok: false, reason: 'missing-bin' }) }));
  assert.deepEqual(noLaunch.supported, []);

  const noCatalog = installationCapabilities(installation(root, undefined, { catalog: () => { throw new Error('catalog damaged'); } }));
  assert.deepEqual(noCatalog.supported, []);
  assert.match(noCatalog.capabilities[0].missing, /catalog damaged/u);

  writeFileSync(observationsPath(root), 'not json');
  assert.deepEqual(installationCapabilities(installation(root)).supported, []);

  // A goal state that cannot be read supports nothing, review included.
  const damaged = scratch(t);
  recordObservations(damaged, FULL({ claude: '2.0.0', codex: '1.0.0' }));
  mkdirSync(join(damaged, 'programs', 'mc', 'goal-one'), { recursive: true });
  writeFileSync(join(damaged, 'programs', 'mc', 'PROGRAMME_STATE.json'), '{}');
  writeFileSync(join(damaged, 'programs', 'mc', 'goal-one', 'AUTONOMOUS_STATE.json'), 'not json');
  const damagedReport = installationCapabilities(installation(damaged));
  assert.deepEqual(damagedReport.supported, []);
  assert.ok(damagedReport.capabilities.every(item => item.missing), 'every capability names the unreadable state');

  const injected = { supported: ['build'] };
  assert.equal(installationCapabilities({ capabilities: injected }), injected);
});

test('a sent goal dispatches with autonomy off while supported is empty', async t => {
  const w = programmeWorld(t);
  const report = installationCapabilities(installation(w.root));
  assert.deepEqual(report.supported, [], 'nothing observed on this installation');
  await w.open(PROJECT, { success_criteria: [CRITERIA[0]] });
  assert.equal(w.programme().autonomy?.enabled ?? false, false);
  w.build({ criteria: ['first'], files: { 'first.js': 'export const first = 1;\n' }, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  assert.equal(w.builds.length, 1, 'the sent goal built');
  assert.equal(w.state().phase, 'review_ready');
  assert.equal(existsSync(observationsPath(w.root)), false, 'a fixture session records nothing');
  assert.deepEqual(installationCapabilities(installation(w.root)).supported, [], 'and proves no support');
});

test('a real build and review record what they showed, and those observations are what support reads', async t => {
  const w = programmeWorld(t);
  w.capability.fixture = false;
  w.deps.toolVersion = () => '9.9.9';
  // The scripted builder measures directly; this session reads status the way a real one does.
  const scripted = w.deps.session;
  w.deps.session = async call => {
    const result = await scripted(call);
    if (call.env.MC_AUTONOMOUS_ROLE === 'step') { mkdirSync(call.env.MC_SCRATCH); markControlRead(call.env.MC_SCRATCH, call.env.MC_AUTONOMOUS_RUN); }
    return result;
  };
  await w.open(PROJECT, { success_criteria: [CRITERIA[0]] });
  w.build({ criteria: ['first'], files: { 'first.js': 'export const first = 1;\n' }, outcome: 'review-ready' });
  assert.equal(await w.run(), 'ran');
  const run = w.builds[0].run_id;
  assert.deepEqual(readObservations(w.root).map(item => [item.tool, item.tool_version, item.role, item.signal, item.run_id, item.project]),
    [['claude', '9.9.9', 'step', 'session', run, PROJECT], ['claude', '9.9.9', 'step', 'control', run, PROJECT]]);

  w.review(cleanReview([CRITERIA[0]]));
  assert.equal(await w.run(), 'ran');
  const review = readObservations(w.root).at(-1);
  assert.deepEqual([review.role, review.signal], ['review', 'session']);
  assert.match(review.run_id, /^review-/u);

  const only = installation(w.root, { claude: '9.9.9' }, { catalog: () => ({ fast: [{ tool: 'claude' }], large: [], review: { tool: 'claude' } }) });
  assert.deepEqual(missingCapabilities(installationCapabilities(only)), ['interrupt']);
});

test('a real build the supervisor interrupted records the interrupt before the run stops', async t => {
  const w = programmeWorld(t);
  w.capability.fixture = false;
  w.deps.toolVersion = () => '9.9.9';
  await w.open(PROJECT, { success_criteria: [CRITERIA[0]] });
  w.build({ publish: false, exit: { ...COMPLETION, normal_exit: false, interrupted: true, signalled: true, reason: 'emergency-boundary' } });
  assert.equal(await w.run(), 'ran');
  assert.deepEqual(readObservations(w.root).map(item => item.signal), ['interrupt']);
});
