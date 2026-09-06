/**
 * The page — the five sections `mc` prints, each built from fixtures, the
 * whole page rendered at three widths, and `collectPage` against a work root
 * made of real files with no git, no gh and no tmux.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runsSince } from '../../src/mc/brief-collect.js';
import {
  collectPage, countNewErrors, intakeSection, newErrorLines, nextSection,
  programmesSection, readDigests, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { planSummary } from '../../src/mc/plan-schema.js';
import { intakeArchiveDir, intakeDir } from '../../src/mc/helper-collect.js';
import { colourFor, columnsFor, renderPage, renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';
import { run as page } from '../../src/mc/commands/home.js';

const NOW = new Date('2026-08-29T12:00:00Z');

/**
 * Plans as `listPlans` returns them: the record the page reads, with the parsed
 * plan on it. A status is not a field any more — it is the state of the first
 * step that is not done — so a fixture says which step it is on by building one.
 *
 * `done` steps in front of it where the fixture asks for them, because
 * `step n/m` on a NEXT row is only worth drawing when a plan can be part-way
 * through: `2/3` has to come from somewhere real.
 */
function planRecord({ repo, programme, project, status, title, done = 0 }) {
  const stopped = status === 'blocked' || status === 'blocked';
  const before = Array.from({ length: done }, (_, n) => ({
    title: `Step ${n + 1}`, status: 'done', done_when: 'it was done', instruction: [], pr: null, blocked_by: null,
  }));
  const steps = status === 'done'
    ? [{ title, status: 'done', done_when: 'it was done', instruction: [], pr: null, blocked_by: null }]
    : [...before, {
      title,
      status,
      done_when: 'the step is finished',
      instruction: ['Do it.'],
      pr: null,
      blocked_by: stopped ? { kind: 'decision', name: `${programme}-1` } : null,
    }];
  const plan = {
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met: false, criterion: 'It is done.', check: 'The gate is green.' }],
    documents: [],
    steps,
  };
  // Through `planSummary`, exactly as `listPlans` builds it: `status`, `next`,
  // the step's number, how many there are, and its title. A fixture that wrote
  // those by hand would be asserting its own arithmetic.
  return {
    repo,
    programme,
    project,
    path: `docs/project/${programme}/${project}/PLAN.json`,
    legacy: false,
    plan,
    problems: [],
    ...planSummary(plan),
  };
}

const PLANS = [
  planRecord({ repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-self-serve', status: 'blocked', title: 'Answer decision 4' }),
  planRecord({ repo: 'memoro', programme: 'docx-editing-surface', project: 'docx-editor', status: 'ready', title: 'Measure paste and IME', done: 1 }),
  planRecord({ repo: 'memoro-cli', programme: 'mc', project: 'mc-ui', status: 'ready', title: 'The page' }),
  planRecord({ repo: 'memoro-cli', programme: 'mc', project: 'mc-run', status: 'done', title: 'nothing' }),
];
const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-29T09:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-29T10:00:00Z\tmc-ui\tstep\t0\t652\t440\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-29T11:00:00Z\tavatar-self-serve\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = runsSince(TSV, new Date('2026-08-28T12:00:00Z'));
const live = () => true;

describe('RUNNER', () => {
  const RUNNER = { pid: 4242, started: '2026-08-29T10:00:00Z' };
  const CURRENT = {
    name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };

  it('carries the step, a pending STOP, the process and the day behind them', () => {
    const runner = runnerSection({
      runner: RUNNER, currents: [CURRENT], stop: true, rows: ROWS, now: NOW, alive: live,
    });
    assert.equal(runner.steps[0].name, 'mc-ui');
    assert.equal(runner.steps[0].elapsed_seconds, 1200);
    assert.equal(runner.steps[0].budget_seconds, 5400);
    assert.equal(runner.stop, true);
    assert.equal(runner.process.alive, true);
    assert.equal(runner.day.steps, 3);
    assert.equal(runner.day.timeout, 1);
    assert.ok(runner.day.cost > 7 && runner.day.cost < 8, `≈ $7.3 list: ${runner.day.cost}`);
  });

  // The section is the machine and nothing else now: a person's session is
  // not the runner's business and is not carried here at all.
  it('carries no session a person opened', () => {
    const runner = runnerSection({ runner: RUNNER, rows: ROWS, now: NOW, alive: live });
    assert.ok(!('foreground' in runner));
    assert.ok(!('live' in runner));
  });

  // `mc run` drives one lane per repository at the same time, so the section
  // is a list: one line for memoro's step and one for memoro-cli's.
  it('carries one step per lane when two lanes are running', () => {
    const runner = runnerSection({
      runner: RUNNER,
      currents: [CURRENT, {
        name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus',
        budget_minutes: 90, started: '2026-08-29T11:50:00Z', pid: 4243, worktree: '/w/docx-editor/memoro',
      }],
      rows: ROWS,
      now: NOW,
      alive: live,
    });
    assert.deepEqual(runner.steps.map((step) => step.repo), ['memoro', 'memoro-cli']);
    assert.deepEqual(runner.steps.map((step) => step.name), ['docx-editor', 'mc-ui']);
  });
});

/**
 * What is in production, drawn from the two readings that know it: the row
 * `mc deploy` wrote and the `/api/version` the helper cached. Fixtures only —
 * the page fetches nothing.
 */
describe('RUNNER — production', () => {
  const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012';
  const OTHER = 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00';
  const DEPLOYED = {
    started: '2026-08-29T09:40:00Z', ended: '2026-08-29T10:00:00Z', sha: SHA, build: '813',
    holder: 'martin@laptop', outcome: 'deployed', live_commit: SHA, live_build: '813',
    stopped_at: '', note: '',
  };
  const version = (commit, ageSeconds = 3600) => ({
    commit, short: commit.slice(0, 7), build: 23533, build_time: '2026-08-29T10:00:00Z',
    fetched: new Date(NOW.getTime() - ageSeconds * 1000).toISOString(), age_seconds: ageSeconds,
  });
  const section = (over = {}) => runnerSection({
    rows: [], now: NOW, alive: () => false, deploy: DEPLOYED, attempt: DEPLOYED, live: version(SHA), ...over,
  }).production;
  const line = (over = {}) => rowWith(
    paintedPage(pageData({ runner: runnerSection({ rows: [], now: NOW, alive: () => false, deploy: DEPLOYED, attempt: DEPLOYED, live: version(SHA), ...over }) })),
    'production',
  );

  it('is the last deployed row, with its age and who typed it', () => {
    const p = section();
    assert.equal(p.short, '1a2b3c4');
    assert.equal(p.build, '813');
    assert.equal(p.holder, 'martin@laptop');
    assert.equal(p.age_seconds, 7200);
    assert.equal(p.differs, false);
    assert.equal(p.running, null);
    assert.match(strip(line()), /production 1a2b3c4 build 813 · deployed 2 h ago by martin@laptop/u);
  });

  it('says in yellow when /api/version names another sha than the row', () => {
    const p = section({ live: version(OTHER) });
    assert.equal(p.differs, true);
    const drawn = line({ live: version(OTHER) });
    assert.match(strip(drawn), /production 1a2b3c4 .* · \/api\/version says b3e65b6 \(60 min old\)/u);
    // Yellow is the page's colour for what waits on a person, and nothing here
    // can tell which of the two shas is the one to believe.
    // The sha itself carries no colour — it is the text of the line — so the
    // only two runs on the row are the grey bookkeeping and the yellow.
    assert.equal(signature(drawn), 'grey yellow+bold');
  });

  it('carries a deploy that is running now, and calls one that never came back late', () => {
    const started = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    const fresh = section({ attempt: { ...DEPLOYED, started, ended: '', sha: OTHER, outcome: 'running' } });
    assert.equal(fresh.running.short, 'b3e65b6');
    assert.equal(fresh.running.late, false);
    assert.match(strip(line({ attempt: { ...DEPLOYED, started, ended: '', sha: OTHER, outcome: 'running' } })),
      /· deploying b3e65b6 since 5 min/u);

    const old = { ...DEPLOYED, started: '2026-08-29T08:00:00Z', ended: '', sha: OTHER, outcome: 'running' };
    assert.equal(section({ attempt: old }).running.late, true);
    assert.match(strip(line({ attempt: old })), /· deploying b3e65b6 since 4 h — no end recorded/u);
  });

  it('says a deploy failed after the last good one, and where it stopped', () => {
    const failed = {
      ...DEPLOYED, started: '2026-08-29T11:00:00Z', ended: '2026-08-29T11:30:00Z', sha: OTHER,
      outcome: 'failed', live_commit: '', stopped_at: 'wrangler deploy',
    };
    assert.equal(section({ attempt: failed }).failed.stopped_at, 'wrangler deploy');
    assert.match(strip(line({ attempt: failed })), /· a deploy failed 30 min ago at wrangler deploy/u);
  });

  it('says what production answers when mc has deployed nothing, and nothing at all when neither knows', () => {
    const p = section({ deploy: null, attempt: null });
    assert.equal(p.sha, null);
    assert.equal(p.differs, false, 'there is no row to differ from');
    assert.match(strip(line({ deploy: null, attempt: null })),
      /production 1a2b3c4 · \/api\/version \(60 min old\) — mc has deployed nothing/u);

    assert.equal(section({ deploy: null, attempt: null, live: null }), null);
    const quiet = paintedPage(pageData({ runner: runnerSection({ rows: [], now: NOW, alive: () => false }) }));
    assert.equal(quiet.filter((row) => strip(row).includes('production')).length, 0,
      'a machine that has never deployed and never collected says nothing about production');
  });
});

describe('SESSIONS', () => {
  const HELPER = {
    verb: 'helper', area: null, tool: 'claude', model: 'sonnet', pid: 99,
    started: '2026-08-27T12:00:00Z',
  };
  const PLAN = {
    verb: 'plan', area: 'plan/msr-core', tool: 'claude', model: 'opus', pid: 100,
    started: '2026-08-29T11:30:00Z',
  };

  it('gives each desk its own slot, and says so when nobody is at one', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.desks.helper.pid, 99);
    // A desk nobody is at is `null` rather than missing: the page draws the
    // row either way, and "is the helper running?" is answered both ways.
    assert.equal(s.desks.brief, null);
    assert.equal(s.count, 2);
  });

  // A planning session belongs to its programme, and PROGRAMMES draws it on
  // that programme's own row. It is keyed by programme here so that section
  // never has to know how `mc plan` spells an area.
  it('keys a planning session by its programme, and keeps it out of the list', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.planning['msr-core'].pid, 100);
    assert.deepEqual(s.others, []);
  });

  // A `mc plan` from before the programme change carries a bare project name,
  // belongs to no programme and cannot be started again.
  it('leaves a plan session with no programme in the list', () => {
    const s = sessionsSection({
      foreground: [{ ...PLAN, area: 'mc-test' }], now: NOW, alive: live,
    });
    assert.deepEqual(s.planning, {});
    assert.deepEqual(s.others.map((item) => item.area), ['mc-test']);
  });

  // The whole point of the section. `started` has been in the register since
  // it existed and nothing read it, so a session opened on Sunday was drawn
  // exactly like one opened twenty minutes ago.
  it('carries how long each session has been open', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.desks.helper.age_seconds, 2 * 24 * 60 * 60);
    assert.equal(s.planning['msr-core'].age_seconds, 1800);
  });

  it('carries a tmux window as a session with no verb', () => {
    const s = sessionsSection({
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      now: NOW,
      alive: live,
    });
    assert.deepEqual(s.others.map((item) => [item.area, item.verb, item.tmux, item.age_seconds]),
      [['docx-editor', null, 'mc-docx-editor', 3600]]);
  });

  // Oldest first: the one open longest is the one most likely to have been
  // forgotten, which is why the age is on the row at all.
  it('puts the oldest session first', () => {
    const s = sessionsSection({
      foreground: [PLAN, { ...HELPER, verb: 'work', area: 'red' }],
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      now: NOW,
      alive: live,
    });
    // The planning session is not here at all — it is on its programme's row.
    assert.deepEqual(s.others.map((item) => item.area), ['red', 'docx-editor']);
  });

  it('drops a registered session whose process is gone', () => {
    const s = sessionsSection({
      foreground: [{ verb: 'brief', pid: 99 }, { verb: 'plan', area: 'x', pid: 100 }],
      now: NOW,
      alive: (pid) => pid === 100,
    });
    assert.equal(s.desks.brief, null);
    assert.deepEqual(s.others.map((item) => item.verb), ['plan']);
  });
});

