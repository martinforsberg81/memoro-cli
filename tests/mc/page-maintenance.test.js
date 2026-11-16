/**
 * MAINTENANCE: its sources as the collector reads them, and the frame and view that draw them (goal mc-ui/maintenance-sources).
 * The readings are pure builders over read data, so every case hands them a fixture; none reads the machine.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SOURCES, aimsOf, areasReading, depsReading, errorsReading, intakeReading, lessonsReading, maintenanceSection,
  proposalsReading, readAreaPages, straysReading, testsReading,
} from '../../src/mc/page-maintenance.js';
import { intakeSection, mergesSection, programmesSection, runnerSection, sessionsSection } from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { width } from '../../src/mc/status-render.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY = 86400000;
const ago = (days) => NOW.getTime() - days * DAY;
const ESC = String.fromCharCode(27);
const strip = (line) => line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), '');
const RED = `${ESC}[31m`;

/** The page's other sections, empty, with a MAINTENANCE section as the collector hands it. */
function pageData(maintenance, over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    merges: mergesSection({ now: NOW }),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({}),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    maintenance,
    ...over,
  };
}

const lesson = (name, state, days, extra = {}) => ({ name, state, at: new Date(ago(days)).toISOString(), ...extra });

/** A fixture for every source's reading. */
const FIXTURE = {
  proposals: () => proposalsReading({
    now: NOW,
    fresh: [{ name: '2026-11-15-new-one.md', at: ago(1) }, { name: '2026-11-10-new-two.md', at: ago(6) }],
    programmes: [
      { programme: 'mc-ui', files: [{ name: 'a.md', at: ago(2) }, { name: 'b.md', at: ago(9) }, { name: 'c.md', at: ago(3) }] },
      { programme: 'memoro', files: [{ name: 'd.md', at: ago(40) }] },
      { programme: 'idle', files: [] },
    ],
  }),
  lessons: () => lessonsReading({
    now: NOW,
    lessons: [
      lesson('one', 'open', 3), lesson('two', 'open', 20), lesson('three', 'in-goal', 5),
      lesson('four', 'landed', 30, { landed_at: new Date(ago(2)).toISOString() }),
      lesson('five', 'landed', 30, { landed_at: new Date(ago(20)).toISOString() }),
      lesson('six', 'dismissed', 8),
    ],
  }),
  errors: () => errorsReading({ intake: { repos: [
    { repo: 'memoro', new_errors: 48, critical: 0, high: 2, age_seconds: 3600, first: false },
    { repo: 'memoro-cli', new_errors: 0, critical: 0, high: 0, age_seconds: 7200, first: false },
  ], last_run: { ok: true } } }),
  tests: () => testsReading({ checks: { repos: [
    { repo: 'memoro', test: { red: 5, age_seconds: 86400, short: 'abc1234' } },
    { repo: 'memoro-cli', test: { red: 0, age_seconds: 3600, short: 'def5678' } },
  ] } }),
  deps: () => depsReading({ checks: { repos: [
    { repo: 'memoro', deps: { critical: 0, high: 4, age_seconds: 7200, short: 'abc1234' } },
    { repo: 'memoro-cli', deps: { critical: 0, high: 0, age_seconds: 7200, short: 'def5678' } },
  ] } }),
  intake: () => intakeReading({ now: NOW, files: [] }),
  areas: () => areasReading({ now: NOW, pages: [
    { repo: 'memoro', page: 'docs/technical/areas/auth.md', name: 'Authentication', changed_at: new Date(ago(0)).toISOString(), aims: 3 },
    { repo: 'memoro-cli', page: 'docs/technical/areas/ui.md', name: 'The page', changed_at: new Date(ago(12)).toISOString(), aims: 0 },
  ] }),
  strays: () => straysReading({ items: [] }),
};

