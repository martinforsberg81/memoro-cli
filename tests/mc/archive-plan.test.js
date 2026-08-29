/**
 * The rules of archiving a plan that says `done`, with no repository behind
 * them: which plans are archived, what a `project_log.md` row says, and the
 * two cells that have to be derived from the plan itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_DOC, UNDOCUMENTED_HEADER, appendRow, donePlans, formatRow, isUndocumented, logRows, mergedPrs,
  planDoc, planSummary, pointerCell, remoteSlug, rowFor, undocumentedRow,
} from '../../src/mc/archive-plan.js';

const LOG = `# Project log

Prose above the table.

## Log

| date | programme | project | outcome | summary | doc | pointer |
|---|---|---|---|---|---|---|
| 2026-08-29 | mc | mc-ui | delivered | Made bare \`mc\` the one page. | [docs/technical/mc-ui.md](../technical/mc-ui.md) | [#430](https://github.com/o/r/pull/430) |
`;

test('done is the whole trigger, and one repository at a time', () => {
  const plans = [
    { repo: 'memoro', project: 'a', status: 'done' },
    { repo: 'memoro', project: 'b', status: 'ready' },
    { repo: 'memoro-cli', project: 'mc-ui', status: 'done' },
    { repo: 'memoro', project: 'c', status: 'waiting-decision' },
  ];
  assert.deepEqual(donePlans(plans, 'memoro').map((p) => p.project), ['a']);
  assert.deepEqual(donePlans(plans, 'memoro-cli').map((p) => p.project), ['mc-ui']);
  assert.deepEqual(donePlans(plans).map((p) => p.project), ['a', 'mc-ui']);
});

test('the header and the |---| rule are not rows; a row starts with a date', () => {
  const rows = logRows(LOG);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'mc-ui');
  assert.equal(rows[0].outcome, 'delivered');
  assert.equal(rowFor(LOG, 'mc-ui').programme, 'mc');
  assert.equal(rowFor(LOG, 'project'), null, 'the header does not answer for a project called "project"');
  assert.equal(rowFor(LOG, 'mc-status'), null);
});

test('a row is appended after the last row of the table, not at the end of the file', () => {
  const text = `${LOG}\n## Notes\n\nProse below the table.\n`;
  const out = appendRow(text, {
    date: '2026-08-29', programme: 'mc', project: 'mc-status', outcome: 'delivered',
    summary: 'Did the thing.', doc: NO_DOC, pointer: '#1',
  });
  const lines = out.split('\n');
  const at = lines.findIndex((line) => line.includes('| mc-status |'));
  assert.ok(at > lines.findIndex((line) => line.includes('| mc-ui |')));
  assert.ok(at < lines.findIndex((line) => line === '## Notes'), 'the row stays inside the table');
  assert.equal(logRows(out).length, 2);
});

test('a log with no table at all still gets its row', () => {
  const out = appendRow('# Project log\n', { date: '2026-08-29', programme: 'mc', project: 'x', outcome: 'delivered', summary: 's', doc: NO_DOC, pointer: '#1' });
  assert.equal(logRows(out).length, 1);
  assert.match(out, /# Project log\n\n\| 2026-08-29 \| mc \| x \|/u);
});

test('a cell is one line and its pipes are escaped, so the table survives a plan that uses them', () => {
  const row = formatRow({ date: '2026-08-29', programme: 'mc', project: 'p', outcome: 'delivered', summary: 'a | b\nc  d', doc: '', pointer: null });
  assert.equal(row, '| 2026-08-29 | mc | p | delivered | a \\| b c d | - | - |');
  assert.equal(logRows(`|---|\n${row}`).length, 1);
});

test('the summary is the plan\'s next: on one line, the doc the docs/technical path it names', () => {
  const plan = [
    '---',
    'status: done',
    'next: "Step 3 — close-out: the note in',
    '  `docs/technical/mc-tidy.md` and the row"',
    'budget: 150k',
    '---',
    '# mc tidy',
    '',
    'See `docs/technical/mc-run.md` for the runner.',
  ].join('\n');
  assert.equal(planSummary(plan), 'Step 3 — close-out: the note in `docs/technical/mc-tidy.md` and the row');
  assert.equal(planDoc(plan), '[docs/technical/mc-tidy.md](../technical/mc-tidy.md)');
  assert.equal(planSummary('---\nstatus: done\n---\n'), '-');
  assert.equal(planDoc('---\nstatus: done\n---\n# X\n'), NO_DOC);
  assert.equal(isUndocumented({ doc: NO_DOC }), true);
  assert.equal(isUndocumented({ doc: '[docs/technical/x.md](../technical/x.md)' }), false);
});

test('the pointer is the PRs the runner merged for the project, linked when the slug is known', () => {
  const tsv = [
    'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
    '2026-08-28T10:00:00Z\tmc-ui\tstep\t0\t900\t430\t9\t1\t2\t3\t4\ts\tsuccess,merged',
    '2026-08-28T12:00:00Z\tmc-ui\tstep\t0\t900\t431\t9\t1\t2\t3\t4\ts\tsuccess,open',
    '2026-08-28T13:00:00Z\tmc-ui\tstep\t0\t900\t435\t9\t1\t2\t3\t4\ts\tsuccess,merged',
    '2026-08-28T14:00:00Z\tother\tstep\t0\t900\t999\t9\t1\t2\t3\t4\ts\tsuccess,merged',
    '2026-08-28T15:00:00Z\tmc-ui\tstep\t1\t9\t-\t1\t-\t-\t-\t-\t-\tquota',
  ].join('\n');
  assert.deepEqual(mergedPrs(tsv, 'mc-ui'), ['430', '435']);
  assert.equal(pointerCell(mergedPrs(tsv, 'mc-ui'), { slug: 'o/r' }),
    '[#430](https://github.com/o/r/pull/430), [#435](https://github.com/o/r/pull/435)');
  assert.equal(pointerCell(['430'], {}), '#430');
  assert.equal(pointerCell([], { fallback: 'abc1234' }), 'abc1234', 'no merged run: the last commit that touched it');
  assert.equal(pointerCell([], {}), NO_DOC);
});

test('the repository slug comes from the remote, in either URL shape', () => {
  assert.equal(remoteSlug('git@github.com:martinforsberg81/memoro-cli.git'), 'martinforsberg81/memoro-cli');
  assert.equal(remoteSlug('https://github.com/martinforsberg81/memoro.git\n'), 'martinforsberg81/memoro');
  assert.equal(remoteSlug('https://github.com/martinforsberg81/memoro'), 'martinforsberg81/memoro');
  assert.equal(remoteSlug(''), null);
});

test('the intake row names the project and where its record is', () => {
  assert.match(UNDOCUMENTED_HEADER, /\| date \| repo \| programme \| project \| pointer \|/u);
  assert.equal(
    undocumentedRow({ date: '2026-08-29', repo: 'memoro', programme: 'prog', project: 'p', pointer: '#7' }),
    '| 2026-08-29 | memoro | prog | p | #7 |',
  );
});