describe('NEXT', () => {
  it('walks the runner\'s own order, counts what is runnable, and counts the skips by reason', () => {
    // Every non-legacy plan on main is in the walk, not only what `queue.md`
    // names: `mc-run` is done and `avatar-self-serve` is blocked, and the
    // runner reaches both and passes them over.
    const next = nextSection({ queueText: 'mc-ui\nbrand-new\n', plans: PLANS });
    assert.deepEqual(next.items.map((item) => item.name),
      ['mc-ui', 'avatar-self-serve', 'docx-editor', 'mc-run'],
      'queue.md first — brand-new has no plan and is not in the order at all');
    assert.equal(next.depth, 4);
    assert.equal(next.from_queue, 1);
    assert.equal(next.runnable, 2);
    assert.equal(next.skipped.count, 2);
    assert.deepEqual(next.skipped.reasons, { blocked: 1, done: 1 });
  });

  /**
   * The defect this section was rebuilt for. With `~/mc/queue.md` empty the
   * page said *"empty — mc brief queues the next thing"* and the brand row said
   * `0 of 0 queued`, while the runner was walking 41 projects and running one.
   * Nothing about the runner's order needs the file to say anything.
   */
  it('names what the runner would step with queue.md empty, one block per lane', () => {
    const next = nextSection({ queueText: '', plans: PLANS });
    assert.equal(next.from_queue, 0);
    assert.deepEqual(next.lanes.map((lane) => [lane.repo, lane.count, lane.items.map((item) => item.name)]), [
      ['memoro', 1, ['docx-editor']],
      ['memoro-cli', 1, ['mc-ui']],
    ], 'one lane per repository, in the order the runner would drive them');
    // The row's own content: where in its plan the project is, and the title of
    // the step that would run — read off the record, never parsed out of `next`.
    assert.deepEqual(next.lanes.flatMap((lane) => lane.items).map((item) => [item.step, item.steps, item.title]), [
      [2, 2, 'Measure paste and IME'],
      [1, 1, 'The page'],
    ]);
    const lines = renderPageLines(pageData({ next }), { columns: 120 });
    assert.ok(lines.some((line) => /NEXT {2}2 runnable of 4 · the order is alphabetical/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /^ {7}docx-editor\s+step 2\/2\s+Measure paste and IME$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /^ {7}mc-ui\s+step 1\/1\s+The page$/u.test(line)), lines.join('\n'));
    assert.ok(!lines.some((line) => /empty — mc brief/u.test(line)), 'the queue file is not the queue');
    // And the brand row above it counts the work rather than the file: with
    // `queue.md` empty it said `0 of 0 queued` while all of this was true.
    const brand = renderPageLines(pageData({ next, programmes: programmesSection({ plans: PLANS, areas: [] }) }),
      { columns: 120, version: '0.7.11' })[1];
    assert.match(brand, /0 in flight · 2 ready · 1 blocked/u);
    assert.doesNotMatch(brand, /queued/u);
  });

  it('says on the heading how much of the order queue.md chose', () => {
    const named = renderPageLines(pageData({
      next: nextSection({ queueText: 'mc-ui\ndocx-editor\n', plans: PLANS }),
    }), { columns: 120 });
    assert.ok(named.some((line) => /NEXT {2}2 runnable of 4 · 2 from queue\.md, then alphabetical/u.test(line)), named.join('\n'));
  });

  it('draws three deep per lane and counts the rest of that lane', () => {
    const many = ['a', 'b', 'c', 'd'].map((name) => planRecord({
      repo: 'memoro', programme: 'p', project: name, status: 'ready', title: `Do ${name}`,
    }));
    const next = nextSection({ queueText: '', plans: [...many, PLANS[2]] });
    assert.deepEqual(next.lanes.map((lane) => [lane.repo, lane.count, lane.items.length, lane.more]), [
      ['memoro', 4, 3, 1], ['memoro-cli', 1, 1, 0],
    ]);
    assert.equal(next.more, 1);
    const lines = renderPageLines(pageData({ next }), { columns: 120 });
    assert.ok(lines.some((line) => /^ {5}memoro · 4 runnable · … 1 more$/u.test(line)), lines.join('\n'));
  });

  // The page used to answer "somebody has a session open here" as a skip of its
  // own, because the runner declined for it. The runner does not any more, and
  // a page that predicts a skip the runner will not make reads as the runner's
  // own answer while being nobody's.
  it('does not pass a project over because somebody has a session open in it', () => {
    const next = nextSection({ queueText: 'docx-editor\n', plans: [PLANS[1]], live: ['docx-editor'] });
    assert.equal(next.runnable, 1);
    assert.equal(next.skipped.count, 0);
    assert.deepEqual(next.skipped.reasons, {});
  });

  /**
   * A pull request the runner would not land keeps its project out of the
   * queue entirely — `inFlight` refuses it every round — so it is in none of
   * the counts above. `~/mc/runner/held.json` is where the runner writes why,
   * and this is where a person reads it without opening runner.log.
   */
  it('carries every held pull request with its reason, oldest first', () => {
    const queue = nextSection({
      queueText: 'mc-ui\n',
      plans: PLANS,
      held: [
        { project: 'mc-run', repo: 'memoro-cli', pr: 561, branch: 'mc-run-2', reason: 'the session changed more of the plan than its step', note: 'plan-trespass', since: '2026-08-29T11:00:00Z', repairs: 1 },
        { project: 'docx-editor', repo: 'memoro', pr: 10958, branch: 'docx-editor', reason: 'two tests the change reaches are red', note: 'open,gate-red', since: '2026-08-29T09:10:00Z', repairs: 0 },
      ],
    });
    assert.equal(queue.held.count, 2);
    assert.deepEqual(queue.held.items.map((item) => [item.project, item.pr, item.repairs]), [
      ['docx-editor', 10958, 0], ['mc-run', 561, 1],
    ]);
    assert.deepEqual(Object.keys(queue.held.items[0]).sort(), [
      'branch', 'note', 'pr', 'project', 'reason', 'repairs', 'repo', 'since',
    ]);
  });

  /**
   * The plans said `ready` for both of memoro-cli's unfinished projects on
   * 2026-09-05 while `held.json` held both of their pull requests, and this
   * block reported two runnable. What the machine refuses is counted here
   * now, in the same words the round refuses in (`RUN_REFUSALS`).
   */
  it('counts what this machine refuses, not only what the plans do', () => {
    const machine = (name) => (name === 'mc-ui'
      ? { runnable: false, reason: 'dirty', detail: 'uncommitted work in /w/mc-ui/memoro-cli: a.js', since: '2026-09-05T10:00:00Z', kind: null }
      : { runnable: true, reason: null, detail: null, since: null, kind: 'step' });
    const queue = nextSection({ queueText: 'mc-ui\ndocx-editor\navatar-self-serve\n', plans: PLANS, machine });
    assert.equal(queue.depth, 4);
    assert.equal(queue.runnable, 1);
    assert.deepEqual(queue.lanes.flatMap((lane) => lane.items).map((item) => item.name), ['docx-editor']);
    assert.deepEqual(queue.skipped.reasons, { dirty: 1, blocked: 1, done: 1 });
    assert.equal(queue.items.find((item) => item.name === 'mc-ui').machine.since, '2026-09-05T10:00:00Z');
  });

  // A plan the runner already refuses is never asked about this machine: that
  // is `machineState`'s own economy, and the page keeps it.
  it('asks nothing of the machine for a name the plan has already refused', () => {
    const asked = [];
    const queue = nextSection({
      queueText: 'mc-ui\navatar-self-serve\nbrand-new\n',
      plans: [PLANS[0], PLANS[2], PLANS[3]],
      machine: (name) => { asked.push(name); return { runnable: true, kind: 'step' }; },
    });
    assert.deepEqual(asked, ['mc-ui'], 'blocked, done and nameless cost no reading at all');
    assert.equal(queue.runnable, 1);
  });

  /**
   * A hold still owed its repair is not a skip — the runner would start it —
   * and what it would start is a repair. The kind beside the name is what the
   * runner would do, so the page does not say `step` where none is coming.
   */
  it('names the kind the runner would actually start', () => {
    const queue = nextSection({
      queueText: 'mc-ui\n',
      plans: [PLANS[2]],
      machine: () => ({ runnable: true, reason: null, detail: '#440 is held before merge — one repair session is owed', since: null, kind: 'repair' }),
    });
    assert.deepEqual(queue.lanes.flatMap((lane) => lane.items).map((item) => [item.name, item.kind]), [['mc-ui', 'repair']]);
    assert.equal(queue.runnable, 1);
    // And the row says it: `repair 1/1`, in the yellow a repair is drawn in.
    const lines = renderPageLines(pageData({ next: queue }), { columns: 120 });
    assert.ok(lines.some((line) => /^ {7}mc-ui\s+repair 1\/1\s+The page$/u.test(line)), lines.join('\n'));
  });

  it('has nothing held when the file is missing or not a list', () => {
    assert.deepEqual(nextSection({ plans: [] }).held, { count: 0, items: [] });
    assert.equal(nextSection({ plans: [], held: null }).held.count, 0);
  });

  // The whole section is empty only when there is nothing on main at all, and
  // then it says that rather than blaming the queue file for it.
  it('says so when there is no plan on main to run', () => {
    const lines = renderPageLines(pageData({ next: nextSection({ plans: [] }) }), { columns: 120 });
    assert.ok(lines.some((line) => /NEXT {2}nothing on main to run/u.test(line)), lines.join('\n'));
  });
});


