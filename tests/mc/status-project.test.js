/**
 * `mc status <name>` — one project, built from fixture files: no git, no gh,
 * no network. A work root under /tmp holds the workarea, its decisions and
 * runs.tsv; origin/main is an injected `git`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  collectProject, decisionsForProject, fieldRows, findMainPlan, findWorkareaPlan,
  renderProject, wrap,
} from '../../src/mc/status-project.js';
import { run as project } from '../../src/mc/commands/status-project.js';
import { runMcCli } from './_helpers/mc-cli.js';

const PLAN = (status, next) => `---
status: ${status}
next: "${next}"
budget: 150k
needs: []
---

# a plan
`;

const DECISION = (title, answered) => `# ${title}

## Rekommendation

**A.** Do it.

${answered ? '**Beslut:** A (Martin, 2026-08-29).\n' : ''}`;

const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-24T10:00:00Z\tmc-status\ttriage\t0\t100\t-\t5\t10\t20\t1000\t30\ts0\tsuccess',
  '2026-08-25T18:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts1\tsuccess,open',
  '2026-08-26T18:00:00Z\tmc-status\tstep\t0\t200\t401\t9\t10\t20\t1000\t30\ts2\tsuccess,merged',
  '2026-08-27T18:00:00Z\tmc-status\tstep\t0\t300\t402\t9\t10\t20\t1000\t30\ts3\tsuccess,merged',
  '2026-08-28T18:00:00Z\tmc-status\tstep\t1\t400\t-\t9\t10\t20\t1000\t30\ts4\tfailed',
  '',
].join('\n');

/** A work root with one workarea that holds a checkout and a plan. */
function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mc-status-'));
  const repo = join(root, 'mc-status', 'memoro-cli');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'project', 'mc', 'mc-status'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'project', 'mc', 'mc-status', 'PLAN.md'), PLAN('ready', 'Step 2 — one project'));
  mkdirSync(join(root, 'mc-status', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'mc-status', 'decisions', 'mc-status-2026-08-29.md'), DECISION('Contract change?', false));
  mkdirSync(join(root, 'mc-utredning', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'mc-utredning', 'decisions', 'mc-2.md'), DECISION('2. The programme question', true));
  mkdirSync(join(root, 'mc-run', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'mc-run', 'decisions', 'mc-run-1.md'), DECISION('1. Another project question', false));
  mkdirSync(join(root, 'jobbet'), { recursive: true });
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'log', 'runs.tsv'), TSV);
  return root;
}

const DECISIONS = [
  { area: 'mc-status', file: 'mc-status/decisions/mc-status-2026-08-29.md', title: 'Contract change?', answered: false },
  { area: 'mc-utredning', file: 'mc-utredning/decisions/mc-2.md', title: '2. The programme question', answered: true },
  { area: 'mc-run', file: 'mc-run/decisions/mc-run-1.md', title: '1. Another project question', answered: false },
  { area: 'avatar', file: 'avatar/decisions/assistant-avatar-4.md', title: '4. Retention?', answered: true },
];

describe('what belongs to one project', () => {
  it('takes its own area, its own name and the programme-wide numbers — not a sibling project', () => {
    assert.deepEqual(decisionsForProject(DECISIONS, { project: 'mc-status', programme: 'mc' }).map((d) => d.file), [
      'mc-status/decisions/mc-status-2026-08-29.md',
      'mc-utredning/decisions/mc-2.md',
    ]);
    assert.deepEqual(decisionsForProject(DECISIONS, { project: 'mc-run', programme: 'mc' }).map((d) => d.file), [
      'mc-utredning/decisions/mc-2.md',
      'mc-run/decisions/mc-run-1.md',
    ]);
    assert.deepEqual(decisionsForProject(DECISIONS, { project: 'x', programme: null }), []);
  });

  it('lists every frontmatter field but next, which gets its own block', () => {
    assert.deepEqual(fieldRows({ status: 'ready', next: 'Step 2', budget: '150k', needs: null }), [['status', 'ready'], ['budget', '150k']]);
    assert.deepEqual(fieldRows(null), []);
  });

  it('folds a paragraph and indents its continuation', () => {
    assert.equal(wrap('one two three four', 9, 3), 'one two\n   three\n   four');
    assert.equal(wrap('  spaced\n\nout ', 40, 2), 'spaced out');
  });
});

