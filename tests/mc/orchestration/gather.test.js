/**
 * In-process tests for `mc gather` (§10a).
 *
 * Same dep-portal pattern as fanout — no real gh / git / registry.
 *
 * Covers:
 *   - happy path: phases merge cleanly → push + summary PR opened
 *   - conflict: second phase conflicts → STOP, surface files +
 *     previously-merged set, exit 1, no auto-resolve
 *   - no open PRs found → error
 *   - bad plan-slug → rejected at parse
 *   - dry-run: lists order, performs no merge or push
 *   - both --json and human-readable error paths asserted
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithDeps } from '../../../src/mc/commands/gather.js';

function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gather-test-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function makeFakeGh({ prs = [], createOk = true } = {}) {
  const calls = { prList: [], createPr: [] };
  return {
    calls,
    async prListByHeadPattern(pattern) {
      calls.prList.push(pattern);
      return prs;
    },
    async createSummaryPr(opts) {
      calls.createPr.push(opts);
      if (!createOk) return { ok: false, error: 'mock-fail' };
      return { ok: true, url: 'https://example.test/pr/999' };
    },
  };
}

function makeFakeGit({
  existingBranches = new Set(),
  mergeOutcomes = {},
  pushOk = true,
  fetchOk = true,
  defaultBranch = {
    ok: true,
    branch: 'main',
    ref: 'refs/heads/main',
    remote: 'origin',
    source: 'remote-head',
  },
} = {}) {
  const calls = {
    fetch: [], createCollectionBranch: [], checkout: [],
    tryMerge: [], push: [],
  };
  return {
    calls,
    branchExists: (_dir, b) => existingBranches.has(b),
    resolveDefaultBranch: () => defaultBranch,
    fetch(_dir, remote, ref) { calls.fetch.push({ remote, ref }); return fetchOk; },
    createCollectionBranch(_dir, branch, fromRef) {
      calls.createCollectionBranch.push({ branch, fromRef });
      existingBranches.add(branch);
    },
    checkout(_dir, branch) { calls.checkout.push(branch); },
    tryMerge(_dir, branch) {
      calls.tryMerge.push(branch);
      const outcome = mergeOutcomes[branch];
      if (outcome) return outcome;
      return { ok: true, conflicts: [] };
    },
    push(_dir, remote, branch) { calls.push.push({ remote, branch }); return pushOk; },
  };
}

function fakeRegistry(entries = []) {
  return { read: () => ({ entries }) };
}

function captureConsole(fn) {
  const stdout = [], stderr = [];
  const origLog = console.log, origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...a) => stdout.push(a.join(' '));
  console.error = (...a) => stderr.push(a.join(' '));
  process.stdout.write = (s) => { stdout.push(typeof s === 'string' ? s : s.toString()); return true; };
  process.stderr.write = (s) => { stderr.push(typeof s === 'string' ? s : s.toString()); return true; };
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }).then((status) => ({ status, stdout: stdout.join('\n'), stderr: stderr.join('\n') }));
}

describe('mc gather — happy path', () => {
  let tmp;
  beforeEach(() => { tmp = withTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  test('merges phase PRs cleanly, pushes, opens summary PR', async () => {
    const prs = [
      { number: 11, headRefName: 'fan/myplan/phase-1', title: 'phase 1 work', url: 'u1' },
      { number: 12, headRefName: 'fan/myplan/phase-2', title: 'phase 2 work', url: 'u2' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([
      { name: 'fanout-myplan-phase-1', parent_plan: 'myplan', phase_n: 1, from_ref: 'main' },
      { name: 'fanout-myplan-phase-2', parent_plan: 'myplan', phase_n: 2, from_ref: 'main' },
    ]);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'myplan', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan_slug, 'myplan');
    assert.equal(payload.collection_branch, 'wip/myplan');
    assert.equal(payload.from, 'main');
    assert.equal(payload.phase_count, 2);
    assert.equal(payload.summary_pr_url, 'https://example.test/pr/999');

    // Order: phase-1 merged before phase-2.
    assert.deepEqual(git.calls.tryMerge, [
      'refs/remotes/origin/fan/myplan/phase-1',
      'refs/remotes/origin/fan/myplan/phase-2',
    ]);
    assert.deepEqual(git.calls.push, [{ remote: 'origin', branch: 'wip/myplan' }]);
    assert.equal(gh.calls.createPr.length, 1);
    assert.equal(gh.calls.createPr[0].head, 'wip/myplan');
    assert.equal(gh.calls.createPr[0].base, 'main');
    assert.match(gh.calls.createPr[0].body, /phase 1: #11/);
    assert.match(gh.calls.createPr[0].body, /phase 2: #12/);
  });

  test('creates a missing collection branch from the resolved base ref', async () => {
    const prs = [{ number: 11, headRefName: 'fan/p/phase-1', title: 't', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([
      { parent_plan: 'p', phase_n: 1, from_ref: 'main' },
    ]);
    await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(git.calls.createCollectionBranch.length, 1);
    assert.equal(git.calls.createCollectionBranch[0].branch, 'wip/p');
    assert.equal(git.calls.createCollectionBranch[0].fromRef, 'refs/heads/main');
  });

  test('skips branch creation if wip/<slug> already exists', async () => {
    const prs = [{ number: 11, headRefName: 'fan/p/phase-1', title: 't', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({ existingBranches: new Set(['wip/p']) });
    const registry = fakeRegistry([
      { parent_plan: 'p', phase_n: 1, from_ref: 'main' },
    ]);
    await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(git.calls.createCollectionBranch.length, 0);
  });

  test('orders by phase number even when gh returns out of order', async () => {
    const prs = [
      { number: 22, headRefName: 'fan/p/phase-3', title: 'p3', url: 'u3' },
      { number: 21, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u1' },
      { number: 23, headRefName: 'fan/p/phase-2', title: 'p2', url: 'u2' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([{ parent_plan: 'p', phase_n: 1, from_ref: 'main' }]);
    await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.deepEqual(git.calls.tryMerge, [
      'refs/remotes/origin/fan/p/phase-1',
      'refs/remotes/origin/fan/p/phase-2',
      'refs/remotes/origin/fan/p/phase-3',
    ]);
  });

  test('uses the resolved default when registry has no phase entries', async () => {
    const prs = [{ number: 1, headRefName: 'fan/p/phase-1', title: 't', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.from, 'main');
  });

  test('uses a custom default branch and non-origin remote when metadata is absent', async () => {
    const prs = [{ number: 1, headRefName: 'fan/p/phase-1', title: 't', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({
      defaultBranch: {
        ok: true,
        branch: 'trunk',
        ref: 'refs/heads/trunk',
        remote: 'upstream',
        source: 'remote-head',
      },
    });
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry: fakeRegistry([]), cwd: tmp.dir },
      ),
    );

    assert.equal(status, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.from, 'trunk');
    assert.deepEqual(git.calls.fetch[0], { remote: 'upstream', ref: 'trunk' });
    assert.equal(git.calls.tryMerge[0], 'refs/remotes/upstream/fan/p/phase-1');
    assert.deepEqual(git.calls.push, [{ remote: 'upstream', branch: 'wip/p' }]);
    assert.equal(gh.calls.createPr[0].base, 'trunk');
  });

  test('refuses unknown default branch before querying or mutating', async () => {
    const gh = makeFakeGh({
      prs: [{ number: 1, headRefName: 'fan/p/phase-1', title: 't', url: 'u' }],
    });
    const git = makeFakeGit({
      defaultBranch: { ok: false, reason: 'default-branch-unknown' },
    });
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry: fakeRegistry([]), cwd: tmp.dir },
      ),
    );

    assert.equal(status, 1);
    assert.match(stderr, /default branch is unknown/);
    assert.equal(gh.calls.prList.length, 0);
    assert.equal(git.calls.fetch.length, 0);
  });
});

describe('mc gather — conflict surface', () => {
  let tmp;
  beforeEach(() => { tmp = withTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  test('stops on first conflict, lists files + previous merges, exit 1', async () => {
    const prs = [
      { number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u1' },
      { number: 12, headRefName: 'fan/p/phase-2', title: 'p2', url: 'u2' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({
      mergeOutcomes: {
        'refs/remotes/origin/fan/p/phase-2': { ok: false, conflicts: ['src/a.js', 'src/b.js'] },
      },
    });
    const registry = fakeRegistry([{ parent_plan: 'p', phase_n: 1, from_ref: 'main' }]);
    const { status, stdout, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.conflict.phase_n, 2);
    assert.deepEqual(payload.conflict.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(payload.conflict.previously_merged, [{ phase_n: 1, pr_number: 11 }]);
    assert.match(stderr, /merge conflict at phase 2/);
    assert.match(stderr, /src\/a\.js/);
    // No push happened.
    assert.equal(git.calls.push.length, 0);
    assert.equal(gh.calls.createPr.length, 0);
  });

  test('conflict surfaces on human-readable path too (no --json)', async () => {
    const prs = [
      { number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u1' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({
      mergeOutcomes: {
        'refs/remotes/origin/fan/p/phase-1': { ok: false, conflicts: ['src/oops.js'] },
      },
    });
    const registry = fakeRegistry([]);
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /merge conflict at phase 1/);
    assert.match(stderr, /src\/oops\.js/);
    assert.match(stderr, /Future work: `mc gather --strategy serial-deps`/);
  });
});

describe('mc gather — empty / dry-run / errors', () => {
  let tmp;
  beforeEach(() => { tmp = withTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  test('no open PRs → exit 1 + stderr message (non-JSON path)', async () => {
    const gh = makeFakeGh({ prs: [] });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'gone', dryRun: false, json: false },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /no open PRs found for plan "gone"/);
  });

  test('no open PRs → JSON ok:false', async () => {
    const gh = makeFakeGh({ prs: [] });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'gone', dryRun: false, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
  });

  test('--dry-run lists order, performs no merge or push', async () => {
    const prs = [
      { number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u1' },
      { number: 12, headRefName: 'fan/p/phase-2', title: 'p2', url: 'u2' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: true, json: true },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.phase_count, 2);
    assert.equal(git.calls.tryMerge.length, 0);
    assert.equal(git.calls.push.length, 0);
    assert.equal(gh.calls.createPr.length, 0);
  });

  test('PRs with unparseable phase numbers are dropped → error if none left', async () => {
    const prs = [
      { number: 1, headRefName: 'fan/p/main', title: 'malformed', url: 'u' },
    ];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /none had a parseable phase number/);
  });

  test('push failure after clean merge → error', async () => {
    const prs = [{ number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({ pushOk: false });
    const registry = fakeRegistry([]);
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /failed to push wip\/p/);
    assert.equal(gh.calls.createPr.length, 0);
  });

  test('fetch failure never merges a stale phase ref', async () => {
    const prs = [{ number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u' }];
    const gh = makeFakeGh({ prs });
    const git = makeFakeGit({
      existingBranches: new Set(['wip/p']),
      fetchOk: false,
    });
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry: fakeRegistry([]), cwd: tmp.dir },
      ),
    );

    assert.equal(status, 1);
    assert.match(stderr, /refusing to merge a stale phase ref/);
    assert.equal(git.calls.tryMerge.length, 0);
    assert.equal(git.calls.push.length, 0);
  });

  test('gh pr create failure → error after successful push', async () => {
    const prs = [{ number: 11, headRefName: 'fan/p/phase-1', title: 'p1', url: 'u' }];
    const gh = makeFakeGh({ prs, createOk: false });
    const git = makeFakeGit();
    const registry = fakeRegistry([]);
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planSlug: 'p', dryRun: false, json: false },
        { gh, git, registry, cwd: tmp.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /`gh pr create` failed/);
  });
});
