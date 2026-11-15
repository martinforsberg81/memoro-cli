import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachPrs, goalsOf, intakeSection, mergesSection, programmesSection, prsSection, runnerSection, sessionsSection } from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-05T09:00:00Z');
const goal = (name, phase, over = {}) => ({ programme: 'inbox', goal: name, title: `Title ${name}`, phase,
  stage: 'build', status: 'ready', repos: ['memoro'], log: [], problems: [],
  success_criteria: [{ criterion: 'works', check: 'observe', met: false }], ...over });
function fixture({ finishedPr = false, currents = [] } = {}) {
  const goals = [goal('later', 3), goal('parallel-b', 1), goal('parallel-a', 1),
    goal('finished', 1, { stage: 'done' }), goal('stuck-later', 4, { status: 'blocked' }),
    goal('pr-later', 5), goal('far-future', 10), goal('plan', 1, { stage: 'draft' }), goal('empty-build', 1, { success_criteria: [] })];
  const programmes = programmesSection({ goalRows: goalsOf({ goals, currents, alive: () => true }), programmes: ['empty'] });
  const prs = prsSection({ now: NOW, fetched: NOW.toISOString(), prs: [
    { repo: 'memoro', number: 14857, headRefName: 'goal/pr-later', title: 'Open later PR' },
    { repo: 'memoro', number: 14858, headRefName: 'plan/standalone', title: 'Standalone change' },
    ...(finishedPr ? [{ repo: 'memoro', number: 14859, headRefName: 'goal/finished', title: 'Open PR on finished goal' }] : []),
  ] });
  attachPrs({ programmes, pulls: prs });
  return { programmes, prs, runner: runnerSection({ now: NOW, currents, runner: { pid: 7 }, alive: () => true }), sessions: sessionsSection({ now: NOW }),
    merges: mergesSection({}), intake: intakeSection({ now: NOW }), language: {}, notes: [] };
}
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');
const draw = (data, over = {}) => renderPageLines(data, { columns: 120, now: NOW, ...over }).map(plain);

