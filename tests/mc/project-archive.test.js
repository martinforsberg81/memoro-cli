/**
 * The rules of archiving a project under `~/mc/programs/` (project-archive.js):
 * when it is due, what its log row says, what its closeout holds, and where
 * the closeout file lives. No git, no file system.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_HOLD_MS, archiveDue, archiveRow, closeoutFileOf, closeoutOf, doneAt,
} from '../../src/mc/project-archive.js';
import { RUNS_HEADER } from '../../src/mc/run-plan.js';

const row = (cells) => RUNS_HEADER.map((key) => cells[key] ?? '-').join('\t');
const RUNS = [
  RUNS_HEADER.join('\t'),
  row({ ts: '2026-10-19T09:00:00Z', name: 'project-archive', kind: 'step', exit: '0', seconds: '100', pr: '1025', session: 's1', note: 'success · merged', model: 'opus' }),
  row({ ts: '2026-10-19T11:00:00Z', name: 'project-archive', kind: 'step', exit: '0', seconds: '50', pr: '1026', session: 's2', note: 'success · merged', model: 'opus' }),
  row({ ts: '2026-10-19T12:00:00Z', name: 'project-archive', kind: 'step', exit: '0', seconds: '30', pr: '1027', session: 's3', note: 'success · open', model: 'opus' }),
  row({ ts: '2026-10-19T13:00:00Z', name: 'other', kind: 'step', exit: '0', seconds: '9', pr: '9', session: 's4', note: 'success · merged', model: 'opus' }),
  '',
].join('\n');

const PLAN = {
  schema: 'mc-plan',
  version: 1,
  repo: 'memoro-cli',
  goal: ['Archive a done project. See docs/technical/project-archive.md.'],
  contract: ['Nothing outside mc changes, and no plan in a repository is removed.'],
  out_of_scope: ['Removing repository plans.'],
  documents: [],
  success_criteria: [{ criterion: 'It is archived.', check: 'Run archive.', met: true }],
  steps: [
    { title: '1. First', status: 'done', done_when: 'One is done.', instruction: ['Do the first thing in full.'] },
    { title: '2. Second — the last\n  step', status: 'done', done_when: 'Two is done.', instruction: ['Do the second thing in full.'] },
  ],
};

const ENTRY = {
  project: 'project-archive', programme: 'mc', repo: 'memoro-cli',
  plan: '/Users/x/mc/programs/mc/project-archive/PLAN.json',
  steps: [
    { status: 'done', pr: 1025, attempts: 1, reason: null, comments: [], landed: { sha: 'aaa', into: 'main', at: '2026-10-19T10:00:00Z' } },
    { status: 'done', pr: 1026, attempts: 0, reason: null, comments: [], landed: { sha: 'bbb', into: 'main', at: '2026-10-19T12:00:00Z' } },
  ],
};

test('doneAt is the latest moment a step or a criterion was finished', () => {
  const entry = {
    steps: [
      { status: 'done', updated: '2026-10-19T08:00:00Z' },
      { status: 'done', updated: '2026-10-20T10:00:00Z' },
    ],
    criteria: [{ criterion: 'c', met: true, at: '2026-10-20T09:00:00Z' }],
  };
  assert.equal(doneAt(entry), '2026-10-20T10:00:00.000Z');
  entry.criteria[0].at = '2026-10-21T00:00:00Z';
  assert.equal(doneAt(entry), '2026-10-21T00:00:00.000Z', 'a criterion met last is the last moment');
});

test('doneAt is null while a step is not done, a criterion is not met, or there are no steps', () => {
  const done = { status: 'done', updated: '2026-10-19T08:00:00Z' };
  const met = { criterion: 'c', met: true, at: '2026-10-19T08:00:00Z' };
  assert.equal(doneAt({ steps: [done, { status: 'ready', updated: null }], criteria: [met] }), null);
  assert.equal(doneAt({ steps: [done], criteria: [{ criterion: 'c', met: false, at: null }] }), null);
  assert.equal(doneAt({ steps: [], criteria: [met] }), null);
  assert.equal(doneAt({ criteria: [met] }), null, 'an entry with no steps key');
  assert.equal(doneAt(null), null);
});

test('doneAt is null when no time can be read from the entry', () => {
  const entry = {
    steps: [{ status: 'done', updated: null }],
    criteria: [{ criterion: 'c', met: true, at: 'not a date' }],
  };
  assert.equal(doneAt(entry), null);
});

const ABSOLUTE = '/Users/x/mc/programs/mc/project-archive/PLAN.json';
const DONE = {
  steps: [{ status: 'done', updated: '2026-10-19T12:00:00Z' }],
  criteria: [{ criterion: 'c', met: true, at: null }],
};
const NOW = Date.parse('2026-10-20T12:00:00Z');

test('archiveDue is not due for a plan in a repository — archiveDone has it', () => {
  const record = { project: 'project-archive', path: 'docs/project/mc/project-archive/PLAN.json', status: 'done' };
  assert.deepEqual(archiveDue({ record, entry: DONE, nowMs: NOW }), {
    due: false, why: 'the plan is in a repository — archiveDone archives it',
  });
});

test('archiveDue is not due for a plan that is not done', () => {
  const record = { project: 'project-archive', path: ABSOLUTE, status: 'ready' };
  assert.deepEqual(archiveDue({ record, entry: DONE, nowMs: NOW }), { due: false, why: 'the plan is ready' });
});

test('archiveDue is not due when the register does not say when it was done', () => {
  const record = { project: 'project-archive', path: ABSOLUTE, status: 'done' };
  assert.deepEqual(archiveDue({ record, entry: null, nowMs: NOW }), {
    due: false, why: 'the register does not say when it was done',
  });
});

test('archiveDue waits out the hold, and says so in hours rounded down', () => {
  const record = { project: 'project-archive', path: ABSOLUTE, status: 'done' };
  const almost = Date.parse('2026-10-20T10:59:00Z');
  assert.deepEqual(archiveDue({ record, entry: DONE, nowMs: almost }), {
    due: false, why: 'done 22h ago — archived after 24h',
  });
});

test('archiveDue is due at exactly the hold, and not before', () => {
  const record = { project: 'project-archive', path: ABSOLUTE, status: 'done' };
  assert.equal(ARCHIVE_HOLD_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual(archiveDue({ record, entry: DONE, nowMs: NOW }), { due: true, why: 'done 24h ago' });
  assert.equal(archiveDue({ record, entry: DONE, nowMs: NOW - 1 }).due, false);
});

test('archiveDue takes the hold it is given', () => {
  const record = { project: 'project-archive', path: ABSOLUTE, status: 'done' };
  const out = archiveDue({ record, entry: DONE, nowMs: NOW, holdMs: 60 * 60 * 1000 });
  assert.deepEqual(out, { due: true, why: 'done 24h ago' });
});

test('archiveRow returns an existing row as it is', () => {
  const existing = {
    date: '2026-10-01', programme: 'mc', project: 'project-archive', outcome: 'delivered',
    summary: 'Written by hand.', doc: 'none', pointer: '#1',
  };
  const out = archiveRow({
    planText: JSON.stringify(PLAN), programme: 'mc', project: 'project-archive', date: '2026-10-20',
    tsv: RUNS, slug: 'o/r', existing,
  });
  assert.equal(out, existing);
});

test('archiveRow writes a new row from the plan and the runs that merged', () => {
  const out = archiveRow({
    planText: JSON.stringify(PLAN), programme: 'mc', project: 'project-archive', date: '2026-10-20',
    tsv: RUNS, slug: 'o/r', existing: null,
  });
  assert.deepEqual(out, {
    date: '2026-10-20',
    programme: 'mc',
    project: 'project-archive',
    outcome: 'delivered',
    summary: '2. Second — the last step',
    doc: '[docs/technical/project-archive.md](../technical/project-archive.md)',
    pointer: '[#1025](https://github.com/o/r/pull/1025), [#1026](https://github.com/o/r/pull/1026)',
  });
});

test('archiveRow points at bare PR numbers when the slug is not known, and at none when no run merged', () => {
  const planText = JSON.stringify({ ...PLAN, goal: ['Nothing named here.'] });
  const bare = archiveRow({ planText, programme: 'mc', project: 'project-archive', date: '2026-10-20', tsv: RUNS, existing: null });
  assert.equal(bare.pointer, '#1025, #1026');
  assert.equal(bare.doc, 'none');
  const none = archiveRow({ planText, programme: 'mc', project: 'project-archive', date: '2026-10-20', tsv: '', existing: null });
  assert.equal(none.pointer, 'none');
});

test('closeoutOf is a closeout of the same shape as a repository one, with its names carried', () => {
  const planPath = '/Users/x/mc/programs/mc/project-archive/PLAN.json';
  const closeout = closeoutOf({
    plan: PLAN, entry: ENTRY, tsv: RUNS, sessions: [], archivedAt: '2026-10-21',
    project: 'project-archive', programme: 'mc', repo: 'memoro-cli', planPath,
  });
  assert.equal(closeout.schema, 'mc-closeout');
  assert.equal(closeout.version, 1);
  assert.equal(closeout.project, 'project-archive');
  assert.equal(closeout.programme, 'mc');
  assert.equal(closeout.repo, 'memoro-cli');
  assert.equal(closeout.plan_path, planPath);
  assert.equal(closeout.archived, '2026-10-21');
  assert.deepEqual(closeout.goal, PLAN.goal);
  assert.deepEqual(closeout.steps.map((step) => step.pr), [1025, 1026]);
  assert.equal(closeout.totals.sessions, 3, 'the other project and the merge rows are not its sessions');
});

test('closeoutFileOf puts CLOSEOUT.json beside the PLAN.json', () => {
  assert.equal(closeoutFileOf('/Users/x/mc/programs/mc/project-archive/PLAN.json'), '/Users/x/mc/programs/mc/project-archive/CLOSEOUT.json');
});
