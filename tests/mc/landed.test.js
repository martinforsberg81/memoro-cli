import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { landedSection, readRunRows } from '../../src/mc/landed.js';
import { pipelineStages, renderPageLines, sparkline } from '../../src/mc/page-render.js';

const NOW = new Date('2026-11-09T18:00:00Z');
// The file keeps the header it was created with; later columns are appended.
const OLD_HEADER = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote';
const row = (ts, name, kind, seconds, note, { pr = '-', model = 'opus', output = 1_000_000 } = {}) =>
  [ts, name, kind, '0', seconds, pr, '1', '0', output, '0', '0', '-', note, '-', model, 'fast', 'claude', 'high', 'plan'].join('\t');

describe('landed in the last 24 hours', () => {
  const tsv = [
    OLD_HEADER,
    // Built two days ago, landed today: its whole life counts.
    row('2026-11-07T10:00:00Z', 'goal:mc/a', 'build-goal', 1200, 'success'),
    row('2026-11-09T10:00:00Z', 'goal:mc/a', 'review-goal', 600, 'success,queued'),
    row('2026-11-09T11:00:00Z', 'goal:mc/a', 'merge', 10, 'merged', { pr: '1', model: '-' }),
    // Needed a finish; its review ran on codex.
    row('2026-11-09T09:00:00Z', 'goal:mc/b', 'build-goal', 6000, 'success'),
    row('2026-11-09T10:00:00Z', 'goal:mc/b', 'review-goal', 600, 'success', { model: 'gpt-6.1-sol' }),
    row('2026-11-09T11:00:00Z', 'goal:mc/b', 'finish', 600, 'success'),
    row('2026-11-09T12:00:00Z', 'goal:mc/b', 'merge', 5, 'red', { pr: '2', model: '-' }),
    row('2026-11-09T13:00:00Z', 'goal:mc/b', 'merge', 5, 'merged', { pr: '2', model: '-' }),
    // Planning a goal is not the goal's own work.
    row('2026-11-09T08:00:00Z', 'goal:mc/a', 'plan', 9000, 'success'),
    // A plan branch's PR, and one landed before the window.
    row('2026-11-09T14:00:00Z', 'memoro-cli', 'merge', 5, 'merged', { pr: '3', model: '-' }),
    row('2026-11-08T10:00:00Z', 'goal:mc/c', 'merge', 5, 'merged', { pr: '4', model: '-' }),
  ].join('\n');
  const landed = landedSection({ rows: readRunRows(tsv), now: NOW });

  it('counts goals and pull requests without a goal apart, and every merge attempt', () => {
    assert.equal(landed.goals, 2);
    assert.equal(landed.without_goal, 1);
    assert.equal(landed.prs, 3);
    assert.equal(landed.attempts, 4);
  });

  it('sums each landed goal over its whole life without its planning, and a finish means not first pass', () => {
    assert.equal(landed.first_pass, 1);
    assert.equal(landed.sessions_per_goal, 2.5);
    assert.equal(landed.time.max_min, 120);
    assert.equal(landed.time.median_min, 30);
    assert.deepEqual(landed.time.histogram, [0, 0, 1, 0, 1, 0]);
  });

  it('prices sessions by their own model, read past the old header', () => {
    assert.equal(landed.cost.priced, 2);
    assert.equal(landed.cost.unpriced_sessions, 0);
    // A million output tokens: $20 on opus (Opus 5.5), $10 on gpt-6.1-sol.
    assert.equal(landed.cost.total, 20 + 20 + 20 + 10 + 20);
    assert.equal(landed.plan_sessions, 1);
    assert.equal(landed.plan_cost, 20, 'the planning is counted beside the goals');
  });
});

