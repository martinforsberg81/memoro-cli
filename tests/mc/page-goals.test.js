/** Programme goals retain their phase order, stable numbers, blockers and PR children. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachPrs, goalsOf, intakeSection, mergesSection, programmesSection, prsSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-01T12:00:00Z');

/** The page's sections around PROGRAMMES, empty — as page.test.js builds them. */
function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    merges: mergesSection({}),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({}),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/** A programme with no goal: a directory on main, drawn when expanded. */
const PROGRAMMES = ['docx-editing-surface'];

/**
 * A goal row as `goalsOf` gives it: the grid's fields — `kind`, `repo`,
 * `state`, `progress`, `prs` — beside the goal's own.
 */
function goalRow(goal) {
  return {
    kind: 'goal',
    repo: goal.repos?.[0] ?? null,
    state: goal.stage,
    progress: `${goal.sessions} sess`,
    prs: [],
    ...goal,
  };
}

/** Two goals under `mc`: one a session is on, one blocked on Martin. */
const GOALS = [
  {
    name: 'rollout', programme: 'mc', repos: ['memoro-cli', 'memoro'], stage: 'build', status: 'ready', sessions: 3,
    last: { next: 'the second repository', comment: null }, running: true, problems: [],
  },
  {
    name: 'cleanup', programme: 'mc', repos: ['memoro-cli'], stage: 'build', status: 'Martin', sessions: 1,
    last: { next: null, comment: 'waits on Martin' }, running: false, problems: [],
  },
].map(goalRow);

/** A line without its colour codes, for finding it by its words. */
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');

/** The goal row named `name`, found by its kind and its name. */
const goalLineOf = (lines, name) => lines.find((line) => new RegExp(`^ +\\d+ ${name}(?: |$)`, 'u').test(plain(line)));

/** The PROGRAMMES section's lines, from its heading to the end of the page. */
function programmesOf(lines) {
  const head = lines.findIndex((line) => plain(line).startsWith('  PROGRAMMES'));
  assert.ok(head >= 0, 'PROGRAMMES is drawn');
  return lines.slice(head);
}

