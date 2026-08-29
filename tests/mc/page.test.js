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
  collectPage, countNewErrors, decisionsSection, intakeSection, newErrorLines, nowSection, queueSection,
  workSection,
} from '../../src/mc/page-collect.js';
import { colourFor, columnsFor, renderPage, renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';
import { run as page } from '../../src/mc/commands/home.js';

const NOW = new Date('2026-08-29T12:00:00Z');

const PLANS = [
  { repo: 'memoro', programme: 'assistant-avatar', project: 'avatar-self-serve', status: 'waiting-decision', next: 'Answer decision 4' },
  { repo: 'memoro', programme: 'docx-editing-surface', project: 'docx-editor', status: 'ready', next: 'Measure paste and IME' },
  { repo: 'memoro-cli', programme: 'mc', project: 'mc-ui', status: 'ready', next: 'Step 3 — the page' },
  { repo: 'memoro-cli', programme: 'mc', project: 'mc-run', status: 'done', next: 'nothing' },
];
const DECISIONS = [
  { area: 'org-update', file: 'org-update/decisions/network-review-1.md', title: '1. A durable graph model?', answered: false },
  { area: 'pdf', file: 'pdf/decisions/document-pipeline-1.md', title: '1. How does PDF extraction fit?', answered: false },
  { area: 'mc-ui', file: 'mc-ui/decisions/mc-3.md', title: '3. What is bare mc?', answered: true },
  { area: 'swedish-grammar', file: 'swedish-grammar/decisions/language-content-1.md', title: '1. Which corpus?', answered: false },
  { area: 'legal-work', file: 'legal-work/decisions/legal-2.md', title: '2. Recurrence guard?', answered: false },
];
const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-29T09:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-29T10:00:00Z\tmc-ui\tstep\t0\t652\t440\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-29T11:00:00Z\tavatar-self-serve\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = runsSince(TSV, new Date('2026-08-28T12:00:00Z'));
const live = () => true;

describe('NOW', () => {
  const RUNNER = { pid: 4242, started: '2026-08-29T10:00:00Z' };
  const CURRENT = {
    name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };

  it('carries the step, the tmux areas, the foreground verbs and the day behind them', () => {
    const now = nowSection({
      runner: RUNNER,
      currents: [CURRENT],
      stop: true,
      rows: ROWS,
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      foreground: [{ verb: 'brief', area: 'brief', tool: 'claude', model: 'opus', pid: 99 }],
      now: NOW,
      alive: live,
    });
    assert.equal(now.steps[0].name, 'mc-ui');
    assert.equal(now.steps[0].elapsed_seconds, 1200);
    assert.equal(now.steps[0].budget_seconds, 5400);
    assert.equal(now.stop, true);
    assert.deepEqual(now.live.map((area) => area.name), ['docx-editor']);
    assert.deepEqual(now.foreground.map((item) => item.verb), ['brief']);
    assert.equal(now.day.steps, 3);
    assert.equal(now.day.timeout, 1);
    assert.ok(now.day.cost > 7 && now.day.cost < 8, `≈ $7.3 list: ${now.day.cost}`);
  });

  // `mc run` drives one lane per repository at the same time, so NOW is a
  // list: one line for memoro's step and one for memoro-cli's.
  it('carries one step per lane when two lanes are running', () => {
    const now = nowSection({
      runner: RUNNER,
      currents: [CURRENT, {
        name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus',
        budget_minutes: 90, started: '2026-08-29T11:50:00Z', pid: 4243, worktree: '/w/docx-editor/memoro',
      }],
      rows: ROWS,
      now: NOW,
      alive: live,
    });
    assert.deepEqual(now.steps.map((step) => step.repo), ['memoro', 'memoro-cli']);
    assert.deepEqual(now.steps.map((step) => step.name), ['docx-editor', 'mc-ui']);
  });

  it('drops a registered foreground session whose process is gone', () => {
    const now = nowSection({
      foreground: [{ verb: 'brief', pid: 99 }, { verb: 'plan', pid: 100 }],
      now: NOW,
      alive: (pid) => pid === 100,
    });
    assert.deepEqual(now.foreground.map((item) => item.verb), ['plan']);
    assert.deepEqual(now.steps, []);
    assert.equal(now.day.steps, 0);
  });
});

describe('QUEUE', () => {
  it('counts the depth and what is runnable, names the next few, and counts the skips by reason', () => {
    const queue = queueSection({
      queue: ['mc-ui', 'docx-editor', 'avatar-self-serve', 'mc-run', 'brand-new'],
      plans: PLANS,
      live: ['docx-editor'],
      named: 2,
    });
    assert.equal(queue.depth, 5);
    assert.equal(queue.runnable, 1);
    assert.deepEqual(queue.next.map((item) => [item.name, item.kind]), [['mc-ui', 'step']]);
    assert.equal(queue.more, 0);
    assert.equal(queue.skipped.count, 4);
    assert.deepEqual(queue.skipped.reasons, {
      live: 1, 'waiting-decision': 1, done: 1, 'no-plan': 1,
    });
  });

  it('says how many runnable it did not name', () => {
    const queue = queueSection({ queue: ['mc-ui', 'docx-editor'], plans: PLANS, named: 1 });
    assert.deepEqual(queue.next.map((item) => item.name), ['mc-ui']);
    assert.equal(queue.more, 1);
  });
});

describe('DECISIONS', () => {
  it('counts only the unanswered and names the first few', () => {
    const decisions = decisionsSection(DECISIONS);
    assert.equal(decisions.count, 4);
    assert.deepEqual(decisions.first.map((d) => d.file.split('/').at(-1)), [
      'network-review-1.md', 'document-pipeline-1.md', 'language-content-1.md',
    ]);
    assert.equal(decisions.more, 1);
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
      digest: { name: 'errors-2026-08-29.md', text: DIGEST, mtime_ms: Date.parse('2026-08-29T10:00:00Z') },
      proposals: ['2026-08-29-one.md', '2026-08-29-two.md'],
      now: NOW,
    });
    assert.equal(intake.date, '2026-08-29');
    assert.equal(intake.age_seconds, 7200);
    assert.equal(intake.new_errors, 2);
    assert.equal(intake.loud, 1);
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
    const intake = intakeSection({ digest: { name: 'errors-2026-08-29.md', text: many, mtime_ms: null }, named: 3 });
    assert.equal(intake.new_errors, 5);
    assert.equal(intake.loud, 4);
    assert.deepEqual(intake.loud_lines, ['`one` — 90x 500 — the first', '`two` — 80x 500 — the second', '`three` — 70x 500 — the third']);
    assert.equal(intake.more_loud, 1);

    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    const at = lines.findIndex((line) => /^ {2}INTAKE/u.test(line));
    assert.match(lines[at + 1], /^ {2} {2}! {2}`one` — 90x 500 — the first$/u, 'the `!` lines come first, right under the heading');
    assert.match(lines[at + 4], /… 1 more above the threshold/u);
  });

  it('has no `!` lines to print on a quiet day', () => {
    const intake = intakeSection({
      digest: { name: 'errors-2026-08-29.md', text: '## New since the last digest\n\n_nothing new_\n', mtime_ms: null },
    });
    assert.deepEqual(intake.loud_lines, []);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    const at = lines.findIndex((line) => /^ {2}INTAKE/u.test(line));
    assert.equal(lines[at + 1], '', 'nothing between the heading and the next section');
  });

  it('says there is no digest rather than a zero that looks like health', () => {
    const intake = intakeSection({ digest: null, proposals: [], now: NOW });
    assert.equal(intake.digest, null);
    assert.equal(intake.new_errors, 0);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    assert.ok(lines.some((line) => /INTAKE {2}no digest yet — mc helper has not run/u.test(line)), lines.join('\n'));
  });
});

