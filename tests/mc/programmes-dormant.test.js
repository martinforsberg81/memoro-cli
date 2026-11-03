/**
 * Dormant programmes (Martin, 2026-11-02): a programme with no goal, of any
 * status, is dormant. PROGRAMMES counts the goals on its heading,
 * draws the active ones as before and folds the dormant ones into one grey
 * line pointing at `mc programs list`; `a` (expand) draws them all. `mc --json`
 * keeps every programme, flagged. `mc programs list` reads the same sources
 * through the same collector and gives the same verdict.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  intakeSection, mergesSection, programmesSection, readProgrammes, runnerSection, sessionsSection,
} from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { listingText, programmesListing, run as programs } from '../../src/mc/commands/programs.js';
import { goalJson } from './_helpers/goal-file.js';

const NOW = new Date('2026-11-02T12:00:00Z');

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

const plain = (line) => line.replace(/\u001b\[[0-9;]*m/gu, '');

/** PROGRAMMES' lines, from its heading to the next section's. */
function programmesOf(lines) {
  const text = lines.map(plain);
  const head = text.findIndex((line) => line.startsWith('  PROGRAMMES'));
  assert.ok(head >= 0, 'PROGRAMMES is drawn');
  const end = text.findIndex((line, n) => n > head && line === '');
  return text.slice(head, end < 0 ? undefined : end);
}

/**
 * Five programmes: `mc` with an open goal, `done-only` whose one goal is done,
 * `goal-only` with a blocked goal, `planned` with nothing but an open plan
 * session, and `empty` with nothing at all — a directory on main.
 */
const goalRow = (name, programme, repo, status) => ({
  name, programme, repos: [repo], status, sessions: 1,
  last: { next: null, comment: null }, running: false, problems: [],
});
const GOALS = [
  goalRow('mc-ui', 'mc', 'memoro-cli', 'open'),
  goalRow('finished', 'done-only', 'memoro', 'done'),
  goalRow('rollout', 'goal-only', 'memoro', 'blocked'),
];
const SESSION = { verb: 'plan', area: 'plan/planned', tool: 'claude-code', pid: 1 };
const section = () => programmesSection({
  goalRows: GOALS,
  planning: { planned: SESSION },
  planningSessions: { planned: [SESSION] },
  programmes: ['empty', 'mc'],
});

describe('dormant programmes in the collector', () => {
  it('flags each programme and counts its goals', () => {
    const programmes = section();
    const verdict = Object.fromEntries(programmes.programmes.map((group) => [group.programme, group.dormant]));
    assert.deepEqual(verdict, {
      'done-only': false, // only a done goal: still a programme with work on it
      empty: true,
      'goal-only': false, // a blocked goal
      mc: false,
      planned: true, // only a plan session: nothing is on it yet
    });
    assert.equal(programmes.active, 3);
    assert.equal(programmes.dormant, 2);
    assert.equal(programmes.active + programmes.dormant, programmes.programmes.length);
  });
});

describe('dormant programmes on the page', () => {
  it('draws only active programmes, and one line for the dormant ones under the heading', () => {
    const lines = programmesOf(renderPageLines(pageData({ programmes: section() }), { columns: 120, now: NOW }));
    assert.match(lines[0], /^ {2}PROGRAMMES {2}3 active · 2 dormant · 3 goals {2}/u);
    assert.equal(lines[1], '  2 dormant · 1 with a plan session · mc programs list');
    assert.ok(!lines.some((line) => /no goal yet/u.test(line)), lines.join('\n'));
    for (const name of ['mc', 'done-only', 'goal-only']) {
      assert.ok(lines.some((line) => line.startsWith(`  ${name} `)), `${name} has its heading`);
    }
    for (const name of ['empty', 'planned']) {
      assert.ok(!lines.some((line) => line.startsWith(`  ${name} `)), `${name} draws no heading`);
    }
  });

  it('leaves the plan-session count out when no dormant programme has one', () => {
    const programmes = programmesSection({ goalRows: GOALS.slice(0, 2), programmes: ['empty'] });
    const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW }));
    assert.equal(lines[1], '  1 dormant · mc programs list');
    assert.match(lines[0], /2 active · 1 dormant · 2 goals/u);
  });

  it('draws no dormant line when every programme is active', () => {
    const programmes = programmesSection({ goalRows: GOALS.slice(0, 1) });
    const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW }));
    assert.match(lines[0], /1 active · 0 dormant · 1 goal {2}/u);
    assert.ok(!lines.some((line) => /mc programs list/u.test(line)));
  });

  it('expanded, draws every programme as before, with no dormant line, and keeps the numbers', () => {
    const data = pageData({ programmes: section() });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW, expand: true }));
    for (const name of ['done-only', 'empty', 'goal-only', 'mc', 'planned']) {
      assert.ok(lines.some((line) => line.startsWith(`  ${name} `)), `${name} has its heading`);
    }
    assert.ok(lines.some((line) => /^ {2}empty +no goal yet/u.test(line)));
    assert.ok(!lines.some((line) => /mc programs list/u.test(line)));
    const numbers = data.programmes.programmes.flatMap((group) => group.goals).map((row) => row.number);
    assert.deepEqual(numbers.sort(), [1, 2, 3]);
  });
});