describe('the maintenance collector', () => {
  it('has one row per source in the order the programme states, and user feedback says it has no source', () => {
    const { sources } = maintenanceSection({ readers: FIXTURE });
    assert.deepEqual(sources.map((s) => s.id), ['feedback', 'proposals', 'lessons', 'errors', 'tests', 'deps', 'intake', 'areas', 'strays']);
    assert.deepEqual(SOURCES.map((s) => s.id), sources.map((s) => s.id));
    const [feedback] = sources;
    assert.equal(feedback.state, 'none');
    assert.equal(feedback.summary, "no source — memoro's product feedback was retired (migration 0213)");
    assert.ok(sources.slice(1).every((s) => s.state === 'ok'), sources.map((s) => `${s.id}:${s.state}`).join(' '));
  });

  it('is a list the frame walks: one more source is one more row, in its place', () => {
    const more = [...SOURCES.slice(0, 3), { id: 'extra', label: 'Extra', verb: 'mc extra' }, ...SOURCES.slice(3)];
    const { sources } = maintenanceSection({ sources: more, readers: { ...FIXTURE, extra: () => ({ count: 7, summary: '7 extra things', tone: ['yellow'] }) } });
    assert.deepEqual(sources.map((s) => s.id).slice(2, 5), ['lessons', 'extra', 'errors']);
    const lines = renderPageLines(pageData({ sources }), { columns: 100, now: NOW, overview: true }).map(strip);
    assert.ok(lines.some((line) => /^ {4}Extra +7 extra things +mc extra$/u.test(line)), lines.join('\n'));
  });

  it('draws a source whose read fails red on its own row, and does not drop it or the others', () => {
    for (const failing of [() => { throw new Error('ENOENT: no such file or directory, scandir /home/x/mc/proposals'); }, undefined, () => null]) {
      const readers = { ...FIXTURE, proposals: failing };
      if (!failing) delete readers.proposals;
      const { sources } = maintenanceSection({ readers });
      assert.equal(sources.length, SOURCES.length, 'no source disappears');
      const row = sources.find((s) => s.id === 'proposals');
      assert.equal(row.state, 'error');
      assert.match(row.summary, /^unreadable — /u);
      assert.deepEqual(row.tone, ['red']);
      assert.ok(row.error);
      assert.deepEqual(sources.filter((s) => s.id !== 'proposals').map((s) => s.state), ['none', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      for (const columns of [60, 100, 140]) {
        const painted = renderPageLines(pageData({ sources }), { columns, now: NOW, overview: true, colour: true });
        const rows = painted.filter((line) => strip(line).includes('Proposals'));
        assert.equal(rows.length, 1, `${columns}: one row`);
        assert.ok(rows[0].includes(RED), `${columns}: the row is red`);
        assert.match(strip(rows[0]), /^ {4}Proposals +unreadable — /u);
        assert.ok(!painted.filter((line) => strip(line).includes('Intake')).some((line) => line.includes(RED)), 'the others are not red');
        assert.ok(painted.every((line) => width(line) <= columns));
      }
    }
  });

  it('keeps the detail of a reading that has problems, and draws that row red: tests with an unreadable history', () => {
    const readers = { ...FIXTURE, tests: () => testsReading({ checks: { repos: [{ repo: 'memoro', test: { red: 1, age_seconds: 60, short: 'abc' } }] }, missing: ['memoro-cli'] }) };
    const { sources } = maintenanceSection({ readers });
    const row = sources.find((s) => s.id === 'tests');
    assert.equal(row.state, 'error');
    assert.match(row.error, /memoro-cli: nightly history unreadable/u);
    assert.equal(row.groups.length, 1, 'what could be read stays');
  });

  it('is red on the row and in the view when the read fails, and the view still lists every other source', () => {
    const { sources } = maintenanceSection({ readers: { ...FIXTURE, areas: () => { throw new Error('git: not a repository'); } } });
    const view = renderPageLines(pageData({ sources }), { columns: 110, now: NOW, maintenance: true, colour: true });
    const text = view.map(strip);
    assert.ok(view.some((line) => strip(line).includes('unreadable — git: not a repository') && line.includes(RED)), text.join('\n'));
    for (const label of ['User feedback', 'Proposals', 'Lessons', 'Errors', 'Tests', 'Dependencies', 'Intake', 'Areas']) {
      assert.ok(text.some((line) => line.trimStart().startsWith(label)), `${label}\n${text.join('\n')}`);
    }
  });
});

describe('the readings count what is on disk', () => {
  it('counts proposals the new ones and the ones in programmes, the oldest by its name\'s date', () => {
    const reading = FIXTURE.proposals();
    assert.equal(reading.count, 6);
    assert.equal(reading.new, 2);
    assert.equal(reading.waiting, 4);
    assert.equal(reading.oldest_seconds, 40 * 86400);
    assert.match(reading.summary, /^2 new · 4 waiting in 2 programmes · oldest 40 days$/u);
    assert.deepEqual(reading.groups.map((g) => [g.label, g.count]), [['New', 2], ['mc-ui', 3], ['memoro', 1]]);
    assert.deepEqual(reading.groups[0].items, ['2026-11-15-new-one.md', '2026-11-10-new-two.md']);
  });

  it('counts lessons by state as `mc martin lessons` does: open, in a goal, late, landed this week', () => {
    const reading = FIXTURE.lessons();
    assert.deepEqual([reading.open, reading.in_goal, reading.late, reading.landed_week, reading.count], [2, 1, 1, 1, 3]);
    assert.equal(reading.summary, '2 open · 1 in a goal · 1 late · 1 landed this week');
    assert.deepEqual(reading.groups.map((g) => [g.label, g.count]), [['open', 2], ['in a goal', 1], ['landed', 2], ['dismissed', 1]]);
    assert.deepEqual(reading.groups[0].items, ['one', 'two']);
    assert.deepEqual(reading.tone, ['red'], 'a late lesson is red');
  });

  it('reads errors, tests and dependencies per repository', () => {
    assert.equal(FIXTURE.errors().count, 48);
    assert.deepEqual(FIXTURE.errors().groups.map((g) => [g.label, g.count]), [['memoro', 48], ['memoro-cli', 0]]);
    assert.equal(errorsReading({ intake: null }).summary, 'no digest collected');
    assert.equal(FIXTURE.tests().count, 5);
    assert.deepEqual(FIXTURE.tests().groups.map((g) => [g.label, g.red]), [['memoro', 5], ['memoro-cli', 0]]);
    assert.equal(FIXTURE.deps().count, 4);
    assert.match(FIXTURE.deps().summary, /memoro 0 critical · 4 high · memoro-cli 0/u);
  });

  it('counts the areas pages with their repo, days since main changed them and their aims, newest first', () => {
    const reading = FIXTURE.areas();
    assert.equal(reading.count, 2);
    assert.deepEqual(reading.areas.map((a) => [a.name, a.repo, a.age_days, a.aims]), [['Authentication', 'memoro', 0, 3], ['The page', 'memoro-cli', 12, 0]]);
    assert.match(reading.summary, /^2 pages · last changed today \(1\) · the rest 12 days ago$/u);
  });

  it('counts the aims under `## Aim`: top-level bullets, and none for a page that states none yet', () => {
    assert.equal(aimsOf('# P\n\n## Aim\n\n- one\n  - nested\n- two\n* three\n\n## Decisions\n\n- not an aim\n'), 3);
    assert.equal(aimsOf('# P\n\n## Aim\n\nNo aim stated yet.\n\n## Decisions\n- x\n'), 0);
    assert.equal(aimsOf('# P\n\nno aim section\n'), 0);
  });

  it('reads each area page once at origin/main: its name, last commit and aims, and a page it cannot read is a problem', () => {
    const declaration = { schema_version: 1, areas: [
      { id: 'a', name: 'A', covers: 'x', standards: ['s.md'], paths: [], questions: [{ when: 'w', ask: 'q' }], page: 'docs/technical/areas/shared.md' },
      { id: 'b', name: 'B', covers: 'x', standards: [], paths: [], questions: [], page: 'docs/technical/areas/shared.md' },
      { id: 'c', name: 'C', covers: 'x', standards: [], paths: [], questions: [], page: 'docs/technical/areas/gone.md' },
    ] };
    const calls = [];
    const git = (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'show' && args[1] === 'origin/main:.mc/areas.json') return { ok: true, stdout: JSON.stringify(declaration), stderr: '' };
      if (args[0] === 'show' && args[1].endsWith('shared.md')) return { ok: true, stdout: '# Shared page\n\n## Aim\n\n- one\n- two\n', stderr: '' };
      if (args[0] === 'show') return { ok: false, stdout: '', stderr: 'fatal: path does not exist' };
      if (args[0] === 'log') return { ok: true, stdout: '2026-11-14T10:00:00+01:00\n', stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };
    const read = readAreaPages({ repos: [{ name: 'memoro', path: '/r/memoro.git' }], git });
    assert.deepEqual(read.pages, [{ repo: 'memoro', page: 'docs/technical/areas/shared.md', name: 'Shared page', changed_at: '2026-11-14T10:00:00+01:00', aims: 2 }]);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0], /memoro: could not read docs\/technical\/areas\/gone\.md at origin\/main/u);
    assert.equal(calls.filter((call) => call.startsWith('log')).length, 1, 'a shared page is read once');
    // A page that could not be read is a problem on the areas row, red, with the rest kept.
    const row = maintenanceSection({ readers: { ...FIXTURE, areas: () => areasReading({ now: NOW, pages: read.pages, problems: read.problems }) } }).sources.find((s) => s.id === 'areas');
    assert.equal(row.state, 'error');
    assert.equal(row.areas.length, 1);
  });
});