describe('PROGRAMMES phase tree', () => {
  it('shows each Manager below the hero and programme turns under their owner, with triggers', () => {
    const runner = runnerSection({ now: NOW, alive: () => true, currents: [
      ...['inbox', 'empty'].map((programme, index) => ({ name: `plan:${programme}`, programme,
        kind: 'plan', reason: 'daily_proposals', pid: 200 + index, session_pid: 300 + index,
        tool: 'codex', model: 'gpt-6.1-sol', started: '2026-11-05T08:45:00Z' })),
      { name: 'goal:inbox/missing', kind: 'plan', reason: 'blocked', pid: 202, session_pid: 302,
        started: '2026-11-05T08:45:00Z' },
    ] });
    const sessions = sessionsSection({ now: NOW, alive: () => true, foreground: [
      { verb: 'manager', pid: 400, reason: 'manual_task', tool: 'codex', model: 'gpt-6.1-sol', started: '2026-11-05T08:30:00Z' },
      { verb: 'brief', pid: 401, tool: 'claude', model: 'opus', started: '2026-11-05T08:40:00Z' },
      { verb: 'plan', programme: 'inbox', pid: 402, tool: 'codex', started: '2026-11-05T08:50:00Z' },
    ] });
    const data = { ...fixture(), runner, sessions,
      programmes: programmesSection({ runnerSessions: runner.sessions, planningSessions: sessions.planning_sessions }) };
    for (const columns of [60, 80, 120, 160]) for (const expand of [false, true]) {
      const lines = draw(JSON.parse(JSON.stringify(data)), { columns, expand });
      const heroEnd = lines.findIndex(line => line.startsWith('  └'));
      const programmes = lines.findIndex(line => line.includes('PROGRAMMES'));
      for (const pid of [400, 401]) {
        const at = lines.findIndex(line => line.includes(`pid ${pid}`));
        assert.ok(at > heroEnd && at < programmes, `Manager ${pid} below hero`);
        const top = lines.findLastIndex((line, index) => index < at && line.startsWith('  ╭'));
        assert.ok(top > heroEnd, 'Manager has its own rounded frame');
        assert.equal(lines.filter(line => line.includes(`pid ${pid}`)).length, 1);
      }
      assert.ok(lines.slice(heroEnd, programmes).some(line => line.includes('manual_task')));
      for (const [programme, pid] of [['inbox', 300], ['empty', 301]]) {
        const heading = lines.findIndex(line => line.startsWith(`  ┌─ ${programme}`));
        const close = lines.findIndex((line, index) => index > heading && line.startsWith('  └'));
        const activity = lines.slice(heading, close).join('\n');
        assert.match(activity, /daily_proposals/u);
        assert.ok(activity.includes(`pid ${pid}`), `${programme} owns its plan turn`);
        assert.equal(lines.filter(line => line.includes(`pid ${pid}`)).length, 1);
      }
      assert.equal(lines.filter(line => line.includes('pid 402')).length, 1, 'interactive plan stays visible');
      const unassigned = lines.findIndex(line => line.includes('UNASSIGNED ACTIVITY'));
      assert.ok(unassigned > programmes);
      assert.ok(lines.slice(unassigned).some(line => line.includes('inbox/missing')), 'goal recovery without a goal stays unassigned');
      assert.ok(!lines.some(line => line.includes('plan:inbox') || line.includes('plan:empty')));
      assert.ok(lines.every(line => width(line) <= columns), `${columns} columns`);
    }
  });

  it('groups parallel goals by numeric phase and separates phase eligibility from stage and status', () => {
    const data = fixture();
    const inbox = data.programmes.programmes.find((p) => p.programme === 'inbox');
    assert.equal(inbox.current_phase, 1);
    assert.deepEqual(inbox.phases.map((p) => [p.number, p.goals.map((g) => g.name)]), [
      [1, ['empty-build', 'finished', 'parallel-a', 'parallel-b', 'plan']],
      [3, ['later']], [4, ['stuck-later']], [5, ['pr-later']], [10, ['far-future']],
    ]);
    assert.ok(inbox.goals.every((g) => !('availability' in g)));
    assert.deepEqual(inbox.goals.map((g) => [g.name, g.stage, g.status]), [
      ['empty-build', 'build', 'ready'], ['far-future', 'build', 'ready'], ['finished', 'done', 'ready'], ['later', 'build', 'ready'],
      ['parallel-a', 'build', 'ready'], ['parallel-b', 'build', 'ready'], ['plan', 'draft', 'ready'],
      ['pr-later', 'build', 'ready'], ['stuck-later', 'build', 'blocked'],
    ]);
    assert.deepEqual(data.programmes.statuses, { ready: 8, blocked: 1 });
    const lines = draw(data);
    const phase = lines.findIndex((line) => line.includes('Phase 1'));
    const names = ['Title parallel-a', 'Title parallel-b'];
    for (const name of names) assert.ok(lines.findIndex((line) => line.includes(name)) > phase);
    assert.ok(!lines.slice(0, lines.findIndex((line) => line.includes('MAINTENANCE'))).some((line) => line.includes('LATEST') || line.includes('SESS')));
    assert.ok(!lines.some((line) => line.includes('phase 3 — after phase')));
  });

  it('shows all unfinished phases and goals and folds history; a expands it all', () => {
    const data = fixture();
    const folded = draw(data);
    assert.ok(folded.some((line) => line.includes('Title later')));
    assert.ok(!folded.some((line) => line.includes('Title finished')));
    assert.ok(folded.some((line) => /Phase 3 · after phase 1/u.test(line)));
    assert.ok(!folded.some((line) => /▸ Finished/u.test(line)), 'no fold of finished goals is drawn');
    assert.ok(folded.some((line) => line.includes('Title stuck-later')));
    assert.ok(folded.some((line) => line.includes('Phase 4 · after phase 1')));
    assert.ok(folded.findIndex((line) => line.includes('Phase 3')) < folded.findIndex((line) => line.includes('Phase 4')), 'folded and expanded phases retain numeric order');
    const owner = folded.findIndex((line) => line.includes('Title pr-later'));
    assert.ok(owner > 0);
    assert.match(folded[owner + 2], /memoro#14857/u, 'PR is a child row of its goal');
    assert.equal(folded.filter((line) => line.includes('#14857')).length, 1);
    assert.equal(folded.filter((line) => line.includes('#14858')).length, 1);
    assert.ok(folded.some((line) => line.includes('PRs without a goal')));
    const expanded = draw(data, { expand: true });
    for (const name of ['later', 'far-future', 'finished']) assert.ok(expanded.some((line) => line.includes(`Title ${name}`)));
    assert.deepEqual(data.programmes.programmes.flatMap((p) => p.goals.map((g) => g.number)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const withFinishedPr = draw(fixture({ finishedPr: true }));
    const finishedAt = withFinishedPr.findIndex((line) => line.includes('Title finished'));
    assert.ok(finishedAt > 0, 'an open PR keeps even its finished goal visible');
    assert.ok(finishedAt > withFinishedPr.findIndex((line) => line.includes('NEEDS ATTENTION')) && withFinishedPr.findIndex((line) => line.includes('NEEDS ATTENTION')) >= 0, 'under NEEDS ATTENTION');
    assert.match(withFinishedPr[finishedAt + 2], /not archived — memoro#14859 is open — land or close it first/u);
    assert.match(withFinishedPr[finishedAt + 3], /memoro#14859/u, 'the PR is a child row');
  });

  it('puts live sessions beneath their goals, exposes future activity and retains unassigned sessions', () => {
    const current = (name, kind) => ({ name: `goal:inbox/${name}`, kind, repo: 'memoro', pid: 7,
      tool: 'codex', model: 'sol', started: '2026-11-05T08:48:00Z', check_in_minutes: 60, check_ins: 1 });
    const data = fixture({ currents: [current('parallel-a', 'build'), current('far-future', 'review'), current('missing-goal', 'plan')] });
    for (const columns of [60, 80, 120, 160]) {
      const lines = draw(data, { columns });
      const painted = renderPageLines(data, { columns, colour: true, now: NOW });
      assert.deepEqual(painted.map(plain), lines);
      for (const [kind, code] of [['BUILD', 32], ['REVIEW', 35], ['PLAN', 34]]) {
        const at = lines.findIndex((line) => line.includes(`● · ${kind}`));
        assert.ok(painted[at - 1].includes(`\u001b[${code}m╭`), `${kind} top border`);
        const bottom = lines.findIndex((line, index) => index > at && line.trimStart().startsWith('╰'));
        assert.ok(bottom > at, `${kind} bottom border`);
        assert.ok(painted[bottom].includes(`\u001b[${code}m╰`), `${kind} bottom border colour`);
        for (let row = at; row < bottom; row++) {
          assert.ok(painted[row].includes(`\u001b[${code}m│`), `${kind} side border colour`);
          assert.equal(width(lines[row]), width(lines[at - 1]), `${kind} wrapped frame width`);
        }
      }
      assert.ok(!lines.some((line) => /^  SESSIONS/u.test(line)));
      for (const title of ['Title parallel-a', 'Title far-future']) {
        const at = lines.findIndex((line) => line.includes(title));
        assert.ok(at >= 0, title);
        assert.match(lines[at + 2], /^ {10}╭─+╮$/u);
        const bottom = lines.findIndex((line, index) => index > at + 2 && line.trimStart().startsWith('╰'));
        const content = lines.slice(at + 3, bottom).map((line) => line.trim().slice(1, -1).trim()).join(' ');
        assert.match(content, /^● · (BUILD|REVIEW) · 12 min · codex · sol(?: ·)? 1 check-in(?: ·)? runner pid 7$/u);
        assert.equal(width(lines[at + 2]), width(lines[at + 3]), 'frame hugs the session');
        assert.equal(width(lines[at + 3]), width(lines[bottom]));
        assert.ok(!lines[bottom + 1]?.includes('check-in'), 'no separate check-in below the frame');
      }
      const unmatched = lines.findIndex((line) => line.includes('UNASSIGNED ACTIVITY'));
      assert.ok(unmatched > 0);
      assert.ok(lines.slice(unmatched).some((line) => line.includes('inbox/missing-goal')));
      assert.equal(lines.filter((line) => line.includes('● · REVIEW')).length, 1);
      assert.ok(lines.every((line) => width(line) <= columns));
    }
  });

  it('keeps the whole tree within terminal width with and without colour and leaves malformed goals visible', () => {
    const data = fixture();
    const broken = programmesSection({ goalRows: [{ programme: 'broken', name: 'invalid', phase: null,
      problems: ['repos names no repository'], repos: [] }] }).programmes[0];
    data.programmes.programmes.push(broken);
    for (const columns of [60, 80, 100, 120, 160]) for (const expand of [false, true]) {
      const plainLines = renderPageLines(data, { columns, expand, now: NOW });
      const colourLines = renderPageLines(data, { columns, expand, colour: true, now: NOW });
      assert.deepEqual(colourLines.map(plain), plainLines);
      assert.ok(plainLines.some((line) => /^  ┌─ inbox /u.test(line)), 'programme has a boundary');
      assert.ok(plainLines.some((line) => /^  └─/u.test(line)), 'programme closes before the next unit');
      assert.ok(plainLines.some((line) => /stage build · status ready · criteria 0\/1/u.test(line)));
      // The pipeline's box borders and arrows are the real grey by contract (mc-ui.md, Pipeline); nothing else is.
      const text = (line) => line.replace(/\u001b\[90m[┌┐└┘│─▶ ]+\u001b\[0m/gu, '');
      assert.ok(!colourLines.some((line) => /\u001b\[(?:90|2)m/u.test(text(line))), 'secondary text is not dark grey or dim');
      assert.ok(colourLines.every((line) => width(line) <= columns), `${columns}: ${colourLines.filter((line) => width(line) > columns)}`);
      assert.ok(plainLines.some((line) => line.includes('invalid')));
      assert.ok(plainLines.some((line) => line.includes('repos names no repository')));
      assert.ok(plainLines.some((line) => line.includes('memoro#14857')), 'PR number stays whole');
    }
  });
});

/**
 * Finished goals leave the page (finished-goals-leave-the-page): the default
 * view draws no done or dropped goal but one still at work, a phase with
 * nothing drawn is not drawn, a programme with nothing to draw is its heading
 * row, and what needs a person (a refused archive, an open PR) goes under
 * NEEDS ATTENTION in both views.
 */
describe('PROGRAMMES without finished goals', () => {
  const entry = (tool, stage, comment = null) => ({ at: '2026-11-05T07:00Z', tool, model: null, stage, status: 'ready', done: tool === 'runner' ? null : 'x', comment, next: null });
  const REFUSAL = "memoro's worktree has uncommitted changes (src/a.js)";
  const goalsFor = (...rows) => rows.map(([name, phase, over]) => goal(name, phase, over));
  function page(goals, { currents = [], prs = [], programmes = [] } = {}) {
    const section = programmesSection({ goalRows: goalsOf({ goals, currents, alive: () => true }), programmes });
    const pulls = prsSection({ now: NOW, fetched: NOW.toISOString(), prs });
    attachPrs({ programmes: section, pulls });
    return { programmes: section, prs: pulls, runner: runnerSection({ now: NOW, currents, runner: { pid: 7 }, alive: () => true }), sessions: sessionsSection({ now: NOW }),
      merges: mergesSection({}), intake: intakeSection({ now: NOW }), language: {}, notes: [] };
  }
  const programmeOf = (lines, name) => {
    const start = lines.findIndex((line) => new RegExp(`^  ┌─ ${name}(?: |$)`, 'u').test(line));
    assert.ok(start >= 0, `${name} has its heading`);
    const end = lines.findIndex((line, index) => index > start && /^  (?:└|┌)/u.test(line));
    return lines.slice(start, end < 0 ? undefined : (lines[end].startsWith('  └') ? end + 1 : end));
  };

  it('counts the finished goals on the heading, draws none by default and not a phase of nothing else', () => {
    const data = page(goalsFor(['a', 1, { stage: 'done' }], ['b', 1, { stage: 'dropped' }], ['c', 2], ['d', 2, { stage: 'done' }]));
    const [group] = data.programmes.programmes;
    assert.equal(group.finished, 3);
    const lines = draw(data);
    assert.match(lines.find((line) => line.startsWith('  ┌─ inbox')), /inbox.* · 3 done/u);
    assert.ok(lines.some((line) => line.includes('Title c')));
    for (const name of ['a', 'b', 'd']) assert.ok(!lines.some((line) => line.includes(`Title ${name}`)), `${name} is not drawn`);
    assert.ok(!lines.some((line) => /Phase 1/u.test(line)), 'phase 1 holds nothing drawn');
    assert.ok(lines.some((line) => /Phase 2/u.test(line)));
    const expanded = draw(data, { expand: true });
    for (const name of ['a', 'b', 'c', 'd']) assert.ok(expanded.some((line) => line.includes(`Title ${name}`)), `${name} drawn under a`);
    assert.ok(expanded.some((line) => /Phase 1/u.test(line)));
  });

  it('draws a programme with nothing unfinished as its heading row alone, the next one directly beneath', () => {
    const data = page([...goalsFor(['x', 1, { stage: 'done' }]), goal('y', 1, { programme: 'second', stage: 'dropped' }), goal('z', 1, { programme: 'third' })]);
    const lines = draw(data);
    const first = lines.findIndex((line) => /^  ┌─ inbox /u.test(line));
    assert.match(lines[first], /· 1 done/u);
    assert.match(lines[first + 1], /^  ┌─ second /u, 'the next heading follows at once');
    assert.match(lines[first + 1], /· 1 done/u);
    assert.ok(!programmeOf(lines, 'inbox').some((line) => /Phase|Title x|NEEDS/u.test(line)));
    assert.ok(programmeOf(lines, 'third').some((line) => line.includes('Title z')));
    assert.ok(width(lines[first]) <= 120);
  });

  it('keeps a finished goal that is running, or owns a live session, in its phase until the session ends', () => {
    const currents = [{ name: 'goal:inbox/live', kind: 'build', repo: 'memoro', pid: 7, tool: 'codex', model: 'sol', started: '2026-11-05T08:48:00Z', check_in_minutes: 60, check_ins: 1 }];
    const data = page(goalsFor(['live', 1, { stage: 'done' }], ['gone', 1, { stage: 'done' }], ['open', 2]), { currents });
    const lines = draw(data);
    assert.ok(lines.some((line) => line.includes('Title live')), 'the running finished goal stays');
    assert.ok(lines.some((line) => /Phase 1/u.test(line)));
    assert.ok(!lines.some((line) => line.includes('Title gone')));
    assert.ok(!lines.some((line) => /NEEDS ATTENTION/u.test(line)), 'a goal at work is not needing attention');
    const after = draw(page(goalsFor(['live', 1, { stage: 'done' }], ['open', 2])));
    assert.ok(!after.some((line) => line.includes('Title live')), 'once the session has ended it leaves');
  });

  it('puts a finished goal the runner refused to archive under NEEDS ATTENTION with the reason, in both views', () => {
    const goals = goalsFor(['stuck', 1, { stage: 'done', log: [entry('claude', 'done'), entry('runner', 'done', `not archived — ${REFUSAL}`)] }],
      ['older', 1, { stage: 'done', log: [entry('claude', 'done'), entry('runner', 'done', 'not archived — a stale reason'), entry('claude', 'build'), entry('claude', 'done')] }], ['open', 2]);
    const rows = goalsOf({ goals, currents: [], alive: () => true });
    assert.deepEqual(rows.map((row) => [row.name, row.archive_refused]).sort(), [['older', null], ['open', null], ['stuck', REFUSAL]]);
    for (const expand of [false, true]) {
      const lines = draw(page(goals), { expand });
      const attention = lines.findIndex((line) => line.includes('NEEDS ATTENTION'));
      assert.ok(attention >= 0, `expand ${expand}`);
      const stuck = lines.findIndex((line, index) => index > attention && line.includes('Title stuck'));
      assert.ok(stuck > attention);
      assert.ok(lines.slice(stuck, stuck + 5).some((line) => line.trim() === `not archived — ${REFUSAL}`), 'the reason is on the row');
      assert.equal(lines.filter((line) => line.includes('Title stuck')).length, 1, 'drawn once');
      assert.equal(lines.some((line) => line.includes('a stale reason')), false, 'a refusal older than the stage entry is no reason');
    }
    const coloured = renderPageLines(page(goals), { columns: 120, now: NOW, colour: true });
    assert.ok(coloured.some((line) => line.includes(`\u001b[31mnot archived — ${REFUSAL}`)), 'in red');
  });

  it('puts a finished goal with an open PR under NEEDS ATTENTION with the PR as its child row, in both views', () => {
    const data = page(goalsFor(['landed', 1, { stage: 'done' }], ['open', 2]), { prs: [{ repo: 'memoro', number: 77, headRefName: 'goal/landed', title: 'Last change' }] });
    for (const expand of [false, true]) {
      const lines = draw(data, { expand });
      const attention = lines.findIndex((line) => line.includes('NEEDS ATTENTION'));
      const landed = lines.findIndex((line) => line.includes('Title landed'));
      assert.ok(attention >= 0 && landed > attention, `expand ${expand}`);
      assert.match(lines[landed + 2], /not archived — memoro#77 is open — land or close it first/u);
      assert.match(lines[landed + 3], /↳ memoro#77/u, 'the PR is a child row');
      assert.equal(lines.filter((line) => line.includes('#77')).length, 2, 'once as the reason, once as the row');
    }
  });

  it('keeps a malformed goal under NEEDS ATTENTION in both views', () => {
    const data = page([goal('bad', null, { problems: ['repos names no repository'] }), goal('fine', 1)]);
    for (const expand of [false, true]) {
      const lines = draw(data, { expand });
      const attention = lines.findIndex((line) => line.includes('NEEDS ATTENTION'));
      assert.ok(attention >= 0);
      assert.ok(lines.slice(attention).some((line) => line.includes('repos names no repository')));
    }
  });

  it('keeps every key of the collector and adds finished and archive_refused to it', () => {
    const goals = goalsFor(['a', 1, { stage: 'done' }], ['b', 1]);
    const [row] = goalsOf({ goals: [goals[1]], currents: [], alive: () => true });
    for (const key of ['programme', 'name', 'title', 'phase', 'stage', 'status', 'repos', 'criteria', 'running', 'last', 'hold', 'problems', 'sessions']) assert.ok(key in row, `${key} is kept`);
    assert.equal(row.archive_refused, null, 'null for a goal that is not finished');
    const [group] = page(goals).programmes.programmes;
    for (const key of ['programme', 'dormant', 'goals', 'phases', 'proposals']) assert.ok(key in group, `${key} is kept`);
    assert.equal(group.finished, 1);
    assert.equal(JSON.parse(JSON.stringify(group)).finished, 1, 'in mc --json');
  });
});