describe('mc programs', () => {
  const read = () => ({ section: section(), homes: { empty: ['memoro'], mc: ['memoro-cli'] } });

  it('lists every programme, sorted by name, with the collector’s verdict', () => {
    const listing = programmesListing(read());
    assert.equal(listing.active, 3);
    assert.equal(listing.dormant, 2);
    assert.deepEqual(listing.programmes.map((item) => [item.name, item.state]), [
      ['done-only', 'active'], ['empty', 'dormant'], ['goal-only', 'active'], ['mc', 'active'], ['planned', 'dormant'],
    ]);
    const byName = Object.fromEntries(listing.programmes.map((item) => [item.name, item]));
    assert.deepEqual(byName.empty.repos, ['memoro'], 'a dormant programme says where it lives');
    assert.deepEqual(byName['goal-only'].repos, ['memoro']);
    assert.deepEqual(byName['done-only'].statuses, { done: 1 });
    assert.ok(!('projects' in byName.mc), 'no project count');
    assert.equal(byName['goal-only'].goals, 1);
    assert.deepEqual(byName.planned.plan_sessions, { claude: 1 });
  });

  it('says it in the page’s words, one line each', () => {
    const lines = listingText(programmesListing(read())).trimEnd().split('\n');
    assert.equal(lines[0], 'programmes — 3 active · 2 dormant');
    assert.equal(lines.length, 6);
    assert.match(lines[1], /^ {2}done-only +active +memoro +1 goal · done 1 +no plan session$/u);
    assert.match(lines[2], /^ {2}empty +dormant +memoro +no goal +no plan session$/u);
    assert.match(lines[3], /^ {2}goal-only +active +memoro +1 goal · blocked 1 +no plan session$/u);
    assert.match(lines[5], /^ {2}planned +dormant +— +no goal +plan claude 1$/u);
  });

  it('prints the list, or the same as data with --json', async () => {
    let out = '';
    const stdout = { write: (text) => { out += text; } };
    assert.equal(await programs(['list'], { stdout, read }), 0);
    assert.equal(out, listingText(programmesListing(read())));
    out = '';
    assert.equal(await programs(['list', '--json'], { stdout, read }), 0);
    assert.deepEqual(JSON.parse(out), programmesListing(read()));
  });

  it('prints its usage alone with exit 0, and refuses what it does not know with exit 2', async () => {
    let out = '';
    let err = '';
    const deps = { stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } }, read };
    assert.equal(await programs([], deps), 0);
    assert.match(out, /^usage — mc programs list \[--json\]/u);
    assert.equal(await programs(['show'], deps), 2);
    assert.match(err, /mc programs has no show/u);
    assert.equal(await programs(['list', 'extra'], deps), 2);
    assert.equal(await programs(['list', '--all'], deps), 2);
  });

  it('reads the page’s sources: the tree’s programmes, the goals and the plan sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-programs-'));
    try {
      const goal = join(root, 'programs', 'goal-only', 'goals', 'rollout');
      mkdirSync(goal, { recursive: true });
      writeFileSync(join(goal, 'GOAL.json'), goalJson({ status: 'open', repos: ['memoro'], class: 'fast', created: '2026-11-02T00:00:00Z', title: 'Rollout' }));
      writeFileSync(join(goal, 'LOG.md'), '');
      mkdirSync(join(root, 'runner', 'foreground'), { recursive: true });
      writeFileSync(join(root, 'runner', 'foreground', '1.json'), JSON.stringify({ ...SESSION, pid: process.pid }));
      const repo = { name: 'memoro', git: root, path: root };
      const { section: read, homes } = readProgrammes({
        env: { MC_WORK_ROOT: root, MC_HOME: join(root, 'home') },
        now: NOW,
        repos: [repo],
        alive: () => true,
        programmes: () => ['empty'],
      });
      assert.deepEqual(homes, { empty: ['memoro'] });
      const verdict = Object.fromEntries(read.programmes.map((group) => [group.programme, group.dormant]));
      assert.deepEqual(verdict, { empty: true, 'goal-only': false, planned: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
