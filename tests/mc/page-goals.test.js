/**
 * Goals on the page (Martin, 2026-11-01): drawn under their programme after the
 * project rows, in the project rows' columns, numbered after the projects, and
 * counted in the programme's heading only when there are any.
 *
 * The rows come from `programmesSection` with `goalRows` — the shape `goalsOf`
 * gives — so the page is the real builder and the fixture is the real shape.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  goalsOf, intakeSection, mergesSection, nextSection, programmesSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-01T12:00:00Z');

/** The page's sections around PROGRAMMES, empty — as page.test.js builds them. */
function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    next: nextSection({ plans: [] }),
    merges: mergesSection({}),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({ areas: [], plans: [] }),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

const PLANS = [
  { repo: 'memoro-cli', programme: 'mc', project: 'mc-ui', status: 'ready', next: 'a' },
  { repo: 'memoro-cli', programme: 'mc', project: 'mc-run', status: 'ready', next: 'b' },
  { repo: 'memoro', programme: 'docx-editing-surface', project: 'docx-editor', status: 'ready', next: 'c' },
];

/** Two goals under `mc`: one a session is on, one blocked on Martin. */
const GOALS = [
  {
    name: 'rollout', programme: 'mc', repos: ['memoro-cli', 'memoro'], stage: 'build', status: 'ready', sessions: 3,
    last: { next: 'the second repository', comment: null }, running: true, problems: [],
  },
  {
    name: 'cleanup', programme: 'mc', repos: ['memoro-cli'], stage: 'build', status: 'blocked', sessions: 1,
    last: { next: null, comment: 'waits on Martin' }, running: false, problems: [],
  },
];

/** A line without its colour codes, for finding it by its words. */
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');

/** The PROGRAMMES section's lines, from its heading to the end of the page. */
function programmesOf(lines) {
  const head = lines.findIndex((line) => plain(line).startsWith('  PROGRAMMES'));
  assert.ok(head >= 0, 'PROGRAMMES is drawn');
  return lines.slice(head);
}

describe('goal rows on the page', () => {
  it('goal rows are drawn under their programme after the project rows', () => {
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: GOALS, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW }));
    const at = (re) => lines.findIndex((line) => re.test(line));

    // Projects are numbered first, in programme then name order; the goals take
    // the numbers after them, in name order — docx-editor is 1, and the mc goals 4 and 5.
    assert.ok(at(/^ +1 · docx-editor /u) >= 0, 'docx-editor is row 1');
    const mcHeading = at(/^ {2}mc\s/u);
    const mcRun = at(/^ +2 · mc-run /u);
    const mcUi = at(/^ +3 · mc-ui /u);
    const cleanup = at(/^ +4 · g · cleanup\s+memoro-cli\s+build · blocked\s+1 session\s+waits on Martin$/u);
    const rollout = at(/^ +5 ● g · rollout\s+memoro-cli\s+build · ready\s+3 sessions\s+the second repository$/u);
    assert.ok(mcHeading < mcRun && mcRun < mcUi, 'the projects are under their programme\'s heading');
    assert.ok(mcUi < cleanup, 'the goals come after the project rows of their programme');
    assert.equal(rollout, cleanup + 1, 'rollout is drawn after cleanup, in name order');
  });

  it('a goal row says criteria 1/2 for a goal with one of two criteria met, green once all are', () => {
    const rows = [{ ...GOALS[1], criteria: { met: 1, all: 2 } }, { ...GOALS[0], criteria: { met: 2, all: 2 } }];
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: rows, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW }));
    assert.ok(lines.some((line) => /^ +4 · g · cleanup\s+memoro-cli\s+build · blocked\s+1 session\s+criteria 1\/2 waits on Martin$/u.test(line)), lines.join('\n'));
    const painted = programmesOf(renderPageLines(data, { columns: 120, now: NOW, colour: true }));
    assert.match(painted.find((line) => line.includes('g · rollout')), /\u001b\[[0-9;]*32mcriteria 2\/2/u);
    assert.doesNotMatch(painted.find((line) => line.includes('g · cleanup')), /\u001b\[[0-9;]*32mcriteria/u);
  });

  it('the state words keep the project rows\' colours', () => {
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: GOALS, now: NOW }) });
    const painted = programmesOf(renderPageLines(data, { columns: 120, now: NOW, colour: true }));
    const rollout = painted.find((line) => line.includes('g · rollout'));
    const cleanup = painted.find((line) => line.includes('g · cleanup'));
    // green for `build` while a session is on it, red for any stage `· blocked`
    assert.match(rollout, /\u001b\[[0-9;]*32m\s*build · ready/u);
    assert.match(cleanup, /\u001b\[[0-9;]*31m\s*build · blocked/u);
  });

  it('a done or dropped goal\'s tail is its last Gjort, never a Nästa that is over', () => {
    const finished = [
      { name: 'landed', programme: 'mc', repos: ['memoro-cli'], stage: 'done', status: 'ready', sessions: 2, last: { done: 'landed #1235 as 60e9f82', next: 'Merge #1235', comment: null }, running: false, problems: [] },
      { name: 'letgo', programme: 'mc', repos: ['memoro-cli'], stage: 'dropped', status: 'ready', sessions: 0, last: { done: null, next: 'build it', comment: 'wrong goal' }, running: false, problems: [] },
    ];
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: finished, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 160, now: NOW })).map(plain);
    const landed = lines.find((line) => line.includes('g · landed'));
    const letgo = lines.find((line) => line.includes('g · letgo'));
    assert.match(landed, /landed #1235 as 60e9f82$/u);
    assert.doesNotMatch(landed, /Merge #1235/u);
    assert.match(letgo, /dropped · ready .*wrong goal$/u);
  });

  it('a goal that does not parse is drawn with its problem', () => {
    const broken = [{
      name: 'broken', programme: 'mc', repos: [], status: null, sessions: 0, last: null, running: false,
      problems: ['repos names no repository'],
    }];
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: broken, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 130, now: NOW, colour: true }));
    const row = lines.find((line) => line.includes('g · broken'));
    assert.ok(row, 'the broken goal is drawn');
    // The problem is drawn in full where it fits; a longer one is cut to the width.
    assert.match(plain(row), /GOAL\.json: repos names no repository$/u);
    assert.match(row, /\u001b\[[0-9;]*31m GOAL\.json|\u001b\[[0-9;]*31mGOAL\.json/u, 'the problem is red');
  });

  it('the programme header counts goals only when there are any', () => {
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: GOALS, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW }));
    const mcHeading = lines.find((line) => /^ {2}mc\s/u.test(line));
    const docxHeading = lines.find((line) => /^ {2}docx-editing-surface\s/u.test(line));
    assert.match(mcHeading, /· 2 goals/u);
    assert.doesNotMatch(docxHeading, /goal/u, 'a programme with no goals says nothing of them');

    const none = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], now: NOW }) });
    assert.doesNotMatch(programmesOf(renderPageLines(none, { columns: 120, now: NOW })).join('\n'), /goal/u);
  });

  it('no row is wider than the terminal, at 80 and at 120 columns', () => {
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: GOALS, now: NOW }) });
    for (const columns of [80, 120]) {
      const lines = programmesOf(renderPageLines(data, { columns, now: NOW }));
      const wide = lines.filter((line) => width(line) > columns);
      assert.deepEqual(wide, [], `at ${columns} columns`);
    }
  });
});

