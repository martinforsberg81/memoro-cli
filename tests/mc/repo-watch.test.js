/**
 * The watcher — the process, its snapshot, and what the view does with it.
 *
 * The guarantees under test (designnote §3 and §5): the snapshot is written
 * atomically, so a reader never sees half a round; the watcher writes its own
 * files and nothing else; a picture older than three rounds reads as STALE
 * with the way to fix it; and with no picture at all the view counts for
 * itself and says so — it never refuses and never pretends.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git } from './_helpers/git-fixture.js';
import { addArea, fixture, json, snapshot } from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';
import {
  combinedPath, readCombinedSnapshot, repoStatusRoot, writeSnapshot,
} from '../../src/mc/repo-snapshot.js';
import { watchRound } from '../../src/mc/repo-watch-loop.js';

/** Wait for something the watcher does in its own time. */
async function until(predicate, { timeoutMs = 30_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, everyMs); });
  }
}

function report(at, repos) {
  return { at, offline: false, mode: 'computed', repos, unknown: [] };
}

const REPO = (path, name) => ({
  name,
  path,
  main: { ref: 'origin/main', id: 'a'.repeat(40), subject: 'A commit', at: at(0), fetched: true, degraded: null },
  pull_requests: { degraded: null, items: [] },
  worktrees: [],
  deploy: null,
});