describe('the stale-blocker line', () => {
  const PLAN = (project, steps) => ({ repo: 'memoro', programme: 'p', project, status: 'blocked', plan: { steps } });
  const BLOCKED = (name) => ({ title: 'A step', status: 'blocked', blocked_by: { kind: 'project', name } });

  it('claims no more than the two things the check can know', () => {
    // `staleBlockers` computes `why` as `is done` or `is not on main`, and is
    // careful about the difference because a project also leaves main when it
    // is abandoned. The header said *not coming*, which is a prediction.
    const plans = [
      PLAN('waiting-on-done', [BLOCKED('already-done')]),
      PLAN('waiting-on-gone', [BLOCKED('never-heard-of-it')]),
      { ...PLAN('already-done', [{ title: 'x', status: 'done' }]), status: 'done' },
    ];
    const queue = nextSection({ plans });
    assert.equal(queue.stale.count, 2);
    const lines = renderPageLines(pageData({ next: queue }), { columns: 120 });
    const header = lines.find((line) => /blocker finished/u.test(line));
    assert.match(header, /blocker finished 2 — a blocked step names a project that is done or no longer on main/u);
    assert.doesNotMatch(header, /not coming/u, 'the page predicts nothing the module refused to');
    assert.ok(lines.some((line) => /waiting-on-done step 1 on already-done, which is done/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /waiting-on-gone step 1 on never-heard-of-it, which is not on main/u.test(line)), lines.join('\n'));
  });
});

describe('INTAKE', () => {
  const DIGEST = [
    '# Errors and maintenance — 2026-08-29', '',
    'Baseline: `errors-2026-08-28.md`.', '',
    '## New since the last digest', '',
    '- ! `abc123` — 41x 500 — a loud one',
    '- · `def456` — 3x 500 — a quiet one', '',
    '## Error fingerprints', '',
    '- not counted, this is another section',
  ].join('\n');

  it('counts the bullets under "New since the last digest", and the loud ones apart', () => {
    assert.deepEqual(countNewErrors(DIGEST), { count: 2, loud: 1, first: false });
    assert.deepEqual(countNewErrors('## New since the last digest\n\n_nothing new_\n'), { count: 0, loud: 0, first: false });
    assert.equal(countNewErrors('## New since the last digest\n\n_first digest — no baseline_\n').first, true);
    assert.deepEqual(countNewErrors('nothing at all'), { count: 0, loud: 0, first: false });
  });

  it('names the digest, its age and the proposals waiting', () => {
    const intake = intakeSection({
      digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: DIGEST, mtime_ms: Date.parse('2026-08-29T10:00:00Z') }],
      proposals: ['2026-08-29-one.md', '2026-08-29-two.md'],
      now: NOW,
    });
    assert.equal(intake.repos[0].repo, 'memoro');
    assert.equal(intake.repos[0].date, '2026-08-29');
    assert.equal(intake.repos[0].age_seconds, 7200);
    assert.equal(intake.repos[0].new_errors, 2);
    assert.equal(intake.repos[0].loud, 1);
    assert.equal(intake.proposals, 2);
  });

  it('keeps the `!` lines themselves, and names the first few', () => {
    const many = ['## New since the last digest', '',
      '- ! `one` — 90x 500 — the first',
      '- ! `two` — 80x 500 — the second',
      '- · `quiet` — 2x 500 — not loud',
      '- ! `three` — 70x 500 — the third',
      '- ! `four` — 60x 500 — the fourth',
    ].join('\n');
    assert.deepEqual(newErrorLines('- ! `a` — x').lines, [], 'a bullet outside the section is not a new error');
    const intake = intakeSection({ digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: many, mtime_ms: null }], named: 3 });
    assert.equal(intake.repos[0].new_errors, 5);
    assert.equal(intake.repos[0].loud, 4);
    assert.deepEqual(intake.repos[0].loud_lines, ['`one` — 90x 500 — the first', '`two` — 80x 500 — the second', '`three` — 70x 500 — the third']);
    assert.equal(intake.repos[0].more_loud, 1);

    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    const at = lines.findIndex((line) => /^ {2}INTAKE/u.test(line));
    assert.match(lines[at + 2], /^ {2} {2}! {2}`one` — 90x 500 — the first$/u, 'the `!` lines come under their repository row');
    assert.match(lines[at + 5], /… 1 more above the threshold/u);
  });

  it('has no `!` lines to print on a quiet day', () => {
    const intake = intakeSection({
      digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: '## New since the last digest\n\n_nothing new_\n', mtime_ms: null }],
    });
    assert.deepEqual(intake.repos[0].loud_lines, []);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    const at = lines.findIndex((line) => /^ {2}INTAKE/u.test(line));
    assert.equal(lines[at + 2], '', 'the repository row, then nothing before the next section');
  });

  it('names today\'s digest with the digests present only in the archive', () => {
    // The section read `~/mc/intake/` alone and matched `errors-<date>.md`
    // alone, so it named a file from 2026-08-30 for six days and then said
    // *no digest yet* on a day the collect had run twice — the drain had
    // archived the two legacy files it was still matching.
    const root = mkdtempSync(join(tmpdir(), 'mc-page-intake-'));
    const env = { MC_WORK_ROOT: root };
    mkdirSync(intakeDir(env), { recursive: true });
    const archive = intakeArchiveDir(env, new Date('2026-08-29T09:00:00Z'));
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'errors-2026-08-25.md'), 'the legacy one');
    writeFileSync(join(archive, 'errors-memoro-cli-2026-08-29.md'), 'mc itself');
    writeFileSync(join(archive, 'errors-memoro-2026-08-29.md'), DIGEST);

    const found = readDigests(env);
    assert.deepEqual(found.map((d) => d.name), ['errors-memoro-2026-08-29.md', 'errors-memoro-cli-2026-08-29.md']);
    const intake = intakeSection({ digests: found, proposals: [], now: NOW });
    assert.equal(intake.repos[0].date, '2026-08-29');
    assert.equal(intake.repos[0].new_errors, 2);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    assert.ok(!lines.some((line) => /no digest yet/u.test(line)), 'the collect has run');
    // One row each, and neither repository is hidden behind the other.
    assert.ok(lines.some((line) => /^ +memoro · 2026-08-29/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /^ +memoro-cli · 2026-08-29/u.test(line)), lines.join('\n'));
  });

  it('has no digest to name when nothing has been collected at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-intake-'));
    assert.deepEqual(readDigests({ MC_WORK_ROOT: root }), []);
  });

  it('says there is no digest rather than a zero that looks like health', () => {
    const intake = intakeSection({ digests: [], proposals: [], now: NOW });
    assert.deepEqual(intake.repos, []);
    assert.equal(intake.digests, 0);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    assert.ok(lines.some((line) => /INTAKE {2}no digest yet — mc helper --intake has not run/u.test(line)), lines.join('\n'));
  });
});

