/**
 * `mc brief --collect` — the builders behind the sections, on fixtures:
 * the proposal listing, PLAN.md frontmatter parsing, the runs.tsv window, and
 * the whole collect run against a work root with no git and no gh.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  UNDOCUMENTED_KEYS, UNPLANNED_KEYS,
  collectBrief, heldForBrief, intakeRows, lastBriefTime, listPlans, parseCatFileBatch, parsePlanFrontmatter,
  listProposals, planFields,
  queueNames, runsFor, runsSince, showBatch, summariseRuns,
} from '../../src/mc/brief-collect.js';
import { UNDOCUMENTED_HEADER, undocumentedRow } from '../../src/mc/archive-plan.js';
import { unplannedFile, unplannedRow } from '../../src/mc/close-workarea.js';
import { unreadableFile } from '../../src/mc/plan-intake.js';

function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc-brief-'));
  // The merge ledger lives under a `decisions/` directory and is not a
  // decision. Nothing reads it here — it is written by a merge round — but it
  // is in the fixture so a collect run over this root is measured against a
  // tree that still has it.
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'log', 'runs.tsv'), [
    'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
    '2026-08-24T10:00:00Z\told\tstep\t0\t100\t1\t5\t10\t20\t1000\t30\ts1\tsuccess,merged',
    '2026-08-25T18:00:00Z\tdocx\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
    '2026-08-25T19:00:00Z\tsql\tstep\t0\t1835\t10963\t114\t228\t55705\t12463655\t149257\ts3\tsuccess,merged',
    '2026-08-25T19:30:00Z\tavatar\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'queue.md'), '# round 3\ndocx-editor\n\nsql-readiness-session-A\n');
  // What the runner would not land: one whose repair session has already run
  // and left it held, one the runner is about to repair itself.
  writeFileSync(join(root, 'runner', 'held.json'), JSON.stringify([
    {
      project: 'sql-readiness-session-A', repo: 'memoro', pr: 10963, branch: 'sql-readiness-session-A-2',
      reason: 'the session changed more of the plan than its step', note: 'plan-trespass',
      since: '2026-08-25T19:20:00Z', repairs: 0,
    },
    {
      project: 'docx-editor', repo: 'memoro', pr: 10958, branch: 'docx-editor-3',
      reason: '2 tests red: docx/export.test.js and docx/import.test.js', note: 'open,gate-red',
      since: '2026-08-25T18:10:00Z', repairs: 1, red: ['docx/export.test.js', 'docx/import.test.js'],
    },
  ], null, 2));
  mkdirSync(join(root, 'proposals'), { recursive: true });
  // Its own room beside intake, not inside it: intake is what the turn
  // reads, proposals are what came out of reading it.
  mkdirSync(join(root, 'intake'), { recursive: true });
  // What `mc run` left behind, in the runner's own room and not in the inbox:
  // one project archived with no note, two folders no plan explains, one plan
  // the schema refuses. Written through the runner's own row builders, so the
  // brief is read against the exact bytes the runner writes.
  writeFileSync(join(root, 'runner', 'undocumented-closures.md'), UNDOCUMENTED_HEADER
    + `${undocumentedRow({ date: '2026-08-29', repo: 'memoro', programme: 'msr-core', project: 'msr-design', pointer: '[#11003](https://github.com/x/y/pull/11003)' })}\n`);
  writeFileSync(join(root, 'runner', 'unplanned-workareas.md'), unplannedFile([
    unplannedRow({ name: 'msr-track-1', repo: 'memoro', uncommitted: 0, lastCommit: '2026-08-24', branch: 'ahead' }),
    unplannedRow({ name: 'mc-repo', repo: 'memoro-cli', uncommitted: 2, lastCommit: '2026-08-20', branch: 'landed' }),
  ]));
  writeFileSync(join(root, 'runner', 'unreadable-plans.md'), unreadableFile([
    { project: 'new-user', repo: 'memoro', problem: 'what_the_code_taught_us[0].body: at least one paragraph', path: 'docs/project/onboarding/new-user/PLAN.json' },
  ]));
  writeFileSync(join(root, 'proposals', '2026-08-29-expose-operations.md'), PROPOSAL);
  writeFileSync(join(root, 'proposals', 'a-note.txt'), 'Not markdown, so not counted.\n');
  return root;
}

const PROPOSAL = `---
name: expose-operations
repo: memoro
kind: project
---

# The nightly and morning outcomes reach no script

## Evidence

- \`/api/admin/operations/status\` answers 401 to an admin token (digest 2026-08-29).

## Proposal

A project whose step 1 is to read the two routes and say what a token may see.

## Done when

The nightly task outcomes are a section in the digest instead of a paragraph
saying they cannot be read.
`;

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

describe('runner log', () => {
  it('keeps the rows inside the window and sums them', () => {
    const tsv = readFileSync(join(workRoot(), 'runner', 'log', 'runs.tsv'), 'utf8');
    const rows = runsSince(tsv, new Date('2026-08-25T00:00:00Z'));
    assert.deepEqual(rows.map((r) => r.name), ['docx', 'sql', 'avatar']);
    const s = summariseRuns(rows);
    assert.equal(s.steps, 3);
    assert.deepEqual(s.kinds, { step: 2, triage: 1 });
    assert.equal(s.merged, 1);
    assert.equal(s.open, 1);
    assert.equal(s.timeout, 1);
    assert.equal(s.failed, 0);
    assert.equal(s.cacheRead, 3683298 + 12463655);
  });

  it('keeps the last rows of one project, whatever the window', () => {
    const tsv = readFileSync(join(workRoot(), 'runner', 'log', 'runs.tsv'), 'utf8');
    assert.deepEqual(runsFor(tsv, 'docx', 3).map((r) => r.pr), ['10958']);
    assert.deepEqual(runsFor(tsv, 'old', 3).map((r) => r.ts), ['2026-08-24T10:00:00Z'], 'older than the 24 h window');
    assert.deepEqual(runsFor(tsv, 'never-ran', 3), []);
  });

  it('reads the queue without comments and blanks', () => {
    assert.deepEqual(queueNames('# round 3\ndocx-editor\n\nsql\n'), ['docx-editor', 'sql']);
  });
});

/**
 * The two files `mc run` writes and never reads. Both are one markdown table
 * under a header paragraph; a cell may carry an escaped pipe, and an absent
 * file is a different answer from an empty one.
 */