describe('the pipeline', () => {
  it('draws one bar per bucket, scaled to the largest, and a space for none', () => {
    assert.equal(sparkline([0, 1, 4, 8]), ' ▁▄█');
    assert.equal(sparkline([0, 0]), '  ');
  });

  it('puts each session in the stage it works on, and flags Martin and blocked where they stand', () => {
    const stages = pipelineStages({
      intake: { proposals: 1 },
      programmes: { programmes: [{ proposals: 2, goals: [
        { stage: 'draft', status: 'ready' }, { stage: 'build', status: 'Martin' }, { stage: 'build', status: 'blocked' },
      ] }] },
      sessions: { planning_sessions: { mc: [{}], photos: [{}] } },
      runner: { sessions: [{ kind: 'plan' }, { kind: 'build' }, { kind: 'build' }, { kind: 'mend' }] },
      merges: { repos: [{ landings: [{}] }] },
    });
    const by = Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
    assert.deepEqual(stages.map((stage) => stage.stage), ['proposals', 'draft', 'build', 'review', 'finish', 'merge']);
    assert.equal(by.proposals.count, 3);
    assert.deepEqual(by.proposals.marks, [], 'proposals carries no session marks');
    assert.equal(by.draft.marks[0].count, 3, 'every plan session, interactive (2) and headless (1), is a mark on draft');
    assert.deepEqual([by.build.count, by.build.martin, by.build.blocked, by.build.marks[0].count], [2, 1, 1, 2]);
    assert.deepEqual(by.merge.marks.map((mark) => mark.count), [1, 1], 'a gate round and a mend');
  });
});

/* The contract's mock, as data: 148 proposals; 21 drafts and three plan
 * sessions (two interactive, one headless); 51 builds, three with Martin and
 * eight sessions; one review with its session. The other stages are empty. */
const goalsIn = (stage, n, status = 'ready') => Array.from({ length: n }, () => ({ stage, status }));
const MOCK = {
  intake: { proposals: 148 },
  programmes: { programmes: [{ goals: [
    ...goalsIn('draft', 21), ...goalsIn('build', 48), ...goalsIn('build', 3, 'Martin'), ...goalsIn('review', 1),
  ] }] },
  sessions: { planning_sessions: { mc: [{}, {}] } },
  runner: { sessions: [{ kind: 'plan' }, ...Array.from({ length: 8 }, () => ({ kind: 'build' })), { kind: 'review' }] },
  merges: { repos: [] },
};
const NOTHING = { intake: { proposals: 0 }, programmes: { programmes: [] }, runner: { sessions: [] } };

