/** Page layouts retain complete identities and numeric-safe clipping at each width. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachPrs, goalsOf, intakeSection, mergesSection, programmesSection, prsSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { devSection } from '../../src/mc/dev-pool.js';
import { clipCell } from '../../src/mc/page-grid.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');

/** A goal as `programsGoals` reads it: a log of two sessions. */
function goal(name, { repos = ['memoro-cli'], stage = 'build', status = 'ready' } = {}) {
  const entry = (at, next) => ({ at, tool: 'claude-code', model: 'opus', stage, status, done: 'x', comment: null, next });
  return { programme: 'mc', goal: name, repos, stage, status, problems: [],
    log: [entry('2026-11-03T10:00Z', 'first'), entry('2026-11-03T11:00Z', 'the next thing to do in this goal')] };
}

/** The page's other sections, empty. */
function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    merges: mergesSection({ now: NOW }),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({}),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/**
 * A page with one row of each kind, every one with an open pull request of its
 * own number: goal `#1102`, lane `#1103`, merge `#1104`. `long` makes every
 * name, title and tail long, and gives the lane four pull requests.
 */
function threeRows({ long = false } = {}) {
  const goalName = long ? 'a-goal-whose-name-is-also-far-too-long-for-it' : 'grid-goal';
  const laneGoal = long ? 'another-goal-with-a-very-long-name-indeed' : 'lane-goal';
  const currents = [{
    name: `goal:mc/${laneGoal}`, goal: `mc/${laneGoal}`, kind: 'build', variant: 'goal', repo: 'memoro-cli',
    lane: 0, tool: 'claude', model: long ? 'claude-opus-5-5-with-a-long-model-id' : 'opus', advisor: long ? 'claude-fable-5-1' : null,
    billing: long ? 'credits' : null, check_in_minutes: 60, check_ins: long ? 12 : 0, pid: 7, started: '2026-11-03T11:20:00Z',
  }];
  const runner = runnerSection({
    runner: { pid: 7, started: '2026-11-03T10:00:00Z' }, currents, rows: [], lanes: { lanes: 2 },
    now: NOW, alive: () => true,
  });
  const goalRows = goalsOf({ goals: [goal(goalName)] });
  const programmes = programmesSection({ goalRows });
  const open = [
    { repo: 'memoro-cli', number: 1102, headRefName: `goal/${goalName}`, title: 'goal PR', updatedAt: '2026-11-03T11:00:00Z' },
    ...(long ? [1103, 1105, 1106, 1107] : [1103]).map((number, n) => ({
      repo: 'memoro-cli', number, headRefName: `goal/${laneGoal}`, title: 'lane PR', updatedAt: '2026-11-03T11:00:00Z',
    })),
    { repo: 'memoro-cli', number: 1104, headRefName: 'merge-branch', title: long ? 'A merge title '.repeat(12) : 'merge PR', updatedAt: '2026-11-03T11:00:00Z' },
  ];
  const queued = [{ repo: 'memoro-cli', pr: 1104, branch: 'merge-branch', since: '2026-11-03T11:50:00Z', state: 'queued' },
    ...(long ? [1108, 1109, 1110].map((pr) => ({ repo: 'memoro-cli', pr, branch: `queued-${pr}`, since: '2026-11-03T11:51:00Z', state: 'queued' })) : [])];
  const merges = mergesSection({ queued, prs: open, now: NOW, merger: { pid: 7 } });
  const pulls = prsSection({ prs: open, merges, fetched: NOW.toISOString(), now: NOW });
  attachPrs({ programmes, runner, pulls });
  // One dev server, leased to the lane's session: DEV's row in the same grid.
  const dev = devSection({
    servers: [{
      instance_id: 'dev-8920', service: 'memoro-worker', worktree_path: `/Users/martin/mc/programs/mc/goals/${laneGoal}/memoro-cli`,
      pid: 7, url: 'http://127.0.0.1:8920', registered_at: '2026-11-03T11:00:00Z', last_used_at: '2026-11-03T11:58:00Z',
      holder: { kind: 'build', owner: 'mc', name: `mc/${laneGoal}`, pid: 7 },
    }],
    now: NOW, alive: () => true, branchOf: () => `goal/${laneGoal}`,
  });
  return pageData({ programmes, runner, merges, dev });
}

/** The three rows, found by their pull request: goal, lane, merge. */
function rowsOf(lines) {
  return [1102, 1103, 1104].map((number) => {
    const found = lines.map(plain).filter((line) => line.includes(`#${number}`));
    assert.equal(found.length, 1, `one row with #${number}:\n${lines.map(plain).join('\n')}`);
    return found[0];
  });
}