describe('the intake tables the runner writes', () => {
  it('reads the rows under the rule, keyed, and ignores the header prose', () => {
    const text = UNDOCUMENTED_HEADER
      + `${undocumentedRow({ date: '2026-08-29', repo: 'memoro', programme: 'mc', project: 'a | b', pointer: 'none' })}\n`;
    assert.deepEqual(intakeRows(text, UNDOCUMENTED_KEYS), [
      { date: '2026-08-29', repo: 'memoro', programme: 'mc', project: 'a | b', pointer: 'none' },
    ], 'the escaped pipe stays one cell');
  });

  it('is empty for a table with no rows, and for text with no table at all', () => {
    assert.deepEqual(intakeRows(unplannedFile([]), UNPLANNED_KEYS), []);
    assert.deepEqual(intakeRows('# nothing here\n\njust prose\n', UNPLANNED_KEYS), []);
  });
});

/**
 * `~/mc/runner/held.json` — the pull requests the runner would not land. The
 * brief takes the ones a repair session has already tried and failed on; an
 * entry still at `repairs: 0` is the runner's next round and not Martin's
 * hour, and raising it would ask him to decide what a session is about to try.
 */
describe('held before merge', () => {
  it('takes the repaired ones only, oldest first', () => {
    const text = JSON.stringify([
      { project: 'b', repo: 'memoro', pr: 2, branch: 'b-1', reason: 'red', since: '2026-09-03T10:00:00Z', repairs: 1 },
      { project: 'a', repo: 'memoro', pr: 1, branch: 'a-1', reason: 'red', since: '2026-09-02T10:00:00Z', repairs: 2 },
      { project: 'c', repo: 'memoro-cli', pr: 3, branch: 'c-1', reason: 'red', since: '2026-09-01T10:00:00Z', repairs: 0 },
    ]);
    assert.deepEqual(heldForBrief(text).map((h) => [h.project, h.repairs]), [['a', 2], ['b', 1]]);
  });

  it('is nothing at all for a file that is empty, absent or unreadable', () => {
    assert.deepEqual(heldForBrief('[]'), []);
    assert.deepEqual(heldForBrief(null), []);
    assert.deepEqual(heldForBrief('{ not json'), []);
  });
});

