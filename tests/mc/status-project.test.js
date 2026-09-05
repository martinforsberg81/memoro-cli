/**
 * `mc status <name>` — one project, built from fixture files: no git, no gh,
 * no network. A work root under /tmp holds the workarea and
 * runs.tsv; origin/main is an injected `git`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  collectProject, fieldRows, findMainPlan, findWorkareaPlan,
  renderProject, wrap,
} from '../../src/mc/status-project.js';
import { run as project } from '../../src/mc/commands/status-project.js';
import { runMcCli } from './_helpers/mc-cli.js';

/** A plan as the file now is: one step, in the state the test wants. */
const PLAN = (status, title) => JSON.stringify({
  schema: 'mc-plan',
  version: 1,
  goal: ['One project on one page.'],
  contract: ['Not without Martin.'],
  out_of_scope: ['Everything else.'],
  success_criteria: [{ met: false, criterion: 'It is done.', check: 'The gate is green.' }],
  documents: [],
  steps: [
    { title: 'The first step', status: 'done', done_when: 'it was done', instruction: [], pr: 401, blocked_by: null },
    {
      title,
      status,
      done_when: 'one project is on one page',
      instruction: ['Do it.'],
      pr: null,
      blocked_by: status === 'blocked' ? { kind: 'decision', name: 'mc-1' } : null,
    },
  ],
}, null, 2);

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
  writeFileSync(join(repo, 'docs', 'project', 'mc', 'mc-status', 'PLAN.json'), PLAN('ready', 'One project'));
  // Areas with no checkout of their own: `mc status` still finds the folder.
  mkdirSync(join(root, 'mc-run'), { recursive: true });
  mkdirSync(join(root, 'jobbet'), { recursive: true });
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'log', 'runs.tsv'), TSV);
  return root;
}

describe('the plan fields', () => {
  it('says the state the steps put the plan in, and anything wrong with the file', () => {
    const plan = JSON.parse(PLAN('ready', 'One project'));
    assert.deepEqual(fieldRows(plan), [['status', 'ready']]);
    assert.deepEqual(fieldRows(null, ['out_of_scope: at least one entry']), [['problem', 'out_of_scope: at least one entry']]);
    assert.deepEqual(fieldRows(null), []);
  });

  /**
   * The pair, in one row. `ready` is the plan's word and it was the whole
   * answer this page gave on 2026-09-05, for two projects the runner could
   * not have started — the machine's half rides on the same row so a person
   * who reads one row has read the answer.
   */
  it('says the plan state and what this machine has to say about it, in one row', () => {
    const plan = JSON.parse(PLAN('ready', 'One project'));
    const held = {
      runnable: false,
      reason: 'held-after-repair',
      detail: '#614 is held before merge after a repair — the brief\'s',
      since: '2026-09-03T10:00:00Z',
      kind: null,
    };
    assert.deepEqual(fieldRows(plan, [], held), [
      ['status', 'ready · #614 is held before merge after a repair — the brief\'s (since 09-03 10:00Z)'],
    ]);
    // The home directory is folded: the row is read in a terminal, and the
    // absolute path of a workarea is most of its width.
    const dirty = {
      runnable: false, reason: 'dirty', kind: null, since: '2026-09-05T10:03:51Z',
      detail: 'uncommitted work in /Users/m/mc/connections-section/memoro: probe.mjs',
    };
    assert.deepEqual(fieldRows(plan, [], dirty, '/Users/m'), [
      ['status', 'ready · uncommitted work in ~/mc/connections-section/memoro: probe.mjs (since 09-05 10:03Z)'],
    ]);
  });

  /**
   * The silent cases, which matter as much: most projects have nothing in the
   * way, and a row that grew a clause for every one of them would be noise on
   * the day it had something to say.
   */
  it('adds nothing when the machine has nothing to say, or only what the plan already says', () => {
    const ready = JSON.parse(PLAN('ready', 'One project'));
    const blocked = JSON.parse(PLAN('blocked', 'Wait for mc-2'));
    const runnable = { runnable: true, reason: null, detail: null, since: null, kind: 'step' };
    assert.deepEqual(fieldRows(ready, [], runnable), [['status', 'ready']]);
    assert.deepEqual(fieldRows(ready, [], null), [['status', 'ready']]);
    // `blocked · blocked` is the row this rule exists to stop.
    assert.deepEqual(fieldRows(blocked, [], {
      runnable: false, reason: 'blocked', detail: 'blocked on decision mc-1', since: null, kind: null,
    }), [['status', 'blocked']]);
  });

  /**
   * A hold still owed its one repair session is not a refusal — the runner
   * would start it — but what it would start is a repair, not the step the
   * plan names, and that is worth a row saying so.
   */
  it('says a repair is what the runner would start, on a plan that reads ready', () => {
    const plan = JSON.parse(PLAN('ready', 'One project'));
    assert.deepEqual(fieldRows(plan, [], {
      runnable: true, reason: null, kind: 'repair', since: '2026-09-03T10:00:00Z',
      detail: '#614 is held before merge — one repair session is owed',
    }), [['status', 'ready · #614 is held before merge — one repair session is owed (since 09-03 10:00Z)']]);
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
    assert.equal(found.path, 'docs/project/mc/mc-status/PLAN.json');
    assert.equal(findWorkareaPlan(join(root, 'jobbet'), 'jobbet'), null);
  });

  it('finds it on origin/main through an injected git', () => {
    const root = workRoot();
    const git = (cwd, args) => {
      if (args[0] === 'ls-tree') return 'docs/project/mc/mc-status/PLAN.json\ndocs/project/mc/mc-run/PLAN.json';
      if (args[0] === 'show') return PLAN('ready', 'The page');
      return null;
    };
    const repos = [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }];
    const main = findMainPlan(repos, 'mc-status', { git });
    assert.equal(main.repo, 'memoro-cli');
    assert.equal(main.programme, 'mc');
    assert.match(main.text, /The page/u);
    assert.equal(findMainPlan(repos, 'nothing-here', { git }), null);
  });
});