describe('PROJECTS', () => {
  const AREAS = [
    { name: 'docx-editor', mtime_ms: Date.parse('2026-08-29T08:00:00Z') },
    { name: 'mc-ui', mtime_ms: Date.parse('2026-08-29T11:50:00Z') },
    { name: 'ui-fixes', mtime_ms: Date.parse('2026-08-20T08:00:00Z') },
    { name: 'avatar-self-serve', mtime_ms: Date.parse('2026-08-29T09:00:00Z') },
  ];

  const projectsFixture = (over = {}) => programmesSection({
    plans: PLANS,
    areas: AREAS,
    rows: ROWS,
    openPrs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }, { repo: 'memoro', number: 2, headRefName: 'elsewhere' }],
    live: ['ui-fixes'],
    ...over,
  });

  const flat = (projects) => projects.programmes.flatMap((group) => group.projects);

  it('groups by programme, then project, and says which repository each lives in', () => {
    const projects = projectsFixture();
    assert.deepEqual(projects.programmes.map((group) => group.programme),
      ['assistant-avatar', 'docx-editing-surface', 'mc']);
    assert.deepEqual(flat(projects).map((p) => [p.number, p.programme, p.name, p.repo]), [
      [1, 'assistant-avatar', 'avatar-self-serve', 'memoro'],
      [2, 'docx-editing-surface', 'docx-editor', 'memoro'],
      [3, 'mc', 'mc-run', 'memoro-cli'],
      [4, 'mc', 'mc-ui', 'memoro-cli'],
    ]);
    assert.equal(projects.count, 4);
  });

  // A programme spanning both repositories is one heading, not two blocks
  // under two repository names — which is the whole reason the grouping moved.
  it('keeps a programme whole across repositories', () => {
    const projects = projectsFixture({
      plans: [
        planRecord({ repo: 'memoro', programme: 'msr-core', project: 'home-on-msr', status: 'ready', title: 'a' }),
        planRecord({ repo: 'memoro-cli', programme: 'msr-core', project: 'msr-cli-bits', status: 'ready', title: 'b' }),
      ],
    });
    assert.deepEqual(projects.programmes.map((group) => group.programme), ['msr-core']);
    assert.deepEqual(projects.programmes[0].repos, ['memoro', 'memoro-cli']);
  });

  // The room `mc plan <programme>` fills. A programme with none is drawn all
  // the same: that is a programme nobody is thinking about right now.
  it('puts a planning session on its programme, and says when there is none', () => {
    const projects = projectsFixture({ planning: { mc: { pid: 7, age_seconds: 600 } } });
    const byName = Object.fromEntries(projects.programmes.map((g) => [g.programme, g]));
    assert.equal(byName.mc.planning.pid, 7);
    assert.equal(byName['assistant-avatar'].planning, null);
    assert.equal(projects.planning, 1);
  });

  // A programme that exists only as an open planning session has no project to
  // be found by, and is the one piece of work the page could otherwise not show.
  it('draws a programme that is only a planning session, or only a directory on main', () => {
    const projects = projectsFixture({
      plans: [],
      planning: { 'brand-new': { pid: 7, age_seconds: 60 } },
      programmes: ['archived-programme'],
    });
    assert.deepEqual(projects.programmes.map((g) => g.programme), ['archived-programme', 'brand-new']);
    assert.deepEqual(projects.programmes.map((g) => g.projects.length), [0, 0]);
  });

  // The mark means the runner, and only the runner. It used to mean a live
  // tmux area, which made one mark answer two questions.
  it('marks a project the runner has a step in flight on, and no other', () => {
    const projects = projectsFixture({ running: ['mc-ui'], live: ['docx-editor'] });
    const byName = Object.fromEntries(flat(projects).map((p) => [p.name, p]));
    assert.equal(byName['mc-ui'].running, true);
    assert.equal(byName['docx-editor'].running, false);
    assert.equal(projects.running, 1);
  });

  it('carries the plan state, how far it has got, its PR and its last step', () => {
    const projects = projectsFixture();
    const ui = flat(projects).find((p) => p.name === 'mc-ui');
    assert.equal(ui.status, 'ready');
    assert.equal(ui.next, 'Step 1, The page — done when the step is finished');
    assert.deepEqual(ui.steps, { done: 0, total: 1 });
    assert.equal(ui.pr, 440);
    assert.equal(ui.workarea, true);
    assert.deepEqual(ui.last, { ts: '2026-08-29T10:00:00Z', kind: 'step', pr: '440', note: 'success,merged' });
    assert.deepEqual(projects.statuses, { 'blocked': 1, ready: 2, done: 1 });
  });

  /**
   * The row used to match `headRefName === name`, so `action-window` had an
   * empty PR column while three of its branches had one open (2026-09-02). A
   * project's branches are `<name>` and `<name>-<suffix>`, and the longest
   * name wins so `mc-run-2` stays out of `mc`'s row.
   */
  it('names the pull request a project is waiting on, whichever of its branches carries it', () => {
    const projects = projectsFixture({
      openPrs: [
        { repo: 'memoro-cli', number: 11246, headRefName: 'mc-ui-4' },
        { repo: 'memoro-cli', number: 11250, headRefName: 'mc-run-2' },
        { repo: 'memoro-cli', number: 3, headRefName: 'spike/mc-ui' },
        { repo: 'memoro', number: 2, headRefName: 'mc-ui' },
      ],
    });
    const by = Object.fromEntries(flat(projects).map((p) => [p.name, p.pr]));
    assert.equal(by['mc-ui'], 11246, 'its own repository, its own family of branches');
    assert.equal(by['mc-run'], 11250);
    assert.equal(by['docx-editor'], null, 'a branch no project explains belongs to nobody');
  });

  // A project is what the work is; a folder is where a session runs. mc-run
  // has a plan and no folder, and used to be a count at the foot of the
  // section rather than a row anybody could open.
  it('lists a project that has no workarea, and says how many are like it', () => {
    const projects = projectsFixture();
    const run = flat(projects).find((p) => p.name === 'mc-run');
    assert.equal(run.workarea, false);
    assert.equal(run.number, 3, 'it is a numbered row, not a footnote');
    assert.equal(projects.no_workarea, 1);
  });

  /**
   * A workarea no project explains is not one of the rows above. Nothing
   * removes it, so it belongs under a heading of its own — with what says
   * whether anything would be lost by removing it by hand.
   */
  it('puts a workarea with no project under its own heading, numbered after the rest', () => {
    const projects = projectsFixture({ detail: (name) => (name === 'ui-fixes' ? { uncommitted: 3, last_commit: '2026-08-20' } : {}) });
    assert.deepEqual(projects.unplanned.shown.map((area) => [area.number, area.name]), [[5, 'ui-fixes']]);
    const orphan = projects.unplanned.shown[0];
    assert.equal(orphan.live, true, 'live or not, it is still nobody’s project');
    assert.equal(orphan.uncommitted, 3);
    assert.equal(orphan.last_commit, '2026-08-20');
    assert.equal(projects.unplanned.count, 1);
    assert.equal(projects.count, 4, 'the count is projects; a folder is not one');
  });

  // Fifty-seven of them on 2026-08-30. Drawn whole they would be the page
  // again, so the page draws a few and counts the rest.
  it('draws the first few orphans and counts the others', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({ name: `old-${String(n).padStart(2, '0')}`, mtime_ms: 1000 - n }));
    const projects = programmesSection({ plans: [], areas: many, shown: 3 });
    assert.deepEqual(projects.unplanned.shown.map((area) => area.name), ['old-00', 'old-01', 'old-02']);
    assert.equal(projects.unplanned.more, 17);
    assert.equal(projects.unplanned.count, 20);
  });

  // Two `git` calls per folder, and they were paid for all 81 folders under
  // `~/mc` — 15 s of an 8 s page, most of it for rows the cap then dropped.
  it('asks git about the orphans it draws, and no others', () => {
    const asked = [];
    const many = Array.from({ length: 20 }, (_, n) => ({ name: `old-${String(n).padStart(2, '0')}`, mtime_ms: 1000 - n }));
    programmesSection({ plans: [], areas: many, shown: 3, detail: (name) => { asked.push(name); return {}; } });
    assert.deepEqual(asked, ['old-00', 'old-01', 'old-02']);
  });

  it('numbers through both lists, so the page has no two rows with one number', () => {
    const projects = projectsFixture();
    const numbers = [...flat(projects), ...projects.unplanned.shown].map((area) => area.number);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
  });

  it('names the repository an orphan workarea holds', () => {
    const projects = programmesSection({ areas: [{ name: 'msr-track-1', mtime_ms: 1, repos: ['memoro'] }], plans: [] });
    assert.equal(projects.unplanned.shown[0].repo, 'memoro');
  });

  it('says a plan still on the old markdown file is one, rather than a fraction of nothing', () => {
    const projects = programmesSection({
      plans: [{ repo: 'memoro', programme: 'mc', project: 'old', legacy: true, plan: null, status: 'ready', next: 'x' }],
      areas: [],
    });
    const [project] = projects.programmes[0].projects;
    assert.equal(project.steps, null);
    assert.equal(project.legacy, true);
  });
});

