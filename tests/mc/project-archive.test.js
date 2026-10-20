/**
 * The rules of archiving a project under `~/mc/programs/` (project-archive.js):
 * when it is due, what its log row says, what its closeout holds, and where
 * the closeout file lives. `archivePrograms` is tested with git, gh and the file
 * system faked, so none of it touches a repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import {
  ARCHIVE_HOLD_MS, archiveDue, archivePrograms, archiveRow, closeoutFileOf, closeoutOf, doneAt,
} from '../../src/mc/project-archive.js';
import { UNDOCUMENTED_HEADER } from '../../src/mc/archive-plan.js';
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

test('archiveDue is not due for a plan in a repository, only for one under ~/mc/programs/', () => {
  const record = { project: 'project-archive', path: 'docs/project/mc/project-archive/PLAN.json', status: 'done' };
  assert.deepEqual(archiveDue({ record, entry: DONE, nowMs: NOW }), {
    due: false, why: 'the plan is in a repository, not under ~/mc/programs/',
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

/* ------------------------------------------------------- archivePrograms */

const ROOT = '/work';
const REPO = '/repos/memoro-cli';
const LOG = 'docs/project/project_log.md';
const WORKTREE = join(ROOT, 'runner', 'archive', 'memoro-cli-programs');
const BRANCH = 'mc-archive-20261020T120000Z-programs';
const PR = 1040;
const CLOCK = () => new Date('2026-10-20T12:00:00Z');
const PATHS = {
  runs: join(ROOT, 'runner', 'log', 'runs.tsv'),
  log: join(ROOT, 'runner', 'log'),
  undocumented: join(ROOT, 'runner', 'log', 'undocumented-closures.md'),
};
const OK = { ok: true, stdout: '', stderr: '' };
const FAIL = { ok: false, stdout: '', stderr: 'fatal' };
const LOG_HEADER = '# Project log\n\n| date | programme | project | outcome | summary | doc | pointer |\n|---|---|---|---|---|---|---|\n';
const DOCUMENTED = '[docs/technical/project-archive.md](../technical/project-archive.md)';

const planPath = (project) => `/Users/x/mc/programs/mc/${project}/PLAN.json`;

/** A done project: its plan text (with a documented goal unless `goal` says otherwise) and its item. */
function plan(project, { goal = PLAN.goal } = {}) {
  const record = { project, programme: 'mc', path: planPath(project), status: 'done' };
  const entry = { project, programme: 'mc', repo: 'memoro-cli', plan: planPath(project), steps: [] };
  return { record, entry, text: JSON.stringify({ ...PLAN, goal }) };
}

const filesOf = (...plans) => Object.fromEntries(plans.map((p) => [p.record.path, p.text]));

/**
 * Fake git, gh and docsMerge over an in-memory file map. `log` is origin/main's
 * project log (null: it cannot be read); `open` the numbers of open `mc-archive-`
 * pull requests; `merge` whether docsMerge lands the pull request.
 */
function world({ log = LOG_HEADER, open = [], merge = true, worktreeAdd = true, files = {} } = {}) {
  const calls = { git: [], gh: [], docsMerge: [] };
  const store = new Map(Object.entries(files));
  const deps = {
    git(cwd, args) {
      calls.git.push({ cwd, args });
      if (args[0] === 'show') return log == null ? FAIL : { ok: true, stdout: log, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        if (!worktreeAdd) return FAIL;
        store.set(join(args[4], LOG), log);
        return OK;
      }
      if (args[0] === 'remote') return { ok: true, stdout: 'git@github.com:o/memoro.git\n', stderr: '' };
      return OK;
    },
    gh(cwd, args) {
      calls.gh.push({ cwd, args });
      if (args.some((arg) => arg.includes('headRefName'))) return { ok: true, stdout: open.map((n) => `${n}\n`).join(''), stderr: '' };
      if (args[1] === 'create') return { ok: true, stdout: `https://github.com/o/memoro/pull/${PR}\n`, stderr: '' };
      if (args[1] === 'list') return { ok: true, stdout: `${PR}\n`, stderr: '' };
      return OK;
    },
    exists: (path) => store.has(path),
    read: (path) => (store.has(path) ? store.get(path) : null),
    write: (path, text) => { store.set(path, text); },
    append: (path, text) => { store.set(path, (store.get(path) ?? '') + text); },
    list: () => [],
    readBytes: () => null,
  };
  const docsMerge = async (options) => {
    calls.docsMerge.push(options);
    return merge
      ? { merged: true, ok: true, merged_into: 'main' }
      : { merged: false, ok: false, stopped_at: 'gate', reason: 'the gate is red' };
  };
  return { deps, docsMerge, calls, store, lines: [] };
}

