/**
 * The page's one grid (goal mc/page-columns): a project, a goal, a lane and a
 * merge are drawn in the same columns — the repository and the pull request
 * at the same x in all four — no row is wider than an 80-column terminal, a
 * cell is never cut inside a number, and every cell is a field `mc --json`
 * carries under the same name in every section.
 *
 * The rows come from the real collectors (`programmesSection`, `goalsOf`,
 * `runnerSection`, `mergesSection`, `attachPrs`), so the fixture is the shape
 * the page is really handed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachPrs, goalsOf, intakeSection, mergesSection, nextSection, programmesSection, prsSection, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { GRID_ROOMY, clipCell, gridColumns, prText } from '../../src/mc/page-grid.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');

/** A plan record as `listPlans` hands it over, with `steps` of which `done` are done. */
function plan(project, { repo = 'memoro-cli', programme = 'mc', status = 'ready', steps = 3, done = 1, title = 'The step' } = {}) {
  return {
    repo, programme, project, status, title,
    plan: { steps: Array.from({ length: steps }, (_, n) => ({ title: `${title} ${n + 1}`, status: n < done ? 'done' : 'ready' })) },
  };
}

/** A goal as `programsGoals` reads it: a log of two sessions. */
function goal(name, { repos = ['memoro-cli'], status = 'open' } = {}) {
  const entry = (at, next) => ({ at, tool: 'claude-code', model: 'opus', status, done: 'x', comment: null, next });
  return { programme: 'mc', goal: name, repos, status, after: [], problems: [],
    log: [entry('2026-11-03T10:00Z', 'first'), entry('2026-11-03T11:00Z', 'the next thing to do in this goal')] };
}

/** The page's other sections, empty. */
function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    next: nextSection({ plans: [] }),
    merges: mergesSection({ now: NOW }),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({ areas: [], plans: [] }),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/**
 * A page with one row of each kind, every one with an open pull request of its
 * own number: project `#1101`, goal `#1102`, lane `#1103`, merge `#1104`. `long`
 * makes every name, title and tail long, and gives the lane four pull requests.
 */
function fourRows({ long = false } = {}) {
  const projectName = long ? 'a-project-whose-name-is-far-too-long-for-any-column' : 'grid-project';
  const goalName = long ? 'a-goal-whose-name-is-also-far-too-long-for-it' : 'grid-goal';
  const plans = [plan(projectName, { title: long ? 'A step title that goes on and on and on, well past any terminal edge' : 'The step' })];
  const currents = [{
    name: long ? 'another-project-with-a-very-long-name-indeed' : 'lane-project', kind: 'build', variant: 'project', repo: 'memoro-cli',
    lane: 0, tool: 'claude', model: long ? 'claude-opus-5-5-with-a-long-model-id' : 'opus', advisor: long ? 'claude-fable-5-1' : null,
    billing: long ? 'credits' : null, check_in_minutes: 60, check_ins: long ? 12 : 0, pid: 7, started: '2026-11-03T11:20:00Z',
  }];
  const runner = runnerSection({
    runner: { pid: 7, started: '2026-11-03T10:00:00Z' }, currents, rows: [], lanes: { lanes: 2 },
    plans: [{ project: currents[0].name, step: 12, steps: 30 }], now: NOW, alive: () => true,
  });
  const goalRows = goalsOf({ goals: [goal(goalName)] });
  const programmes = programmesSection({ plans, areas: [], goalRows, now: NOW });
  const open = [
    { repo: 'memoro-cli', number: 1101, headRefName: projectName, title: 'project PR', updatedAt: '2026-11-03T11:00:00Z' },
    { repo: 'memoro-cli', number: 1102, headRefName: `goal/${goalName}`, title: 'goal PR', updatedAt: '2026-11-03T11:00:00Z' },
    ...(long ? [1103, 1105, 1106, 1107] : [1103]).map((number, n) => ({
      repo: 'memoro-cli', number, headRefName: n ? `${currents[0].name}-${n}` : currents[0].name, title: 'lane PR', updatedAt: '2026-11-03T11:00:00Z',
    })),
    { repo: 'memoro-cli', number: 1104, headRefName: 'merge-branch', title: long ? 'A merge title '.repeat(12) : 'merge PR', updatedAt: '2026-11-03T11:00:00Z' },
  ];
  const queued = [{ repo: 'memoro-cli', pr: 1104, branch: 'merge-branch', since: '2026-11-03T11:50:00Z', state: 'queued' },
    ...(long ? [1108, 1109, 1110].map((pr) => ({ repo: 'memoro-cli', pr, branch: `queued-${pr}`, since: '2026-11-03T11:51:00Z', state: 'queued' })) : [])];
  const merges = mergesSection({ queued, prs: open, now: NOW, merger: { pid: 7 } });
  const pulls = prsSection({ prs: open, plans: [...plans, { repo: 'memoro-cli', project: currents[0].name }], merges, fetched: NOW.toISOString(), now: NOW });
  attachPrs({ programmes, runner, pulls });
  return pageData({ programmes, runner, merges });
}

/** The four rows, found by their pull request: project, goal, lane, merge. */
function rowsOf(lines) {
  return [1101, 1102, 1103, 1104].map((number) => {
    const found = lines.map(plain).filter((line) => line.includes(`#${number}`));
    assert.equal(found.length, 1, `one row with #${number}:\n${lines.map(plain).join('\n')}`);
    return found[0];
  });
}