function at(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

describe('the watcher', () => {
  it('runs, writes a snapshot, answers for itself, and stops', async () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      // The interval is deliberately long, and nothing here waits for it. The
      // loop writes its first round before it sleeps, so a short interval buys
      // no speed — it only shortens the window in which that round counts as
      // fresh, to three seconds. This test then spawns three more mc processes
      // before it looks, and under load that took longer than three seconds:
      // the snapshot went STALE mid-test and `view.stale` failed. What the
      // staleness rule does with an old picture is proved on its own below,
      // against timestamps rather than against a clock nobody controls.
      const started = runMcCli(['repo', 'watch', 'start', '--interval', '60'], fx.env);
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /watching every 60s \(pid \d+\)/u);

      const written = await until(() => existsSync(combinedPath(fx.mcHome)));
      assert.ok(written, 'the watcher wrote no snapshot');

      const state = json(runMcCli(['repo', 'watch', 'status', '--json'], fx.env));
      assert.equal(state.running, true);
      assert.ok(state.pid > 0);
      assert.equal(state.stale, false);

      // And now the view is a file read rather than a fetch and a gh round.
      const view = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(view.mode, 'snapshot');
      // Said with the age in it: if this ever fails again, the message is the
      // diagnosis rather than `true !== false`.
      assert.equal(view.stale, false, `snapshot was ${view.age_ms}ms old against a ${view.interval_ms}ms interval`);
      assert.equal(view.watcher.running, true);
      assert.equal(view.repos[0].path, fx.dir);
      assert.equal(view.repos[0].worktrees[0].area, 'alpha');

      const stopped = runMcCli(['repo', 'watch', 'stop'], fx.env);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped the watcher \(pid \d+\)/u);
      const gone = await until(() => json(runMcCli(['repo', 'watch', 'status', '--json'], fx.env)).running === false);
      assert.ok(gone !== null, 'the watcher was still running after stop');
      assert.equal(existsSync(join(repoStatusRoot(fx.mcHome), 'watcher.json')), false);
    } finally {
      runMcCli(['repo', 'watch', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('a round writes its own files and touches nothing else', async () => {
    const fx = fixture({ name: 'repo-watch' });
    const worktree = addArea(fx, 'alpha', 'alpha');
    try {
      const before = {
        head: git(fx.dir, 'rev-parse HEAD'),
        branches: git(fx.dir, 'show-ref --heads'),
        dirty: git(fx.dir, 'status --porcelain'),
        files: snapshot(fx.dir, { skipGit: true }),
        worktreeFiles: snapshot(worktree, { skipGit: true }),
        work: snapshot(fx.workRoot),
      };
      await watchRound({ intervalMs: 60_000, root: fx.mcHome, env: { ...process.env, ...fx.env } });

      assert.equal(git(fx.dir, 'rev-parse HEAD'), before.head);
      assert.equal(git(fx.dir, 'show-ref --heads'), before.branches);
      assert.equal(git(fx.dir, 'status --porcelain'), before.dirty);
      assert.deepEqual(snapshot(fx.dir, { skipGit: true }), before.files);
      assert.deepEqual(snapshot(worktree, { skipGit: true }), before.worktreeFiles);
      assert.deepEqual(snapshot(fx.workRoot), before.work);

      // Everything it wrote is under repo-status/, and nothing else is under
      // mc's home at all.
      assert.deepEqual(readdirSync(fx.mcHome), ['repo-status']);
      const names = readdirSync(repoStatusRoot(fx.mcHome)).sort();
      assert.ok(names.includes('all.json'), names.join(', '));
      assert.ok(names.every((name) => name.endsWith('.json')), names.join(', '));
    } finally { fx.cleanup(); }
  });

  it('a reader never sees half a round', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      const path = combinedPath(fx.mcHome);
      let reads = 0;
      let stop = false;
      const reader = (async () => {
        while (!stop) {
          if (existsSync(path)) {
            // Parsed, and checked for the last field written: a torn file
            // would either fail to parse or arrive without its repositories.
            const value = JSON.parse(readFileSync(path, 'utf8'));
            assert.ok(Array.isArray(value.repos), 'a half-written snapshot was read');
            reads += 1;
          }
          await new Promise((resolve) => { setTimeout(resolve, 0); });
        }
      })();

      const big = Array.from({ length: 40 }, (_, index) => REPO(`/tmp/repo-${index}`, `repo-${index}`));
      for (let round = 0; round < 200; round += 1) {
        writeSnapshot(report(at(0), big), { intervalMs: 60_000, root: fx.mcHome });
        if (round % 20 === 0) await new Promise((resolve) => { setTimeout(resolve, 0); });
      }
      stop = true;
      await reader;
      assert.ok(reads > 0, 'the reader never managed a read');
    } finally { fx.cleanup(); }
  });

  it('a picture older than three rounds is STALE, and says how to fix it', () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      writeSnapshot(report(at(10 * 60_000), [REPO(fx.dir, 'repo')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      const view = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(view.mode, 'snapshot');
      assert.equal(view.stale, true);
      assert.ok(view.age_ms > 3 * 60_000);

      const page = runMcCli(['repo', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /STALE/u);
      assert.match(page.stdout, /mc repo watch start/u);
    } finally { fx.cleanup(); }
  });

  it('within three rounds it is simply the answer', () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      writeSnapshot(report(at(90_000), [REPO(fx.dir, 'repo')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      const view = json(runMcCli(['repo', 'status', '--json'], fx.env));
      assert.equal(view.stale, false);
      assert.doesNotMatch(runMcCli(['repo', 'status'], fx.env).stdout, /STALE/u);
    } finally { fx.cleanup(); }
  });

  it('with no watcher at all it counts for itself, and says that is what it did', () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const view = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.stale, false);
      assert.equal(view.watcher.running, false);
      assert.match(runMcCli(['repo', 'status', '--offline'], fx.env).stdout, /counted now/u);
    } finally { fx.cleanup(); }
  });

  it('a snapshot mc cannot read is no snapshot — it counts instead', () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      writeSnapshot(report(at(0), [REPO(fx.dir, 'repo')]), { intervalMs: 60_000, root: fx.mcHome });
      writeFileSync(combinedPath(fx.mcHome), '{ "schema": "something-else"');
      const view = json(runMcCli(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.repos.length, 1);
      assert.equal(readCombinedSnapshot({ root: fx.mcHome }).kind, 'absent');
    } finally { fx.cleanup(); }
  });

  it('a repository the picture has never heard of is counted, not denied', () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      writeSnapshot(report(at(0), [REPO('/nowhere/other-repo', 'other-repo')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      const view = json(runMcCli(['repo', 'status', 'repo', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.repos[0].path, fx.dir);
      assert.deepEqual(view.unknown, []);
    } finally { fx.cleanup(); }
  });

  it('stopping nothing is not an error, and neither is asking twice', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      const stopped = runMcCli(['repo', 'watch', 'stop'], fx.env);
      assert.equal(stopped.status, 0);
      assert.match(stopped.stdout, /no watcher is running/u);

      const started = runMcCli(['repo', 'watch', 'start', '--interval', '60'], fx.env);
      assert.equal(started.status, 0, started.stderr);
      const again = runMcCli(['repo', 'watch', 'start'], fx.env);
      assert.equal(again.status, 0);
      assert.match(again.stdout, /already running \(pid \d+/u);
    } finally {
      runMcCli(['repo', 'watch', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('the snapshot forgets a repository that is no longer there', () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      writeSnapshot(report(at(0), [REPO('/a/one', 'one'), REPO('/a/two', 'two')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      assert.equal(readdirSync(repoStatusRoot(fx.mcHome)).length, 3);
      writeSnapshot(report(at(0), [REPO('/a/one', 'one')]), { intervalMs: 60_000, root: fx.mcHome });
      const names = readdirSync(repoStatusRoot(fx.mcHome)).sort();
      assert.equal(names.length, 2, names.join(', '));
      assert.ok(!names.some((name) => name.startsWith('two-')), names.join(', '));
    } finally { fx.cleanup(); }
  });
});