describe('goalsOf — what the page reads of a goal', () => {
  const log = [
    { at: '2026-11-01T10:00Z', tool: 'person', model: null, stage: 'build', status: 'ready', done: 'skapat', comment: null, next: null },
    { at: '2026-11-01T11:00Z', tool: 'claude-code', model: 'opus', stage: 'build', status: 'ready', done: 'x', comment: null, next: 'the next thing' },
    { at: '2026-11-01T11:30Z', tool: 'runner', model: null, stage: 'build', status: 'ready', done: null, comment: 'a runner note', next: null },
  ];

  it('counts the sessions, takes the last entry, and is running only while a live current file names it', () => {
    const rows = goalsOf({
      goals: [
        { programme: 'mc', goal: 'rollout', repos: ['memoro-cli'], stage: 'build', status: 'ready', log, problems: [], success_criteria: [{ met: true }, { met: false }] },
        { programme: 'mc', goal: 'cleanup', repos: ['memoro-cli'], stage: 'build', status: 'ready', log, problems: [] },
      ],
      currents: [
        { name: 'goal:mc/rollout', pid: 7 },
        { name: 'goal:mc/cleanup', pid: 8 },
      ],
      alive: (pid) => pid === 7,
    });
    const [rollout, cleanup] = rows;
    assert.equal(rollout.name, 'rollout');
    assert.equal(rollout.sessions, 1, 'the person and the runner are not sessions');
    assert.equal(rollout.last.next, null, 'the last entry is the runner\'s');
    assert.equal(rollout.running, true);
    assert.deepEqual(rollout.criteria, { met: 1, all: 2 }, 'how many of its criteria are met, of how many');
    assert.equal(cleanup.running, false, 'a current file whose process is gone is not a session');
  });
});