/** The page's data with one section replaced — everything else is empty. */
function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    next: nextSection({ plans: [] }),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({ areas: [], plans: [] }),
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/** The whole page, with every section carrying something. */
const DATA = pageData({
  runner: runnerSection({
    runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
    currents: [{
      name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
      started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
    }],
    stop: true,
    rows: ROWS,
    now: NOW,
    alive: live,
  }),
  sessions: sessionsSection({
    foreground: [{
      verb: 'helper', area: null, tool: 'claude', model: 'sonnet', pid: 99,
      started: '2026-08-29T11:00:00Z',
    }],
    live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
    now: NOW,
    alive: live,
  }),
  next: nextSection({
    queueText: 'mc-ui\ndocx-editor\nmc-run\n',
    plans: PLANS,
    held: [{
      project: 'docx-editor', repo: 'memoro', pr: 10958, branch: 'docx-editor',
      reason: 'two tests the change reaches are red', note: 'open,gate-red',
      since: '2026-08-29T09:10:00Z', repairs: 0,
    }],
  }),
  intake: intakeSection({
    digests: [{
      repo: 'memoro',
      name: 'errors-memoro-2026-08-29.md',
      text: '## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n',
      mtime_ms: Date.parse('2026-08-29T11:00:00Z'),
    }],
    proposals: ['a.md'],
    now: NOW,
  }),
  programmes: programmesSection({
    plans: PLANS,
    areas: [{ name: 'mc-ui', mtime_ms: Date.parse('2026-08-29T11:50:00Z') }, { name: 'ui-fixes', mtime_ms: 0 }],
    rows: ROWS,
    openPrs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }],
    live: [],
    repoOrder: ['memoro', 'memoro-cli'],
  }),
  caches: { fresh: false, plans: [], prs: { fetched: '2026-08-29T10:00:00Z', age_seconds: 7200, count: 1 } },
  notes: ['PRs from cache, 2 h old — --fresh asks GitHub', 'no queue.md'],
});

describe('the page', () => {
  it('prints the sections in order — the listing first, the machine last and nearest the prompt', () => {
    const text = renderPage(DATA, { columns: 120, version: '0.7.11', now: NOW });
    // RUNNER and the desks are the rows that change while the page is open,
    // and the live loop can only rewrite rows still on the screen; at the
    // top they scrolled off under the projects and never moved (2026-09-03).
    const at = ['NEXT', 'INTAKE', 'PROGRAMMES', 'WORK', 'RUNNER', 'HELPER', 'BRIEF'].map((head) => text.indexOf(`  ${head}`));
    assert.ok(at.every((index, n) => index >= 0 && (n === 0 || index > at[n - 1])), text);
    assert.match(text, /MEMORO·CLI {2}0\.7\.11/u);
    // What is true of the work, and never `0 of 0 queued`: the step in flight,
    // and the plans PROGRAMMES counts ready and blocked, in the same numbers.
    assert.match(text, /1 in flight · 2 ready · 1 blocked/u);
    assert.doesNotMatch(text, /queued/u);
    assert.match(text, /● mc-ui\s+step · claude opus · 20 min of 90 min · pid 4242/u);
    assert.match(text, /■ STOP requested — the runner exits after the steps it is in/u);
    assert.match(text, /HELPER {2}● open 60 min · claude sonnet · pid 99\s+mc helper/u);
    assert.match(text, /BRIEF {2}· {2}not open\s+mc brief/u);
    assert.match(text, /WORK {2}1 session · 1 workarea with no project\s+mc work <name>/u);
    assert.match(text, /◆ docx-editor\s+tmux · open 60 min · mc-docx-editor/u);
    assert.match(text, /runner up 120 min · 3 steps in 24 h — merged 1, open 1, failed 0, timed out 1 · ≈\$7\.\d\d list \(opus, 2026-06\)/u);
    assert.match(text, /NEXT {2}2 runnable of 4 · 3 from queue\.md, then alphabetical · held before merge 1\s+mc status <name>/u);
    // One block per lane, three deep, and the row says where in its plan the
    // project is. The lanes run at the same time: both heads start now.
    assert.match(text, /^ {5}memoro-cli · 1 runnable\n {7}mc-ui\s+step 1\/1\s+The page$/mu);
    assert.match(text, /^ {5}memoro · 1 runnable\n {7}docx-editor\s+step 2\/2\s+Measure paste and IME$/mu);
    assert.match(text, /skipped 2 \(done 1, blocked 1\)/u);
    assert.match(text, /· docx-editor {2}#10958 {2}two tests the change reaches are red/u);
    assert.doesNotMatch(text, /DECISIONS/u);
    assert.match(text, /INTAKE {2}1 digest · 1 proposal\s+mc helper --intake/u);
    assert.match(text, /^ +memoro · 2026-08-29 \(60 min old\) · 1 new error \(1 loud\)$/mu);
    assert.match(text, /PROGRAMMES {2}3 programmes · 4 projects {2}ready 2 · blocked 1 · done 1\s+p {2}plan a programme/u);
    assert.match(text, /^ {2}docx-editing-surface\s+·\s{2}no plan session$/mu, 'the programme is a heading of its own');
    assert.match(text, /^ {4}2 · docx-editor\s+memoro\s+ready/mu, 'the repository is a column on the row');
    assert.match(text, / {4}4 · mc-ui\s+memoro-cli\s+ready\s+0\/1\s+Step 1, The page — done when the step[^|]*#440/u);
    assert.match(text, /3 of them have no workarea yet/u);
    assert.match(text, / {4}5 · ui-fixes\s+—\s+no project on main/u);
    assert.match(text, / {4}5 · ui-fixes\s+—\s+no project on main/u);
    assert.match(text, /offline, PRs 2 h old — --fresh asks GitHub/u);
    assert.match(text, /note: no queue\.md/u);
    assert.ok(!/note: PRs from cache/u.test(text), 'the cache line already says it');
  });

  it('fits the terminal it is printed in, from 60 columns to 160', () => {
    for (const columns of [40, 60, 100, 200]) {
      const wide = Math.max(60, Math.min(columns, 160));
      const lines = renderPageLines(DATA, { columns, version: '0.7.11', now: NOW });
      const over = lines.filter((line) => width(line) > wide);
      assert.deepEqual(over, [], `${columns} columns: ${over.join('\n')}`);
      assert.ok(lines.some((line) => /RUNNER/u.test(line)), `${columns} columns lost RUNNER`);
    }
  });

  it('colours only a terminal, and only when NO_COLOR is unset or empty', () => {
    assert.equal(colourFor({ isTTY: true }, {}), true);
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '' }), true);
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '1' }), false);
    // The convention is any non-empty value; `!== '1'` was the old bug.
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: 'true' }), false);
    assert.equal(colourFor({ isTTY: false }, {}), false);
    assert.equal(colourFor(undefined, {}), false);
    assert.equal(columnsFor({ columns: 12 }), 60);
    assert.equal(columnsFor({ columns: 400 }), 160);
    assert.equal(columnsFor({}), 100);
    const plain = renderPage(DATA, { columns: 100, colour: false, now: NOW });
    const painted = renderPage(DATA, { columns: 100, colour: true, now: NOW });
    assert.ok(!/\u001b\[/u.test(plain), 'a page that is not a terminal carries no escapes');
    assert.ok(/\u001b\[32m/u.test(painted), 'green is running');
  });

  it('--json is the object the renderer takes, one key per section', async () => {
    let out = '';
    const code = await page(['--json'], { collect: async () => DATA, stdout: { write: (s) => { out += s; } } });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(Object.keys(parsed), ['runner', 'sessions', 'next', 'intake', 'programmes', 'caches', 'notes']);
    assert.equal(parsed.programmes.programmes[0].projects[0].name, 'avatar-self-serve');
    assert.equal(parsed.next.runnable, 2);
    // Every field the section draws is in the object, lanes and all: the page
    // is rendered from `--json` alone and the two cannot say different things.
    assert.deepEqual(parsed.next.lanes.map((lane) => [lane.repo, lane.items.map((item) => `${item.name} ${item.kind} ${item.step}/${item.steps} ${item.title}`)]), [
      ['memoro-cli', ['mc-ui step 1/1 The page']],
      ['memoro', ['docx-editor step 2/2 Measure paste and IME']],
    ]);
    // Rendering the parsed JSON gives the same page: the two cannot drift.
    assert.equal(renderPage(parsed, { columns: 100, now: NOW }), renderPage(DATA, { columns: 100, now: NOW }));
  });
});

