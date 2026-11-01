import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { run as page } from '../../src/mc/commands/home.js';
import { collectPage, intakeSection, mergesSection, nextSection, programmesSection, runnerSection, sessionsSection } from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { planSummary } from '../../src/mc/plan-schema.js';
import { autonomousProject } from './autonomy-fixtures.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const record = (name, phase = 1, programme = 'mc') => {
  const plan = autonomousProject({ project_id: name, programme: { id: programme }, programme_phase: phase });
  return { project: name, programme, repo: 'memoro-cli', plan, ...planSummary(plan) };
};
const goal = (phase, state = 'ready') => ({ programme_phase: phase, phase: state, active_run: null,
  criteria: [{ id: 'first', builder: 'verified' }, { id: 'second', builder: 'unknown' }], sessions_run: 3, next_action: 'start a build session' });
function data(over = {}) {
  return {
    runner: runnerSection({ now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    next: nextSection(), programmes: programmesSection(),
    merges: mergesSection(), intake: intakeSection({ now: NOW }), notes: [], ...over,
  };
}
const draw = value => renderPageLines(value, { columns: 140, now: NOW }).join('\n');

test('NEXT is not drawn and RUNNER carries the queue counts', () => {
  const plans = [record('sent'), record('running'), record('unsent')];
  const next = nextSection({ plans });
  const programmes = programmesSection({ plans, goals: { 'mc/sent': goal(1),
    'mc/running': { ...goal(1, 'running'), active_run: { run_id: 'build-1' } }, 'mc/unsent': goal(1, 'draft') } });
  const value = data({ next, programmes, autonomy: { programmes: [{ programme: 'mc', mode: 'off' }] } });
  const before = JSON.stringify(value);
  const text = draw(value);
  assert.doesNotMatch(text, /^  NEXT /mu);
  assert.match(text, /^  RUNNER .*1 queued \(0 projects · 1 goals\)/mu);
  assert.equal(JSON.stringify(value), before, 'rendering preserves data.next, data.autonomy and all project fields');
  // Use the existing queue object seam: legacy runnable entries retain their full detail.
  const mixed = data({ programmes, next: { ...next, items: [...next.items, { name: 'legacy', runnable: true, repo: 'memoro-cli' }] } });
  assert.match(draw(mixed), /^  RUNNER .*2 queued \(1 projects · 1 goals\)/mu);
});

test('goals are drawn by phase under their programme', () => {
  const plans = [record('a-later', 2), record('z-first', 1), record('other', 1, 'other-programme')];
  const programmes = programmesSection({ plans, goals: { 'mc/a-later': goal(2), 'mc/z-first': goal(1), 'other-programme/other': goal(1) } });
  const numbers = programmes.programmes.flatMap(group => group.projects).map(({ name, number }) => [name, number]);
  const text = draw(data({ programmes }));
  assert.ok(text.indexOf('phase 1') < text.indexOf('z-first'));
  assert.ok(text.indexOf('z-first') < text.indexOf('phase 2'));
  assert.ok(text.indexOf('phase 2') < text.indexOf('a-later'));
  assert.ok(text.indexOf('a-later') < text.indexOf('other-programme'));
  assert.match(text, /1\/2 criteria · 3 sessions · ready/u);
  assert.match(text, /start a build session/u);
  assert.deepEqual(numbers, [['a-later', 1], ['z-first', 2], ['other', 3]]);
  assert.match(text, /^    2 · z-first/mu);
  assert.match(text, /^    1 · a-later/mu);
});

test('programme rows carry sessions per provider and AUTONOMY is gone', () => {
  const foreground = ['claude', 'codex', 'codex'].map((tool, n) => ({ verb: 'plan', area: 'plan/mc', tool, pid: n + 1, started: NOW.toISOString() }));
  foreground.push({ verb: 'plan', area: 'plan/mc', tool: 'claude', pid: 99, started: NOW.toISOString() });
  const sessions = sessionsSection({ foreground, now: NOW, alive: pid => pid !== 99 });
  assert.equal(sessions.others.length, 0, 'every planning provider belongs to the programme, not WORK');
  const plan = { project: 'legacy', programme: 'mc', repo: 'memoro-cli', status: 'ready', title: 'Long next detail', plan: {
    steps: [{ status: 'ready', title: 'Short row', done_when: 'Long done-when detail' }] } };
  const programmes = programmesSection({ plans: [plan], planning: sessions.planning, planningSessions: sessions.planning_sessions });
  const value = data({ sessions, programmes, autonomy: { programmes: [{ programme: 'mc', mode: 'off' }] } });
  const text = draw(value);
  assert.match(text, /^  mc .*plan claude 1 · codex 2/mu);
  assert.match(renderPageLines(value, { columns: 60, now: NOW }).join('\n'), /^  mc .*plan claude 1 · codex 2/mu);
  assert.doesNotMatch(text, /^  AUTONOMY /mu);
  assert.doesNotMatch(text, /Long next detail|Long done-when detail/u);
  assert.equal(programmes.programmes[0].projects[0].next, 'Long next detail');
});

test('collected goal rows read durable state and open by their unchanged number', async t => {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const state = JSON.parse(readFileSync(f.paths.project, 'utf8'));
  state.phase = 'ready'; state.plan_sent = true;
  state.runs = [{ run_id: 'old-build', role: 'step' }, { run_id: 'old-review', role: 'review' }];
  writeFileSync(f.paths.project, JSON.stringify(state));
  const repo = { name: 'memoro-cli', path: join(f.root, 'repos', 'memoro-cli') };
  mkdirSync(join(repo.path, '.git'), { recursive: true });
  mkdirSync(join(f.root, 'runner'), { recursive: true });
  writeFileSync(join(f.root, 'runner', 'current-memoro-cli.json'), JSON.stringify({
    name: `programme:${f.programme}`, programme: f.programme, kind: 'plan', pid: process.pid, tool: 'codex', started: NOW.toISOString() }));
  const plans = [{ project: f.project, programme: f.programme, repo: repo.name, plan: state.contract, ...planSummary(state.contract) }];
  const value = await collectPage({ env: { MC_WORK_ROOT: f.root, MC_HOME: f.root }, now: NOW,
    repos: [repo], offline: true, git: () => null, run: () => ({ status: 1, stdout: '' }), checkout: null,
    alive: pid => pid === process.pid, laneCount: () => ({ per_repo: 1, total: null }), merges: () => [], claudeSettings: () => null,
    cache: { loadPlans: () => ({ plans, sources: [] }), loadPrs: () => ({ prs: [], fetched: NOW.toISOString(), age_seconds: 0 }) } });
  const project = value.programmes.programmes[0].projects[0];
  assert.equal(project.goal.programme_phase, 1); assert.equal(project.goal.phase, 'ready');
  assert.equal(project.goal.sessions_run, 2); assert.equal(project.goal.criteria.length, 2);
  assert.match(draw(value), /^  RUNNER .*1 queued/mu);
  assert.match(draw(value), /^  test-programme .*plan codex 1/mu);
  assert.ok(value.next); assert.ok(value.autonomy);
  let opened;
  assert.equal(await page([], { collect: async () => value, env: {}, interactive: () => true,
    stdout: { columns: 140, write: () => {} }, stderr: { write: () => {} },
    reader: { ask: async () => String(project.number), show: () => {} },
    openArea: name => { opened = name; return 0; }, checkAndPrintFreshInstall: async () => {} }), 0);
  assert.equal(opened, f.project);
});

test('an unsent draft is listed but is not counted in the runner queue', async t => {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const value = await collectPage({ env: { MC_WORK_ROOT: f.root, MC_HOME: f.root }, now: NOW,
    repos: [], offline: true, git: () => null, run: () => ({ status: 1, stdout: '' }), checkout: null,
    alive: () => false, laneCount: () => ({ per_repo: 1, total: null }), merges: () => [], claudeSettings: () => null,
    cache: { loadPlans: () => ({ plans: [], sources: [] }), loadPrs: () => ({ prs: [], fetched: NOW.toISOString(), age_seconds: 0 }) } });
  const project = value.programmes.programmes[0].projects[0];
  assert.equal(project.name, f.project); assert.equal(project.goal.phase, 'plan_pending');
  assert.match(draw(value), /^  RUNNER .*0 queued/mu);
  assert.equal(value.next.items.length, 0, 'drafts do not change the runner pick order');
});

test('the page survives unreadable programme state with a ready goal', async t => {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const state = JSON.parse(readFileSync(f.paths.project, 'utf8'));
  state.phase = 'ready'; state.plan_sent = true;
  writeFileSync(f.paths.project, JSON.stringify(state));
  writeFileSync(join(f.root, 'programs', f.programme, 'PROGRAMME_STATE.json'), 'not json');
  const plans = [{ project: f.project, programme: f.programme, repo: 'memoro-cli', plan: state.contract, ...planSummary(state.contract) }];
  const value = await collectPage({ env: { MC_WORK_ROOT: f.root, MC_HOME: f.root }, now: NOW,
    repos: [], offline: true, git: () => null, run: () => ({ status: 1, stdout: '' }), checkout: null,
    alive: () => false, laneCount: () => ({ per_repo: 1, total: null }), merges: () => [], claudeSettings: () => null,
    cache: { loadPlans: () => ({ plans, sources: [] }), loadPrs: () => ({ prs: [], fetched: NOW.toISOString(), age_seconds: 0 }) } });
  assert.ok(value.programmes); assert.ok(draw(value));
});

test('goal metrics and state fit a narrow terminal without changing row numbers', () => {
  const plan = record('a-very-long-goal-name-that-must-give-way');
  const programmes = programmesSection({ plans: [plan], goals: { [`mc/${plan.project}`]: goal(1) } });
  const value = data({ programmes });
  for (const columns of [60, 80, 100, 140]) {
    const lines = renderPageLines(value, { columns, now: NOW });
    const row = lines.find(line => /^    1 · /u.test(line));
    assert.ok(row, 'the same number stays visible');
    assert.match(row, /1\/2 criteria · 3 (runs|sessions) · ready$/u);
    assert.ok(row.length <= columns);
  }
});
