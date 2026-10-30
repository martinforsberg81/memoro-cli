/** The documented operator commands against a disposable programme, each a real
 * process: ordinary goal assignment creation without programme approval,
 * then `capabilities`, `status` and `autonomy on|off`. The installed `mc`
 * refuses autonomy on; a fixture installation that reports every capability
 * (`fixtures/programme-installation.js`, never a production switch) turns it
 * on. Fake `codex` and `claude` binaries on PATH record every
 * invocation: no verb launches an agent, and a headless session driving them
 * cannot change the programme's autonomy. No model is called. */
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
import { programmeMetadata } from './autonomy-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLATION = join(HERE, 'fixtures', 'programme-installation.js');
const MC_CLI = join(HERE, '..', '..', 'src', 'mc-cli.js');
const PROGRAMME = 'disposable-programme';
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
  w.on = run => run(['autonomy', PROGRAMME, 'on', '--expected-revision', String(w.revision()), '--stop', 'design-review', '--by', 'Martin']);

  // Foreground programme context needs no draft/approve or reservation.
  const metadata = programmeMetadata({ id: PROGRAMME });
  const created = w.mc(['metadata', PROGRAMME, '--expected-revision', '0', '--input-file', w.file('metadata.json', metadata)]);
  assert.equal(created.code, 0, created.err);

  // A v1 project in the same programme directory.
  const legacy = join(root, 'programs', PROGRAMME, 'legacy'); mkdirSync(legacy);
  w.legacy = join(legacy, 'PLAN.json');
  writeFileSync(w.legacy, JSON.stringify({ schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['Legacy goal.'], contract: ['Fixed steps.'],
    out_of_scope: ['Autonomy.'], success_criteria: [{ met: false, criterion: 'Legacy step runs.', check: 'Inspect fixture.' }], documents: [],
    steps: [{ title: 'Legacy work', status: 'ready', instruction: ['Do legacy work.'], done_when: 'Legacy work is done.' }] }));
  w.legacyBytes = readFileSync(w.legacy, 'utf8');
  return w;
}

test('the installed mc reports what it lacks and refuses autonomy on a disposable programme; nothing is written or launched', t => {
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
  assert.equal(read.mode, 'off'); assert.equal(read.execution.supported, false);
  assert.deepEqual(read.metadata, programmeMetadata({ id: PROGRAMME })); assert.equal(read.autonomy.enabled, false);
  assert.deepEqual(read.legacy, ['legacy']); assert.match(read.next_action, /autonomy off/u);
  assert.match(w.mc(['status', PROGRAMME]).out, /execution\s+not supported here/u);

  const before = w.bytes();
  const on = w.on(w.mc);
  assert.equal(on.code, 1); assert.match(on.err, /not activated in this installation — missing programme-jobs/u);
  assert.equal(w.mc(['autonomy', PROGRAMME, 'off', '--by', 'Martin']).code, 0, 'off is already the preference');
  assert.equal(w.bytes(), before, 'refusals write nothing');
  assert.deepEqual(w.tools(), [], 'no agent was launched');
  assert.equal(readFileSync(w.legacy, 'utf8'), w.legacyBytes);
});

test('on a fixture installation autonomy on and off drive the disposable programme; headless sessions cannot, and no agent is launched', t => {
  const w = disposable(t);
  const on = w.on(w.fixture);
  assert.equal(on.code, 0, on.err);
  assert.equal(on.json().mode, 'active'); assert.match(on.json().next_action, /planner unavailable/u);
  const once = w.revision();
  assert.equal(w.on(w.fixture).code, 0); assert.equal(w.revision(), once, 'a repeated on is a read');

  // The installed mc reads the recorded preference, and says it runs nothing.
  const status = w.mc(['status', PROGRAMME, '--json']).json();
  assert.equal(status.mode, 'active'); assert.equal(status.autonomy.by, 'Martin');
  assert.equal(status.autonomy.stop, 'design-review'); assert.equal(status.execution.supported, false);
  assert.equal(status.next_action, 'planner unavailable — this installation cannot run autonomous work');

  // Headless sessions, as fake tool processes, may read the report but cannot change autonomy.
  const started = w.bytes();
  const read = w.session('review', ['capabilities', '--json']);
  assert.equal(read.code, 0, read.err); assert.equal(read.json().supported, false);
  const step = w.session('step', ['autonomy', PROGRAMME, 'off', '--by', 'step']);
  assert.equal(step.code, 1); assert.match(step.err, /belong to the operator/u);
  const review = w.session('review', ['autonomy', PROGRAMME, 'on', '--expected-revision', String(w.revision())]);
  assert.equal(review.code, 1); assert.match(review.err, /autonomous review may only examine and report/u);
  const plan = w.session('plan', ['autonomy', PROGRAMME, 'off', '--by', 'plan']);
  assert.equal(plan.code, 1); assert.match(plan.err, /belong to the operator/u);
  assert.equal(w.bytes(), started);

  // Off needs no capability; the installed mc records it.
  const off = w.mc(['autonomy', PROGRAMME, 'off', '--by', 'Martin']);
  assert.equal(off.code, 0, off.err); assert.equal(off.json().mode, 'off');
  const held = w.revision();
  assert.equal(w.mc(['autonomy', PROGRAMME, 'off', '--by', 'Martin']).code, 0); assert.equal(w.revision(), held, 'a repeated off is a read');
  const text = w.mc(['status', PROGRAMME]).out;
  assert.match(text, /autonomous · off/u);
  assert.match(text, /next\s+no headless planner — autonomy off/u);

  // On rechecks support: the installed mc refuses, the fixture installation turns it on.
  assert.equal(w.on(w.mc).code, 1); assert.equal(w.revision(), held);
  const back = w.on(w.fixture);
  assert.equal(back.code, 0, back.err); assert.equal(back.json().mode, 'active');

  const state = JSON.parse(w.bytes());
  assert.deepEqual(state.planner_jobs.control.map(item => [item.operation, item.by]), [['autonomy-on', 'Martin'], ['autonomy-off', 'Martin'], ['autonomy-on', 'Martin']]);
  assert.equal(state.autonomy.stop, 'design-review'); assert.equal(state.execution_enabled, false);
  // The only tool processes are the sessions this test ran; mc launched none.
  assert.deepEqual(w.tools().map(item => [item.tool, item.role]), [['codex', 'review'], ['codex', 'step'], ['codex', 'review'], ['codex', 'plan']]);
  assert.equal(readFileSync(w.legacy, 'utf8'), w.legacyBytes);
});