describe('collectPage', () => {
  /** A work root of real files — and no git, no gh, no tmux. */
  function workRootFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-'));
    mkdirSync(join(root, 'runner', 'log'), { recursive: true });
    writeFileSync(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: process.pid, started: '2026-08-29T10:00:00Z' }));
    writeFileSync(join(root, 'runner', 'current-memoro-cli.json'), JSON.stringify({
      name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
      started: '2026-08-29T11:40:00Z', pid: process.pid, worktree: `${root}/mc-ui/memoro-cli`,
    }));
    writeFileSync(join(root, 'runner', 'current-memoro.json'), JSON.stringify({
      name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus', budget_minutes: 90,
      started: '2026-08-29T11:50:00Z', pid: process.pid, worktree: `${root}/docx-editor/memoro`,
    }));
    mkdirSync(join(root, 'runner', 'foreground'), { recursive: true });
    writeFileSync(join(root, 'runner', 'foreground', `${process.pid}.json`), JSON.stringify({
      verb: 'brief', area: 'brief', tool: 'claude', model: 'opus', pid: process.pid, started: '2026-08-29T11:00:00Z',
    }));
    writeFileSync(join(root, 'runner', 'log', 'runs.tsv'), TSV);
    // What `mc deploy` wrote, and what the helper's last collect heard from
    // `/api/version` — the page's whole knowledge of production, both offline.
    writeFileSync(join(root, 'runner', 'log', 'deploys.tsv'), [
      'started\tended\tsha\tbuild\tholder\toutcome\tlive_commit\tlive_build\tstopped_at\tnote',
      '2026-08-29T09:40:00Z\t2026-08-29T10:00:00Z\t1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012\t813\tmartin@laptop\tdeployed\t1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012\t813\t\t',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'runner', 'version.json'), JSON.stringify({
      fetched: '2026-08-29T11:00:00Z',
      version: { commit: 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00', build: 23533, build_time: '2026-08-29T09:50:00Z' },
    }));
    writeFileSync(join(root, 'runner', 'held.json'), JSON.stringify([{
      project: 'docx-editor', repo: 'memoro', pr: 10958, branch: 'docx-editor',
      reason: 'two tests the change reaches are red', note: 'open,gate-red',
      since: '2026-08-29T09:10:00Z', repairs: 0,
    }]));
    writeFileSync(join(root, 'queue.md'), '# the queue\nmc-ui\ndocx-editor\n');
    mkdirSync(join(root, 'proposals'), { recursive: true });
    mkdirSync(join(root, 'intake'), { recursive: true });
    writeFileSync(join(root, 'intake', 'errors-2026-08-29.md'), '# Errors\n\n## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n');
    writeFileSync(join(root, 'proposals', '2026-08-29-one.md'), 'A proposal, with no heading — mc counts it either way.\n');
    for (const area of ['mc-ui', 'docx-editor']) mkdirSync(join(root, area, 'memoro-cli', '.git'), { recursive: true });
    return root;
  }

  it('builds every section from the files, offline, without git, gh or tmux', async () => {
    const root = workRootFixture();
    const asked = [];
    const gitArgs = [];
    const data = await collectPage({
      env: { MC_WORK_ROOT: root },
      now: NOW,
      repos: [],
      exec: async (cmd) => { asked.push(cmd); return { ok: false, stdout: '' }; },
      run: (cmd) => { asked.push(cmd); return { status: 1, stdout: '' }; },
      // The queue reading asks each queued workarea whether it is dirty, which
      // is the one thing on the page that has to ask git anything. Null is how
      // this git says it could not answer, and the reading then reads the
      // worktree as clean — the same thing the round does.
      git: (cwd, args) => { gitArgs.push(args.join(' ')); return null; },
      cache: {
        loadPlans: () => ({ plans: PLANS, sources: [{ repo: 'memoro-cli', sha: 'aaa', cached: true }] }),
        loadPrs: () => ({ prs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }], fetched: '2026-08-29T10:00:00Z', age_seconds: 7200 }),
        savePrs: () => { throw new Error('savePrs on the offline page'); },
      },
    });
    assert.deepEqual(asked, ['tmux'], 'the default page runs no fetch and no gh');
    assert.deepEqual(data.runner.steps.map((step) => step.name), ['docx-editor', 'mc-ui'],
      'one current-<repo>.json per lane, and the page reads every one of them');
    assert.equal(data.sessions.desks.brief.verb, 'brief');
    assert.equal(data.runner.day.steps, 3);
    // The row and the cached version, read from the files and nothing fetched.
    assert.equal(data.runner.production.short, '1a2b3c4');
    assert.equal(data.runner.production.live.short, 'b3e65b6');
    assert.equal(data.runner.production.differs, true);
    // Every non-legacy plan on main is in the walk — the two `queue.md` names
    // first, then the rest alphabetically — and the comment line is not a
    // project. The file used to be the whole section, which is why an empty one
    // said `empty` while the runner walked forty.
    assert.deepEqual(data.next.items.map((item) => item.name),
      ['mc-ui', 'docx-editor', 'avatar-self-serve', 'mc-run']);
    assert.equal(data.next.depth, 4);
    assert.equal(data.next.from_queue, 2, 'the comment line is not a project');
    // Both queued plans say `ready`, and #440 is open on mc-ui's branch — so
    // the runner would start one of the two, and the block says one. It said
    // two until the machine was read here, which is the defect this project is
    // about: a partial answer is read as the whole one.
    assert.equal(data.next.runnable, 1);
    assert.deepEqual(data.next.skipped.reasons, { 'in-flight': 1, blocked: 1, done: 1 });
    assert.deepEqual(data.next.lanes.map((lane) => [lane.repo, lane.items.map((item) => item.name)]),
      [['memoro', ['docx-editor']]]);
    assert.deepEqual([...new Set(gitArgs)], ['status --porcelain'],
      'the reading asks the worktree one read-only question and nothing else');
    // The runner's own file, read where the runner writes it: nobody has to
    // open runner.log to see which pull request is standing still.
    assert.deepEqual(data.next.held.items.map((item) => [item.project, item.pr, item.reason]),
      [['docx-editor', 10958, 'two tests the change reaches are red']]);
    assert.equal(data.intake.repos[0].new_errors, 1);
    assert.deepEqual(data.intake.repos[0].loud_lines, ['`abc` — 41x 500 — loud']);
    assert.equal(data.intake.proposals, 1);
    assert.deepEqual(data.programmes.programmes.flatMap((g) => g.projects).map((p) => p.name), ['avatar-self-serve', 'docx-editor', 'mc-run', 'mc-ui']);
    assert.equal(data.programmes.programmes.flatMap((g) => g.projects).find((p) => p.name === 'mc-ui').pr, 440);
    assert.equal(data.programmes.no_workarea, 2);
    assert.equal(data.caches.fresh, false);
    assert.equal(data.caches.prs.age_seconds, 7200);
    // The whole page renders from it without throwing.
    assert.match(renderPage(data, { columns: 100, now: NOW }), /PROGRAMMES {2}3 programmes · 4 projects/u);
  });

  it('--fresh fetches, asks GitHub and refills the PR cache', async () => {
    const root = workRootFixture();
    const asked = [];
    let saved = null;
    let fields = null;
    const data = await collectPage({
      env: { MC_WORK_ROOT: root },
      now: NOW,
      repos: [{ name: 'memoro-cli', path: process.cwd() }],
      fresh: true,
      exec: async (cmd, args) => {
        asked.push(`${cmd} ${args[0] === '-C' ? args[2] : args[0]}`);
        if (cmd === 'gh') fields = args[args.indexOf('--json') + 1];
        return { ok: true, stdout: cmd === 'gh' ? '[{"number":440,"headRefName":"mc-ui","baseRefName":"main","isDraft":false,"title":"The page"}]' : '' };
      },
      run: () => ({ status: 1, stdout: '' }),
      cache: {
        loadPlans: () => ({ plans: PLANS, sources: [{ repo: 'memoro-cli', sha: 'aaa', cached: false }] }),
        loadPrs: () => { throw new Error('loadPrs under --fresh'); },
        savePrs: ({ prs }) => { saved = prs; return { prs, fetched: '2026-08-29T12:00:00Z', age_seconds: 0 }; },
      },
    });
    assert.deepEqual(asked.sort(), ['gh pr', 'git fetch']);
    // The base and the draft flag ride along with the number: the round asks
    // the same question, and a stack is ordered by what each PR is based on.
    assert.equal(fields, 'number,headRefName,baseRefName,isDraft,title');
    assert.deepEqual(saved, [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui', baseRefName: 'main', isDraft: false, title: 'The page' }]);
    assert.equal(data.caches.fresh, true);
    assert.equal(data.programmes.programmes.flatMap((g) => g.projects).find((p) => p.name === 'mc-ui').pr, 440);
  });
});