describe('WORK', () => {
  const AREAS = [
    { name: 'docx-editor', mtime_ms: Date.parse('2026-08-29T08:00:00Z') },
    { name: 'mc-ui', mtime_ms: Date.parse('2026-08-29T11:50:00Z') },
    { name: 'ui-fixes', mtime_ms: Date.parse('2026-08-20T08:00:00Z') },
    { name: 'avatar-self-serve', mtime_ms: Date.parse('2026-08-29T09:00:00Z') },
  ];

  const workFixture = (over = {}) => workSection({
    areas: AREAS,
    plans: PLANS,
    rows: ROWS,
    openPrs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }, { repo: 'memoro', number: 2, headRefName: 'elsewhere' }],
    live: ['ui-fixes'],
    ...over,
  });

  it('numbers one row per workarea, live first and then by last activity', () => {
    const work = workFixture();
    assert.deepEqual(work.areas.map((area) => [area.number, area.name]), [
      [1, 'mc-ui'], [2, 'avatar-self-serve'], [3, 'docx-editor'],
    ]);
    const ui = work.areas.find((area) => area.name === 'mc-ui');
    assert.equal(ui.status, 'ready');
    assert.equal(ui.next, 'Step 3 — the page');
    assert.equal(ui.pr, 440);
    assert.deepEqual(ui.last, { ts: '2026-08-29T10:00:00Z', kind: 'step', pr: '440', note: 'success,merged' });
    // mc-run has a plan and no workarea; it is a number, not a row.
    assert.equal(work.count, 4);
    assert.equal(work.without_workarea, 1);
  });

  /**
   * A workarea with no plan on main is not one of the rows above. Nothing
   * removes it, so it belongs under a heading of its own — with what says
   * whether anything would be lost by removing it by hand.
   */
  it('puts a workarea with no plan on main under its own heading, numbered after the rest', () => {
    const work = workFixture({ detail: { 'ui-fixes': { uncommitted: 3, last_commit: '2026-08-20' } } });
    assert.deepEqual(work.unplanned.map((area) => [area.number, area.name]), [[4, 'ui-fixes']]);
    const orphan = work.unplanned[0];
    assert.equal(orphan.status, null);
    assert.equal(orphan.live, true, 'live or not, it is still nobody\u2019s plan');
    assert.equal(orphan.unplanned, true);
    assert.equal(orphan.uncommitted, 3);
    assert.equal(orphan.last_commit, '2026-08-20');
    assert.equal(work.count, 4, 'the count is every workarea, planned or not');
    assert.equal(work.areas.some((area) => area.name === 'ui-fixes'), false);
  });

  it('numbers through both lists, so the page has no two rows with one number', () => {
    const work = workFixture();
    const numbers = [...work.areas, ...work.unplanned].map((area) => area.number);
    assert.deepEqual(numbers, [1, 2, 3, 4]);
  });

  it('names the repository a workarea holds when no plan names one', () => {
    const work = workSection({ areas: [{ name: 'msr-track-1', mtime_ms: 1, repos: ['memoro'] }], plans: [] });
    assert.equal(work.unplanned[0].repo, 'memoro');
  });
});