describe('finding the plan', () => {
  it('finds it in the workarea checkout, under whichever programme', () => {
    const root = workRoot();
    const found = findWorkareaPlan(join(root, 'mc-status'), 'mc-status');
    assert.equal(found.repo, 'memoro-cli');
    assert.equal(found.programme, 'mc');
    assert.equal(found.path, 'docs/project/mc/mc-status/PLAN.md');
    assert.equal(findWorkareaPlan(join(root, 'jobbet'), 'jobbet'), null);
  });

  it('finds it on origin/main through an injected git', () => {
    const root = workRoot();
    const git = (cwd, args) => {
      if (args[0] === 'ls-tree') return 'docs/project/mc/mc-status/PLAN.md\ndocs/project/mc/mc-run/PLAN.md';
      if (args[0] === 'show') return PLAN('ready', 'Step 1 — the page');
      return null;
    };
    const repos = [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }];
    const main = findMainPlan(repos, 'mc-status', { git });
    assert.equal(main.repo, 'memoro-cli');
    assert.equal(main.programme, 'mc');
    assert.match(main.text, /Step 1 — the page/u);
    assert.equal(findMainPlan(repos, 'nothing-here', { git }), null);
  });
});

describe('collectProject', () => {
  const git = (cwd, args) => {
    if (args[0] === 'ls-tree') return 'docs/project/mc/mc-status/PLAN.md';
    if (args[0] === 'show') return PLAN('ready', 'Step 1 — the page');
    return null;
  };

  it('prefers the workarea plan, says it differs from main, and keeps the last three runs', async () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root };
    const repos = [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }];
    const data = await collectProject('mc-status', { env, repos, offline: true, git });
    assert.equal(data.repo, 'memoro-cli');
    assert.equal(data.programme, 'mc');
    assert.equal(data.source, 'workarea memoro-cli');
    assert.equal(data.unmerged, true, 'the workarea says step 2, origin/main still says step 1');
    assert.deepEqual(data.fields, { status: 'ready', next: 'Step 2 — one project', budget: '150k', needs: '[]' });
    assert.deepEqual(data.runs.map((r) => [r.ts.slice(0, 10), r.pr]), [['2026-08-26', '401'], ['2026-08-27', '402'], ['2026-08-28', '-']]);
    assert.deepEqual(data.decisions.map((d) => d.answered), [false, true]);
    assert.deepEqual(data.prs, []);
    assert.deepEqual(data.notes, []);
  });

  it('falls back to origin/main when no workarea holds the plan', async () => {
    const root = workRoot();
    const repos = [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }];
    const data = await collectProject('mc-run', {
      env: { MC_WORK_ROOT: root },
      repos,
      offline: true,
      git: (cwd, args) => (args[0] === 'ls-tree' ? 'docs/project/mc/mc-run/PLAN.md' : PLAN('blocked', 'Wait for mc-2')),
    });
    assert.equal(data.source, 'origin/main');
    assert.equal(data.unmerged, false);
    assert.equal(data.path, 'docs/project/mc/mc-run/PLAN.md');
    assert.match(data.workarea, /mc-run$/u, 'the area exists for the decisions, but holds no checkout');
    assert.deepEqual(data.runs, []);
  });

  it('answers about a workarea with no plan, and about nothing at all', async () => {
    const root = workRoot();
    const opts = { env: { MC_WORK_ROOT: root }, repos: [], offline: true, git };
    const orphan = await collectProject('jobbet', opts);
    assert.equal(orphan.path, null);
    assert.equal(orphan.repo, null);
    assert.match(orphan.workarea, /jobbet$/u);
    assert.equal(await collectProject('never-existed', opts), null);
  });

  it('asks gh for the open PR on the branch of the same name', async () => {
    const root = workRoot();
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'gh') return { ok: true, stdout: JSON.stringify([{ number: 427, title: 'mc status <name>' }]) };
      return { ok: true, stdout: '' };
    };
    const data = await collectProject('mc-status', {
      env: { MC_WORK_ROOT: root }, repos: [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }], git, exec,
    });
    assert.deepEqual(data.prs, [{ number: 427, title: 'mc status <name>' }]);
    assert.ok(calls.some((c) => c.includes('fetch')), calls.join('\n'));
    assert.ok(calls.some((c) => c.startsWith('gh pr list') && c.includes('--head mc-status')), calls.join('\n'));
  });
});