/* ------------------------------------------------------------- the palette */

const NAMES = {
  0: 'reset', 1: 'bold', 2: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'grey',
};
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'gu');
const strip = (line) => line.replace(SGR, '');

/**
 * A row's colours in order — `bold grey` for a painted name followed by a
 * painted count. The palette is a table, and this is how a test reads one
 * row of it back without pinning the escape bytes themselves.
 *
 * Primary text carries no escape at all (it is the terminal's own foreground),
 * so it leaves no run here: a row's signature is what the page painted *on
 * top of* the text, and a cell that vanishes from a signature is a cell that
 * went back to being read rather than coloured.
 */
function signature(line) {
  const out = [];
  let run = [];
  for (const match of line.matchAll(SGR)) {
    const name = NAMES[Number(match[1])];
    if (name === 'reset') { if (run.length) out.push(run.join('+')); run = []; continue; }
    if (name) run.push(name);
  }
  return out.join(' ');
}

/** The one row whose text contains `text`, painted. */
function rowWith(lines, text) {
  const found = lines.filter((line) => strip(line).includes(text));
  assert.equal(found.length, 1, `one row saying "${text}", found ${found.length}`);
  return found[0];
}

const paintedPage = (data, over = {}) => renderPageLines(data, {
  columns: 120, colour: true, version: '0.7.11', now: NOW, ...over,
});