/** The page's data with one section replaced — everything else is empty. */
function pageData(over = {}) {
  return {
    now: nowSection({ rows: [], now: NOW, alive: () => false }),
    queue: queueSection({ queue: [], plans: [] }),
    decisions: decisionsSection([]),
    intake: intakeSection({ digest: null, proposals: [], now: NOW }),
    work: workSection({ areas: [], plans: [] }),
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/** The whole page, with every section carrying something. */
const DATA = pageData({
  now: nowSection({
    runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
    currents: [{
      name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
      started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
    }],
    stop: true,
    rows: ROWS,
    live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
    now: NOW,
    alive: live,
  }),
  queue: queueSection({ queue: ['mc-ui', 'docx-editor', 'mc-run'], plans: PLANS, live: ['docx-editor'] }),
  decisions: decisionsSection(DECISIONS),
  intake: intakeSection({
    digest: {
      name: 'errors-2026-08-29.md',
      text: '## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n',
      mtime_ms: Date.parse('2026-08-29T11:00:00Z'),
    },
    proposals: ['a.md'],
    now: NOW,
  }),
  work: workSection({
    areas: [{ name: 'mc-ui', mtime_ms: Date.parse('2026-08-29T11:50:00Z') }, { name: 'ui-fixes', mtime_ms: 0 }],
    plans: PLANS,
    rows: ROWS,
    openPrs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }],
    live: [],
  }),
  caches: { fresh: false, plans: [], prs: { fetched: '2026-08-29T10:00:00Z', age_seconds: 7200, count: 1 } },
  notes: ['PRs from cache, 2 h old — --fresh asks GitHub', 'no queue.md'],
});

