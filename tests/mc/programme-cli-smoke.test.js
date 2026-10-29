/** The documented operator commands against a disposable programme, each a real
 * process: an agreement drafted and approved with `mc programme draft|approve`,
 * then `capabilities`, `status`, `start`, `pause` and `resume`. The installed
 * `mc` refuses to start it; a fixture installation that reports every
 * capability (`fixtures/programme-installation.js`, never a production switch)
 * starts and resumes it. Fake `codex` and `claude` binaries on PATH record every
 * invocation: no verb launches an agent, and a headless session driving them
 * cannot change the programme's mode. No model is called. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runMcCli } from './_helpers/mc-cli.js';
import { releaseProgrammeRun, reserveProgrammeRun } from '../../src/mc/autonomous-state.js';
import { CONTROL_CAPABILITIES } from '../../src/mc/programme-control.js';
import { programmeContract } from './autonomy-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLATION = join(HERE, 'fixtures', 'programme-installation.js');
const MC_CLI = join(HERE, '..', '..', 'src', 'mc-cli.js');
const PROGRAMME = 'disposable-programme';
const PROFILE = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
const START = { by: 'Martin', build: { class: 'fast', profile: PROFILE }, review: { model: { tool: 'claude', model: 'opus', effort: 'high' } } };

// A deterministic stand-in for a provider CLI: it records how it was called
// and, as a headless session, runs one `mc programme` verb. No model, no network.
const FAKE_TOOL = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const tool = require('node:path').basename(process.argv[1]);
appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({ tool, argv: process.argv.slice(2), role: process.env.MC_AUTONOMOUS_ROLE || null }) + '\\n');
if (!process.env.FAKE_TOOL_DRIVE) process.exit(0);
const result = spawnSync(process.execPath, [process.env.FAKE_TOOL_MC, 'programme', ...JSON.parse(process.env.FAKE_TOOL_DRIVE)], { encoding: 'utf8', env: process.env });
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`;

function disposable(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-programme-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const tool of ['codex', 'claude']) { writeFileSync(join(bin, tool), FAKE_TOOL); chmodSync(join(bin, tool), 0o755); }
  const log = join(root, 'tools.jsonl'); writeFileSync(log, '');
  const env = { MC_WORK_ROOT: root, MC_HOME: join(root, 'mc-home'), PATH: `${bin}${delimiter}${process.env.PATH}`,
    MC_AUTONOMOUS_ROLE: '', MC_AUTONOMOUS_RUN: '', MC_PROGRAMME: '', MC_PROGRAMME_LEASE: '', FAKE_TOOL_LOG: log, FAKE_TOOL_MC: MC_CLI };
  const shape = result => ({ code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) });
  const w = { root, state: join(root, 'programs', PROGRAMME, 'PROGRAMME_STATE.json') };
  /** The installed `mc`. */
  w.mc = (argv, extra = {}) => shape(runMcCli(['programme', ...argv], { ...env, ...extra }));
  /** The same verbs on the fixture installation that supports every capability. */
  w.fixture = argv => shape(spawnSync(process.execPath, [INSTALLATION, ...argv], { encoding: 'utf8',
    env: { ...process.env, MC_TEST_MODE: '1', ...env } }));
  /** A headless session of the fake codex, run the way the runner starts one, driving one verb. */
  w.session = (role, argv) => shape(spawnSync(join(bin, 'codex'), ['exec', '--json', '-'], { encoding: 'utf8',
    env: { ...process.env, ...env, MC_AUTONOMOUS_ROLE: role, MC_AUTONOMOUS_RUN: `${role}-run-1`, FAKE_TOOL_DRIVE: JSON.stringify(argv) } }));
  w.file = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  w.bytes = () => readFileSync(w.state, 'utf8');
  w.revision = () => JSON.parse(w.bytes()).revision;
  w.tools = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  w.start = run => run(['start', PROGRAMME, '--expected-revision', String(w.revision()), '--stop', 'design-review', '--input-file', w.file('start.json', START)]);

  // The agreement: a foreground plan run drafts and approves it through the CLI.
  // There is no public reservation command, so the run is reserved directly.
  const foreground = { run_id: 'foreground-1', role: 'foreground-plan' };
  reserveProgrammeRun(root, PROGRAMME, foreground, 0);
  const as = { MC_AUTONOMOUS_RUN: foreground.run_id, MC_AUTONOMOUS_ROLE: foreground.role };
  const draft = programmeContract({ id: PROGRAMME, status: 'draft' }); delete draft.approval;
  const drafted = w.mc(['draft', PROGRAMME, '--expected-revision', '1', '--input-file', w.file('draft.json', draft)], as);
  assert.equal(drafted.code, 0, drafted.err);
  const approved = w.mc(['approve', PROGRAMME, '--expected-revision', '2', '--input-file', w.file('approve.json', { by: 'Martin', at: '2026-10-28T12:00:00Z' })], as);
  assert.equal(approved.code, 0, approved.err);
  releaseProgrammeRun(root, PROGRAMME, foreground, 3);

  // A v1 project in the same programme directory.
  const legacy = join(root, 'programs', PROGRAMME, 'legacy'); mkdirSync(legacy);
  w.legacy = join(legacy, 'PLAN.json');
  writeFileSync(w.legacy, JSON.stringify({ schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['Legacy goal.'], contract: ['Fixed steps.'],
    out_of_scope: ['Autonomy.'], success_criteria: [{ met: false, criterion: 'Legacy step runs.', check: 'Inspect fixture.' }], documents: [],
    steps: [{ title: 'Legacy work', status: 'ready', instruction: ['Do legacy work.'], done_when: 'Legacy work is done.' }] }));
  w.legacyBytes = readFileSync(w.legacy, 'utf8');
  return w;
}

