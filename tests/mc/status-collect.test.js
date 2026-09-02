/**
 * The readers behind the page — each block built from fixture data, with no
 * git, no gh and no tmux. The five sections themselves are page.test.js and
 * the surfaces are front-door.test.js; this is the shared half underneath.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runsSince } from '../../src/mc/brief-collect.js';
import { estimateCost, priceFor } from '../../src/mc/prices.js';
import { kindFor, nowBlock, pidAlive } from '../../src/mc/status-collect.js';

/**
 * Plans as `listPlans` returns them, with the parsed plan on the record: a
 * status belongs to the first step that is not done, so a fixture says which
 * state it is in by building that step.
 */
function planRecord({ repo, programme, project, status, title }) {
  const stopped = status === 'blocked';
  const plan = {
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met: false, criterion: 'It is done.', check: 'The gate is green.' }],
    documents: [],
    steps: [{
      title,
      status,
      done_when: 'the step is finished',
      instruction: status === 'done' ? [] : ['Do it.'],
      pr: null,
      blocked_by: stopped ? { kind: status === 'blocked' ? 'project' : 'decision', name: `${programme}-1` } : null,
    }],
  };
  return { repo, programme, project, path: `docs/project/${programme}/${project}/PLAN.json`, legacy: false, plan, problems: [], status, next: title };
}

const PLANS = [
  planRecord({ repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-self-serve', status: 'blocked', title: 'Answer decision 4' }),
  planRecord({ repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-image-animation', status: 'ready', title: 'Publish Tim' }),
  planRecord({ repo: 'memoro', programme: 'docx-editing-surface', project: 'docx-editor', status: 'blocked', title: 'Wait' }),
  planRecord({ repo: 'memoro-cli', programme: 'mc', project: 'mc-status', status: 'ready', title: 'The page' }),
];
const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-25T18:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-25T19:00:00Z\tavatar-image-animation\tstep\t0\t652\t10964\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-25T19:30:00Z\tfocused-session-ui\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = runsSince(TSV, new Date('2026-08-25T00:00:00Z'));

describe('kind', () => {
  it('decides each queued name the way the runner does: only ready runs', () => {
    const ctx = { plans: PLANS };
    assert.equal(kindFor('brand-new', ctx), 'skip:no-plan', 'the runner does not write plans');
    assert.equal(kindFor('avatar-image-animation', ctx), 'step');
    assert.equal(kindFor('avatar-self-serve', ctx), 'skip:blocked', 'a blocked step is not ready');
    assert.equal(kindFor('docx-editor', ctx), 'skip:blocked');
  });
});

describe('COST', () => {
  it('prices by family, and says n/a for a model it does not know', () => {
    assert.deepEqual(priceFor('opus'), { input: 5, output: 25 });
    assert.deepEqual(priceFor('claude-fable-5'), { input: 10, output: 50 });
    assert.equal(estimateCost({ input: 1e6 }, 'gemini'), null);
    assert.equal(estimateCost({ cacheRead: 1e6 }, 'opus'), 0.5);
  });
});

describe('NOW', () => {
  const NOW = new Date('2026-08-29T10:30:00Z');
  const RUNNER = { pid: 4242, started: '2026-08-29T08:30:00Z' };
  const CURRENT = {
    name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };
  const OTHER = {
    name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:20:00Z', pid: 4243, worktree: '/w/docx-editor/memoro',
  };
  const live = () => true;
  const dead = () => false;

  it('names the step in flight with its elapsed time against its budget', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT], rows: ROWS, now: NOW, alive: live });
    assert.deepEqual(block.runner, { pid: 4242, started: '2026-08-29T08:30:00Z', alive: true, up_seconds: 7200 });
    assert.equal(block.steps.length, 1);
    assert.equal(block.steps[0].name, 'mc-ui');
    assert.equal(block.steps[0].kind, 'step');
    assert.equal(block.steps[0].tool, 'claude');
    assert.equal(block.steps[0].repo, 'memoro-cli');
    assert.equal(block.steps[0].elapsed_seconds, 1800);
    assert.equal(block.steps[0].budget_seconds, 5400);
    assert.equal(block.steps[0].over_budget, false);
    assert.deepEqual(block.stale, []);
    assert.equal(block.stop, false);
  });

  // One lane per repository, so there is one `current-<repo>.json` per lane
  // and NOW names every one of them — the file that says what is running is
  // no longer a single file.
  it('names every lane that has a step in flight', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT, OTHER], now: NOW, alive: live });
    assert.deepEqual(block.steps.map((step) => [step.name, step.repo]), [
      ['docx-editor', 'memoro'], ['mc-ui', 'memoro-cli'],
    ]);
    assert.deepEqual(block.steps.map((step) => step.elapsed_seconds), [600, 1800]);
    assert.deepEqual(block.stale, []);
  });

  it('is empty when no runner has written a file, and says so when a step is over budget', () => {
    const empty = nowBlock({ now: NOW, alive: live });
    assert.equal(empty.runner, null);
    assert.deepEqual(empty.steps, []);
    assert.deepEqual(empty.quota, { count: 0, last: null });
    const late = nowBlock({ currents: [{ ...CURRENT, started: '2026-08-29T08:00:00Z' }], now: NOW, alive: live });
    assert.equal(late.steps[0].over_budget, true);
  });

  it('a file whose pid is gone is stale, not running — and it says which lane', () => {
    const block = nowBlock({ runner: RUNNER, currents: [CURRENT, OTHER], now: NOW, alive: dead });
    assert.equal(block.runner.alive, false);
    assert.deepEqual(block.steps, []);
    assert.deepEqual(block.stale, [
      'runner.json (pid 4242 is gone)',
      'current-memoro-cli.json (pid 4242 is gone)',
      'current-memoro.json (pid 4243 is gone)',
    ]);
  });

  it('carries a pending STOP and the quota answers of the last 24 h', () => {
    const rows = runsSince([
      'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
      '2026-08-29T04:00:00Z\tmc-ui\tstep\t1\t8\t-\t1\t-\t-\t-\t-\t-\tquota',
      '2026-08-29T05:00:00Z\tmc-ui\tstep\t0\t600\t9\t9\t-\t-\t-\t-\t-\tsuccess,merged',
    ].join('\n'), new Date('2026-08-28T10:30:00Z'));
    const block = nowBlock({ runner: RUNNER, stop: true, rows, now: NOW, alive: live });
    assert.equal(block.stop, true);
    assert.deepEqual(block.quota, { count: 1, last: '2026-08-29T04:00:00Z' });
  });

  it('liveness is this process by pid, and nothing for a pid that cannot exist', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(null), false);
    assert.equal(pidAlive('nope'), false);
  });
});