describe('goal rows on the page', () => {
  it('keeps merge goals in the programme with PR states and excludes the active PR from the full queue', () => {
    const goal = { goal: 'ship', programme: 'mc', dir: '/goals/ship', repos: ['memoro-cli'],
      stage: 'merge', status: 'ready', log: [], prs: [31, 32, 33].map((pr) => ({ repo: 'memoro-cli', pr })) };
    const queued = [
      { repo: 'memoro-cli', pr: 31, state: 'landing', merger: 4242, started: '2026-11-01T11:59:00Z',
        goal: { programme: 'mc', goal: 'ship', dir: '/goals/ship' } },
      { repo: 'memoro-cli', pr: 32, state: 'queued' },
    ];
    const merges = mergesSection({ goals: [goal], queued, now: NOW, alive: (pid) => pid === 4242 });
    const programmes = programmesSection({ goalRows: [goalRow({ ...goal, name: 'ship', carries: goal.prs, problems: [] })] });
    const pulls = prsSection({ prs: [], merges, now: NOW });
    const runner = runnerSection({ rows: [], now: NOW });
    attachPrs({ programmes, runner, pulls });
    assert.deepEqual(merges.landings.map((item) => item.pr), [31]);
    assert.deepEqual(merges.queued.items.map((item) => item.pr), [32, 33]);
    for (const columns of [60, 80, 120]) {
      const text = renderPageLines(pageData({ merges, programmes, runner }), { columns, now: NOW }).join('\n');
      const programme = text.slice(0, text.indexOf('MERGE & DEPLOY'));
      assert.match(programme, /stage merge · status ready/u);
      assert.match(programme, /memoro-cli#31 · merging/u);
      assert.match(programme, /memoro-cli#32 · in queue/u);
      assert.match(programme, /memoro-cli#33 · in queue/u);
      assert.doesNotMatch(programme, /╭|REVIEW|BUILD/u);
      assert.match(text, /Queue: #32 #33/u);
      assert.match(text, /merging #31/u);
    }
    const dead = mergesSection({ goals: [goal], queued, now: NOW, alive: () => false });
    assert.deepEqual(dead.landings, []);
    assert.deepEqual(dead.queued.items.map((item) => item.pr), [31, 32, 33]);
  });

  it('goal rows are drawn under their programme and phase, with menu numbers', () => {
    const data = pageData({ programmes: programmesSection({ goalRows: GOALS, programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW }));
    const at = (re) => lines.findIndex((line) => re.test(line));


    const mcHeading = at(/^ {2}┌─ mc(?: |$)/u);
    const cleanup = at(/^ +1 cleanup$/u);
    const rollout = at(/^ +2 rollout$/u);
    assert.ok(mcHeading >= 0 && mcHeading < cleanup, 'the goals are under their programme\'s heading');
    assert.equal(rollout, cleanup + 4, 'rollout is drawn after cleanup, in name order');
  });

  it('shows criteria met/total beside each goal in both views', () => {
    const rows = [{ ...GOALS[1], criteria: { met: 1, all: 2 } }, { ...GOALS[0], criteria: { met: 2, all: 2 } }];
    const data = pageData({ programmes: programmesSection({ goalRows: rows, programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW }));
    for (const [name, count] of [['cleanup', '1/2'], ['rollout', '2/2']]) {
      const at = lines.indexOf(goalLineOf(lines, name));
      assert.ok(at >= 0);
      assert.ok(lines[at + 1].endsWith(`criteria ${count}`));
    }
    assert.doesNotMatch(lines.join('\n'), /the second repository/u);
    const expanded = programmesOf(renderPageLines(data, { columns: 120, now: NOW, expand: true }));
    assert.ok(expanded.some((line) => /the second repository$/u.test(line)));
    for (const [name, count] of [['cleanup', '1/2'], ['rollout', '2/2']]) {
      assert.ok(expanded[expanded.indexOf(goalLineOf(expanded, name)) + 1].endsWith(`criteria ${count}`));
    }
    assert.deepEqual(data.programmes.programmes.find((group) => group.programme === 'mc').goals[0].criteria, { met: 1, all: 2 });
  });

  it('the state words keep their colours', () => {
    const data = pageData({ programmes: programmesSection({ goalRows: GOALS, programmes: PROGRAMMES }) });
    const painted = programmesOf(renderPageLines(data, { columns: 120, now: NOW, colour: true }));
    const rollout = painted[painted.indexOf(goalLineOf(painted, 'rollout')) + 1];
    const cleanup = painted[painted.indexOf(goalLineOf(painted, 'cleanup')) + 1];
    // Status stays canonical even while a session is running.
    assert.match(rollout, /\u001b\[[0-9;]*32mready/u);
    assert.doesNotMatch(plain(rollout), /g · /u, 'no `g ·` before the name');
    assert.match(plain(goalLineOf(painted, 'rollout')), /^ +2 rollout/u);
    assert.match(cleanup, /\u001b\[[0-9;]*31mMartin/u);
  });

  it('a done or dropped goal\'s tail is its last Gjort, never a Nästa that is over', () => {
    const finished = [
      { name: 'landed', programme: 'mc', repos: ['memoro-cli'], stage: 'done', status: 'ready', sessions: 2, last: { done: 'landed #1235 as 60e9f82', next: 'Merge #1235', comment: null }, running: false, problems: [] },
      { name: 'letgo', programme: 'mc', repos: ['memoro-cli'], stage: 'dropped', status: 'ready', sessions: 0, last: { done: null, next: 'build it', comment: 'wrong goal' }, running: false, problems: [] },
    ];
    const data = pageData({ programmes: programmesSection({ goalRows: finished.map(goalRow), programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 160, now: NOW, expand: true })).map(plain);
    const landed = goalLineOf(lines, 'landed');
    assert.ok(lines.some((line) => /landed #1235 as 60e9f82$/u.test(line)));
    assert.doesNotMatch(landed, /Merge #1235/u);
    assert.ok(lines.some((line) => /stage dropped · status ready/u.test(line)));
    assert.ok(lines.some((line) => /wrong goal$/u.test(line)));
    const painted = programmesOf(renderPageLines(data, { columns: 160, now: NOW, colour: true, expand: true }));
    for (const name of ['landed', 'letgo']) {
      const codes = [...goalLineOf(painted, name).matchAll(/\u001b\[(\d+)m/gu)].map((match) => match[1]);
      assert.ok(!goalLineOf(painted, name).includes(`\u001b[90m${name}\u001b[0m`), 'the name keeps the readable terminal foreground');
      assert.ok(codes.every((code) => ['37', '0'].includes(code)), 'finished state and metadata remain quiet');
    }

  });

  it('a goal that does not parse is drawn with its problem', () => {
    const broken = [{
      name: 'broken', programme: 'mc', repos: [], status: null, sessions: 0, last: null, running: false,
      problems: ['repos names no repository'],
    }];
    const data = pageData({ programmes: programmesSection({ goalRows: broken.map(goalRow), programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW, colour: true }));
    const row = goalLineOf(lines, 'broken');
    assert.ok(row, 'the broken goal is drawn');
    // The problem is drawn in full where it fits; a longer one is cut to the width.
    assert.ok(lines.some((line) => /GOAL\.json: repos names no repository$/u.test(plain(line))));
    assert.ok(lines.some((line) => /\u001b\[[0-9;]*31mGOAL\.json/u.test(line)), 'the problem is red');
  });

  it('the programme header counts its goals, or says it has none yet', () => {
    const data = pageData({ programmes: programmesSection({ goalRows: GOALS, programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW, expand: true }));
    const mcHeading = lines.find((line) => /^ {2}┌─ mc(?: |$)/u.test(line));
    const docxHeading = lines.find((line) => /^ {2}┌─ docx-editing-surface\s/u.test(line));
    assert.match(mcHeading, /2 goals/u);
    assert.match(docxHeading, /0 goals/u, 'a programme with no goal says so');
  });

  it('no row is wider than the terminal, at 80 and at 120 columns', () => {
    const data = pageData({ programmes: programmesSection({ goalRows: GOALS, programmes: PROGRAMMES }) });
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
  it('goalsOf gives the stage and the status, and distinguishes Martin from blocked recovery in any stage with the last entry\'s comment', () => {
    const asked = { at: '2026-11-01T11:00Z', tool: 'claude', model: 'opus', stage: 'build', status: 'Martin', done: null, comment: 'which table?', next: null };
    const died = { at: '2026-11-01T11:00Z', tool: 'runner', model: null, stage: 'review', status: 'Martin', done: null, comment: 'the review ended with the goal still in review, a second time — waits on a person', next: null };
    const [byQuestion, byRunner, judged, blocked] = goalsOf({
      goals: [
        { programme: 'mc', goal: 'asked', repos: ['memoro-cli'], stage: 'build', status: 'Martin', log: [asked], problems: [] },
        { programme: 'mc', goal: 'died', repos: ['memoro-cli'], stage: 'review', status: 'Martin', log: [died], problems: [] },
        { programme: 'mc', goal: 'judged', repos: ['memoro-cli'], stage: 'merge', status: 'ready', log: [], problems: [] },
        { programme: 'mc', goal: 'blocked', repos: ['memoro-cli'], stage: 'build', status: 'blocked', log: [], problems: [] },
      ],
    });
    assert.deepEqual([byQuestion.stage, byQuestion.status, byQuestion.person, byQuestion.question], ['build', 'Martin', true, 'which table?']);
    assert.deepEqual([byRunner.person, byRunner.question], [true, died.comment]);
    assert.deepEqual([judged.stage, judged.status, judged.person, judged.question], ['merge', 'ready', false, null]);
    assert.deepEqual([blocked.person, blocked.question, blocked.runnable], [false, null, false]);
  });

  it('uses quiet stage labels, canonical ready status and red blockers', () => {
    const rows = [
      { name: 'judged', programme: 'mc', repos: ['memoro-cli'], stage: 'review', status: 'ready', sessions: 2, last: { next: null, comment: null }, running: false, problems: [] },
      { name: 'landing', programme: 'mc', repos: ['memoro-cli'], stage: 'merge', status: 'ready', sessions: 2, last: { next: null, comment: null }, running: false, problems: [] },
      { name: 'stuck', programme: 'mc', repos: ['memoro-cli'], stage: 'finish', status: 'Martin', sessions: 2, last: { next: null, comment: 'split it?' }, running: false, person: true, question: 'split the goal in two?', problems: [] },
    ];
    const data = pageData({ programmes: programmesSection({ goalRows: rows.map(goalRow), programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 140, now: NOW, colour: true }));
    const line = (name) => lines[lines.indexOf(goalLineOf(lines, name)) + 1];
    assert.match(plain(line('judged')), /stage review · status ready/u);
    assert.match(plain(line('landing')), /stage merge · status ready/u);
    assert.match(line('landing'), /\u001b\[32mready/u);
    assert.match(plain(line('stuck')), /stage finish · status Martin/u);
    assert.ok(lines.some((row) => plain(row).includes('split the goal in two?')));
    assert.match(line('stuck'), /\u001b\[31mMartin/u);
    assert.ok(lines.some((row) => /\u001b\[31msplit the goal in two\?/u.test(row)), 'the question is red');
  });
});

describe('a goal in a phase its programme has not reached', () => {
  const goals = [
    { programme: 'mc', goal: 'landed', repos: ['memoro-cli'], stage: 'done', status: 'ready', phase: 1, log: [], problems: [] },
    { programme: 'mc', goal: 'runner-sessions', repos: ['memoro-cli'], stage: 'build', status: 'ready', phase: 2, log: [], problems: [] },
    { programme: 'mc', goal: 'headless-plan', repos: ['memoro-cli'], stage: 'draft', status: 'ready', phase: 3, log: [], problems: [] },
  ];

  it('goalsOf gives its phase and whether it is held, and the page JSON carries both', () => {
    const rows = goalsOf({ goals });
    const row = rows.find((each) => each.name === 'headless-plan');
    assert.deepEqual([row.stage, row.status], ['draft', 'ready'], 'it keeps its stage');
    assert.equal(row.phase, 3);
    assert.equal(row.held, true);
    assert.equal(rows.find((each) => each.name === 'runner-sessions').held, false, 'the phase in progress is not held');

    const section = programmesSection({ goalRows: rows, programmes: PROGRAMMES });
    const json = JSON.parse(JSON.stringify(section));
    const listed = json.programmes.flatMap((group) => group.goals ?? []).find((goal) => goal.name === 'headless-plan');
    assert.equal(listed.phase, 3);
    assert.equal(listed.held, true);
    assert.deepEqual([listed.stage, listed.status], ['draft', 'ready'], 'mc --json carries stage and status');
  });

  it('the page labels future phases without replacing the goal status', () => {
    const data = pageData({ programmes: programmesSection({ goalRows: goalsOf({ goals }), programmes: PROGRAMMES }) });
    const lines = programmesOf(renderPageLines(data, { columns: 160, now: NOW, colour: true, expand: true }));
    assert.ok(lines.some((line) => /stage draft · status ready/u.test(plain(line))));
    assert.ok(lines.some((line) => /Phase 3 · after phase 2/u.test(line)), 'phase eligibility is separate from goal status');
  });
});

describe('programme pull requests', () => {
  it('shows each owned PR only under its programme and keeps unassigned PRs visible', () => {
    const root = '/work';
    const programmes = programmesSection({ goalRows: [GOALS[0]], programmes: ['study'] });
    const pulls = prsSection({
      root, fetched: NOW.toISOString(), now: NOW,
      prs: [
        { repo: 'memoro-cli', number: 31, headRefName: 'goal/rollout', title: 'Goal change' },
        { repo: 'memoro-cli', number: 32, headRefName: 'study/chat', title: 'Study change' },
        { repo: 'memoro-cli', number: 33, headRefName: 'plan/mc', title: 'Scratch plan change' },
        { repo: 'memoro-cli', number: 34, headRefName: 'fix/unassigned', title: 'Unassigned change' },
      ],
      worktrees: { 'memoro-cli': [
        { branch: 'study/chat', path: `${root}/programs/study/chat/memoro-cli` },
        { branch: 'plan/mc', path: '/tmp/plan-copy/memoro-cli' },
      ] },
    });
    attachPrs({ programmes, pulls });
    const group = (name) => programmes.programmes.find((item) => item.programme === name);
    assert.deepEqual(group('mc').goals[0].prs.map((pr) => pr.number), [31]);
    assert.deepEqual(group('mc').prs.map((pr) => pr.number), [33]);
    assert.deepEqual(group('study').prs.map((pr) => pr.number), [32]);
    assert.equal(group('study').dormant, false);
    assert.deepEqual(pulls.items.map((pr) => [pr.number, pr.programme]), [
      [34, null], [33, 'mc'], [32, 'study'], [31, 'mc'],
    ]);
    for (const columns of [60, 80, 120, 160]) {
      const lines = renderPageLines(pageData({ programmes, prs: pulls }), { columns, now: NOW });
      const divider = lines.findIndex((line) => line.includes('PRs outside goals'));
      assert.match(lines[divider + 1], /1 open · 1 nobody's/u);
      for (const number of [31, 32, 33, 34]) {
        const own = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes(`#${number}`));
        assert.equal(own.length, 1, `#${number} appears once at ${columns} columns`);
        assert.equal(own[0].index < divider, number !== 34);
      }
    }
  });

  it('draws unclaimed plan PRs under their programme, including a programme with no goals', () => {
    const programmes = programmesSection({ goalRows: [{ ...GOALS[0], carries: [{ repo: 'memoro-cli', pr: 3 }] }], programmes: ['empty'] });
    const pr = (number, name, branch = `plan/${name}`) => ({ repo: 'memoro-cli', number, title: `Change ${number}`, branch, owner: { kind: 'plan', name } });
    const carried = pr(3, 'mc');
    const standalone = pr(4, 'mc');
    const only = pr(5, 'empty');
    const newProgramme = pr(6, 'new-programme');
    attachPrs({ programmes, pulls: { items: [carried, standalone, only, newProgramme] } });
    const group = (name) => programmes.programmes.find((item) => item.programme === name);
    assert.deepEqual(group('mc').goals[0].prs, [carried]);
    assert.deepEqual(group('mc').prs, [standalone]);
    assert.deepEqual(group('empty').prs, [only]);
    assert.deepEqual(group('new-programme').prs, [newProgramme]);
    assert.equal(group('empty').dormant, false, 'a PR keeps its programme visible');
    for (const columns of [60, 80, 120]) {
      const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns, now: NOW }));
      for (const number of [3, 4, 5, 6]) assert.equal(lines.filter((line) => line.includes(`#${number}`)).length, 1);
      assert.ok(lines.some((line) => /memoro-cli#5 · open +Change 5/u.test(line)), 'standalone PR has its own row');
      assert.ok(lines.every((line) => width(line) <= columns));
    }
  });
});
