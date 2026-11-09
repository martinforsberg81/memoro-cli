import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { landedSection, readRunRows } from '../../src/mc/landed.js';
import { pipelineStages, sparkline } from '../../src/mc/page-render.js';

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
      sessions: { planning_sessions: { mc: [{}] } },
      runner: { sessions: [{ kind: 'plan' }, { kind: 'build' }, { kind: 'build' }, { kind: 'mend' }] },
      merges: { repos: [{ landings: [{}] }] },
    });
    const by = Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
    assert.deepEqual(stages.map((stage) => stage.stage), ['proposals', 'draft', 'build', 'review', 'finish', 'merge']);
    assert.equal(by.proposals.count, 3);
    assert.equal(by.proposals.marks[0].count, 1, 'interactive planning takes proposals');
    assert.equal(by.draft.marks[0].count, 1, 'headless planning takes drafts');
    assert.deepEqual([by.build.count, by.build.martin, by.build.blocked, by.build.marks[0].count], [2, 1, 1, 2]);
    assert.deepEqual(by.merge.marks.map((mark) => mark.count), [1, 1], 'a gate round and a mend');
  });
});