describe('the maintenance frame and view', () => {
  const sources = () => maintenanceSection({ readers: FIXTURE }).sources;

  it('draws the frame last in the overview, one row per source with what waits, the oldest and the verb', () => {
    const lines = renderPageLines(pageData({ sources: sources() }), { columns: 120, now: NOW, overview: true }).map(strip);
    const top = lines.findIndex((line) => /^ {2}┌─ MAINTENANCE {2}9 sources ─+/u.test(line));
    assert.ok(top >= 0, lines.join('\n'));
    const labels = lines.slice(top + 1).filter((line) => /^ {4}\S/u.test(line)).map((line) => line.trim().split(/ {2,}/u)[0]);
    assert.deepEqual(labels.slice(0, 9), ['User feedback', 'Proposals', 'Lessons', 'Errors', 'Tests', 'Dependencies', 'Intake', 'Areas', 'Strays']);
    const row = (label) => lines.slice(top).find((line) => line.startsWith(`    ${label}`));
    assert.match(row('Proposals'), /2 new · 4 waiting in 2 programmes · oldest 40 days +mc plan$/u);
    assert.match(row('Lessons'), /2 open · 1 in a goal · 1 late · 1 landed this week +mc martin$/u);
    assert.match(row('User feedback'), /no source — memoro's product feedback was retired \(migration 0213\)/u);
    assert.match(row('Intake'), /nothing waiting +~\/mc\/intake$/u);
    assert.match(row('Strays'), /none/u);
  });

  it('opens the view with the detail below each row: proposals by programme, lessons by state, repos, areas', () => {
    const text = renderPageLines(pageData({ sources: sources() }), { columns: 120, now: NOW, maintenance: true }).map(strip);
    const joined = text.join('\n');
    assert.match(joined, /┌─ MAINTENANCE {2}9 sources/u);
    assert.match(joined, /2026-11-15-new-one\.md/u, 'the new proposals by name');
    assert.match(joined, /mc-ui +3/u);
    assert.match(joined, /memoro +1/u);
    for (const state of ['open', 'in a goal', 'landed', 'dismissed']) assert.match(joined, new RegExp(`^ +${state} +\\d`, 'mu'), state);
    for (const repo of ['memoro', 'memoro-cli']) assert.ok(text.some((line) => line.trim().startsWith(`${repo} `)), repo);
    // The areas as the README draws them: name, repo, when main last changed the page, aims.
    assert.ok(text.some((line) => /^ +Authentication +memoro +today +3 aims$/u.test(line)), joined);
    assert.ok(text.some((line) => /^ +The page +memoro-cli +12 days ago +no aim$/u.test(line)), joined);
    assert.ok(text.every((line) => width(line) <= 120));
    // The key says what leaves the view, and the view is the header and the frame: the hero frames are `o`'s.
    assert.match(text.find((line) => line.includes('┌─ MAINTENANCE')), / h {2}home ┐$/u);
    assert.doesNotMatch(joined, /FIGURES 24 h|PIPELINE|m {2}back/u);
  });

  it('draws the strays beneath their row when something lies outside the programmes', () => {
    const data = pageData({ sources: sources() });
    data.programmes = { ...data.programmes, strays: [{ name: 'old-area', checkout: true, uncommitted: 2 }] };
    const lines = renderPageLines(data, { columns: 120, now: NOW, overview: true }).map(strip);
    const at = lines.findIndex((line) => /^ {4}Strays +1 outside the programmes/u.test(line));
    assert.ok(at >= 0, lines.join('\n'));
    assert.match(lines[at + 1], /^ {6}old-area +not an area mc knows · checkout yes · 2 uncommitted$/u);
  });
});
