/**
 * The lease (designnote §4): advisory, strict with mc and with nothing else.
 *
 * What is asserted here is the whole of what a lease is allowed to be — a
 * file under mc's home, a refusal aimed at `mc repo claim` and at nothing
 * that touches git, an age that never restarts on its own, an override that
 * is always written down, and no expiry: an old lease is visible, never
 * cleared behind somebody's back.
 *
 * And what it must not become: nothing else in mc reads it (§5.5). A held
 * lease changes no other command's behaviour, which is why the last case runs
 * ordinary work commands with one held.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git } from './_helpers/git-fixture.js';
import { addArea, fixture, json, snapshot } from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { leaseLogPath, leasePath, readLease } from '../../src/mc/repo-lease.js';
import { writeSnapshot } from '../../src/mc/repo-snapshot.js';

/** A shell standing in one of the work areas — that is who holds a lease. */
function inArea(fx, name) {
  const path = join(fx.workRoot, name);
  mkdirSync(path, { recursive: true });
  return { cwd: path };
}

function lease(fx) {
  return readLease(fx.dir, { root: fx.mcHome });
}

describe('the repository lease', () => {
  it('is taken by the work area that asks, and says what for', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const claimed = runMcCli(['repo', 'claim', 'repo', 'merge round #338'], fx.env, inArea(fx, 'alpha'));
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.match(claimed.stdout, /alpha holds .*merge round #338/u);

      const held = lease(fx);
      assert.equal(held.held, true);
      assert.equal(held.holder, 'alpha');
      assert.equal(held.holder_kind, 'work-area');
      assert.equal(held.errand, 'merge round #338');

      const who = json(runMcCli(['repo', 'who', 'repo', '--json'], fx.env, inArea(fx, 'alpha')));
      assert.equal(who.holder, 'alpha');
      assert.equal(who.errand, 'merge round #338');
    } finally { fx.cleanup(); }
  });

  it('lives under mc\'s home and never inside the repository', () => {
    const fx = fixture({ name: 'repo-lease' });
    const worktree = addArea(fx, 'alpha', 'alpha');
    try {
      const before = {
        files: snapshot(fx.dir, { skipGit: true }),
        worktreeFiles: snapshot(worktree, { skipGit: true }),
        head: git(fx.dir, 'rev-parse HEAD'),
        dirty: git(fx.dir, 'status --porcelain'),
      };
      runMcCli(['repo', 'claim', 'repo', 'a round'], fx.env, inArea(fx, 'alpha'));

      assert.ok(existsSync(leasePath(fx.dir, fx.mcHome)));
      assert.deepEqual(snapshot(fx.dir, { skipGit: true }), before.files);
      assert.deepEqual(snapshot(worktree, { skipGit: true }), before.worktreeFiles);
      assert.equal(git(fx.dir, 'rev-parse HEAD'), before.head);
      assert.equal(git(fx.dir, 'status --porcelain'), before.dirty);
      assert.deepEqual(readdirSync(fx.mcHome).sort(), ['repo-leases']);
    } finally { fx.cleanup(); }
  });

  it('refuses a second holder, names the first, and leaves the lease alone', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));
      const refused = runMcCli(['repo', 'claim', 'repo', 'another round'], fx.env, inArea(fx, 'beta'));
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /held by alpha/u);
      assert.match(refused.stderr, /merge round/u);
      assert.match(refused.stderr, /nothing is blocked/u);
      assert.match(refused.stderr, /--force/u);
      // The refusal changed nothing.
      assert.equal(lease(fx).holder, 'alpha');
      assert.equal(lease(fx).errand, 'merge round');
    } finally { fx.cleanup(); }
  });

  it('claiming your own does not restart the clock', async () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));
      const first = lease(fx).since;
      await new Promise((resolve) => { setTimeout(resolve, 1100); });
      const again = runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));
      assert.equal(again.status, 0);
      assert.match(again.stdout, /you already hold/u);
      assert.equal(lease(fx).since, first);
    } finally { fx.cleanup(); }
  });

  it('is given back by its holder, and taken from it only with --force', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));

      const refused = runMcCli(['repo', 'release', 'repo'], fx.env, inArea(fx, 'beta'));
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /held by alpha, not by you \(beta\)/u);
      assert.equal(lease(fx).held, true);

      const forced = runMcCli(['repo', 'release', 'repo', '--force'], fx.env, inArea(fx, 'beta'));
      assert.equal(forced.status, 0, forced.stderr);
      assert.match(forced.stdout, /took the lease .* from alpha — logged/u);
      assert.equal(lease(fx).held, false);

      // Always logged, and legible against what came before it.
      const log = readFileSync(leaseLogPath(fx.mcHome), 'utf8');
      assert.match(log, /claim\s+\S+\s+holder=alpha/u);
      assert.match(log, /force\s+\S+\s+by=beta\s+was=alpha/u);
    } finally { fx.cleanup(); }
  });

  it('its holder gives it back without ceremony, and a free one is not an error', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));
      const released = runMcCli(['repo', 'release', 'repo'], fx.env, inArea(fx, 'alpha'));
      assert.equal(released.status, 0, released.stderr);
      assert.equal(lease(fx).held, false);

      const again = runMcCli(['repo', 'release', 'repo'], fx.env, inArea(fx, 'alpha'));
      assert.equal(again.status, 0);
      assert.match(again.stdout, /already free/u);
      assert.match(runMcCli(['repo', 'who', 'repo'], fx.env, inArea(fx, 'alpha')).stdout, /free/u);
    } finally { fx.cleanup(); }
  });

  it('shows up in the view, held or free', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const free = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(free.repos[0].lease.held, false);
      assert.match(runMcCli(['repo', 'status', '--offline'], fx.env).stdout, /lease\s+free/u);

      runMcCli(['repo', 'claim', 'repo', 'merge round #338'], fx.env, inArea(fx, 'alpha'));
      const held = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(held.repos[0].lease.held, true);
      assert.equal(held.repos[0].lease.holder, 'alpha');
      const page = runMcCli(['repo', 'status', '--offline'], fx.env).stdout;
      assert.match(page, /lease\s+alpha/u);
      assert.match(page, /merge round #338/u);
      assert.match(page, /held for/u);
    } finally { fx.cleanup(); }
  });

  it('is read live even when the rest of the page comes from a snapshot', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      // A picture taken before anyone claimed anything.
      writeSnapshot({
        at: new Date().toISOString(),
        offline: false,
        repos: [{
          name: 'repo',
          path: fx.dir,
          main: { ref: 'origin/main', id: 'a'.repeat(40), subject: 'A commit', at: new Date().toISOString(), fetched: true, degraded: null },
          pull_requests: { degraded: null, items: [] },
          worktrees: [],
          deploy: null,
          lease: { held: false, holder: null, holder_kind: null, errand: '', since: null, age_ms: null },
        }],
      }, { intervalMs: 60_000, root: fx.mcHome });

      runMcCli(['repo', 'claim', 'repo', 'a round that just started'], fx.env, inArea(fx, 'alpha'));
      const view = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(view.mode, 'snapshot');
      assert.equal(view.repos[0].lease.held, true, 'the snapshot served a lease from before the claim');
      assert.equal(view.repos[0].lease.holder, 'alpha');
    } finally { fx.cleanup(); }
  });

  it('nothing else in mc reads it: a held lease changes no other command', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const before = runMcCli(['status', '--json'], fx.env);
      runMcCli(['repo', 'claim', 'repo', 'merge round'], fx.env, inArea(fx, 'alpha'));

      // The board says exactly what it said, and says nothing about leases.
      const after = runMcCli(['status', '--json'], fx.env);
      assert.equal(after.status, 0);
      assert.equal(JSON.stringify(areas(after)), JSON.stringify(areas(before)));
      // Not a text search — the fixture's own path has "lease" in it. The
      // board's shape is what must be free of the word.
      assert.equal(JSON.stringify(JSON.parse(after.stdout).areas).includes('"lease"'), false);

      // And the ordinary work verbs go on working on a held repository.
      const added = runMcCli(['work', 'add', 'beta', fx.dir, 'beta-branch'], fx.env);
      assert.equal(added.status, 0, added.stderr);
      assert.equal(lease(fx).holder, 'alpha');
    } finally { fx.cleanup(); }
  });

  it('asks for what it needs: a repository, and what the round is for', () => {
    const fx = fixture({ name: 'repo-lease' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const noErrand = runMcCli(['repo', 'claim', 'repo'], fx.env, inArea(fx, 'alpha'));
      assert.equal(noErrand.status, 2);
      assert.match(noErrand.stderr, /what for\?/u);

      const noRepo = runMcCli(['repo', 'who'], fx.env, inArea(fx, 'alpha'));
      assert.equal(noRepo.status, 2);
      assert.match(noRepo.stderr, /which repository\?/u);

      const nowhere = runMcCli(['repo', 'who', 'not-a-repo'], fx.env, inArea(fx, 'alpha'));
      assert.equal(nowhere.status, 1);
      assert.match(nowhere.stderr, /no repository called "not-a-repo"/u);
    } finally { fx.cleanup(); }
  });
});

/** The board's areas with their volatile fields dropped. */
function areas(result) {
  const page = JSON.parse(result.stdout);
  return page.areas.map((area) => ({
    name: area.name,
    worktrees: area.worktrees,
    running: area.running,
  }));
}
