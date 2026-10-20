/**
 * `brief-collect.js` — the shared readers of plans, runs and proposals, on
 * fixtures: the proposal listing, PLAN.md frontmatter parsing, the batch read
 * of plans, and the runs.tsv rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  listArchived, listPlans, listProposals, parseCatFileBatch, parsePlanFrontmatter, planFields, runsFor, showBatch,
  withProgrammePlans,
} from '../../src/mc/brief-collect.js';

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

  it('lists docs/project/<programme>/<project>/PLAN.md with one batch read per repository', () => {
    const git = (cwd, args) => {
      if (args[0] === 'ls-tree') return 'docs/project/README.md\ndocs/project/mc/mc-brief/PLAN.md\ndocs/project/mc/mc.md\ndocs/project/mc/mc-plan/notes/PLAN.md';
      if (args[0] === 'show') return `---\nstatus: ready\nnext: "Step 1 — ${args[1]}"\n---\n`;
      return null;
    };
    const batches = [];
    const batch = (cwd, refs) => { batches.push(refs); return showBatch(git)(cwd, refs); };
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git, batch });
    assert.deepEqual(plans.map((p) => [p.programme, p.project, p.status]), [['mc', 'mc-brief', 'ready']]);
    assert.match(plans[0].next, /origin\/main:docs\/project\/mc\/mc-brief\/PLAN\.md/u);
    assert.deepEqual(batches, [['origin/main:docs/project/mc/mc-brief/PLAN.md']], 'one call, every plan in it');
  });

  it('splits a cat-file --batch stream by byte size, and skips what is missing', () => {
    const plan = '---\nstatus: ready\nnext: "Steg 1 — mät i sekunder"\n---\n';
    const bytes = Buffer.byteLength(plan);
    const stdout = Buffer.concat([
      Buffer.from(`abc123 blob ${bytes}\n`), Buffer.from(plan), Buffer.from('\n'),
      Buffer.from('origin/main:gone.md missing\n'),
      Buffer.from('def456 blob 3\nhi!\n'),
    ]);
    const texts = parseCatFileBatch(stdout, ['a', 'origin/main:gone.md', 'c']);
    assert.equal(texts.get('a'), plan, 'a multi-byte plan survives the split');
    assert.equal(texts.has('origin/main:gone.md'), false);
    assert.equal(texts.get('c'), 'hi!', 'the walk stayed in step after the miss');
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
  const fromRepo = (project) => ({
    repo: 'memoro-cli', programme: 'mc', project, path: `docs/project/mc/${project}/PLAN.md`, status: 'ready', next: 'from the repository',
  });

  it('puts a plan of this repository first, with its absolute path, and drops the repository copy of the same project', () => {
    const out = withProgrammePlans('memoro-cli', [fromRepo('mc-x'), fromRepo('mc-y')], { programs: () => [program('mc-x', 'memoro-cli')] });
    assert.deepEqual(out.map((r) => [r.project, r.path, r.repo]), [
      ['mc-x', '/w/programs/mc/mc-x/PLAN.json', 'memoro-cli'], ['mc-y', 'docs/project/mc/mc-y/PLAN.md', 'memoro-cli'],
    ]);
    assert.match(out[0].next, /done when one/u, 'the programs plan is read, not the repository record');
  });

  it('leaves out a plan of another repository, and still drops that project\'s repository copy here', () => {
    const out = withProgrammePlans('memoro-cli', [fromRepo('mc-x'), fromRepo('mc-y')], { programs: () => [program('mc-x', 'memoro')] });
    assert.deepEqual(out.map((r) => r.project), ['mc-y']);
  });

  it('returns the records unchanged when nothing is under ~/mc/programs/', () => {
    const records = [fromRepo('mc-x')];
    assert.deepEqual(withProgrammePlans('memoro-cli', records, { programs: () => [] }), records);
  });

  it('lists a repository\'s plans with the programs plans laid over them', () => {
    const git = (cwd, args) => (args[0] === 'ls-tree' ? 'docs/project/mc/mc-x/PLAN.md\ndocs/project/mc/mc-y/PLAN.md' : null);
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git, batch: () => new Map(), programs: () => [program('mc-x', 'memoro-cli')] });
    assert.deepEqual(plans.map((p) => [p.project, p.path]), [
      ['mc-x', '/w/programs/mc/mc-x/PLAN.json'], ['mc-y', 'docs/project/mc/mc-y/PLAN.md'],
    ]);
  });

  it('drops the repository copy of a project archived under ~/mc/programs/, and returns no record for it', () => {
    const archived = () => [{ path: '/w/programs/mc/mc-x/PLAN.json', programme: 'mc', project: 'mc-x', repo: 'memoro-cli', closeoutPath: '/w/programs/mc/mc-x/CLOSEOUT.json' }];
    const out = withProgrammePlans('memoro-cli', [fromRepo('mc-x'), fromRepo('mc-y')], { programs: () => [], archived });
    assert.deepEqual(out.map((r) => r.project), ['mc-y']);
  });

  it('lists a repository\'s plans without the archived projects under ~/mc/programs/', () => {
    const git = (cwd, args) => (args[0] === 'ls-tree' ? 'docs/project/mc/mc-x/PLAN.md\ndocs/project/mc/mc-y/PLAN.md' : null);
    const archived = () => [{ path: '/w/programs/mc/mc-x/PLAN.json', programme: 'mc', project: 'mc-x', repo: 'memoro-cli', closeoutPath: '/w/programs/mc/mc-x/CLOSEOUT.json' }];
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git, batch: () => new Map(), programs: () => [], archived });
    assert.deepEqual(plans.map((p) => p.project), ['mc-y']);
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
