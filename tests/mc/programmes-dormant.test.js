/**
 * Dormant programmes (Martin, 2026-11-02): a programme with no goal, of any
 * status, is dormant. a programme's heading counts its goals; the overview draws
 * the programmes with something under way as frames and folds the rest into one frame; `a` (expand) draws them all. `mc --json`
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

/** The programme frames' lines, from the first heading to the next section's (MAINTENANCE or MERGE). */
function programmesOf(lines) {
  const text = lines.map(plain);
  const head = text.findIndex((line) => /^ {6}┌─ (?:\d+ {2})?[a-z][a-z-]*(?: |$)/u.test(line) || /^ {6}┌─ \d+ programmes? with nothing under way/u.test(line));
  assert.ok(head >= 0, 'a programme frame is drawn');
  const end = text.findIndex((line, n) => n > head && /^ {2}┌─ (?:MAINTENANCE|MERGE )/u.test(line));
  return text.slice(head, end < 0 ? undefined : end);
}

/**
 * Five programmes: `mc` with an open goal, `done-only` whose one goal is done,
 * `goal-only` with a blocked goal, `planned` with nothing but an open plan
 * session, and `empty` with nothing at all — a directory on main.
 */
const goalRow = (name, programme, repo, status) => ({
  name, programme, repos: [repo], stage: status === 'done' ? 'done' : 'build',
  status: status === 'blocked' ? 'blocked' : 'ready', sessions: 1,
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

/** Whether a frame headed `name` is drawn among `lines`. */
const framed = (lines, name) => lines.some((line) => new RegExp(`^ {6}┌─ (?:\\d+ {2})?${name}(?: |$)`, 'u').test(line));

describe('programmes with nothing under way on the page', () => {
  it('draws the programmes under way as frames, and the rest as one folded frame', () => {
    const lines = programmesOf(renderPageLines(pageData({ programmes: section() }), { columns: 120, now: NOW }));
    assert.ok(lines.some((line) => /^ {6}┌─ 2 programmes with nothing under way · a shows them ─+┐$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => line.startsWith('      ┌─ planned ')));
    assert.ok(lines.some((line) => line.includes('PLAN')));
    assert.ok(!lines.some((line) => /no goal yet/u.test(line)), lines.join('\n'));
    for (const name of ['mc', 'goal-only', 'planned']) assert.ok(framed(lines, name), `${name} has its frame`);
    // A programme whose goals are all done, or with no goal at all, has nothing under way.
    for (const name of ['empty', 'done-only']) assert.ok(!framed(lines, name), `${name} is folded`);
  });

  it('shows no proposal count on a heading: proposals wait in the areas, not in a programme', () => {
    const programmes = programmesSection({
      goalRows: GOALS.slice(0, 1),
      programmes: ['empty', 'mc'],
      planningSessions: { mc: [{ ...SESSION, tool: 'codex' }] },
    });
    const wide = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW, expand: true }));
    assert.ok(wide.some((line) => /PLAN.*codex/u.test(line)));
    for (const name of ['mc', 'empty']) assert.doesNotMatch(wide.find((line) => line.startsWith(`      ┌─ ${name} `)), /proposal/u, name);
  });

  it('folds a programme with nothing under way, and says "1 programme" for one', () => {
    const programmes = programmesSection({ goalRows: GOALS.slice(0, 2), programmes: ['empty'] });
    const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW }));
    assert.ok(lines.some((line) => /^ {6}┌─ 2 programmes with nothing under way · a shows them ─+┐$/u.test(line)), lines.join('\n'));
    const one = programmesOf(renderPageLines(pageData({ programmes: programmesSection({ goalRows: GOALS.slice(0, 1), programmes: ['empty'] }) }), { columns: 120, now: NOW }));
    assert.ok(one.some((line) => /^ {6}┌─ 1 programme with nothing under way · a shows them ─+┐$/u.test(line)), one.join('\n'));
  });

  it('draws no folded frame when every programme is under way', () => {
    const programmes = programmesSection({ goalRows: GOALS.slice(0, 1) });
    const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW }));
    assert.ok(framed(lines, 'mc'));
    assert.ok(!lines.some((line) => /nothing under way/u.test(line)));
  });

  it('expanded, draws every programme as a frame, with no folded frame, and keeps the numbers', () => {
    const data = pageData({ programmes: section() });
    const lines = programmesOf(renderPageLines(data, { columns: 120, now: NOW, expand: true }));
    for (const name of ['done-only', 'empty', 'goal-only', 'mc', 'planned']) assert.ok(framed(lines, name), `${name} has its frame`);
    assert.ok(lines.some((line) => /^ {6}┌─ empty {2}0 goals/u.test(line)));
    assert.ok(!lines.some((line) => /nothing under way/u.test(line)));
    const numbers = data.programmes.programmes.flatMap((group) => group.goals).map((row) => row.number);
    assert.deepEqual(numbers.sort(), [1, 2, 3]);
  });
});

it('shows programme priority on the page and in the listing', () => {
  const programmes = programmesSection({ goalRows: GOALS, priority: (name) => name === 'mc' ? 7 : 0 });
  const lines = programmesOf(renderPageLines(pageData({ programmes }), { columns: 120, now: NOW }));
  assert.match(lines.find((line) => line.startsWith('      ┌─ mc ')), /priority 7/u);
  const listing = programmesListing({ section: programmes });
  assert.equal(listing.programmes.find((item) => item.name === 'mc').priority, 7);
  assert.match(listingText(listing), /mc\s+active\s+priority 7/u);
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
    assert.deepEqual(byName['done-only'].statuses, { ready: 1 });
    assert.ok(!('projects' in byName.mc), 'no project count');
    assert.equal(byName['goal-only'].goals, 1);
    assert.deepEqual(byName.planned.plan_sessions, { claude: 1 });
    assert.ok(!('proposals' in byName.mc), 'no proposal count: proposals are the areas\'');
  });

  it('says it in the page’s words, one line each', () => {
    const lines = listingText(programmesListing(read())).trimEnd().split('\n');
    assert.equal(lines[0], 'programmes — 3 active · 2 dormant');
    assert.equal(lines.length, 6);
    assert.match(lines[1], /^ {2}done-only +active +priority 0 +memoro +1 goal · ready 1 +no plan session$/u);
    assert.match(lines[2], /^ {2}empty +dormant +priority 0 +memoro +no goal +no plan session$/u);
    assert.match(lines[3], /^ {2}goal-only +active +priority 0 +memoro +1 goal · blocked 1 +no plan session$/u);
    assert.match(lines[5], /^ {2}planned +dormant +priority 0 +— +no goal +plan claude 1$/u);
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
    assert.equal(await programs(['archive'], deps), 2);
    assert.match(err, /mc programs has no archive/u);
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