describe('collectProject', () => {
  const git = (cwd, args) => {
    if (args[0] === 'ls-tree') return 'docs/project/mc/mc-status/PLAN.json';
    if (args[0] === 'show') return PLAN('ready', 'The page');
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
    assert.equal(data.unmerged, true, 'the workarea and origin/main hold different plans');
    assert.deepEqual(data.problems, []);
    assert.equal(data.plan.steps[1].title, 'One project', 'the workarea plan wins');
    assert.deepEqual(data.runs.map((r) => [r.ts.slice(0, 10), r.pr]), [['2026-08-26', '401'], ['2026-08-27', '402'], ['2026-08-28', '-']]);
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
      git: (cwd, args) => (args[0] === 'ls-tree' ? 'docs/project/mc/mc-run/PLAN.json' : PLAN('blocked', 'Wait for mc-2')),
    });
    assert.equal(data.source, 'origin/main');
    assert.equal(data.unmerged, false);
    assert.equal(data.path, 'docs/project/mc/mc-run/PLAN.json');
    assert.match(data.workarea, /mc-run$/u, 'the area exists but holds no checkout');
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

  /**
   * The whole defect, end to end: on 2026-09-05 this printed `ready` for
   * `role-instructions` while #614 was held with its one repair spent and the
   * runner could not have started it. The plan is still `ready` — that is a
   * fact about the file on main — and the row now says both.
   */
  it('names the held pull request beside the plan state', async () => {
    const root = workRoot();
    writeFileSync(join(root, 'runner', 'held.json'), JSON.stringify([{
      project: 'mc-status', repo: 'memoro-cli', pr: 427, branch: 'mc-status',
      reason: 'two tests the change reaches are red', note: 'open,gate-red',
      since: '2026-09-03T10:00:00Z', repairs: 1,
    }]));
    const exec = async (cmd) => (cmd === 'gh'
      ? { ok: true, stdout: JSON.stringify([{ number: 427, title: 'mc status <name>', headRefName: 'mc-status' }]) }
      : { ok: true, stdout: '' });
    const data = await collectProject('mc-status', {
      env: { MC_WORK_ROOT: root },
      repos: [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }],
      git,
      exec,
    });
    assert.equal(data.machine.runnable, false);
    assert.equal(data.machine.reason, 'held-after-repair');
    assert.equal(data.machine.since, '2026-09-03T10:00:00Z');
    assert.match(renderProject(data), /status +ready · #427 is held before merge after a repair/u);
  });

  /**
   * `--offline` did not ask GitHub, and what nobody asked is not the same as
   * nothing being open — the reading says so rather than promising a `ready`
   * it cannot stand behind. It is the round's own word for it.
   */
  it('will not call a project startable on a GitHub it was not allowed to ask', async () => {
    const root = workRoot();
    const data = await collectProject('mc-status', {
      env: { MC_WORK_ROOT: root },
      repos: [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }],
      offline: true,
      git,
    });
    assert.equal(data.machine.reason, 'prs-unknown');
    assert.match(renderProject(data), /status +ready · GitHub could not be asked/u);
  });

  // `--head <name>` printed nothing for a project whose three branches all
  // had an open PR (`action-window`, 2026-09-02). The project's branches are
  // `<name>` and `<name>-<n>`, and its siblings on main are what keep
  // `mc-status-2` out of `mc`'s row.
  it('asks gh for the whole project: its own branch and every `<name>-<n>`', async () => {
    const root = workRoot();
    const calls = [];
    const open = [
      { number: 427, title: 'mc status <name>', headRefName: 'mc-status' },
      { number: 428, title: 'mc status, again', headRefName: 'mc-status-2' },
      { number: 429, title: 'somewhere else', headRefName: 'mc-run' },
      { number: 430, title: 'a branch of its own', headRefName: 'spike/mc-status' },
    ];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'gh') return { ok: true, stdout: JSON.stringify(open) };
      return { ok: true, stdout: '' };
    };
    const tree = ['docs/project/mc/mc-status/PLAN.json', 'docs/project/mc/mc-run/PLAN.json'].join('\n');
    const many = (cwd, args) => (args[0] === 'ls-tree' ? tree : git(cwd, args));
    const data = await collectProject('mc-status', {
      env: { MC_WORK_ROOT: root }, repos: [{ name: 'memoro-cli', path: join(root, 'mc-status', 'memoro-cli') }], git: many, exec,
    });
    assert.deepEqual(data.prs.map((pr) => pr.number), [427, 428]);
    assert.ok(calls.some((c) => c.includes('fetch')), calls.join('\n'));
    assert.ok(calls.some((c) => c.startsWith('gh pr list') && !c.includes('--head')), calls.join('\n'));
  });
});

