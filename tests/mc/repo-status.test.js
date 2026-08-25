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
  addArea, fixture, json, moveOriginMain, snapshot,
} from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';

describe('mc repo status — the view', () => {
  it('groups the board\'s own worktree inspection by repository', () => {
    const fx = fixture();
    const worktree = addArea(fx, 'alpha', 'alpha');
    writeFileSync(join(worktree, 'scratch.txt'), 'work in progress\n');
    try {
      const board = json(runMcCli(['status', '--sessions', '--json'], fx.env));
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
        home: snapshot(fx.mcHome),
        work: snapshot(fx.workRoot),
      });
      const before = state();
      assert.equal(runMcCli(['repo', 'status', '--json'], fx.env).status, 0);
      assert.equal(runMcCli(['repo', 'status', '--offline'], fx.env).status, 0);

      // Every commit, branch and file exactly where it was — and nothing at
      // all written under mc's home or the work root.
      assert.deepEqual(state(), before);
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