test('the installed mc reports what it lacks and refuses to start a disposable programme; nothing is written or launched', t => {
  const w = disposable(t);
  const report = w.mc(['capabilities', '--json']);
  assert.equal(report.code, 0, report.err);
  const capabilities = report.json();
  assert.equal(capabilities.supported, false); assert.deepEqual(capabilities.missing, [...CONTROL_CAPABILITIES]);
  assert.match(capabilities.reason, /not activated in this installation/u);
  assert.deepEqual(capabilities.capabilities.map(item => item.name), [...CONTROL_CAPABILITIES]);
  for (const item of capabilities.capabilities) assert.ok(item.built && item.proven && item.missing, `${item.name} says what it lacks`);
  assert.deepEqual(capabilities.transport.map(item => item.tool), ['codex', 'claude']);
  assert.match(capabilities.transport[0].context, /unavailable/u); assert.match(capabilities.transport[1].context, /estimated/u);
  for (const item of capabilities.transport) assert.match(item.measured, /no model session/u);
  const text = w.mc(['capabilities']);
  assert.equal(text.code, 0); assert.match(text.out, /not supported here/u); assert.match(text.out, /^TRANSPORT/mu);

  const status = w.mc(['status', PROGRAMME, '--json']);
  assert.equal(status.code, 0, status.err);
  const read = status.json();
  assert.equal(read.mode, 'inactive'); assert.equal(read.execution.supported, false);
  assert.equal(read.agreement.approved_revision, 1); assert.deepEqual(read.planned_stop.agreed, ['design-review']);
  assert.deepEqual(read.legacy, ['legacy']); assert.match(read.next_action, /not started/u);
  assert.match(w.mc(['status', PROGRAMME]).out, /execution\s+not supported here/u);

  const before = w.bytes();
  const start = w.start(w.mc);
  assert.equal(start.code, 1); assert.match(start.err, /not activated in this installation — missing programme-jobs/u);
  const pause = w.mc(['pause', PROGRAMME, '--by', 'Martin']);
  assert.equal(pause.code, 1); assert.match(pause.err, /never started/u);
  const resume = w.mc(['resume', PROGRAMME, '--expected-revision', String(w.revision()), '--by', 'Martin']);
  assert.equal(resume.code, 1); assert.match(resume.err, /not activated in this installation/u);
  assert.equal(w.bytes(), before, 'refusals write nothing');
  assert.deepEqual(w.tools(), [], 'no agent was launched');
  assert.equal(readFileSync(w.legacy, 'utf8'), w.legacyBytes);
});

