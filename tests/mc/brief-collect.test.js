/**
 * `mc brief --collect` — the builders behind the sections, on fixtures:
 * the decision-file scan (answered vs unanswered, bookkeeping skipped, a
 * question whose options are neither a `## Options` heading nor a bold lead
 * still listed), PLAN.md frontmatter parsing, the runs.tsv window, and the
 * whole collect run against a work root with no git and no gh.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  UNDOCUMENTED_KEYS, UNPLANNED_KEYS,
  collectBrief, intakeRows, lastBriefTime, listPlans, parseCatFileBatch, parseDecision, parsePlanFrontmatter,
  listProposals, planFields,
  queueNames, runsFor, runsSince, scanDecisions, showBatch, summariseRuns,
} from '../../src/mc/brief-collect.js';
import { UNDOCUMENTED_HEADER, undocumentedRow } from '../../src/mc/archive-plan.js';
import { unplannedFile, unplannedRow } from '../../src/mc/close-workarea.js';

const DECISION = (answered) => `---
programme: assistant-avatar
project: avatar-image-animation
---

# 1. Ska QA-tabellen fortsätta grinda?

Text.

## Alternativ

**A.** one. **B.** two.

## Rekommendation

**B.** Keeps the veto,
drops the approval work.

${answered ? '**Beslut:** B (Martin, 2026-08-25). Keep the veto.\n' : ''}`;

// The shape the runner watches and the old rule dropped: the options are a
// heading of their own words and a bullet, and there is no recommendation
// section at all. ~/mc/swedish-grammar/decisions/language-content-1.md.
const OWN_WORDS = `---
programme: language-content
---

# Is the Swedish map accepted, and when does grammar go live?

## Half one — does the map count as accepted?

- **Option A (recommended).** Yes, record acceptance.
- **Option B.** No.
`;

function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc-brief-'));
  mkdirSync(join(root, 'avatar', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md'), DECISION(true));
  writeFileSync(join(root, 'avatar', 'decisions', 'assistant-avatar-2.md'), DECISION(false));
  writeFileSync(join(root, 'avatar', 'decisions', 'language-content-1.md'), OWN_WORDS);
  mkdirSync(join(root, 'pm', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'pm', 'decisions', 'merge-log.md'), '## 2026-08-15 — PR #344\n- **Beslut:** Martin\n');
  writeFileSync(join(root, 'pm', 'decisions', 'log.md'), '# Beslutslogg — append-only\n\n## Alternativ\n\n**Beslut:** whatever.\n');
  writeFileSync(join(root, 'pm', 'decisions', 'README.md'), '# decisions\n\nAppend-only log.\n');
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
  mkdirSync(join(root, 'proposals'), { recursive: true });
  // Its own room beside intake, not inside it: intake is what the turn
  // reads, proposals are what came out of reading it.
  mkdirSync(join(root, 'intake'), { recursive: true });
  // What `mc run` left behind: one project archived with no note, two folders
  // no plan explains. Written through the runner's own row builders, so the
  // brief is read against the exact bytes the runner writes.
  writeFileSync(join(root, 'intake', 'undocumented-closures.md'), UNDOCUMENTED_HEADER
    + `${undocumentedRow({ date: '2026-08-29', repo: 'memoro', programme: 'msr-core', project: 'msr-design', pointer: '[#11003](https://github.com/x/y/pull/11003)' })}\n`);
  writeFileSync(join(root, 'intake', 'unplanned-workareas.md'), unplannedFile([
    unplannedRow({ name: 'msr-track-1', repo: 'memoro', uncommitted: 0, lastCommit: '2026-08-24', branch: 'ahead' }),
    unplannedRow({ name: 'mc-repo', repo: 'memoro-cli', uncommitted: 2, lastCommit: '2026-08-20', branch: 'landed' }),
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

describe('decision files', () => {
  it('parses title, recommendation and whether a **Beslut:** line exists', () => {
    const open = parseDecision(DECISION(false));
    assert.equal(open.title, '1. Ska QA-tabellen fortsätta grinda?');
    assert.equal(open.recommendation, '**B.** Keeps the veto, drops the approval work.');
    assert.equal(open.answered, false);
    assert.equal(parseDecision(DECISION(true)).answered, true);
  });

  it('reads the bold-lead shape too', () => {
    const d = parseDecision('# surface 3 — autosave\n\n**Question.** Autosave?\n\n**Options.**\n\n1. no\n2. yes\n\n**Recommendation: option 2.** Text is never lost,\nhistory stays readable.\n\n**Beslut:** 2 (Martin).\n');
    assert.equal(d.title, 'surface 3 — autosave');
    assert.equal(d.recommendation, '**option 2.** Text is never lost, history stays readable.');
    assert.equal(d.answered, true);
    assert.equal(parseDecision('no heading at all\n'), null);
  });

  it('lists a question whose options are its own words, with no recommendation to quote', () => {
    const d = parseDecision(OWN_WORDS);
    assert.equal(d.title, 'Is the Swedish map accepted, and when does grammar go live?');
    assert.equal(d.recommendation, null);
    assert.equal(d.answered, false);
  });

  it('scans every <area>/decisions/*.md and skips the bookkeeping names only', () => {
    const found = scanDecisions(workRoot());
    assert.deepEqual(found.map((d) => [d.file, d.answered]), [
      ['avatar/decisions/assistant-avatar-1.md', true],
      ['avatar/decisions/assistant-avatar-2.md', false],
      ['avatar/decisions/language-content-1.md', false],
    ]);
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

describe('collectBrief', () => {
  it('writes the nine sections, offline, with a 24 h window on the first run', async () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'no-repos') };
    const now = new Date('2026-08-25T20:00:00Z');
    assert.equal(lastBriefTime(join(root, 'brief')), null);
    const result = await collectBrief({ env, now, offline: true });
    const text = readFileSync(result.path, 'utf8');
    assert.equal(text, result.text);
    const order = ['## Merged since last brief', '## Opened, not merged', '## Waiting on Martin', '## Proposals',
      '## Plan status', '## Archived without a note', '## Workareas with no project on main', '## Runner', '## Queue'];
    let at = -1;
    for (const heading of order) {
      const next = text.indexOf(heading);
      assert.ok(next > at, `${heading} in order`);
      at = next;
    }
    assert.match(text, /First brief: the window is the last 24 h \(since 2026-08-24T20:00:00Z\)/u);
    assert.match(text, /\| avatar\/decisions\/assistant-avatar-2\.md \| 1\. Ska QA-tabellen fortsätta grinda\? \| \*\*B\.\*\* Keeps the veto/u);
    assert.match(text, /\| avatar\/decisions\/language-content-1\.md \| Is the Swedish map accepted[^|]*\| — \|/u);
    assert.match(text, /2 waiting, 1 answered/u);
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
    assert.match(text, /Last 24 h: 3 steps \(step 2, triage 1\) — merged 1, left open 1, failed 0, timed out 1/u);
    assert.match(text, /- docx-editor\n- sql-readiness-session-A/u);
    assert.match(text, /memoro: no checkout/u);
    assert.ok(lastBriefTime(join(root, 'brief')) instanceof Date);
  });
});

/**
 * The tidying, where it lives now: `--collect` deletes an answered decision
 * file whose plan has absorbed it, before the agenda is built, so *Waiting on
 * Martin* is only ever open questions. The runner does not do this — it has
 * nothing to do with decisions at all (Martin, 2026-08-29).
 */