function run(w, items) {
  return archivePrograms({
    repo: { name: 'memoro-cli', path: REPO }, items, root: ROOT, paths: PATHS, deps: w.deps,
    docsMerge: w.docsMerge, now: CLOCK, say: (line) => w.lines.push(line),
  });
}

const pullRequests = (w) => w.calls.gh.filter((c) => c.args[1] === 'create');
const addedWorktree = (w) => w.calls.git.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add');

function assertWorktreeTakenDown(w) {
  assert.ok(w.calls.git.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove' && c.args[2] === '--force' && c.args[3] === WORKTREE),
    'the worktree is removed with --force');
  assert.ok(w.calls.git.some((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === BRANCH),
    'the branch is deleted');
}

test('archivePrograms: a project whose row is already on main gets its CLOSEOUT.json and no pull request', async () => {
  const p = plan('plans-in-mc');
  const log = `${LOG_HEADER}| 2026-10-19 | mc | plans-in-mc | delivered | Done. | ${DOCUMENTED} | #1025 |\n`;
  const w = world({ log, files: filesOf(p) });
  const out = await run(w, [p]);
  assert.deepEqual(out, { archived: ['plans-in-mc'], held: [] });
  assert.equal(pullRequests(w).length, 0);
  assert.equal(addedWorktree(w), false, 'no worktree is made when no row is needed');
  const closeout = JSON.parse(w.store.get(closeoutFileOf(p.record.path)));
  assert.equal(closeout.schema, 'mc-closeout');
  assert.equal(closeout.project, 'plans-in-mc');
  assert.equal(closeout.repo, 'memoro-cli');
  assert.deepEqual(w.lines, ['archive: memoro-cli mc/plans-in-mc archived — CLOSEOUT.json written']);
});

test('archivePrograms: projects without rows go in one commit and one pull request, and get their CLOSEOUT.json once it lands', async () => {
  const a = plan('plans-in-mc');
  const b = plan('project-archive');
  const w = world({ files: filesOf(a, b) });
  const out = await run(w, [a, b]);
  assert.deepEqual(out, { archived: ['plans-in-mc', 'project-archive'], held: [] });

  const commits = w.calls.git.filter((c) => c.args[0] === 'commit');
  assert.equal(commits.length, 1, 'one commit for both rows');
  assert.equal(commits[0].cwd, WORKTREE);
  assert.equal(commits[0].args[3], 'Archive 2 done projects: plans-in-mc, project-archive');
  assert.equal(pullRequests(w).length, 1);
  assert.equal(w.calls.docsMerge.length, 1);
  assert.equal(w.calls.docsMerge[0].repoPath, WORKTREE);
  assert.equal(w.calls.docsMerge[0].pr, PR);

  const log = w.store.get(join(WORKTREE, LOG));
  assert.equal(log.match(/\| plans-in-mc \|/gu).length, 1);
  assert.equal(log.match(/\| project-archive \|/gu).length, 1);
  assert.ok(w.store.has(closeoutFileOf(a.record.path)));
  assert.ok(w.store.has(closeoutFileOf(b.record.path)));
  assert.equal(w.calls.git.filter((c) => c.args[0] === 'fetch').length, 1, 'main is fetched once the row has landed');
  assertWorktreeTakenDown(w);
});

test('archivePrograms: an open mc-archive- pull request holds the projects and writes nothing', async () => {
  const a = plan('plans-in-mc');
  const w = world({ open: [1030], files: filesOf(a) });
  const out = await run(w, [a]);
  assert.deepEqual(out, { archived: [], held: [{ project: 'plans-in-mc', why: '#1030 is still open' }] });
  assert.equal(addedWorktree(w), false);
  assert.equal(pullRequests(w).length, 0);
  assert.deepEqual([...w.store.keys()], [a.record.path], 'nothing written but the plan itself');
});

test('archivePrograms: a docs merge that does not land writes no CLOSEOUT.json and holds the projects', async () => {
  const a = plan('plans-in-mc');
  const w = world({ merge: false, files: filesOf(a) });
  const out = await run(w, [a]);
  assert.deepEqual(out, { archived: [], held: [{ project: 'plans-in-mc', why: '#1040 left open — the gate is red' }] });
  assert.equal(w.store.has(closeoutFileOf(a.record.path)), false);
  assert.equal(w.calls.git.some((c) => c.args[0] === 'fetch'), false, 'main is not fetched when nothing landed');
  assertWorktreeTakenDown(w);
});

test('archivePrograms: a worktree that cannot be made holds the projects, and nothing else is done', async () => {
  const a = plan('plans-in-mc');
  const w = world({ worktreeAdd: false, files: filesOf(a) });
  const out = await run(w, [a]);
  assert.deepEqual(out, { archived: [], held: [{ project: 'plans-in-mc', why: 'the archive worktree could not be opened' }] });
  assert.equal(pullRequests(w).length, 0);
  assert.equal(w.store.has(closeoutFileOf(a.record.path)), false);
  assertWorktreeTakenDown(w);
});

test('archivePrograms: a project log that cannot be read holds every project and archives nothing', async () => {
  const a = plan('plans-in-mc');
  const w = world({ log: null, files: filesOf(a) });
  const out = await run(w, [a]);
  assert.deepEqual(out, { archived: [], held: [{ project: 'plans-in-mc', why: 'the project log could not be read' }] });
  assert.deepEqual([...w.store.keys()], [a.record.path]);
});

test('archivePrograms: a row that names no docs/technical note is recorded in the undocumented file, with its header', async () => {
  const a = plan('plans-in-mc', { goal: ['Nothing named here.'] });
  const w = world({ files: { ...filesOf(a), [PATHS.runs]: '' } });
  await run(w, [a]);
  assert.equal(
    w.store.get(PATHS.undocumented),
    `${UNDOCUMENTED_HEADER}| 2026-10-20 | memoro-cli | mc | plans-in-mc | none |\n`,
  );
});

test('archivePrograms: the undocumented file keeps its header and gets the row appended', async () => {
  const a = plan('plans-in-mc');
  const log = `${LOG_HEADER}| 2026-10-19 | mc | plans-in-mc | delivered | Done. | none | #1025 |\n`;
  const existing = `${UNDOCUMENTED_HEADER}| 2026-10-01 | memoro-cli | mc | old-one | #1 |\n`;
  const w = world({ log, files: { ...filesOf(a), [PATHS.undocumented]: existing } });
  await run(w, [a]);
  assert.equal(
    w.store.get(PATHS.undocumented),
    `${existing}| 2026-10-20 | memoro-cli | mc | plans-in-mc | #1025 |\n`,
  );
});

test('archivePrograms: a closeout that cannot be written holds its project, and the others go on', async () => {
  const a = plan('plans-in-mc');
  const b = plan('project-archive');
  const log = `${LOG_HEADER}| 2026-10-19 | mc | plans-in-mc | delivered | Done. | ${DOCUMENTED} | #1025 |\n`
    + `| 2026-10-19 | mc | project-archive | delivered | Done. | ${DOCUMENTED} | #1026 |\n`;
  const w = world({ log, files: filesOf(a, b) });
  const write = w.deps.write;
  w.deps.write = (path, text) => {
    if (path === closeoutFileOf(a.record.path)) throw new Error('disk full');
    write(path, text);
  };
  const out = await run(w, [a, b]);
  assert.deepEqual(out, { archived: ['project-archive'], held: [{ project: 'plans-in-mc', why: 'disk full' }] });
  assert.equal(w.store.has(closeoutFileOf(a.record.path)), false);
  assert.ok(w.store.has(closeoutFileOf(b.record.path)));
});