describe('the grid', () => {
  it('draws a project, a goal, a lane and a merge with the repository and the PR at the same x, at 80, 100 and 140', () => {
    for (const columns of [80, 100, 140]) {
      const col = gridColumns(columns);
      const rows = rowsOf(renderPageLines(fourRows(), { columns, now: NOW }));
      const prAt = rows.map((line) => line.search(/#11\d\d/u));
      assert.deepEqual(prAt, [col.pr.x, col.pr.x, col.pr.x, col.pr.x], `${columns}: the PR column\n${rows.join('\n')}`);
      if (columns >= GRID_ROOMY) {
        const repoAt = rows.map((line) => line.indexOf(' memoro-cli ') + 1);
        assert.deepEqual(repoAt, [col.repo.x, col.repo.x, col.repo.x, col.repo.x], `${columns}: the repo column\n${rows.join('\n')}`);
      } else {
        // Under 90 columns the repository gives way, in every section alike.
        assert.equal(col.repo.width, 0);
        for (const line of rows) assert.doesNotMatch(line, / memoro-cli /u, `${columns}: ${line}`);
      }
      // The same kind of fact in the same column: the state and the progress too.
      const cells = rows.map((line) => [line.slice(col.kind.x, col.kind.x + col.kind.width).trim(),
        line.slice(col.state.x, col.state.x + col.state.width).trim(),
        line.slice(col.progress.x, col.progress.x + col.progress.width).trim()]);
      assert.deepEqual(cells, [['project', 'ready', '1/3'], ['goal', 'open', '2 sess'], ['BUILD', 'running', '40 min'], ['WAIT', 'queued', '10 min']]);
    }
  });

  it('draws no line of the page wider than 80 columns, with long names, four PRs and a long tail', () => {
    for (const colour of [false, true]) {
      const lines = renderPageLines(fourRows({ long: true }), { columns: 80, now: NOW, colour, version: '0.7.11' });
      const over = lines.filter((line) => width(line) > 80).map(plain);
      assert.deepEqual(over, [], `colour ${colour}`);
    }
    // The four on the lane are the newest and `+3`, in the PR column; the long
    // names gave way, the state and the progress did not.
    const lane = renderPageLines(fourRows({ long: true }), { columns: 80, now: NOW }).find((line) => / BUILD /u.test(line));
    const col = gridColumns(80);
    assert.equal(lane.slice(col.pr.x, col.pr.x + col.pr.width).trim(), '#1107+3', lane);
    assert.match(lane.slice(col.name.x, col.name.x + col.name.width), /^another-proj… 12\/30 /u, lane);
    assert.equal(lane.slice(col.state.x, col.progress.x + col.progress.width).replace(/\s+/gu, ' ').trim(), 'running 40 min');
  });

  it('draws a goal as a project is drawn: `goal` in the kind column, never `g ·` before its name', () => {
    const lines = renderPageLines(fourRows(), { columns: 120, now: NOW }).map(plain);
    const row = lines.find((line) => line.includes('#1102'));
    const col = gridColumns(120);
    assert.equal(row.slice(col.kind.x, col.kind.x + col.kind.width).trim(), 'goal');
    assert.equal(row.slice(col.name.x, col.name.x + col.name.width).trim(), 'grid-goal');
    assert.ok(!lines.some((line) => /(?:^| )g · /u.test(line)), 'no row says `g ·`');
  });

  it('carries name, repo, state, progress and prs for projects, goals, sessions and merges in mc --json', () => {
    const data = JSON.parse(JSON.stringify(fourRows()));
    const [group] = data.programmes.programmes;
    const fields = (row) => ({ name: row.name, repo: row.repo, state: row.state, progress: row.progress, prs: row.prs.map((pr) => pr.number) });
    assert.deepEqual(fields(group.projects[0]), { name: 'grid-project', repo: 'memoro-cli', state: 'ready', progress: '1/3', prs: [1101] });
    assert.deepEqual(fields(group.goals[0]), { name: 'grid-goal', repo: 'memoro-cli', state: 'open', progress: '2 sess', prs: [1102] });
    assert.deepEqual(fields(data.runner.sessions[0]), { name: 'lane-project', repo: 'memoro-cli', state: 'running', progress: '40 min', prs: [1103] });
    const [repo] = data.merges.repos.filter((one) => one.repo === 'memoro-cli');
    assert.deepEqual(fields(repo.waiting[0]), { name: 'merge-branch', repo: 'memoro-cli', state: 'queued', progress: '10 min', prs: [1104] });
    assert.deepEqual([group.projects[0].kind, group.goals[0].kind, data.runner.sessions[0].kind, repo.waiting[0].kind],
      ['project', 'goal', 'build', 'wait']);
    // An idle queue's own row is the repository's: its name, state and last landing.
    const idle = data.merges.repos.find((one) => one.repo === 'memoro');
    assert.deepEqual([idle.kind, idle.name, idle.state, idle.progress, idle.prs], ['idle', 'memoro', 'idle', null, []]);
  });

  it('clips a cell with … and never inside a number', () => {
    assert.equal(clipCell('short', 9), 'short');
    assert.equal(clipCell('docx-editor-toolbar', 10), 'docx-edit…');
    assert.equal(clipCell('step 12/30 of it', 9), 'step…', 'not `step 12/…`');
    assert.equal(clipCell('awaits #14709 now', 10), 'awaits…', 'not `awaits #1…`');
    assert.equal(clipCell('2.5 h', 3), '…');
    assert.equal(clipCell('a 1 b', 4), 'a 1…', 'a cut after a whole number is a cut between words');
    // The PR cell drops its count before its number, and never cuts the number.
    assert.equal(prText([{ number: 14709 }, { number: 1 }, { number: 2 }, { number: 3 }]), '#14709+3');
    assert.equal(prText([{ number: 1234567 }, { number: 1 }]), '#1234567');
    assert.equal(prText([{ number: 123456789 }]), '');
  });
});
