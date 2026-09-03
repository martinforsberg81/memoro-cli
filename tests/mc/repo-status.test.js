/**
 * `mc repo status` — the guarantees, asserted rather than claimed.
 *
 * Four of them (designnote §5): the view reads and writes nothing but the
 * refs a fetch updates; the worktree section is the board's own inspection
 * regrouped, so the two pages cannot drift apart; a missing `gh` degrades one
 * section instead of refusing the page; and `--offline` means the network,
 * not merely the fetch.
 */
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git } from './_helpers/git-fixture.js';
import {
  addArea, addedPaths, fixture, json, moveOriginMain, snapshot,
} from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { board as workModel } from './_helpers/board.js';
import { recordNightlyRun } from '../../src/mc/nightly-history.js';

describe('mc repo status — the view', () => {
  it('groups the work model\'s own worktree inspection by repository', async () => {
    const fx = fixture();
    const worktree = addArea(fx, 'alpha', 'alpha');
    writeFileSync(join(worktree, 'scratch.txt'), 'work in progress\n');
    try {
      const board = await workModel(fx.env);
      const view = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));

      assert.equal(view.repos.length, 1);
      assert.equal(view.repos[0].path, fx.dir);
      const fromBoard = board.areas.find((area) => area.name === 'alpha').worktrees[0];
      const fromView = view.repos[0].worktrees[0];
      assert.equal(fromView.area, 'alpha');
      assert.equal(fromView.branch, fromBoard.branch);
      assert.equal(fromView.uncommitted, fromBoard.uncommitted);
      assert.equal(fromView.unmerged_commits, fromBoard.unmerged_commits);
      assert.equal(fromView.uncommitted, 1);
    } finally { fx.cleanup(); }
  });

  it('counts how far behind main each open pull request is', () => {
    const fx = fixture({ gh: true });
    try {
      const worktree = addArea(fx, 'alpha', 'alpha');
      writeFileSync(join(worktree, 'a.txt'), 'a\n');
      git(worktree, 'add a.txt');
      git(worktree, 'commit -q -m "Alpha work"');
      const head = git(worktree, 'rev-parse HEAD');
      moveOriginMain(fx, 'One');
      moveOriginMain(fx, 'Two');

      // The pull request names the branch's real sha, so the count is done
      // against a commit this checkout actually has.
      writeFileSync(fx.prsPath, JSON.stringify([{
        number: 7,
        title: 'Something',
        headRefName: 'alpha',
        headRefOid: head,
        isDraft: false,
        updatedAt: '2026-08-14T10:00:00Z',
      }]));

      const view = json(runMcCli(['repo', 'status', '--json'], fx.env));
      const [pr] = view.repos[0].pull_requests.items;
      assert.equal(pr.number, 7);
      assert.equal(pr.branch, 'alpha');
      assert.equal(pr.behind_main, 2, JSON.stringify(view.repos[0].pull_requests));
      assert.equal(view.repos[0].pull_requests.degraded, null);
    } finally { fx.cleanup(); }
  });

  it('degrades the pull-request section when gh is missing, and shows the rest', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      const result = runMcCli(['repo', 'status', '--json'], fx.env);
      const view = json(result);
      const repo = view.repos[0];
      assert.match(repo.pull_requests.degraded, /gh is not installed/u);
      assert.deepEqual(repo.pull_requests.items, []);
      // The sections that do not need gh are all there.
      assert.equal(repo.main.id.length, 40);
      assert.equal(repo.worktrees.length, 1);
    } finally { fx.cleanup(); }
  });

  it('--offline neither fetches nor asks GitHub, and says so', () => {
    const fx = fixture({ gh: true });
    addArea(fx, 'alpha', 'alpha');
    try {
      const before = git(fx.dir, 'rev-parse origin/main');
      const moved = moveOriginMain(fx);

      const offline = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(offline.repos[0].main.id, before);
      assert.match(offline.repos[0].main.degraded, /offline/u);
      assert.match(offline.repos[0].pull_requests.degraded, /offline/u);
      assert.equal(existsSync(fx.ghLog), false, 'gh was called under --offline');

      const online = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(online.repos[0].main.id, moved);
      assert.equal(online.repos[0].main.degraded, null);
      assert.ok(readFileSync(fx.ghLog, 'utf8').includes('pr list'));
    } finally { fx.cleanup(); }
  });

  it('reads: it changes no repository, no worktree and nothing under mc\'s home', () => {
    const fx = fixture({ gh: true });
    const worktree = addArea(fx, 'alpha', 'alpha');
    try {
      const state = () => ({
        head: git(fx.dir, 'rev-parse HEAD'),
        dirty: git(fx.dir, 'status --porcelain'),
        branches: git(fx.dir, 'show-ref --heads'),
        worktreeHead: git(worktree, 'rev-parse HEAD'),
        worktreeDirty: git(worktree, 'status --porcelain'),
        files: snapshot(fx.dir, { skipGit: true }),
        worktreeFiles: snapshot(worktree, { skipGit: true }),
        home: snapshot(fx.mcHome, { skipLog: true }),
        work: snapshot(fx.workRoot),
      });
      const before = state();
      const homeBefore = snapshot(fx.mcHome);
      assert.equal(runMcCli(['repo', 'status', '--json'], fx.env).status, 0);
      assert.equal(runMcCli(['repo', 'status', '--offline'], fx.env).status, 0);

      // Every commit, branch and file exactly where it was — and no STATE
      // written under mc's home or the work root.
      assert.deepEqual(state(), before);
      // The log is the one exception, and it is named rather than filtered
      // out of sight: a read-only command records that it ran, and records
      // nothing else. Asserting the exact set is what keeps this test worth
      // running — "nothing changed except the thing we stopped looking at" is
      // not an invariant (2026-08-30).
      assert.deepEqual(addedPaths(homeBefore, snapshot(fx.mcHome)), ['logs/mc.log']);
    } finally { fx.cleanup(); }
  });

  it('reports the installation when mc runs straight from a checkout', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      // An `mc` on PATH that is a symlink into the working tree is what makes
      // `git pull` there a deploy — the case the deploy section exists for.
      const entry = join(fx.dir, 'run-mc.js');
      writeFileSync(entry, '#!/usr/bin/env node\n');
      chmodSync(entry, 0o755);
      symlinkSync(entry, join(fx.bin, 'mc'));

      const inStep = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(inStep.repos[0].deploy.source, entry);
      assert.equal(inStep.repos[0].deploy.in_step, true);
      assert.equal(inStep.repos[0].deploy.behind_main, 0);

      moveOriginMain(fx);
      const behind = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(behind.repos[0].deploy.in_step, false);
      assert.equal(behind.repos[0].deploy.behind_main, 1);
    } finally { fx.cleanup(); }
  });

  it('a name that matches nothing is an error, not an empty page', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      const result = runMcCli(['repo', 'status', 'not-a-repo', '--offline'], fx.env);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no repository called "not-a-repo"/u);
    } finally { fx.cleanup(); }
  });

  it('one repository by name, out of the ones mc can see', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      const view = json(runMcCli(['repo', 'status', 'repo', '--offline', '--json'], fx.env));
      assert.equal(view.repos.length, 1);
      assert.equal(view.repos[0].name, 'repo');
      assert.deepEqual(view.unknown, []);
    } finally { fx.cleanup(); }
  });
});