/** The pipeline's rows, from the first box's top border: `rows` lines, painted as drawn. */
const pipelineOf = (lines, rows) => {
  const at = lines.findIndex((line) => line.replace(/\x1b\[[0-9;]*m/gu, '').startsWith('  ┌─ proposals '));
  assert.ok(at >= 0, 'the pipeline is drawn');
  return lines.slice(at, at + rows);
};

describe('the pipeline drawn', () => {
  const at = (columns, colour = false) => renderPageLines(MOCK, { columns, now: NOW, colour });

  it('is one row of boxes with the wide arrow at 160 columns, each box as wide as its content', () => {
    assert.deepEqual(pipelineOf(at(160), 4), [
      '  ┌─ proposals ─┐     ┌─ draft ─┐     ┌─ build ──┐     ┌─ review ─┐     ┌─ finish ─┐     ┌─ merge ─┐',
      '  │     148     │ ──▶ │   21    │ ──▶ │  51 ⚑3   │ ──▶ │    1     │ ──▶ │    0     │ ──▶ │    0    │',
      '  │             │     │   ●●●   │     │ ●●●●●●●● │     │    ●     │     │          │     │         │',
      '  └─────────────┘     └─────────┘     └──────────┘     └──────────┘     └──────────┘     └─────────┘',
    ]);
  });

  it('falls back to the narrow arrow at 100 columns, still one row', () => {
    assert.deepEqual(pipelineOf(at(100), 4), [
      '  ┌─ proposals ─┐   ┌─ draft ─┐   ┌─ build ──┐   ┌─ review ─┐   ┌─ finish ─┐   ┌─ merge ─┐',
      '  │     148     │ ▶ │   21    │ ▶ │  51 ⚑3   │ ▶ │    1     │ ▶ │    0     │ ▶ │    0    │',
      '  │             │   │   ●●●   │   │ ●●●●●●●● │   │    ●     │   │          │   │         │',
      '  └─────────────┘   └─────────┘   └──────────┘   └──────────┘   └──────────┘   └─────────┘',
    ]);
  });

  it('is three and three on two rows, each keeping its arrows, at 72 columns', () => {
    assert.deepEqual(pipelineOf(at(72), 8), [
      '  ┌─ proposals ─┐     ┌─ draft ─┐     ┌─ build ──┐',
      '  │     148     │ ──▶ │   21    │ ──▶ │  51 ⚑3   │',
      '  │             │     │   ●●●   │     │ ●●●●●●●● │',
      '  └─────────────┘     └─────────┘     └──────────┘',
      '  ┌─ review ─┐     ┌─ finish ─┐     ┌─ merge ─┐',
      '  │    1     │ ──▶ │    0     │ ──▶ │    0    │',
      '  │    ●     │     │          │     │         │',
      '  └──────────┘     └──────────┘     └─────────┘',
    ]);
  });

  it('keeps every line within the page, at each width', () => {
    for (const columns of [160, 100, 72]) {
      for (const line of at(columns)) assert.ok(line.length <= columns, `${columns} columns: ${line}`);
    }
  });

  it('draws more than eight marks of a kind as one mark and its count', () => {
    const busy = { ...MOCK, runner: { sessions: Array.from({ length: 9 }, () => ({ kind: 'build' })) } };
    const [, , marks] = pipelineOf(renderPageLines(busy, { columns: 160, now: NOW }), 3);
    assert.match(marks, /│ +●×9 +│/u);
    assert.doesNotMatch(marks, /●{9}/u);
  });

  it('draws an empty pipeline: each box its name and a grey zero, no marks', () => {
    const [top, counts, marks] = pipelineOf(renderPageLines(NOTHING, { columns: 160, now: NOW }), 3);
    assert.equal(top, '  ┌─ proposals ─┐     ┌─ draft ─┐     ┌─ build ─┐     ┌─ review ─┐     ┌─ finish ─┐     ┌─ merge ─┐');
    assert.equal(counts, '  │      0      │ ──▶ │    0    │ ──▶ │    0    │ ──▶ │    0     │ ──▶ │    0     │ ──▶ │    0    │');
    assert.equal(marks, '  │             │     │         │     │         │     │          │     │          │     │         │');
  });

  it('paints each border and its marks in the stage colour, an empty stage grey, the name bold, the count bold or grey', () => {
    // One stage of each colour: proposals yellow (waiting), draft blue (a plan
    // session), build green (a blocked goal does not change its border), review
    // magenta (a session), finish grey (empty), merge orange (a gate round, and
    // a mend in yellow).
    const data = {
      intake: { proposals: 2 },
      programmes: { programmes: [{ goals: [
        { stage: 'draft', status: 'ready' }, { stage: 'build', status: 'blocked' }, { stage: 'build', status: 'ready' },
      ] }] },
      sessions: { planning_sessions: { mc: [{}] } },
      runner: { sessions: [{ kind: 'review' }, { kind: 'mend' }] },
      merges: { repos: [{ landings: [{}] }] },
    };
    const painted = renderPageLines(data, { columns: 160, now: NOW, colour: true });
    const [top, counts, marks, bottom] = pipelineOf(painted, 4);
    for (const [stage, code] of [['proposals', '33'], ['draft', '34'], ['build', '32'], ['review', '35'], ['finish', '90'], ['merge', '38;5;208']]) {
      assert.ok(top.includes(`\x1b[${code}m┌─ \x1b[0m\x1b[1m${stage}\x1b[0m`), `${stage}: its border and its name`);
    }
    assert.ok(top.includes('\x1b[90m┌─ \x1b[0m\x1b[1mfinish\x1b[0m'), 'empty is the real grey, not the mapped white');
    assert.ok(!top.includes('\x1b[37m┌'), 'no border is the mapped white');
    assert.ok(marks.includes('\x1b[34m●\x1b[0m'), 'a plan session on draft is blue');
    assert.ok(marks.includes('\x1b[35m●\x1b[0m'), 'a review session is magenta');
    assert.ok(marks.includes('\x1b[38;5;208m◎\x1b[0m'), 'a gate round is merge\'s orange');
    assert.ok(marks.includes('\x1b[33m↺\x1b[0m'), 'a mend is yellow');
    assert.match(counts, /\x1b\[1m2\x1b\[0m/u, 'a count above zero is bold');
    assert.match(counts, /\x1b\[37m0\x1b\[0m/u, 'a zero count is grey text (the page maps it)');
    assert.match(counts, /\x1b\[31m ⊘1\x1b\[0m/u, 'the blocked flag keeps its red');
    assert.match(counts, /\x1b\[90m ─*▶ \x1b\[0m/u, 'arrows are grey');
    assert.deepEqual(pipelineOf(painted, 4).map((line) => line.replace(/\x1b\[[0-9;]*m/gu, '')),
      pipelineOf(renderPageLines(data, { columns: 160, now: NOW }), 4), 'painted and plain rows are the same text');
    assert.ok(bottom.includes('\x1b[38;5;208m└'), 'the bottom border carries the stage colour');
  });
});