describe('page layouts', () => {
  it('keeps goal PRs, unassigned activity and environment addresses visible at every width', () => {
    for (const columns of [60, 80, 100, 120, 160]) {
      const lines = renderPageLines(threeRows(), { columns, now: NOW }).map(plain);
      const rows = rowsOf(lines);
      assert.match(rows[0], /↳ memoro-cli#1102/u);
      assert.match(rows[1], /memoro-cli#1103/u, 'unassigned activity retains its PR');
      assert.match(rows[2], /Queue: #1104/u);
      assert.ok(lines.some((line) => /SLOT +:8920 +leased/u.test(line)));
      assert.ok(lines.every((line) => width(line) <= columns));
      assert.ok(!lines.some((line) => /^  SESSIONS/u.test(line)));
    }
  });

  it('draws no line of the page wider than 80 columns, with long names, four PRs and a long tail', () => {
    for (const columns of [60, 80, 120, 160]) for (const colour of [false, true]) {
      const lines = renderPageLines(threeRows({ long: true }), { columns, now: NOW, colour });
      assert.deepEqual(lines.filter((line) => width(line) > columns), []);
      for (const number of [1103, 1105, 1106, 1107]) assert.ok(lines.some((line) => line.includes(`#${number}`)));
      assert.ok(lines.some((line) => line.includes('40 min')));
    }
  });

  it('draws a numbered goal with its own layout and its PR as a child', () => {
    const lines = renderPageLines(threeRows(), { columns: 120, now: NOW }).map(plain);
    const index = lines.findIndex((line) => /^ +1 grid-goal$/u.test(line));
    assert.ok(index >= 0, lines.join('\n'));
    assert.match(lines[index + 2], /↳ memoro-cli#1102/u);
    assert.ok(!lines.some((line) => /(?:^| )g · /u.test(line)), 'no row says `g ·`');
  });

  it('carries name, repo, state, progress and prs for goals, sessions and merges in mc --json', () => {
    const data = JSON.parse(JSON.stringify(threeRows()));
    const [group] = data.programmes.programmes;
    const fields = (row) => ({ name: row.name, repo: row.repo, state: row.state, progress: row.progress, prs: row.prs.map((pr) => pr.number) });
    assert.deepEqual(fields(group.goals[0]), { name: 'grid-goal', repo: 'memoro-cli', state: 'build', progress: '2 sess', prs: [1102] });
    assert.deepEqual(fields(data.runner.sessions[0]), { name: 'mc/lane-goal', repo: 'memoro-cli', state: 'running', progress: '40 min', prs: [1103] });
    const [repo] = data.merges.repos.filter((one) => one.repo === 'memoro-cli');
    assert.deepEqual(fields(repo.waiting[0]), { name: 'merge-branch', repo: 'memoro-cli', state: 'queued', progress: '10 min', prs: [1104] });
    assert.deepEqual([group.goals[0].kind, data.runner.sessions[0].kind, repo.waiting[0].kind],
      ['goal', 'build', 'wait']);
    // An idle queue's own row is the repository's: its name, state and last landing.
    const idle = data.merges.repos.find((one) => one.repo === 'memoro');
    assert.deepEqual([idle.kind, idle.name, idle.state, idle.progress, idle.prs], ['idle', 'memoro', 'idle', null, []]);
  });

  it('gives a merge item with no pull request number no PR cell — never #0 or #NaN', () => {
    const queued = [
      { repo: 'memoro-cli', branch: 'goal/no-number', since: '2026-11-03T11:50:00Z', state: 'queued' },
      { repo: 'memoro-cli', pr: null, branch: 'null-number', since: '2026-11-03T11:51:00Z', state: 'queued' },
      { repo: 'memoro-cli', pr: 1104, branch: 'merge-branch', since: '2026-11-03T11:52:00Z', state: 'queued' },
    ];
    const merges = mergesSection({ queued, now: NOW, merger: { pid: 7 } });
    const repo = merges.repos.find((one) => one.repo === 'memoro-cli');
    const numbers = repo.waiting.flatMap((item) => item.prs.map((pr) => pr.number));
    assert.deepEqual(numbers, [1104], 'only the item with a number has a PR');
    assert.ok(repo.waiting.some((item) => item.prs.length === 0), 'an item without a number is still in the queue');
    assert.deepEqual(repo.prs.map((pr) => pr.number), [1104]);
    const text = renderPageLines(pageData({ merges }), { columns: 120, now: NOW }).map(plain).join('\n');
    assert.doesNotMatch(text, /#0\b|#NaN/u, text);
  });

  it('clips a cell with … and never inside a number', () => {
    assert.equal(clipCell('short', 9), 'short');
    assert.equal(clipCell('docx-editor-toolbar', 10), 'docx-edit…');
    assert.equal(clipCell('step 12/30 of it', 9), 'step…', 'not `step 12/…`');
    assert.equal(clipCell('awaits #14709 now', 10), 'awaits…', 'not `awaits #1…`');
    assert.equal(clipCell('2.5 h', 3), '…');
    assert.equal(clipCell('a 1 b', 4), 'a 1…', 'a cut after a whole number is a cut between words');
    // The PR cell drops its count before its number, and never cuts the number.
  });
});
