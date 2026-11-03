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
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { fakeGitModel } from '../_fake-git-default.mjs';
import { useGitRunner } from '../../src/mc/git.js';
import { git } from './_helpers/git-fixture.js';
import { addArea, fixture, json, snapshot } from './_helpers/repo-fixture.js';
import { runVerb } from './_helpers/mc-verb.js';
import {
  combinedPath, readCombinedSnapshot, repoStatusRoot, writeSnapshot,
} from '../../src/mc/repo-snapshot.js';
import { watchLoop, watchRound } from '../../src/mc/repo-watch-loop.js';

/** mc's own checkout, where the watcher reads the commit it runs. */
const CHECKOUT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const CHECKOUT_HEAD = 'c0ffee1';

/** Wait for something the watcher does in its own time. */
async function until(predicate, { timeoutMs = 30_000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, everyMs); });
  }
}

/**
 * The reader thread of 'a reader never sees half a round': reads the combined
 * snapshot as fast as it can until told to stop, and answers with how many
 * whole reads it made and what each torn one looked like.
 */
const READER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const shared = new Int32Array(workerData.shared);
const torn = [];
let reads = 0;
Atomics.store(shared, 1, 1);
while (Atomics.load(shared, 0) === 0) {
  let text;
  try { text = readFileSync(workerData.path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  let whole = false;
  try { whole = Array.isArray(JSON.parse(text).repos); } catch { whole = false; }
  if (whole) { reads += 1; Atomics.add(shared, 2, 1); } else torn.push(text.slice(0, 80));
}
parentPort.postMessage({ reads, torn });
`;

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
      // fresh, to three seconds. This test then asks three more questions
      // before it looks, and when each was an mc process that took longer than
      // three seconds under load: the snapshot went STALE mid-test and
      // `view.stale` failed. What the staleness rule does with an old picture
      // is proved on its own below, against timestamps rather than against a
      // clock nobody controls.
      //
      // The file's git is the repository model, which knows the fixture and
      // not mc's own checkout; the checkout's HEAD is answered here, so the
      // commit the watcher records is pinned to the one read at its start.
      const model = fakeGitModel();
      const restoreGit = useGitRunner((cwd, args, options) => (
        args[0] === '-C' && realpathSync(args[1]) === CHECKOUT && args.slice(2).join(' ') === 'rev-parse --short HEAD'
          ? { status: 0, stdout: `${CHECKOUT_HEAD}\n`, stderr: '', signal: null }
          : model.runner(cwd, args, options)));
      let started;
      try {
        started = await runVerb(['repo', 'watch', 'start', '--interval', '60'], fx.env);
      } finally { restoreGit(); }
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /watching every 60s \(pid \d+\)/u);

      const written = await until(() => existsSync(combinedPath(fx.mcHome)));
      assert.ok(written, 'the watcher wrote no snapshot');

      const state = json(await runVerb(['repo', 'watch', 'status', '--json'], fx.env));
      assert.equal(state.running, true);
      assert.ok(state.pid > 0);
      // The commit mc's checkout held when it started.
      assert.equal(state.commit, CHECKOUT_HEAD);
      assert.equal(state.stale, false);

      // And now the view is a file read rather than a fetch and a gh round.
      const view = json(await runVerb(['repo', 'status', '--json'], fx.env));
      assert.equal(view.mode, 'snapshot');
      // Said with the age in it: if this ever fails again, the message is the
      // diagnosis rather than `true !== false`.
      assert.equal(view.stale, false, `snapshot was ${view.age_ms}ms old against a ${view.interval_ms}ms interval`);
      assert.equal(view.watcher.running, true);
      assert.equal(view.repos[0].path, fx.dir);
      assert.equal(view.repos[0].worktrees[0].area, 'alpha');

      const stopped = await runVerb(['repo', 'watch', 'stop'], fx.env);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped the watcher \(pid \d+\)/u);
      const gone = await until(async () => json(await runVerb(['repo', 'watch', 'status', '--json'], fx.env)).running === false);
      assert.ok(gone !== null, 'the watcher was still running after stop');
      assert.equal(existsSync(join(repoStatusRoot(fx.mcHome), 'watcher.json')), false);
    } finally {
      await runVerb(['repo', 'watch', 'stop'], fx.env);
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

  // The code moved: the watcher leaves after the refresh in flight, and the
  // successor it starts runs the next one (repo-watch-run.js).
  it('a loop told after a round that the code moved runs no further round', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      const said = [];
      let asked = 0;
      await watchLoop({
        rounds: 3, intervalMs: 1, root: fx.mcHome, env: { ...process.env, ...fx.env },
        log: (line) => said.push(line), afterRound: async () => { asked += 1; return true; },
      });
      assert.equal(said.filter((line) => /^(wrote|round failed)/u.test(line)).length, 1, said.join('\n'));
      assert.equal(asked, 1);
    } finally { fx.cleanup(); }
  });

  // `mc repo watch stop` waits for the watcher to leave; a minute's sleep
  // between rounds must not be what it waits for.
  it('a stop asked for while the loop sleeps ends the sleep at once', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      const said = [];
      const woken = new AbortController();
      let stopping = false;
      const began = Date.now();
      await watchLoop({
        rounds: 2, intervalMs: 60_000, root: fx.mcHome, env: { ...process.env, ...fx.env },
        shouldStop: () => stopping, wake: woken.signal,
        // Asked once the round is written and the loop has gone to sleep, as a
        // signal would arrive.
        log: (line) => { said.push(line); setImmediate(() => { stopping = true; woken.abort(); }); },
      });
      assert.equal(said.filter((line) => /^(wrote|round failed)/u.test(line)).length, 1, said.join('\n'));
      assert.ok(Date.now() - began < 10_000, `the loop slept ${Date.now() - began}ms after the stop`);
    } finally { fx.cleanup(); }
  });

  it('a reader never sees half a round', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      // The reader is a thread of its own, reading while the rounds are being
      // written rather than between them: in one thread a synchronous write
      // can never be caught half-done, so only a second one can catch it.
      // Each read is parsed and checked for the last field written: a torn
      // file would either fail to parse or arrive without its repositories.
      const shared = new Int32Array(new SharedArrayBuffer(12)); // stop, ready, reads
      const reader = new Worker(READER, { eval: true, workerData: { path: combinedPath(fx.mcHome), shared: shared.buffer } });
      const verdict = new Promise((resolve, reject) => { reader.once('message', resolve); reader.once('error', reject); });
      await until(() => Atomics.load(shared, 1) === 1, { everyMs: 1 });

      // Rounds go on until the reader has read fifty times mid-write, and
      // there are at least twenty whatever the reader managed.
      const big = Array.from({ length: 40 }, (_, index) => REPO(`/tmp/repo-${index}`, `repo-${index}`));
      let rounds = 0;
      while (rounds < 20 || (Atomics.load(shared, 2) < 50 && rounds < 2000)) {
        writeSnapshot(report(at(0), big), { intervalMs: 60_000, root: fx.mcHome });
        rounds += 1;
      }
      Atomics.store(shared, 0, 1);
      const { reads, torn } = await verdict;
      assert.deepEqual(torn, [], 'a half-written snapshot was read');
      assert.ok(reads > 0, `the reader never managed a read in ${rounds} rounds`);
    } finally { fx.cleanup(); }
  });

  it('a picture older than three rounds is STALE, and says how to fix it', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      writeSnapshot(report(at(10 * 60_000), [REPO(fx.dir, 'repo')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      const view = json(await runVerb(['repo', 'status', '--json'], fx.env));
      assert.equal(view.mode, 'snapshot');
      assert.equal(view.stale, true);
      assert.ok(view.age_ms > 3 * 60_000);

      const page = await runVerb(['repo', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /STALE/u);
      assert.match(page.stdout, /mc repo watch start/u);
    } finally { fx.cleanup(); }
  });

  it('within three rounds it is simply the answer', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      // One and a half rounds old, of an hour each: the picture is read by an
      // mc process this test starts, and with one-minute rounds the margin to
      // STALE was the ninety seconds that process has to start — a margin a
      // loaded machine can spend. In hours, the clock is out of it.
      writeSnapshot(report(at(90 * 60_000), [REPO(fx.dir, 'repo')]), {
        intervalMs: 60 * 60_000, root: fx.mcHome,
      });
      const view = json(await runVerb(['repo', 'status', '--json'], fx.env));
      assert.equal(view.stale, false);
      assert.doesNotMatch((await runVerb(['repo', 'status'], fx.env)).stdout, /STALE/u);
    } finally { fx.cleanup(); }
  });

  it('with no watcher at all it counts for itself, and says that is what it did', async () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const view = json(await runVerb(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.stale, false);
      assert.equal(view.watcher.running, false);
      assert.match((await runVerb(['repo', 'status', '--offline'], fx.env)).stdout, /counted now/u);
    } finally { fx.cleanup(); }
  });

  it('a snapshot mc cannot read is no snapshot — it counts instead', async () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      writeSnapshot(report(at(0), [REPO(fx.dir, 'repo')]), { intervalMs: 60_000, root: fx.mcHome });
      writeFileSync(combinedPath(fx.mcHome), '{ "schema": "something-else"');
      const view = json(await runVerb(['repo', 'status', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.repos.length, 1);
      assert.equal(readCombinedSnapshot({ root: fx.mcHome }).kind, 'absent');
    } finally { fx.cleanup(); }
  });

  it('a repository the picture has never heard of is counted, not denied', async () => {
    const fx = fixture({ name: 'repo-watch' });
    addArea(fx, 'alpha', 'alpha');
    try {
      writeSnapshot(report(at(0), [REPO('/nowhere/other-repo', 'other-repo')]), {
        intervalMs: 60_000, root: fx.mcHome,
      });
      const view = json(await runVerb(['repo', 'status', 'repo', '--offline', '--json'], fx.env));
      assert.equal(view.mode, 'computed');
      assert.equal(view.repos[0].path, fx.dir);
      assert.deepEqual(view.unknown, []);
    } finally { fx.cleanup(); }
  });

  it('stopping nothing is not an error, and neither is asking twice', async () => {
    const fx = fixture({ name: 'repo-watch' });
    try {
      const stopped = await runVerb(['repo', 'watch', 'stop'], fx.env);
      assert.equal(stopped.status, 0);
      assert.match(stopped.stdout, /no watcher is running/u);

      const started = await runVerb(['repo', 'watch', 'start', '--interval', '60'], fx.env);
      assert.equal(started.status, 0, started.stderr);
      const again = await runVerb(['repo', 'watch', 'start'], fx.env);
      assert.equal(again.status, 0);
      assert.match(again.stdout, /already running \(pid \d+/u);
    } finally {
      await runVerb(['repo', 'watch', 'stop'], fx.env);
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
