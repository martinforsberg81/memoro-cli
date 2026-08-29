/**
 * `mc brief --collect` — the builders behind the six sections, on fixtures:
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
  collectBrief, lastBriefTime, listPlans, parseDecision, parsePlanFrontmatter, planFields,
  queueNames, runsFor, runsSince, scanDecisions, summariseRuns,
} from '../../src/mc/brief-collect.js';

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
  return root;
}

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

  it('lists docs/project/<programme>/<project>/PLAN.md through an injected git', () => {
    const git = (cwd, args) => {
      if (args[0] === 'ls-tree') return 'docs/project/README.md\ndocs/project/mc/mc-brief/PLAN.md\ndocs/project/mc/mc.md\ndocs/project/mc/mc-plan/notes/PLAN.md';
      if (args[0] === 'show') return `---\nstatus: ready\nnext: "Step 1 — ${args[1]}"\n---\n`;
      return null;
    };
    const plans = listPlans({ name: 'memoro-cli', path: '/nowhere' }, { git });
    assert.deepEqual(plans.map((p) => [p.programme, p.project, p.status]), [['mc', 'mc-brief', 'ready']]);
    assert.match(plans[0].next, /origin\/main:docs\/project\/mc\/mc-brief\/PLAN\.md/u);
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

describe('collectBrief', () => {
  it('writes the six sections, offline, with a 24 h window on the first run', async () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'no-repos') };
    const now = new Date('2026-08-25T20:00:00Z');
    assert.equal(lastBriefTime(join(root, 'brief')), null);
    const result = await collectBrief({ env, now, offline: true });
    const text = readFileSync(result.path, 'utf8');
    assert.equal(text, result.text);
    const order = ['## Merged since last brief', '## Opened, not merged', '## Waiting on Martin', '## Plan status', '## Runner', '## Queue'];
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

  /** A work root plus a real git repository whose main carries the plans. */
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
    const { root, env } = rootWithPlans({ 'docs/project/assistant-avatar/avatar/PLAN.md': PLAN('ready') });
    const r = await collectBrief({ env, now: new Date('2026-08-29T10:00:00Z'), offline: true, ref: 'main' });
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-1.md')), false, 'answered and applied — gone');
    assert.equal(existsSync(join(root, 'avatar', 'decisions', 'assistant-avatar-2.md')), true, 'the open question stays');
    assert.ok(r.data.notes.some((n) => /retired 1 answered decision file\(s\).*assistant-avatar-1\.md/u.test(n)));
    const agenda = r.text.slice(r.text.indexOf('## Waiting on Martin'), r.text.indexOf('## Plan status'));
    assert.doesNotMatch(agenda, /assistant-avatar-1\.md/u, 'and it is not on the agenda');
    assert.match(agenda, /assistant-avatar-2\.md/u);
    assert.match(agenda, /1 waiting, 0 answered/u, 'nothing answered is left to count');
  });

  it('keeps it while the plan still says waiting-decision', async () => {
    const { root, env } = rootWithPlans({ 'docs/project/assistant-avatar/avatar/PLAN.md': PLAN('waiting-decision') });
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