describe('a goal\'s stage and status on the page, and one waiting on a person', () => {
  it('goalsOf gives the stage and the status, and marks a blocked goal, in any stage, as waiting on a person with the last entry\'s comment', () => {
    const asked = { at: '2026-11-01T11:00Z', tool: 'claude', model: 'opus', stage: 'build', status: 'blocked', done: null, comment: 'which table?', next: null };
    const died = { at: '2026-11-01T11:00Z', tool: 'runner', model: null, stage: 'review', status: 'blocked', done: null, comment: 'the review ended with the goal still in review, a second time — waits on a person', next: null };
    const [byQuestion, byRunner, judged] = goalsOf({
      goals: [
        { programme: 'mc', goal: 'asked', repos: ['memoro-cli'], stage: 'build', status: 'blocked', log: [asked], problems: [] },
        { programme: 'mc', goal: 'died', repos: ['memoro-cli'], stage: 'review', status: 'blocked', log: [died], problems: [] },
        { programme: 'mc', goal: 'judged', repos: ['memoro-cli'], stage: 'merging', status: 'ready', log: [], problems: [] },
      ],
    });
    assert.deepEqual([byQuestion.stage, byQuestion.status, byQuestion.person, byQuestion.question], ['build', 'blocked', true, 'which table?']);
    assert.deepEqual([byRunner.person, byRunner.question], [true, died.comment]);
    assert.deepEqual([judged.stage, judged.status, judged.person, judged.question], ['merging', 'ready', false, null]);
    assert.equal('plan' in judged, false, 'nothing waits on plan any more');
  });

  it('the page draws review and merging green, and a blocked goal in the colour of what waits on a person', () => {
    const rows = [
      { name: 'judged', programme: 'mc', repos: ['memoro-cli'], stage: 'review', status: 'ready', sessions: 2, last: { next: null, comment: null }, running: false, problems: [] },
      { name: 'landing', programme: 'mc', repos: ['memoro-cli'], stage: 'merging', status: 'ready', sessions: 2, last: { next: null, comment: null }, running: false, problems: [] },
      { name: 'stuck', programme: 'mc', repos: ['memoro-cli'], stage: 'finish', status: 'blocked', sessions: 2, last: { next: null, comment: 'split it?' }, running: false, person: true, question: 'split the goal in two?', problems: [] },
    ];
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: rows, now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 140, now: NOW, colour: true }));
    const line = (name) => lines.find((one) => plain(one).includes(`g · ${name}`));
    assert.match(line('judged'), /\u001b\[32mreview · ready/u, 'review is green');
    assert.match(line('landing'), /\u001b\[32mmerging · ready/u, 'merging is green');
    assert.match(plain(line('stuck')), /finish · blocked .*waits on a person · split the goal in two\?/u);
    assert.match(line('stuck'), /\u001b\[31mwaits on a person/u, 'waits on a person is red');
  });
});

describe('a goal in a phase its programme has not reached', () => {
  const goals = [
    { programme: 'mc', goal: 'landed', repos: ['memoro-cli'], stage: 'done', status: 'ready', phase: 1, log: [], problems: [] },
    { programme: 'mc', goal: 'runner-sessions', repos: ['memoro-cli'], stage: 'build', status: 'ready', phase: 2, log: [], problems: [] },
    { programme: 'mc', goal: 'headless-plan', repos: ['memoro-cli'], stage: 'plan', status: 'ready', phase: 3, log: [], problems: [] },
  ];

  it('goalsOf gives its phase and whether it is held, and the page JSON carries both', () => {
    const rows = goalsOf({ goals });
    const row = rows.find((each) => each.name === 'headless-plan');
    assert.deepEqual([row.stage, row.status], ['plan', 'ready'], 'it keeps its stage');
    assert.equal(row.phase, 3);
    assert.equal(row.held, true);
    assert.equal(rows.find((each) => each.name === 'runner-sessions').held, false, 'the phase in progress is not held');

    const section = programmesSection({ plans: PLANS, areas: [], goalRows: rows, now: NOW });
    const json = JSON.parse(JSON.stringify(section));
    const listed = json.programmes.flatMap((group) => group.goals ?? []).find((goal) => goal.name === 'headless-plan');
    assert.equal(listed.phase, 3);
    assert.equal(listed.held, true);
    assert.deepEqual([listed.stage, listed.status], ['plan', 'ready'], 'mc --json carries stage and status');
  });

  it('the page leads its tail with the phase it waits on, in the projects\' waiting colour', () => {
    const data = pageData({ programmes: programmesSection({ plans: PLANS, areas: [], goalRows: goalsOf({ goals }), now: NOW }) });
    const lines = programmesOf(renderPageLines(data, { columns: 160, now: NOW, colour: true }));
    const row = lines.find((line) => plain(line).includes('g · headless-plan'));
    assert.match(plain(row), /plan · ready .*phase 3 — after phase 2$/u);
    assert.match(row, /\u001b\[33mphase 3 — after phase 2/u, 'yellow');
  });
});