describe('collectBrief retires what has been answered', () => {
  const PLAN = (status) => `---\nstatus: ${status}\nnext: "x"\n---\n# P\n`;

  /**
   * A work root plus a real git repository whose main carries the plans.
   *
   * The plan path must name the project `DECISION` declares in its
   * frontmatter — `assistant-avatar/avatar-image-animation` — because that is
   * what decides ownership. The decision's own directory under the work root
   * (`avatar/`) does not, and the two differ here on purpose: matching by area
   * was the guess that made `mc-test-1` deletable.
   */
  function rootWithPlans(plans) {
    const root = mkdtempSync(join(tmpdir(), 'mc-retire-'));
    mkdirSync(join(root, 'avatar', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md'), DECISION(true));
    writeFileSync(join(root, 'avatar', 'decisions', 'assistant-avatar-2.md'), DECISION(false));
    const repo = join(root, 'repos', 'memoro');
    mkdirSync(repo, { recursive: true });
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    for (const [path, text] of Object.entries(plans)) {
      mkdirSync(join(repo, path.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git('add', '-A');
    git('commit', '-qm', 'plans');
    git('branch', '-f', 'origin/main', 'main');
    return { root, env: { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'repos') } };
  }

  it('deletes the answered file once its plan is no longer waiting on it', async () => {
    const { root, env } = rootWithPlans({ 'docs/project/assistant-avatar/avatar-image-animation/PLAN.md': PLAN('ready') });
    const r = await collectBrief({ env, now: new Date('2026-08-29T10:00:00Z'), offline: true, ref: 'main' });
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md')), false, 'answered and applied — gone');
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-2.md')), true, 'the open question stays');
    assert.ok(r.data.notes.some((n) => /retired 1 answered decision file\(s\).*assistant-avatar-1\.md/u.test(n)));
    const agenda = r.text.slice(r.text.indexOf('## Waiting on Martin'), r.text.indexOf('## Plan status'));
    assert.doesNotMatch(agenda, /assistant-avatar-1\.md/u, 'and it is not on the agenda');
    assert.match(agenda, /assistant-avatar-2\.md/u);
    assert.match(agenda, /1 waiting, 0 answered/u, 'nothing answered is left to count');
    // A work root the runner has never tidied: absent is said as absent,
    // never as "none", or the brief would report a clean board it never read.
    assert.equal(r.data.unplanned, null);
    assert.match(r.text, /_no `~\/mc\/intake\/unplanned-workareas\.md` — `mc run` writes it at the end of every round_/u);
    assert.match(r.text, /_no `~\/mc\/intake\/undocumented-closures\.md` — nothing has been archived without one_/u);
  });

  it('keeps it while the plan still says waiting-decision', async () => {
    const { root, env } = rootWithPlans({ 'docs/project/assistant-avatar/avatar-image-animation/PLAN.md': PLAN('waiting-decision') });
    await collectBrief({ env, now: new Date('2026-08-29T10:00:00Z'), offline: true, ref: 'main' });
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md')), true, 'the answer is still needed');
  });

  it('reports an orphan and never deletes it', async () => {
    const { root, env } = rootWithPlans({ 'docs/project/other/elsewhere/PLAN.md': PLAN('ready') });
    const r = await collectBrief({ env, now: new Date('2026-08-29T10:00:00Z'), offline: true, ref: 'main' });
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md')), true);
    assert.ok(r.data.notes.some((n) => /orphan decision avatar\/decisions\/assistant-avatar-1\.md.*by hand/u.test(n)));
  });
});