describe('the page', () => {
  it('prints the five sections in order, with the counts and the verb that expands each', () => {
    const text = renderPage(DATA, { columns: 120, version: '0.7.11', now: NOW });
    const at = ['NOW', 'QUEUE', 'DECISIONS', 'INTAKE', 'WORK'].map((head) => text.indexOf(`  ${head}`));
    assert.ok(at.every((index, n) => index >= 0 && (n === 0 || index > at[n - 1])), text);
    assert.match(text, /MEMORO·CLI {2}0\.7\.11/u);
    assert.match(text, /4 decisions {2}· {2}1 of 3 queued/u);
    assert.match(text, /● mc-ui\s+step · claude opus · 20 min of 90 min · pid 4242/u);
    assert.match(text, /■ STOP requested — the runner exits after the steps it is in/u);
    assert.match(text, /◆ docx-editor\s+tmux mc-docx-editor · open 60 min/u);
    assert.match(text, /runner up 120 min · 3 steps in 24 h — merged 1, open 1, failed 0, timed out 1 · ≈\$7\.\d\d list \(opus, 2026-06\)/u);
    assert.match(text, /QUEUE {2}1 runnable of 3\s+mc status <name>/u);
    assert.match(text, /skipped 2 \(live 1, done 1\)/u);
    assert.match(text, /DECISIONS {2}4 waiting\s+mc brief/u);
    assert.match(text, /… 1 more/u);
    assert.match(text, /INTAKE {2}2026-08-29 \(60 min old\) · 1 new error \(1 loud\) · 1 proposal\s+mc helper/u);
    assert.match(text, /WORK {2}2 workareas\s+mc status <name>/u);
    assert.match(text, / {2}1 · mc-ui\s+ready\s+Step 3 — the page\s+08-29 10:00Z step #440/u);
    assert.match(text, / {2}2 · ui-fixes\s+—\s+no PLAN\.md on main/u);
    assert.match(text, /3 project\(s\) on main without a workarea/u);
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
      assert.ok(lines.some((line) => /NOW/u.test(line)), `${columns} columns lost NOW`);
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
    assert.deepEqual(Object.keys(parsed), ['now', 'queue', 'decisions', 'intake', 'work', 'caches', 'notes']);
    assert.equal(parsed.work.areas[0].name, 'mc-ui');
    assert.equal(parsed.queue.runnable, 1);
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
    writeFileSync(join(root, 'queue.md'), '# the queue\nmc-ui\ndocx-editor\n');
    mkdirSync(join(root, 'org-update', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'org-update', 'decisions', 'network-review-1.md'), '# 1. A durable graph model?\n\n## Rekommendation\n\nA.\n');
    mkdirSync(join(root, 'intake', 'proposals'), { recursive: true });
    writeFileSync(join(root, 'intake', 'errors-2026-08-29.md'), '# Errors\n\n## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n');
    writeFileSync(join(root, 'intake', 'proposals', '2026-08-29-one.md'), '# A proposal\n');
    for (const area of ['mc-ui', 'docx-editor']) mkdirSync(join(root, area, 'memoro-cli', '.git'), { recursive: true });
    return root;
  }

  it('builds every section from the files, offline, without git, gh or tmux', async () => {
    const root = workRootFixture();
    const asked = [];
    const data = await collectPage({
      env: { MC_WORK_ROOT: root },
      now: NOW,
      repos: [],
      exec: async (cmd) => { asked.push(cmd); return { ok: false, stdout: '' }; },
      run: (cmd) => { asked.push(cmd); return { status: 1, stdout: '' }; },
      cache: {
        loadPlans: () => ({ plans: PLANS, sources: [{ repo: 'memoro-cli', sha: 'aaa', cached: true }] }),
        loadPrs: () => ({ prs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }], fetched: '2026-08-29T10:00:00Z', age_seconds: 7200 }),
        savePrs: () => { throw new Error('savePrs on the offline page'); },
      },
    });
    assert.deepEqual(asked, ['tmux'], 'the default page runs no fetch and no gh');
    assert.deepEqual(data.now.steps.map((step) => step.name), ['docx-editor', 'mc-ui'],
      'one current-<repo>.json per lane, and the page reads every one of them');
    assert.deepEqual(data.now.foreground.map((item) => item.verb), ['brief']);
    assert.equal(data.now.day.steps, 3);
    assert.equal(data.queue.depth, 2, 'the comment line is not a project');
    assert.equal(data.queue.runnable, 2);
    assert.equal(data.decisions.count, 1);
    assert.equal(data.intake.new_errors, 1);
    assert.deepEqual(data.intake.loud_lines, ['`abc` — 41x 500 — loud']);
    assert.equal(data.intake.proposals, 1);
    assert.deepEqual(data.work.areas.map((area) => area.name).sort(), ['docx-editor', 'mc-ui']);
    assert.equal(data.work.areas.find((area) => area.name === 'mc-ui').pr, 440);
    assert.equal(data.work.without_workarea, 2);
    assert.equal(data.caches.fresh, false);
    assert.equal(data.caches.prs.age_seconds, 7200);
    // The whole page renders from it without throwing.
    assert.match(renderPage(data, { columns: 100, now: NOW }), /WORK {2}2 workareas/u);
  });

  it('--fresh fetches, asks GitHub and refills the PR cache', async () => {
    const root = workRootFixture();
    const asked = [];
    let saved = null;
    const data = await collectPage({
      env: { MC_WORK_ROOT: root },
      now: NOW,
      repos: [{ name: 'memoro-cli', path: process.cwd() }],
      fresh: true,
      exec: async (cmd, args) => {
        asked.push(`${cmd} ${args[0] === '-C' ? args[2] : args[0]}`);
        return { ok: true, stdout: cmd === 'gh' ? '[{"number":440,"headRefName":"mc-ui"}]' : '' };
      },
      run: () => ({ status: 1, stdout: '' }),
      cache: {
        loadPlans: () => ({ plans: PLANS, sources: [{ repo: 'memoro-cli', sha: 'aaa', cached: false }] }),
        loadPrs: () => { throw new Error('loadPrs under --fresh'); },
        savePrs: ({ prs }) => { saved = prs; return { prs, fetched: '2026-08-29T12:00:00Z', age_seconds: 0 }; },
      },
    });
    assert.deepEqual(asked.sort(), ['gh pr', 'git fetch']);
    assert.deepEqual(saved, [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }]);
    assert.equal(data.caches.fresh, true);
    assert.equal(data.work.areas.find((area) => area.name === 'mc-ui').pr, 440);
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
 * A row's colours in order — `bold+white grey` for a painted name followed by
 * a painted count. The palette is a table, and this is how a test reads one
 * row of it back without pinning the escape bytes themselves.
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
  const SNAPSHOT = [
    '',
    'bold+white grey grey yellow+bold grey white grey grey', //   MEMORO·CLI 0.7.11 ── 4 decisions · 1 of 3 queued · ≈$7.28 today
    '',
    'bold+cyan', //                                               NOW
    'green bold+white green grey grey grey white grey grey', //  ● mc-ui  step · claude opus · 20 min of 90 min · pid 4242
    'red+bold grey', //                                          ■ STOP requested — the runner exits after the steps it is in
    'yellow bold+white grey', //                                 ◆ docx-editor  tmux mc-docx-editor · open 60 min
    'grey', //                                                     runner up 120 min · 3 steps in 24 h — …
    '',
    'bold+cyan grey grey', //                                      QUEUE  1 runnable of 3            mc status <name>
    'grey bold+white green', //                                      1  mc-ui  step
    'dim+grey', //                                                   skipped 2 (live 1, done 1)
    '',
    'bold+cyan grey grey', //                                      DECISIONS  4 waiting              mc brief
    'yellow grey white', //                                        ● org-update/…/network-review-1.md  1. A durable graph model?
    'yellow grey white',
    'yellow grey white',
    'grey', //                                                     … 1 more
    '',
    'bold+cyan green grey red grey yellow grey', //                INTAKE  2026-08-29 (60 min old) · 1 new error (1 loud) · 1 proposal
    'red bold+white', //                                           !  `abc` — 41x 500 — loud
    '',
    'bold+cyan grey grey', //                                      WORK  2 workareas                 mc status <name>
    'grey grey white green grey green cyan', //                      1 · mc-ui  ready  Step 3 — the page  08-29 10:00Z step #440
    'grey', //                                                       3 project(s) on main without a workarea
    '',
    'grey', //                                                     1 workarea with no plan on main — nothing removes them
    'grey grey grey dim+grey grey', //                               2 · ui-fixes  —  no PLAN.md on main
    '',
    'grey', //                                                     offline, PRs 2 h old — --fresh asks GitHub
    'grey', //                                                     note: no queue.md
  ];

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
    assert.deepEqual(Object.keys(JSON.parse(out)), ['now', 'queue', 'decisions', 'intake', 'work', 'caches', 'notes']);
  });

  it('gives a step kind one colour wherever a kind is printed', () => {
    for (const [kind, tone] of [['step', 'green'], ['reconcile', 'magenta'], ['triage', 'blue'], ['brief', 'cyan'], ['plan', 'cyan']]) {
      const data = pageData({
        now: nowSection({
          runner: { pid: 4242, started: '2026-08-29T11:00:00Z' },
          currents: [{
            name: 'thing', kind, repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
            started: '2026-08-29T11:40:00Z', pid: 4242,
          }],
          now: NOW,
          alive: live,
        }),
        queue: {
          depth: 1, runnable: 1, items: [], next: [{ name: 'thing', kind }], more: 0, skipped: { count: 0, reasons: {} },
        },
        work: workSection({
          areas: [{ name: 'thing', mtime_ms: 1 }],
          plans: [{ repo: 'memoro-cli', programme: 'mc', project: 'thing', status: 'ready', next: 'go on' }],
          rows: [{ ts: '2026-08-29T10:00:00Z', name: 'thing', kind, pr: '-', note: '' }],
        }),
      });
      const lines = paintedPage(data);
      const now = signature(rowWith(lines, `● thing  `)).split(' ');
      assert.equal(now[2], tone, `NOW says ${kind} in ${now[2]}`);
      assert.equal(signature(rowWith(lines, `  1  thing`)).split(' ').at(-1), tone, `QUEUE says ${kind} in its colour`);
      assert.equal(signature(rowWith(lines, 'go on')).split(' ').at(-1), tone, `WORK says ${kind} in its colour`);
    }
  });

  it('gives a plan status one colour wherever a status is printed', () => {
    const plans = [
      { repo: 'memoro-cli', project: 'a-ready', status: 'ready', next: 'one' },
      { repo: 'memoro-cli', project: 'b-blocked', status: 'blocked', next: 'two' },
      { repo: 'memoro-cli', project: 'c-waiting', status: 'waiting-decision', next: 'three' },
      { repo: 'memoro-cli', project: 'd-done', status: 'done', next: 'four' },
    ];
    const data = pageData({
      work: workSection({ areas: plans.map((plan, n) => ({ name: plan.project, mtime_ms: 100 - n })).concat([{ name: 'e-none', mtime_ms: 0 }]), plans }),
    });
    const lines = paintedPage(data);
    for (const [name, tone] of [['a-ready', 'green'], ['b-blocked', 'red'], ['c-waiting', 'yellow'], ['d-done', 'grey']]) {
      assert.equal(signature(rowWith(lines, name)).split(' ')[3], tone, `${name} is ${tone}`);
    }
    // A workarea with no PLAN.md on main is grey through and through, and its
    // missing status is the dimmest thing on the page.
    assert.deepEqual(signature(rowWith(lines, 'e-none')).split(' '), ['grey', 'grey', 'grey', 'dim+grey', 'grey']);
  });

  it('turns the clock yellow near the budget and red past it', () => {
    const stepAt = (spent) => pageData({
      now: nowSection({
        runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
        currents: [{
          name: 'thing', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', budget_minutes: 90,
          started: new Date(NOW.getTime() - spent * 1000).toISOString(), pid: 4242,
        }],
        now: NOW,
        alive: live,
      }),
    });
    const clock = (spent) => signature(rowWith(paintedPage(stepAt(spent)), '● thing')).split(' ')[6];
    assert.equal(clock(600), 'white', 'ten minutes in, the clock is just a clock');
    assert.equal(clock(0.74 * 5400), 'white');
    assert.equal(clock(0.8 * 5400), 'yellow', 'past three quarters of the budget');
    assert.equal(clock(5401), 'red+bold', 'over budget');
    assert.ok(strip(rowWith(paintedPage(stepAt(5401)), '● thing')).includes('over budget'));
  });

  it('says a quota answer in yellow while it is recent, and in grey once it is history', () => {
    const quota = (last) => {
      const rows = [{
        ts: last, name: 'thing', kind: 'step', exit: '1', seconds: '10', pr: '-', note: 'quota,timeout',
      }];
      const lines = paintedPage(pageData({ now: nowSection({ rows, now: NOW, alive: () => false }) }));
      return signature(rowWith(lines, 'quota: 1 answer(s)'));
    };
    assert.equal(quota('2026-08-29T11:00:00Z'), 'yellow', 'an hour ago is why the runner is idle');
    assert.equal(quota('2026-08-29T02:00:00Z'), 'grey', 'ten hours ago is history');
  });

  it('paints a foreground verb in the cyan the verbs are printed in', () => {
    const data = pageData({
      now: nowSection({
        foreground: [{ verb: 'brief', area: 'brief', tool: 'claude', model: 'opus', pid: 99 }],
        now: NOW,
        alive: live,
      }),
    });
    assert.deepEqual(signature(rowWith(paintedPage(data), '● mc brief')).split(' ').slice(0, 2), ['cyan', 'bold+cyan']);
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
    assert.ok(/\| no PLAN\.md on main \| dim grey \|/u.test(doc));
    assert.deepEqual(signature(rowWith(paintedPage(pageData({
      work: workSection({
        areas: [{ name: 'unplanned', mtime_ms: 1 }],
        plans: [],
        rows: [{ ts: '2026-08-29T10:00:00Z', name: 'unplanned', kind: 'rebase', pr: '-', note: '' }],
      }),
    })), 'unplanned')).split(' '), ['grey', 'grey', 'grey', 'dim+grey', 'grey', 'grey', 'grey'],
    'a kind the table has no key for, on a row with no plan, is the page at its quietest');
  });

  it('says nothing about a watch in the header — there is none', () => {
    assert.ok(!strip(paintedPage(DATA)[1]).includes('watch'));
  });
});
