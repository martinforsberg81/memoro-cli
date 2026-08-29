/**
 * Bare `mc status` — each block built from fixture data, no git, no gh, no
 * tmux; the whole page rendered once; and the routing between the page and
 * the old board.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runsSince } from '../../src/mc/brief-collect.js';
import { estimateCost, priceFor } from '../../src/mc/prices.js';
import {
  decisionsBlock, kindFor, nowBlock, orphanWorkareas, pidAlive, projectsBlock, renderStatus, runnerBlock,
} from '../../src/mc/status-collect.js';
import { run as page } from '../../src/mc/commands/status-page.js';
import { runMcCli } from './_helpers/mc-cli.js';

const PLANS = [
  { repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-self-serve', status: 'waiting-decision', next: 'Answer decision 4' },
  { repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-image-animation', status: 'ready', next: 'Publish Tim' },
  { repo: 'memoro', programme: 'docx-editing-surface', project: 'docx-editor', status: 'blocked', next: 'Wait' },
  { repo: 'memoro-cli', programme: 'mc', project: 'mc-status', status: 'ready', next: 'Step 1 — the page' },
];
const DECISIONS = [
  { area: 'avatar-image-animation', file: 'avatar-image-animation/decisions/assistant-avatar-4.md', title: '4. Retention?', answered: true },
  { area: 'docs-structure', file: 'docs-structure/decisions/docs-navigation-1.md', title: '1. Where do docs go?', answered: false },
  { area: 'focused-session-ui', file: 'focused-session-ui/decisions/focused-session-ui-2026-08-25.md', title: 'Contract change?', answered: false },
];
const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-25T18:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-25T19:00:00Z\tavatar-image-animation\tstep\t0\t652\t10964\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-25T19:30:00Z\tfocused-session-ui\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = runsSince(TSV, new Date('2026-08-25T00:00:00Z'));

describe('RUNNER', () => {
  it('decides each queued name the way runner.sh does', () => {
    const ctx = { plans: PLANS, decisions: DECISIONS };
    assert.equal(kindFor('brand-new', ctx), 'triage');
    assert.equal(kindFor('avatar-image-animation', ctx), 'step');
    assert.equal(kindFor('avatar-self-serve', ctx), 'step', 'waiting-decision with an answered programme file');
    assert.equal(kindFor('docx-editor', ctx), 'skip:blocked');
    const unanswered = { plans: [{ ...PLANS[0], programme: 'docs-navigation', project: 'docs-structure' }], decisions: DECISIONS };
    assert.equal(kindFor('docs-structure', unanswered), 'skip:waiting-decision');
  });

  it('names the next runnable project, skips live areas, sums and prices the day', () => {
    const block = runnerBlock({
      queue: ['docx-editor', 'avatar-image-animation', 'mc-status'], plans: PLANS, decisions: DECISIONS, rows: ROWS,
      alive: 'tmux runner', live: ['avatar-image-animation'],
    });
    assert.equal(block.next.name, 'mc-status');
    assert.deepEqual(block.queue.map((q) => [q.name, q.kind, q.live]), [
      ['docx-editor', 'skip:blocked', false], ['avatar-image-animation', 'step', true], ['mc-status', 'step', false],
    ]);
    assert.equal(block.summary.steps, 3);
    assert.equal(block.summary.timeout, 1);
    assert.equal(block.tokens.cacheRead, 3683298 + 4724690);
    assert.equal(block.tokens.output, 36423 + 33172);
    const expected = estimateCost({ input: 184, output: 69595, cacheRead: 8407988, cacheWrite: 212890 }, 'opus');
    assert.equal(block.cost, expected);
    assert.ok(block.cost > 7 && block.cost < 8, `≈ $7.3 list: ${block.cost}`);
  });

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
    name: 'mc-ui', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };
  const live = () => true;
  const dead = () => false;

  it('names the step in flight with its elapsed time against its budget', () => {
    const block = nowBlock({ runner: RUNNER, current: CURRENT, rows: ROWS, now: NOW, alive: live });
    assert.deepEqual(block.runner, { pid: 4242, started: '2026-08-29T08:30:00Z', alive: true, up_seconds: 7200 });
    assert.equal(block.step.name, 'mc-ui');
    assert.equal(block.step.kind, 'step');
    assert.equal(block.step.tool, 'claude');
    assert.equal(block.step.elapsed_seconds, 1800);
    assert.equal(block.step.budget_seconds, 5400);
    assert.equal(block.step.over_budget, false);
    assert.deepEqual(block.stale, []);
    assert.equal(block.stop, false);
  });

  it('is empty when no runner has written a file, and says so when a step is over budget', () => {
    const empty = nowBlock({ now: NOW, alive: live });
    assert.equal(empty.runner, null);
    assert.equal(empty.step, null);
    assert.deepEqual(empty.quota, { count: 0, last: null });
    const late = nowBlock({ current: { ...CURRENT, started: '2026-08-29T08:00:00Z' }, now: NOW, alive: live });
    assert.equal(late.step.over_budget, true);
  });

  it('a file whose pid is gone is stale, not running', () => {
    const block = nowBlock({ runner: RUNNER, current: CURRENT, now: NOW, alive: dead });
    assert.equal(block.runner.alive, false);
    assert.equal(block.step, null);
    assert.deepEqual(block.stale, ['runner.json (pid 4242 is gone)', 'current.json (pid 4242 is gone)']);
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

describe('DECISIONS and PROJECTS', () => {
  it('lists only unanswered files and names what waits on them', () => {
    assert.deepEqual(decisionsBlock(DECISIONS).map((d) => [d.file.split('/').at(-1), d.waits_on]), [
      ['docs-navigation-1.md', 'docs-navigation'],
      ['focused-session-ui-2026-08-25.md', 'focused-session-ui'],
    ]);
  });

  it('groups plans per repo and programme with last step, open PR and workarea', () => {
    const projects = projectsBlock({
      plans: PLANS, rows: ROWS,
      openPrs: [{ repo: 'memoro', number: 10958, headRefName: 'docx-editor' }, { repo: 'memoro-cli', number: 1, headRefName: 'other' }],
      workareas: ['docx-editor', 'avatar-image-animation'],
    });
    assert.deepEqual(Object.keys(projects), ['memoro', 'memoro-cli']);
    const docx = projects.memoro.find((r) => r.project === 'docx-editor');
    assert.equal(docx.pr, 10958);
    assert.equal(docx.workarea, true);
    assert.deepEqual(docx.last, { ts: '2026-08-25T18:00:00Z', kind: 'step', pr: '10958', note: 'success,open' });
    const self = projects.memoro.find((r) => r.project === 'avatar-self-serve');
    assert.equal(self.last, null);
    assert.equal(self.workarea, false);
    assert.equal(projects['memoro-cli'][0].pr, null);
  });

  it('finds the workareas with a checkout but no plan', () => {
    assert.deepEqual(orphanWorkareas({ workareas: ['docx-editor', 'ui-fixes', 'jobbet'], plans: PLANS }), ['ui-fixes', 'jobbet']);
  });
});

describe('the page', () => {
  it('renders the five blocks in order, and --json emits the data', async () => {
    const data = {
      now: nowBlock({
        runner: { pid: 4242, started: '2026-08-25T19:00:00Z' },
        current: { name: 'mc-status', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90, started: '2026-08-25T19:20:00Z', pid: 4242, worktree: '/w/mc-status/memoro-cli' },
        stop: true,
        rows: ROWS,
        now: new Date('2026-08-25T19:40:00Z'),
        alive: () => true,
      }),
      runner: runnerBlock({ queue: ['mc-status'], plans: PLANS, decisions: DECISIONS, rows: ROWS, alive: null }),
      decisions: decisionsBlock(DECISIONS),
      projects: projectsBlock({ plans: PLANS, rows: ROWS, workareas: ['docx-editor'] }),
      orphans: ['ui-fixes'],
      notes: ['memoro-cli: gh pr list failed'],
    };
    const text = renderStatus(data);
    const at = ['NOW', 'RUNNER', 'DECISIONS', 'PROJECTS', 'WORKAREAS WITHOUT A PROJECT'].map((h) => text.indexOf(`${h}\n`));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), text);
    assert.match(text, /  runner: pid 4242, up 40 min\n/u);
    assert.match(text, /  step: mc-status — step \(claude opus\) 20 min of 90 min\n/u);
    assert.match(text, /  STOP requested — the runner exits after the step it is in\n/u);
    assert.match(text, /not running/u);
    assert.match(text, /queue: 1 projects — next: mc-status \(step\)/u);
    assert.match(text, /≈ \$\d+\.\d\d list \(opus, prices 2026-06\); quota is the real limit/u);
    assert.match(text, /docs-navigation-1\.md  1\. Where do docs go\?  → docs-navigation/u);
    assert.match(text, /    assistant-avatar\n      avatar-image-animation/u);
    assert.match(text, /08-25 19:00Z step #10964/u);
    assert.match(text, /  ui-fixes\n/u);
    assert.match(text, /note: memoro-cli: gh pr list failed/u);

    let out = '';
    const code = await page(['--json'], { collect: async () => data, stdout: { write: (s) => { out += s; } } });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).orphans[0], 'ui-fixes');
  });

  it('refuses an unknown flag, and the help says what the bare verb is', async () => {
    let err = '';
    assert.equal(await page(['--watch'], { stderr: { write: (s) => { err += s; } } }), 2);
    assert.match(err, /unknown argument --watch/u);
    assert.match(runMcCli(['--help']).stdout, /mc status --sessions/u);
  });
});