/**
 * What the nightly found, on the page that says what a repository's state is.
 *
 * Not behind a verb somebody has to know to type, and not a section that
 * appears only when something is wrong: "last full run 4h ago, all green" is
 * the line that makes the red line credible when it finally appears.
 */
describe('mc repo status — red, and since when', () => {
  const run = (fx, at, red, commit) => recordNightlyRun({
    repo: 'repo', path: fx.dir, started_at: at, duration_ms: 302_300,
    commit, verdict: red.length ? 'red' : 'green', stopped_at: red.length ? 'red' : null,
    reason: null, red, tests: 2445,
  }, { root: fx.mcHome });

  it('names a test red in two runs with the first run that saw it, on the page and in --json', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      // A green run first, so the date below is the day it broke rather than
      // the edge of the history — which the page words differently, and does.
      run(fx, '2026-08-31T03:00:00.000Z', [], 'c'.repeat(40));
      run(fx, '2026-09-01T03:00:00.000Z', ['data-bus event names'], 'a'.repeat(40));
      run(fx, '2026-09-02T03:00:00.000Z', ['data-bus event names'], 'b'.repeat(40));

      const view = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      const { nightly } = view.repos[0];
      assert.equal(nightly.runs, 3);
      assert.equal(nightly.measured.commit, 'b'.repeat(40));
      assert.equal(nightly.red[0].name, 'data-bus event names');
      assert.equal(nightly.red[0].since, '2026-09-01T03:00:00.000Z');

      const page = runMcCli(['repo', 'status', '--offline'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+bbbbbbb/u);
      assert.match(page.stdout, /red since .* \(2 runs\)\s+data-bus event names/u);
    } finally { fx.cleanup(); }
  });

  it('a repository nobody has measured says so rather than nothing', () => {
    const fx = fixture();
    addArea(fx, 'alpha', 'alpha');
    try {
      const view = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.deepEqual(view.repos[0].nightly, { runs: 0, last: null, measured: null, red: [] });
      assert.match(runMcCli(['repo', 'status', '--offline'], fx.env).stdout, /full run\s+never — mc repo nightly start/u);
    } finally { fx.cleanup(); }
  });
});