describe('the project page', () => {
  const data = {
    name: 'mc-status',
    repo: 'memoro-cli',
    programme: 'mc',
    path: 'docs/project/mc/mc-status/PLAN.json',
    source: 'workarea memoro-cli',
    unmerged: true,
    plan: JSON.parse(PLAN('ready', 'One project')),
    problems: [],
    workarea: '/tmp/mc/mc-status',
    runs: [{ ts: '2026-08-27T18:00:00Z', kind: 'step', seconds: '300', pr: '402', note: 'success,merged' }],
    prs: [{ number: 427, title: 'mc status <name>' }],
    notes: ['gh pr list failed'],
  };

  it('renders the state, the next step, every step, the runs and the PR', () => {
    const text = renderProject(data);
    const at = ['NEXT', 'STEPS', 'LAST RUNS', 'OPEN PR'].map((h) => text.indexOf(`${h}\n`));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), text);
    assert.match(text, /^mc-status — memoro-cli · mc\n/u);
    assert.match(text, /plan +docs\/project\/mc\/mc-status\/PLAN\.json \(workarea memoro-cli, differs from\n +origin\/main\)/u);
    assert.match(text, /status +ready/u);
    assert.doesNotMatch(text, /^ +next /mu, 'next is a block, not a label row');
    assert.match(text, /NEXT\n {2}Step 2, One project — done when one project is on one page/u);
    // The steps are the record: what is finished, with its PR, and where the
    // project is now.
    assert.match(text, /STEPS\n {2}✓ {2}1 {2}The first step\s+#401\n {2}▸ {2}2 {2}One project\s+ready/u);
    assert.match(text, /08-27 18:00Z +step +300s +#402 +success,merged/u);
    assert.match(text, /#427 {2}mc status <name>/u);
    assert.match(text, /note: gh pr list failed/u);
  });

  it('says plainly when a workarea has no plan, no runs and no PR', () => {
    const text = renderProject({ ...data, path: null, repo: null, programme: null, plan: null, problems: [], runs: [], prs: [], notes: [] });
    assert.match(text, /no plan — this is a workarea without a project/u);
    assert.doesNotMatch(text, /NEXT/u);
    assert.doesNotMatch(text, /DECISIONS/u);
    assert.match(text, /LAST RUNS\n {2}none in the runner log/u);
    assert.match(text, /OPEN PR\n {2}none for this project/u);
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
    assert.match(page.stdout, /NEXT\n {2}Step 2, One project — done when one project is on one page/u);

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