describe('the palette', () => {
  // One line of the page per row, and the colours it carries. The text beside
  // each is what that row says at 120 columns; the plain page below is the
  // same page with the escapes taken out again.
  //
  // A name with no run against it is not an unpainted row: it is a name drawn
  // in the terminal's own foreground, which is what primary text is here. Every
  // `white` and every `dim+grey` that used to be in this list went one of those
  // two ways — to nothing, or to plain `grey`.
  const SNAPSHOT = [
    '',
    'bold grey grey grey grey', //               MEMORO·CLI 0.7.11 ── 2 of 3 queued · ≈$7.28 today
    '',
    'bold+cyan grey grey grey grey yellow+bold grey', //            NEXT  2 runnable of 4 · 3 from queue.md, then alphabetical · held before merge 1   mc status <name>
    'bold grey grey', //                                             memoro-cli · 1 runnable
    'bold green', //                                                   mc-ui        step 1/1  The page
    'bold grey grey', //                                             memoro · 1 runnable
    'bold green', //                                                   docx-editor  step 2/2  Measure paste and IME
    'grey', //                                                       skipped 2 (done 1, blocked 1)
    'yellow+bold yellow', //                                         · docx-editor  #10958  two tests the change reaches are red
    '',
    'bold+cyan grey grey yellow grey', //                          INTAKE  1 digest · 1 proposal
    'bold grey green grey red', //                                         memoro · 2026-08-29 (60 min old) · 1 new error (1 loud)
    'red bold', //                                                 !  `abc` — 41x 500 — loud
    '',
    'bold+cyan grey green grey red grey grey grey', //          PROGRAMMES  3 programmes · 4 projects  ready 2 · done 1 · blocked 1
    'bold+cyan grey', //                                           assistant-avatar   ·  no plan session
    'grey grey grey red grey grey blue', //                      1 · avatar-self-serve  memoro  blocked  0/1  …  triage
    'bold+cyan grey', //                                           docx-editing-surface   ·  no plan session
    'grey grey grey green grey grey green', //                   2 · docx-editor  memoro  ready  0/1  …  step
    'bold+cyan grey', //                                           mc   ·  no plan session
    'grey grey grey grey grey', //                               3 · mc-run  memoro-cli  done  1/1  nothing
    'grey grey grey green grey cyan', //                         4 · mc-ui  memoro-cli  ready  0/1  Step 1, …  #440
    'grey', //                                                       3 of them have no workarea yet
    '',
    'bold+cyan grey grey', //                                      WORK  1 session · 1 workarea with no project
    'yellow bold cyan grey grey grey grey', //                  ◆ docx-editor  tmux · open 60 min · mc-docx-editor
    '',
    'grey grey grey grey grey', //                                   5 · ui-fixes  —  no project on main
    '',
    'bold+cyan grey', //                                          RUNNER                                mc run
    'green bold green grey grey grey grey grey', //             ● mc-ui  step · claude opus · 20 min of 90 min · pid 4242
    'red+bold grey', //                                          ■ STOP requested — the runner exits after the steps it is in
    'grey', //                                                     runner up 120 min · 3 steps in 24 h — …
    '',
    'bold+cyan cyan grey grey grey grey grey grey', //            HELPER  ● open 60 min · claude sonnet · pid 99   mc helper
    'bold+cyan grey grey', //                                     BRIEF  ·  not open                                mc brief
    '',
    'grey', //                                                     offline, PRs 2 h old — --fresh asks GitHub
    'grey', //                                                     note: no queue.md
  ];

  it('paints nothing with the dim attribute, anywhere on the page', () => {
    // The palette's own floor: `ESC[2m` sat at or below the background on
    // Martin's terminal, so a row that carried it was a row nobody could read.
    for (const [index, line] of paintedPage(DATA).entries()) {
      assert.ok(!signature(line).split(' ').some((run) => run.split('+').includes('dim')),
        `row ${index} is drawn dim: ${strip(line)}`);
      assert.ok(!signature(line).split(' ').some((run) => run.split('+').includes('white')),
        `row ${index} is drawn in ESC[37m rather than the terminal's foreground: ${strip(line)}`);
    }
  });

  it('paints every row of the page, and the same colour for the same meaning', () => {
    assert.deepEqual(paintedPage(DATA).map(signature), SNAPSHOT);
  });

  it('adds every escape outside the width: a coloured row is as wide as its plain twin', () => {
    for (const columns of [60, 80, 100, 120, 160]) {
      const wide = Math.max(60, Math.min(columns, 160));
      const plain = renderPageLines(DATA, { columns, version: '0.7.11', now: NOW });
      const painted = paintedPage(DATA, { columns });
      assert.equal(painted.length, plain.length, `${columns} columns: a different number of rows`);
      for (const [index, line] of painted.entries()) {
        assert.equal(strip(line), plain[index], `${columns} columns, row ${index}: the text moved`);
        assert.equal(width(line), width(plain[index]), `${columns} columns, row ${index}: a different width`);
        assert.ok(width(line) <= wide, `${columns} columns, row ${index}: over the margin`);
        // No clip ever cut an escape in half: every ESC still starts a whole
        // SGR sequence.
        const halves = line.split(ESC).slice(1).filter((part) => !/^\[[0-9;]*m/u.test(part));
        assert.deepEqual(halves, [], `${columns} columns, row ${index}: a cut escape`);
      }
    }
  });

  it('leaves the plain page exactly as it was: NO_COLOR and a pipe carry no escapes', () => {
    const plain = renderPage(DATA, { columns: 120, version: '0.7.11', now: NOW });
    assert.ok(!plain.includes(ESC), 'a page that is not a terminal carries no escapes');
    // What `NO_COLOR=1 mc` prints is the plain render, decided before a single
    // escape is chosen.
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '1' }), false);
    assert.equal(renderPage(DATA, {
      columns: 120, version: '0.7.11', now: NOW, colour: colourFor({ isTTY: true }, { NO_COLOR: '1' }),
    }), plain);
  });

  it('--json carries no colour, terminal or not', async () => {
    let out = '';
    const code = await page(['--json'], {
      collect: async () => DATA,
      stdout: { isTTY: true, columns: 120, write: (s) => { out += s; } },
      env: {},
    });
    assert.equal(code, 0);
    assert.ok(!out.includes(ESC), '--json is bytes for a program, never for an eye');
    assert.deepEqual(Object.keys(JSON.parse(out)), ['runner', 'sessions', 'next', 'intake', 'programmes', 'caches', 'notes']);
  });

  it('gives a step kind one colour wherever a kind is printed', () => {
    for (const [kind, tone] of [['step', 'green'], ['triage', 'blue'], ['brief', 'cyan'], ['plan', 'cyan']]) {
      const data = pageData({
        runner: runnerSection({
          runner: { pid: 4242, started: '2026-08-29T11:00:00Z' },
          currents: [{
            name: 'thing', kind, repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
            started: '2026-08-29T11:40:00Z', pid: 4242,
          }],
          now: NOW,
          alive: live,
        }),
        next: {
          depth: 1,
          from_queue: 0,
          runnable: 1,
          items: [],
          lanes: [{ repo: 'memoro-cli', count: 1, more: 0, items: [{ name: 'thing', kind, step: 1, steps: 2, title: 'carry on' }] }],
          more: 0,
          skipped: { count: 0, reasons: {} },
        },
        programmes: programmesSection({
          plans: [{ repo: 'memoro-cli', programme: 'mc', project: 'thing', status: 'ready', next: 'go on' }],
          areas: [{ name: 'thing', mtime_ms: 1 }],
          rows: [{ ts: '2026-08-29T10:00:00Z', name: 'thing', kind, pr: '-', note: '' }],
        }),
      });
      const lines = paintedPage(data);
      const now = signature(rowWith(lines, `● thing  `)).split(' ');
      assert.equal(now[2], tone, `NOW says ${kind} in ${now[2]}`);
      assert.equal(signature(rowWith(lines, `${kind} 1/2`)).split(' ').at(-1), tone, `NEXT says ${kind} in its colour`);
      assert.equal(signature(rowWith(lines, 'go on')).split(' ').at(-1), tone, `PROJECTS says ${kind} in its colour`);
    }
  });

  it('gives a plan status one colour wherever a status is printed', () => {
    const plans = [
      { repo: 'memoro-cli', programme: 'mc', project: 'a-ready', status: 'ready', next: 'one' },
      { repo: 'memoro-cli', programme: 'mc', project: 'b-blocked', status: 'blocked', next: 'two' },
      { repo: 'memoro-cli', programme: 'mc', project: 'd-done', status: 'done', next: 'four' },
    ];
    const data = pageData({
      programmes: programmesSection({ plans, areas: plans.map((plan, n) => ({ name: plan.project, mtime_ms: 100 - n })).concat([{ name: 'e-none', mtime_ms: 0 }]) }),
    });
    const lines = paintedPage(data);
    // Index 3: the number, the mark, the repository, then the status. The name
    // between the mark and the repository is the terminal's own foreground and
    // paints no run of its own.
    for (const [name, tone] of [['a-ready', 'green'], ['b-blocked', 'red'], ['d-done', 'grey']]) {
      assert.equal(signature(rowWith(lines, name)).split(' ')[3], tone, `${name} is ${tone}`);
    }
    // A workarea no project explains is grey through and through — the number,
    // the mark, the name, the repository and the middle, one grey each.
    assert.deepEqual(signature(rowWith(lines, 'e-none')).split(' '), ['grey', 'grey', 'grey', 'grey', 'grey']);
  });

  it('turns the clock yellow near the budget and red past it', () => {
    const stepAt = (spent) => pageData({
      runner: runnerSection({
        runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
        currents: [{
          name: 'thing', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
          started: new Date(NOW.getTime() - spent * 1000).toISOString(), pid: 4242,
        }],
        now: NOW,
        alive: live,
      }),
    });
    const clock = (spent) => signature(rowWith(paintedPage(stepAt(spent)), '● thing')).split(' ');
    // Inside its budget the clock carries no colour of its own — it is text to
    // read — so it leaves no run at all, and the row is the eight runs around
    // it: the mark, the name, the kind, and the greys of the separators, the
    // tool and the pid. Once it turns, it is a ninth run at index 6.
    const QUIET = ['green', 'bold', 'green', 'grey', 'grey', 'grey', 'grey', 'grey'];
    assert.deepEqual(clock(600), QUIET, 'ten minutes in, the clock is just a clock');
    assert.deepEqual(clock(0.74 * 5400), QUIET);
    assert.equal(clock(0.8 * 5400)[6], 'yellow', 'past three quarters of the budget');
    assert.equal(clock(5401)[6], 'red+bold', 'over budget');
    assert.ok(strip(rowWith(paintedPage(stepAt(5401)), '● thing')).includes('over budget'));
  });

  it('says a quota answer in yellow while it is recent, and in grey once it is history', () => {
    const quota = (last) => {
      const rows = [{
        ts: last, name: 'thing', kind: 'step', exit: '1', seconds: '10', pr: '-', note: 'quota,timeout',
      }];
      const lines = paintedPage(pageData({ runner: runnerSection({ rows, now: NOW, alive: () => false }) }));
      return signature(rowWith(lines, 'quota: 1 answer(s)'));
    };
    assert.equal(quota('2026-08-29T11:00:00Z'), 'yellow', 'an hour ago is why the runner is idle');
    assert.equal(quota('2026-08-29T02:00:00Z'), 'grey', 'ten hours ago is history');
  });

  it('paints a session in the cyan the verbs are printed in', () => {
    const data = pageData({
      sessions: sessionsSection({
        foreground: [{ verb: 'work', area: 'red', tool: 'claude', model: 'opus', pid: 99, started: '2026-08-29T11:00:00Z' }],
        now: NOW,
        alive: live,
      }),
    });
    assert.deepEqual(signature(rowWith(paintedPage(data), '● red')).split(' ').slice(0, 3), ['cyan', 'bold', 'cyan']);
  });

  // The two tables in `docs/technical/mc-ui.md` are the palette written down;
  // a colour changed in one place and not the other is a doc that lies, which
  // is worse than no doc at all.
  it('says the same colours in docs/technical/mc-ui.md as page-render.js does', () => {
    const source = readFileSync(new URL('../../src/mc/page-render.js', import.meta.url), 'utf8');
    const doc = readFileSync(new URL('../../docs/technical/mc-ui.md', import.meta.url), 'utf8');
    const inCode = (name) => Object.fromEntries(
      [...new RegExp(`const ${name} = \\{([^}]*)\\}`, 'u').exec(source)[1]
        .matchAll(/'?([\w-]+)'?:\s*\[([^\]]*)\]/gu)]
        .map(([, key, styles]) => [key, styles.split(',').map((s) => s.trim().replace(/'/gu, '')).join(' ')]),
    );
    const inDoc = (heading) => Object.fromEntries(
      [...new RegExp(`\\| ${heading} \\| colour \\|\\n\\|---\\|---\\|\\n([\\s\\S]*?)\\n\\n`, 'u').exec(doc)[1]
        .matchAll(/^\| `([\w-]+)` \| (.+?) \|$/gmu)].map(([, key, tone]) => [key, tone]),
    );
    assert.deepEqual(inDoc('step kind'), inCode('KIND_TONE'), 'the doc names another colour for a step kind');
    assert.deepEqual(inDoc('plan status'), inCode('STATUS_TONE'), 'the doc names another colour for a plan status');
    // The two fallbacks are rows of their own in the doc, and they are the
    // colours `kindTone` and `statusTone` reach for when the table has no key.
    assert.ok(/\| anything else \| grey \|/u.test(doc));
    assert.ok(/\| no plan on main \| grey \|/u.test(doc));
    // And no row of any table in the document names a colour the page has
    // stopped drawing. The prose above them may still explain what `dim grey`
    // and `white` were; a table row saying so would be a table that lies.
    for (const line of doc.split('\n').filter((l) => l.startsWith('|'))) {
      assert.ok(!/\b(dim|white)\b/u.test(line), `a palette row still says dim or white: ${line}`);
    }
    assert.deepEqual(signature(rowWith(paintedPage(pageData({
      programmes: programmesSection({
        plans: [],
        areas: [{ name: 'unplanned', mtime_ms: 1 }],
        rows: [{ ts: '2026-08-29T10:00:00Z', name: 'unplanned', kind: 'rebase', pr: '-', note: '' }],
      }),
    })), 'unplanned')).split(' '), ['grey', 'grey', 'grey', 'grey', 'grey'],
    'a folder no project explains is the page at its quietest');
  });

  it('says nothing about a watch in the header — there is none', () => {
    assert.ok(!strip(paintedPage(DATA)[1]).includes('watch'));
  });
});