describe('collectBrief', () => {
  it('writes the eleven sections, offline, with a 24 h window on the first run', async () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'no-repos') };
    const now = new Date('2026-08-25T20:00:00Z');
    assert.equal(lastBriefTime(join(root, 'brief')), null);
    const result = await collectBrief({ env, now, offline: true });
    const text = readFileSync(result.path, 'utf8');
    assert.equal(text, result.text);
    const order = ['## Merged since last brief', '## Opened, not merged', '## Proposals',
      '## Plan status', '## Archived without a note', '## Workareas with no project on main',
      '## Plans that do not parse', '## Runner', '## Production', '## Held before merge', '## Queue'];
    let at = -1;
    for (const heading of order) {
      const next = text.indexOf(heading);
      assert.ok(next > at, `${heading} in order`);
      at = next;
    }
    assert.match(text, /First brief: the window is the last 24 h \(since 2026-08-24T20:00:00Z\)/u);
    // No agenda of questions: mc has no decision concept to build one from.
    assert.doesNotMatch(text, /Waiting on Martin|Beslut/u);
    // The helper's own output, listed where Martin decides: the names, and
    // the .txt beside them is not one.
    assert.equal(result.data.proposals.length, 1);
    assert.match(text, /- `2026-08-29-expose-operations\.md`/u);
    // The two files the runner writes and nothing read until now.
    assert.deepEqual(result.data.undocumented.map((r) => r.project), ['msr-design']);
    assert.match(text, /\| 2026-08-29 \| memoro \| msr-core \/ msr-design \| #11003 \|/u, 'the URL is dropped, not clipped mid-link');
    assert.match(text, /1 project archived with `doc: none`/u);
    assert.deepEqual(result.data.unplanned.map((r) => r.name), ['msr-track-1', 'mc-repo']);
    assert.match(text, /\| mc-repo \| memoro-cli \| 2 \| 2026-08-20 \| landed \|/u);
    assert.match(text, /2 folders under `~\/mc` that no project on main explains — no plan, and no row in `project_log.md` — 1 whose branch is already on main/u);
    // The third file the runner writes and nobody read: a plan the schema
    // refuses. `new-user` sat unreadable on origin/main for a day, and the
    // only place that said so was a `runner.log` line.
    assert.deepEqual(result.data.unreadable.map((r) => r.project), ['new-user']);
    assert.match(text, /\| new-user \| memoro \| what_the_code_taught_us\[0\]\.body: at least one paragraph \|/u);
    assert.match(text, /1 plan on `origin\/main` the schema refuses/u);
    // All three are read from `~/mc/runner/`, and named there for a person to
    // open. They were in `~/mc/intake/` until 2026-09-04, which the inbox
    // cannot drain: two of the three come back whole every round.
    assert.match(text, /`~\/mc\/runner\/undocumented-closures\.md` is append-only/u);
    assert.doesNotMatch(text, /~\/mc\/intake\//u, 'no runner table is named in the inbox any more');
    assert.match(text, /Last 24 h: 3 steps \(step 2, triage 1\) — merged 1, left open 1, failed 0, timed out 1/u);
    // The pull requests the runner would not land: the repaired one is the
    // brief's, the one still waiting for its repair session is the runner's.
    assert.deepEqual(result.data.held.map((h) => h.pr), [10958]);
    assert.match(text, /\| docx-editor \| memoro \| #10958 \| docx-editor-3 \| 1 \| 2 tests red: docx\/export\.test\.js and docx\/import\.test\.js \|/u);
    assert.doesNotMatch(text, /\| sql-readiness-session-A \| memoro \| #10963 \|/u);
    assert.match(text, /1 pull request the runner would not land, its one repair session already behind it/u);
    // And it is said at the top, not only in the ninth section of a long file.
    assert.match(text, /\*\*1 pull request held before merge\*\* after its repair/u);
    assert.match(text, /- docx-editor\n- sql-readiness-session-A/u);
    assert.match(text, /memoro: no checkout/u);
    // No memoro on this machine is no production reading, said as an absence
    // rather than as a deploy that never happened.
    assert.equal(result.data.production, null);
    assert.match(text, /## Production\n\n_no memoro checkout here — nothing to read_/u);
    assert.ok(lastBriefTime(join(root, 'brief')) instanceof Date);
  });

  /**
   * *Production*: the row `mc deploy` wrote, the commits on `main` it does not
   * have, and what the nightly said about the tree that would ship. Three
   * readings from files on this disk — no network, and the same three
   * `mc deploy` prints before it asks its question.
   */
  it('reads production from the deploy row, the gap to main and the nightly', async () => {
    const root = workRoot();
    const home = mkdtempSync(join(tmpdir(), 'mc-repos-'));
    mkdirSync(join(home, 'memoro', '.git'), { recursive: true });
    const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012';
    const MAIN = 'abcdef1234567890abcdef1234567890abcdef12';
    const LIVE = 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00';
    writeFileSync(join(root, 'runner', 'log', 'deploys.tsv'), [
      'started\tended\tsha\tbuild\tholder\toutcome\tlive_commit\tlive_build\tstopped_at\tnote',
      `2026-08-25T09:00:00Z\t2026-08-25T09:12:00Z\t${SHA}\t813\tmartin@laptop\tdeployed\t${SHA}\t813\t\t`,
      '',
    ].join('\n'));
    writeFileSync(join(root, 'runner', 'version.json'), JSON.stringify({
      fetched: '2026-08-25T19:00:00Z', version: { commit: LIVE, build: 23533, build_time: '2026-08-25T04:00:00Z' },
    }));
    const git = (cwd, args) => {
      if (args[0] === 'rev-parse') return MAIN;
      if (args[0] === 'rev-list') return '4';
      return null; // no plans on this fixture's origin/main
    };
    const nightly = () => ({ measured: { commit: MAIN, at: '2026-08-25T02:00:00Z', red: 0, outcome: 'passed' } });
    const result = await collectBrief({
      env: { MC_WORK_ROOT: root, MC_REPOS_HOME: home },
      now: new Date('2026-08-25T20:00:00Z'),
      offline: true,
      git,
      nightly,
    });
    assert.equal(result.data.production.ahead, 4);
    assert.equal(result.data.production.nightly.this_tree, true);
    const section = result.text.split('## Production')[1].split('## Held')[0];
    assert.match(section, /- Last deploy: `1a2b3c4` build 813 — 2026-08-25 09:12 by martin@laptop, verified live `1a2b3c4`/u);
    assert.match(section, /- `origin\/main` is `abcdef1`, \*\*4 commits ahead of production\*\*/u);
    assert.match(section, /- The nightly measured `abcdef1` — this tree, 0 red \(2026-08-25 02:00\)/u);
    // The two readings of what is live, and the page draws the same difference.
    assert.match(section, /- `\/api\/version` said build 23533 · `b3e65b6` \(read 1 h ago\) — \*\*not the sha of the last deploy\*\*/u);
    // The gap is a deploy to propose, and a proposal is all it can be.
    assert.match(section, /A deploy is Martin's word every time/u);
  });
});

/**
 * The tidying, where it lives now: `--collect` deletes an answered decision
 * file whose plan has absorbed it, before the agenda is built, so *Waiting on
 * Martin* is only ever open questions. The runner does not do this — it has
 * nothing to do with decisions at all (Martin, 2026-08-29).
 */
