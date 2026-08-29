/**
 * The page — the five sections `mc` prints, each built from fixtures, the
 * whole page rendered at three widths, and `collectPage` against a work root
 * made of real files with no git, no gh and no tmux.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runsSince } from '../../src/mc/brief-collect.js';
import {
  collectPage, countNewErrors, decisionsSection, intakeSection, nowSection, queueSection, workSection,
} from '../../src/mc/page-collect.js';
import { colourFor, columnsFor, renderPage, renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';
import { run as page } from '../../src/mc/commands/status-page.js';

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
    name: 'mc-ui', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };

  it('carries the step, the tmux areas, the foreground verbs and the day behind them', () => {
    const now = nowSection({
      runner: RUNNER,
      current: CURRENT,
      stop: true,
      rows: ROWS,
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      foreground: [{ verb: 'brief', area: 'brief', tool: 'claude', model: 'opus', pid: 99 }],
      now: NOW,
      alive: live,
    });
    assert.equal(now.step.name, 'mc-ui');
    assert.equal(now.step.elapsed_seconds, 1200);
    assert.equal(now.step.budget_seconds, 5400);
    assert.equal(now.stop, true);
    assert.deepEqual(now.live.map((area) => area.name), ['docx-editor']);
    assert.deepEqual(now.foreground.map((item) => item.verb), ['brief']);
    assert.equal(now.day.steps, 3);
    assert.equal(now.day.timeout, 1);
    assert.ok(now.day.cost > 7 && now.day.cost < 8, `≈ $7.3 list: ${now.day.cost}`);
  });

  it('drops a registered foreground session whose process is gone', () => {
    const now = nowSection({
      foreground: [{ verb: 'brief', pid: 99 }, { verb: 'plan', pid: 100 }],
      now: NOW,
      alive: (pid) => pid === 100,
    });
    assert.deepEqual(now.foreground.map((item) => item.verb), ['plan']);
    assert.equal(now.step, null);
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

  it('numbers one row per workarea, live first and then by last activity', () => {
    const work = workSection({
      areas: AREAS,
      plans: PLANS,
      rows: ROWS,
      openPrs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }, { repo: 'memoro', number: 2, headRefName: 'elsewhere' }],
      live: ['ui-fixes'],
    });
    assert.deepEqual(work.areas.map((area) => [area.number, area.name]), [
      [1, 'ui-fixes'], [2, 'mc-ui'], [3, 'avatar-self-serve'], [4, 'docx-editor'],
    ]);
    const ui = work.areas.find((area) => area.name === 'mc-ui');
    assert.equal(ui.status, 'ready');
    assert.equal(ui.next, 'Step 3 — the page');
    assert.equal(ui.pr, 440);
    assert.deepEqual(ui.last, { ts: '2026-08-29T10:00:00Z', kind: 'step', pr: '440', note: 'success,merged' });
    // An area with no plan on main is still a row — that it has none is the
    // thing worth seeing.
    const orphan = work.areas.find((area) => area.name === 'ui-fixes');
    assert.equal(orphan.status, null);
    assert.equal(orphan.live, true);
    // mc-run has a plan and no workarea; it is a number, not a row.
    assert.equal(work.count, 4);
    assert.equal(work.without_workarea, 1);
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

describe('the page', () => {
  const DATA = pageData({
    now: nowSection({
      runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
      current: {
        name: 'mc-ui', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90,
        started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
      },
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

  it('prints the five sections in order, with the counts and the verb that expands each', () => {
    const text = renderPage(DATA, { columns: 120, version: '0.7.11', now: NOW });
    const at = ['NOW', 'QUEUE', 'DECISIONS', 'INTAKE', 'WORK'].map((head) => text.indexOf(`  ${head}`));
    assert.ok(at.every((index, n) => index >= 0 && (n === 0 || index > at[n - 1])), text);
    assert.match(text, /MEMORO·CLI {2}0\.7\.11/u);
    assert.match(text, /4 decisions {2}· {2}1 of 3 queued/u);
    assert.match(text, /● mc-ui\s+step · claude opus · 20 min of 90 min · pid 4242/u);
    assert.match(text, /■ STOP requested — the runner exits after the step it is in/u);
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
    writeFileSync(join(root, 'runner', 'current.json'), JSON.stringify({
      name: 'mc-ui', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90,
      started: '2026-08-29T11:40:00Z', pid: process.pid, worktree: `${root}/mc-ui/memoro-cli`,
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
    assert.equal(data.now.step.name, 'mc-ui');
    assert.deepEqual(data.now.foreground.map((item) => item.verb), ['brief']);
    assert.equal(data.now.day.steps, 3);
    assert.equal(data.queue.depth, 2, 'the comment line is not a project');
    assert.equal(data.queue.runnable, 2);
    assert.equal(data.decisions.count, 1);
    assert.equal(data.intake.new_errors, 1);
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
