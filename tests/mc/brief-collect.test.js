/**
 * `brief-collect.js` — the shared readers of plans, runs and proposals, on
 * fixtures: the proposal listing, PLAN.md frontmatter parsing, the plans under
 * `~/mc/programs/`, and the runs.tsv rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  listArchived, listPlans, listProposals, parsePlanFrontmatter, planFields, runsFor, showBatch,
} from '../../src/mc/brief-collect.js';
import { programsArchived } from '../../src/mc/plan-source.js';

const RUNS = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-24T10:00:00Z\told\tstep\t0\t100\t1\t5\t10\t20\t1000\t30\ts1\tsuccess,merged',
  '2026-08-25T18:00:00Z\tdocx\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '',
].join('\n');

describe('proposals', () => {
  // mc does not read a proposal. It used to parse a frontmatter and fixed
  // section names, in three places that disagreed — a file whose first prose
  // line was not marked `# ` was counted by the page, missing from the brief,
  // and recorded as "wrote nothing" by the turn that had just written it. The
  // names are the whole of what mc knows now.
  it('lists the markdown names and nothing about what is in them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-proposals-'));
    writeFileSync(join(dir, 'b.md'), 'no heading here, and it still counts\n');
    writeFileSync(join(dir, 'a.md'), '# A title\n');
    writeFileSync(join(dir, 'notes.txt'), 'not markdown\n');
    assert.deepEqual(listProposals(dir).map((p) => p.file), ['a.md', 'b.md']);
    assert.deepEqual(Object.keys(listProposals(dir)[0]).sort(), ['file', 'path']);
  });

  it('an absent directory is empty, not an error', () => {
    assert.deepEqual(listProposals(join(tmpdir(), 'mc-no-such-proposals-dir')), []);
  });
});


describe('PLAN.md frontmatter', () => {
  it('reads a quoted next and a folded one', () => {
    assert.deepEqual(parsePlanFrontmatter('---\nstatus: ready\nnext: "Step 1 — do it"\nbudget: 150k\n---\n# x'),
      { status: 'ready', next: 'Step 1 — do it' });
    assert.deepEqual(parsePlanFrontmatter('---\nstatus: blocked\nnext: >-\n  Add a watchdog —\n  done when tested.\nneeds: []\n---\n'),
      { status: 'blocked', next: 'Add a watchdog — done when tested.' });
    assert.deepEqual(parsePlanFrontmatter('no frontmatter'), { status: null, next: null });
  });

  it('keeps every field for the page about one project', () => {
    assert.deepEqual(planFields('---\nstatus: ready\nnext: "Step 1 — do it"\nbudget: 150k\nneeds: []\n---\n# x'),
      { status: 'ready', next: 'Step 1 — do it', budget: '150k', needs: '[]' });
    assert.deepEqual(planFields('no frontmatter'), {});
  });
});

describe('the plans under ~/mc/programs/', () => {
  // A plan that parses, with one step ready. Its top-level `repo` is what makes it a programs plan.
  const PROGRAM_TEXT = JSON.stringify({
    schema: 'mc-plan', version: 1, repo: 'memoro-cli', goal: ['g'], contract: ['c'], out_of_scope: ['o'],
    success_criteria: [{ met: false, criterion: 'x', check: 'y' }], documents: [],
    steps: [{ title: 'S1 — one', status: 'ready', done_when: 'one', instruction: ['Do it.'], pr: null, blocked_by: null }],
  });
  const program = (project, repo) => ({
    path: `/w/programs/mc/${project}/PLAN.json`, programme: 'mc', project, file: 'PLAN.json', text: PROGRAM_TEXT, repo,
  });

  it('lists the programs plans of this repository, with their absolute paths, and leaves out another repository\'s', () => {
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, {
      programs: () => [program('mc-x', 'memoro-cli'), program('mc-z', 'memoro'), program('mc-y', 'memoro-cli')],
    });
    assert.deepEqual(plans.map((p) => [p.project, p.path, p.repo, p.legacy]), [
      ['mc-x', '/w/programs/mc/mc-x/PLAN.json', 'memoro-cli', false], ['mc-y', '/w/programs/mc/mc-y/PLAN.json', 'memoro-cli', false],
    ]);
    assert.match(plans[0].next, /done when one/u, 'the plan is read');
  });

  it('asks no git, and takes the old options without reading them', () => {
    const git = () => { throw new Error('listPlans asked git'); };
    const batch = () => { throw new Error('listPlans asked for a batch'); };
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git, batch: showBatch(git), programs: () => [program('mc-x', 'memoro-cli')] });
    assert.deepEqual(plans.map((p) => p.project), ['mc-x']);
    assert.deepEqual(listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git, batch, programs: () => [] }), []);
  });

  it('says a plan that does not parse is invalid, with the reason', () => {
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { programs: () => [{ ...program('mc-x', 'memoro-cli'), text: '{' }] });
    assert.equal(plans[0].status, 'invalid');
    assert.equal(plans[0].plan, null);
  });
});

describe('archived projects', () => {
  it('lists the closeout records on a ref, and not the markdown or what is nested under closeout/', () => {
    const git = (cwd, args) => {
      if (args[0] === 'ls-tree') return [
        'docs/project/README.md',
        'docs/project/mc/closeout/a.json',
        'docs/project/mc/closeout/a.md',
        'docs/project/mc/b/PLAN.json',
        'docs/project/mc/closeout/notes/c.json',
      ].join('\n');
      return null;
    };
    assert.deepEqual(listArchived({ name: 'memoro-cli', path: '/nowhere' }, { git, archived: () => [] }), ['a']);
  });

  it('is empty when the ref cannot be read and nothing is archived under ~/mc/programs/', () => {
    assert.deepEqual(listArchived({ name: 'memoro-cli', path: '/nowhere' }, { git: () => null, archived: () => [] }), []);
  });

  it('adds the programs-archived projects of this repository, closeout names first, each name once', () => {
    const git = (cwd, args) => (args[0] === 'ls-tree' ? 'docs/project/mc/closeout/a.json' : null);
    const archived = () => [
      { path: '/w/programs/mc/a/PLAN.json', programme: 'mc', project: 'a', repo: 'memoro-cli', closeoutPath: '/w/programs/mc/a/CLOSEOUT.json' },
      { path: '/w/programs/mc/b/PLAN.json', programme: 'mc', project: 'b', repo: 'memoro-cli', closeoutPath: '/w/programs/mc/b/CLOSEOUT.json' },
      { path: '/w/programs/ops/c/PLAN.json', programme: 'ops', project: 'c', repo: 'memoro', closeoutPath: '/w/programs/ops/c/CLOSEOUT.json' },
    ];
    assert.deepEqual(listArchived({ name: 'memoro-cli', path: '/nowhere' }, { git, archived }), ['a', 'b']);
  });

  it('returns the programs-archived names when the ref cannot be read', () => {
    const archived = () => [
      { path: '/w/programs/mc/b/PLAN.json', programme: 'mc', project: 'b', repo: 'memoro-cli', closeoutPath: '/w/programs/mc/b/CLOSEOUT.json' },
    ];
    assert.deepEqual(listArchived({ name: 'memoro-cli', path: '/nowhere' }, { git: () => null, archived }), ['b']);
  });

  it('names a project that is only under the archive home', () => {
    const files = { '/a/mc/moved/PLAN.json': '{"repo":"memoro-cli"}', '/a/mc/moved/CLOSEOUT.json': '{}' };
    const dirs = { '/a': ['mc'], '/a/mc': ['moved'] };
    const archived = () => programsArchived({
      home: '/nowhere', archivedHome: '/a', list: (path) => dirs[path] ?? [], read: (path) => files[path] ?? null,
    });
    assert.deepEqual(listArchived({ name: 'memoro-cli', path: '/nowhere' }, { git: () => null, archived }), ['moved']);
  });
});

describe('runner log', () => {
  it('keeps the last rows of one project', () => {
    assert.deepEqual(runsFor(RUNS, 'docx', 3).map((r) => r.pr), ['10958']);
    assert.deepEqual(runsFor(RUNS, 'old', 3).map((r) => r.ts), ['2026-08-24T10:00:00Z']);
    assert.deepEqual(runsFor(RUNS, 'never-ran', 3), []);
  });

  it('keeps only the last `limit` of them, oldest first', () => {
    const many = `${RUNS}2026-08-26T18:00:00Z\tdocx\tstep\t0\t1\t11\t-\t-\t-\t-\t-\ts4\tsuccess,open\n`;
    assert.deepEqual(runsFor(many, 'docx', 1).map((r) => r.pr), ['11']);
    assert.deepEqual(runsFor(many, 'docx', 3).map((r) => r.pr), ['10958', '11']);
  });
});
