/**
 * The rules of archiving a plan that says `done`, with no repository behind
 * them: which plans are archived, what a `project_log.md` row says, and the
 * two cells that have to be derived from the plan itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_DOC, UNDOCUMENTED_HEADER, appendRow, donePlans, duplicateRow, formatRow, isUndocumented, keptFiles, keptParagraph,
  logRows, mergedPrs, namedFiles, planDoc, planSummary, pointerCell, remoteSlug, rowFor, undocumentedRow,
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
    { repo: 'memoro', project: 'c', status: 'blocked' },
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

test('a row already in the log is not appended a second time', () => {
  const again = { date: '2026-10-10', programme: 'mc', project: 'mc-ui', outcome: 'delivered', summary: 'other', doc: NO_DOC, pointer: '#2' };
  assert.equal(appendRow(LOG, again), LOG, 'same programme and project: the text comes back unchanged');
  const programmeRow = appendRow(LOG, { date: '2026-10-10', programme: 'staff', project: null, outcome: 'delivered', summary: 's', doc: NO_DOC, pointer: '#3' });
  assert.equal(logRows(programmeRow).length, 2);
  assert.equal(appendRow(programmeRow, { date: '2026-10-11', programme: 'staff', project: '-', outcome: 'delivered', summary: 's', doc: NO_DOC, pointer: '#4' }), programmeRow,
    'a programme row (project `-`) is not written twice either');
  assert.equal(logRows(appendRow(LOG, { ...again, programme: 'other' })).length, 2, 'another programme\'s project of the same name is its own row');
});

test('duplicateRow names the first row that occurs twice by date, programme and project', () => {
  assert.equal(duplicateRow(LOG), null);
  const row = '| 2026-10-10 | staff | link-counts | delivered | s | none | #1 |';
  const twice = `${LOG}${row}\n${row.replace('#1', '#2')}\n`;
  const found = duplicateRow(twice);
  assert.deepEqual([found.date, found.programme, found.project], ['2026-10-10', 'staff', 'link-counts']);
  assert.equal(duplicateRow(`${LOG}${row}\n${row.replace('2026-10-10', '2026-10-11')}\n`), null, 'another date is another row');
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

/** A worktree as `git grep` and `git ls-files` answer it, with the files `read` returns. */
function worktree({ grep = [], files = [], texts = {} }) {
  const calls = [];
  return {
    calls,
    git: (cwd, args) => {
      calls.push(args);
      if (args[0] === 'grep') return grep.length ? { ok: true, stdout: `${grep.join('\n')}\n` } : { ok: false, stdout: '' };
      if (args[0] === 'ls-files') return { ok: true, stdout: `${files.join('\n')}\n` };
      return { ok: true, stdout: '' };
    },
    read: (path) => texts[path] ?? '',
  };
}

const Q = 'docs/project/p/q';
const Q_FILES = [`${Q}/PLAN.json`, `${Q}/skills/a.md`, `${Q}/skills/b.md`, `${Q}/notes/c.md`];

test('a file under the plan that a test names is kept, and everything else is removed', () => {
  const w = worktree({
    grep: ['tests/x.test.js'],
    files: Q_FILES,
    texts: { 'tests/x.test.js': "const a = 1;\nreadFileSync('docs/project/p/q/skills/a.md', 'utf8');\n" },
  });
  const { kept, remove } = keptFiles('/wt', Q, w);
  assert.deepEqual(kept, [{ file: `${Q}/skills/a.md`, by: 'tests/x.test.js:2' }]);
  assert.deepEqual(remove, [`${Q}/PLAN.json`, `${Q}/skills/b.md`, `${Q}/notes/c.md`]);
  assert.deepEqual(w.calls[0], ['grep', '-l', '-F', '--', `${Q}/`, '--', 'src', 'tests', 'scripts', 'config', 'package.json'],
    'the directory with its trailing slash, over the code and nothing under docs/');
  assert.deepEqual(keptParagraph(kept).at(-1), `- kept: ${Q}/skills/a.md — named by tests/x.test.js:2`);
});

test('nothing named is the whole directory, as before — and git ls-files is not asked', () => {
  const w = worktree({ grep: [] });
  assert.deepEqual(keptFiles('/wt', Q, w), { kept: [], remove: null });
  assert.deepEqual(w.calls.map((c) => c[0]), ['grep']);
  assert.deepEqual(keptParagraph([]), []);
});

test('a template names every file under the directory its fixed prefix points at', () => {
  const kept = namedFiles(Q, Q_FILES, [
    { path: 'src/skills.js', text: 'const at = `docs/project/p/q/skills/${name}.md`;' },
  ]);
  assert.deepEqual(kept.map((k) => k.file), [`${Q}/skills/a.md`, `${Q}/skills/b.md`]);
  assert.deepEqual(kept.map((k) => k.by), ['src/skills.js:1', 'src/skills.js:1']);
});

test('a directory named literally keeps what is under it; a file that is not there keeps nothing', () => {
  assert.deepEqual(namedFiles(Q, Q_FILES, [{ path: 'src/a.js', text: "join(root, 'docs/project/p/q/notes', f)" }]).map((k) => k.file),
    [`${Q}/notes/c.md`]);
  assert.deepEqual(namedFiles(Q, Q_FILES, [{ path: 'src/a.js', text: "'docs/project/p/q/gone.md'" }]), []);
  assert.deepEqual(namedFiles(Q, Q_FILES, [{ path: 'src/a.js', text: "'docs/project/p/q-two/skills/a.md'" }]), [],
    'q-two is not q');
});