test('on a fixture installation start, pause and resume drive the disposable programme; headless sessions cannot, and no agent is launched', t => {
  const w = disposable(t);
  const start = w.start(w.fixture);
  assert.equal(start.code, 0, start.err);
  assert.equal(start.json().mode, 'active'); assert.match(start.json().next_action, /plan session for 1 pending event/u);
  assert.equal(w.start(w.fixture).code, 1, 'a start applies once');

  // The installed mc reads the recorded start, and says it runs nothing.
  const status = w.mc(['status', PROGRAMME, '--json']).json();
  assert.equal(status.mode, 'active'); assert.equal(status.activation.by, 'Martin'); assert.equal(status.activation.build.class, 'fast');
  assert.equal(status.planned_stop.target, 'design-review'); assert.equal(status.execution.supported, false);
  assert.equal(status.next_action, 'none — this installation cannot run autonomous work');

  // Headless sessions, as fake tool processes, may read the report but cannot change the mode.
  const started = w.bytes();
  const read = w.session('review', ['capabilities', '--json']);
  assert.equal(read.code, 0, read.err); assert.equal(read.json().supported, false);
  const step = w.session('step', ['pause', PROGRAMME, '--by', 'step']);
  assert.equal(step.code, 1); assert.match(step.err, /belong to the operator/u);
  const review = w.session('review', ['resume', PROGRAMME, '--expected-revision', String(w.revision())]);
  assert.equal(review.code, 1); assert.match(review.err, /autonomous review may only examine and report/u);
  const plan = w.session('plan', ['pause', PROGRAMME, '--by', 'plan']);
  assert.equal(plan.code, 1); assert.match(plan.err, /belong to the operator/u);
  assert.equal(w.bytes(), started);

  // Pause needs no capability; the installed mc holds the programme.
  const pause = w.mc(['pause', PROGRAMME, '--by', 'Martin']);
  assert.equal(pause.code, 0, pause.err); assert.equal(pause.json().mode, 'paused');
  const paused = w.revision();
  assert.equal(w.mc(['pause', PROGRAMME, '--by', 'Martin']).code, 0); assert.equal(w.revision(), paused, 'a repeated pause is a read');
  const text = w.mc(['status', PROGRAMME]).out;
  assert.match(text, /autonomous · paused/u); assert.match(text, /paused\s+\S+ by Martin \(was active\)/u);
  assert.match(text, /next\s+none — paused; mc programme resume/u);

  // Resume rechecks support: the installed mc refuses, the fixture installation resumes.
  const refused = w.mc(['resume', PROGRAMME, '--expected-revision', String(paused), '--by', 'Martin']);
  assert.equal(refused.code, 1); assert.equal(w.revision(), paused);
  const resume = w.fixture(['resume', PROGRAMME, '--expected-revision', String(paused), '--by', 'Martin']);
  assert.equal(resume.code, 0, resume.err); assert.equal(resume.json().mode, 'active');

  const journal = JSON.parse(w.bytes()).planner_jobs;
  assert.deepEqual(journal.control.map(item => [item.operation, item.by]), [['start', 'Martin'], ['pause', 'Martin'], ['resume', 'Martin']]);
  assert.equal(journal.activation.stop, 'design-review'); assert.equal(JSON.parse(w.bytes()).execution_enabled, false);
  // The only tool processes are the sessions this test ran; mc launched none.
  assert.deepEqual(w.tools().map(item => [item.tool, item.role]), [['codex', 'review'], ['codex', 'step'], ['codex', 'review'], ['codex', 'plan']]);
  assert.equal(readFileSync(w.legacy, 'utf8'), w.legacyBytes);
});