describe('the project page', () => {
  const data = {
    name: 'mc-status',
    repo: 'memoro-cli',
    programme: 'mc',
    path: 'docs/project/mc/mc-status/PLAN.md',
    source: 'workarea memoro-cli',
    unmerged: true,
    fields: { status: 'ready', next: 'Step 2 — one project', budget: '150k' },
    workarea: '/tmp/mc/mc-status',
    decisions: [{ file: 'mc-status/decisions/mc-status-2026-08-29.md', title: 'Contract change?', answered: false, recommendation: '**A.** Do it.' }],
    runs: [{ ts: '2026-08-27T18:00:00Z', kind: 'step', seconds: '300', pr: '402', note: 'success,merged' }],
    prs: [{ number: 427, title: 'mc status <name>' }],
    notes: ['gh pr list failed'],
  };

  it('renders the frontmatter, the step, the decisions, the runs and the PR', () => {
    const text = renderProject(data);
    const at = ['NEXT', 'DECISIONS', 'LAST RUNS', 'OPEN PR'].map((h) => text.indexOf(`${h}\n`));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), text);
    assert.match(text, /^mc-status — memoro-cli · mc\n/u);
    assert.match(text, /plan +docs\/project\/mc\/mc-status\/PLAN\.md \(workarea memoro-cli, differs from\n +origin\/main\)/u);
    assert.match(text, /status +ready/u);
    assert.doesNotMatch(text, /^ +next /mu, 'next is a block, not a label row');
    assert.match(text, /NEXT\n {2}Step 2 — one project/u);
    assert.match(text, /waiting {3}mc-status\/decisions\/mc-status-2026-08-29\.md {2}Contract change\?/u);
    assert.match(text, /\*\*A\.\*\* Do it\./u);
    assert.match(text, /08-27 18:00Z +step +300s +#402 +success,merged/u);
    assert.match(text, /#427 {2}mc status <name>/u);
    assert.match(text, /note: gh pr list failed/u);
  });

  it('says plainly when a workarea has no plan, no decisions, no runs and no PR', () => {
    const text = renderProject({ ...data, path: null, repo: null, programme: null, fields: {}, decisions: [], runs: [], prs: [], notes: [] });
    assert.match(text, /no PLAN\.md — this is a workarea without a project/u);
    assert.doesNotMatch(text, /NEXT/u);
    assert.match(text, /DECISIONS\n {2}none/u);
    assert.match(text, /LAST RUNS\n {2}none in the runner log/u);
    assert.match(text, /OPEN PR\n {2}none on this branch/u);
  });

  it('prints the data with --json, refuses an unknown flag, and reports an unknown name', async () => {
    let out = '';
    const collect = async () => data;
    assert.equal(await project(['mc-status', '--json'], { collect, stdout: { write: (s) => { out += s; } } }), 0);
    assert.equal(JSON.parse(out).prs[0].number, 427);

    let err = '';
    const stderr = { write: (s) => { err += s; } };
    assert.equal(await project(['mc-status', '--watch'], { collect, stderr }), 2);
    assert.match(err, /unknown argument --watch/u);
    err = '';
    assert.equal(await project(['a', 'b'], { collect, stderr }), 2);
    assert.match(err, /usage — mc status <name>/u);
    err = '';
    assert.equal(await project(['gone'], { collect: async () => null, stderr }), 1);
    assert.match(err, /no project or workarea "gone"/u);
  });
});

describe('routing', () => {
  it('a name is the project page; no name says the page is mc', () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'no-repos') };
    const page = runMcCli(['status', 'mc-status', '--offline'], env);
    assert.equal(page.status, 0, page.stderr);
    assert.match(page.stdout, /^mc-status — memoro-cli · mc\n/u);
    assert.match(page.stdout, /NEXT\n {2}Step 2 — one project/u);

    // The board and its flags went with decision mc-3: `--sessions` is not a
    // name, so it lands on the same sentence a bare `mc status` does.
    const moved = runMcCli(['status', '--sessions', 'mc-status'], env);
    assert.equal(moved.status, 2, moved.stdout);
    assert.match(moved.stderr, /--sessions went with the old board/u);
    assert.match(moved.stderr, /mc status is now mc/u);
    const bare = runMcCli(['status'], env);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /mc status is now mc/u);
  });

  it('the sentence names only surfaces that run', () => {
    const root = workRoot();
    const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'no-repos') };
    const bare = runMcCli(['status'], env);
    // `mc --watch` was the page on a timer and was removed the day it landed;
    // pointing at it sent a person to `unknown command "--watch"`.
    assert.doesNotMatch(bare.stderr, /--watch/u);
    // Every `mc …` the sentence offers is run here, so the pointer cannot rot
    // into a menu of things that exit 2.
    const offered = [...bare.stderr.matchAll(/^ {4}(mc [^ ]*(?: <name>)?)/gmu)]
      .map((m) => m[1].replace(' <name>', ' mc-status').split(' ').slice(1).filter(Boolean));
    assert.ok(offered.length >= 2, bare.stderr);
    for (const args of offered) {
      const result = runMcCli([...args, '--offline'], env);
      assert.equal(result.status, 0, `mc ${args.join(' ')}: ${result.stderr}`);
    }
  });
});
