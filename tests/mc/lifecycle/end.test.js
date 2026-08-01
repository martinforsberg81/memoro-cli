/**
 * TDD spec for `mc end` (§2 + §9b + §9c).
 *
 * Per the plan:
 *   - Confirmed `mc end <name>` removes a worktree and its local branch.
 *   - `mc end .` auto-detects the current worktree.
 *   - Shows status and confirms once before any interactive teardown.
 *   - `--keep-branch` retains the branch regardless.
 *   - Bulk: `mc end a b c` operates sequentially.
 *   - `--dry-run` prints one line per target with verdict, no side effects.
 *   - Squash-merge phantoms (§9b) affect status only; they never bypass
 *     permanent-teardown confirmation.
 *
 * Phantom detection mocking: the plan §9b uses `gh pr list --head` to
 * confirm a recent merged PR. Tests can't hit GitHub, so the
 * implementation should accept an injected `gh` stub via env:
 *   MC_TEST_GH_PHANTOM=1  → treat any branch as having a merged PR.
 *   The phantom verdict still requires the changeset to already live
 *   on main (we set this up explicitly via makeSquashPhantom).
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import {
  makeTempRepo, git, makeBranchWithCommit, makeSquashPhantom, addWorktree,
} from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';
import { run as runEnd } from '../../../src/mc/commands/end.js';

describe('mc end', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'end' }); });
  after(() => { repo?.cleanup(); });

  test('rejects unknown name', () => {
    const r = runMc(['end', 'nope'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });

  test('non-interactive dirty teardown requires explicit automation consent', () => {
    // Create a worktree with a dirty file.
    makeBranchWithCommit(repo.dir, 'sess/dirty', 'tmp.txt', 'committed\n');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'dirty');
    addWorktree(repo.dir, wtPath, 'sess/dirty');
    // Make it dirty.
    git(wtPath, 'config user.email "t@x"');
    git(wtPath, 'config user.name "t"');
    // Write an uncommitted file.
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'dirty', branch: 'sess/dirty',
      worktree_path: wtPath, dirty_files: 1,
      safety_verdict: 'NEEDS_REVIEW',
    })]);
    const r = runMc(['end', 'dirty'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0,
      `expected non-zero exit for dirty worktree; stderr:${r.stderr}`);
    assert.match(r.stderr + r.stdout, /dirty|uncommitted|force/i);
  });

  test('non-interactive live teardown requires explicit automation consent', () => {
    makeBranchWithCommit(repo.dir, 'sess/live', 'tmp.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'live');
    addWorktree(repo.dir, wtPath, 'sess/live');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'live', branch: 'sess/live',
      worktree_path: wtPath, session_state: 'live',
      safety_verdict: 'IS_ACTIVE_NOW',
    })]);
    const r = runMc(['end', 'live'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /live|active|force/i);
  });

  test('asks before ending an active session and keeps it when declined', async () => {
    makeBranchWithCommit(repo.dir, 'sess/live-decline', 'tmp.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'live-decline');
    addWorktree(repo.dir, wtPath, 'sess/live-decline');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'live-decline', branch: 'sess/live-decline',
      worktree_path: wtPath, session_state: 'live',
      safety_verdict: 'IS_ACTIVE_NOW',
    })]);

    const { result, stdout } = await runEndInProcess(repo, ['live-decline'], 'n');

    assert.equal(result, 1);
    assert.match(stdout, /Avsluta och ta bort allt sessionsbundet lokalt\? y\/n/);
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.match(wts, /live-decline/);
  });

  test('asks before ending an active session and ends it when confirmed', async () => {
    git(repo.dir, 'branch sess/live-confirm main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'live-confirm');
    addWorktree(repo.dir, wtPath, 'sess/live-confirm');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'live-confirm', branch: 'sess/live-confirm',
      worktree_path: wtPath, session_state: 'live',
      safety_verdict: 'IS_ACTIVE_NOW',
    })]);

    const { result, stdout, stderr } = await runEndInProcess(repo, ['live-confirm'], 'y', {
      removeBrokerSessionForEntry: async () => ({ ok: true, removed: true }),
    });

    assert.equal(result, 0, stderr);
    assert.match(stdout, /Avsluta och ta bort allt sessionsbundet lokalt\? y\/n/);
    assert.match(stdout, /mc: ended live-confirm/);
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('live-confirm'), `worktree should be gone; got:\n${wts}`);
  });

  test('successfully ends a clean, merged worktree (§2)', () => {
    // Branch off main, no commits ahead → "merged" in cs's sense.
    git(repo.dir, 'branch sess/clean main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'clean');
    addWorktree(repo.dir, wtPath, 'sess/clean');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'clean', branch: 'sess/clean',
      worktree_path: wtPath, safety_verdict: 'SAFE_TO_END',
    })]);
    const r = runMc(['end', 'clean', '--json', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.ok, true);
    // Side effect: worktree removed.
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('clean'),
      `worktree should be gone; got:\n${wts}`);
  });

  test('ends a launched session that recorded no provider artifacts at all', () => {
    // A session can launch with provider transcripts disabled (e.g. the
    // child-session marker) and record no tool_session_* fields. There is
    // nothing identifiable to delete provider-side — teardown must proceed
    // with the provider surface untouched, not dead-end forever.
    git(repo.dir, 'branch sess/providerless main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'providerless');
    addWorktree(repo.dir, wtPath, 'sess/providerless');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'providerless', branch: 'sess/providerless',
      worktree_path: wtPath, safety_verdict: 'SAFE_TO_END',
      session_state: 'idle',
      coding_session_id: 'sess_providerless1',
      tool: 'claude',
    })]);
    const r = runMc(['end', 'providerless', '--json', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j?.ok, true);
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('providerless'),
      `worktree should be gone; got:\n${wts}`);
  });

  test('bare `mc end` auto-detects the current registered worktree', () => {
    git(repo.dir, 'branch sess/current main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'current');
    addWorktree(repo.dir, wtPath, 'sess/current');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'current',
      branch: 'sess/current',
      worktree_path: wtPath,
      primary_worktree: repo.dir,
      safety_verdict: 'SAFE_TO_END',
    })]);

    const r = runMc(['end', '--json', '--force'], {
      cwd: wtPath, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j?.ok, true);
    assert.equal(j.name, 'current');
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('/current'), `worktree should be gone; got:\n${wts}`);
  });

  test('bare `mc end` from primary repo ends the last opened session for that repo', () => {
    git(repo.dir, 'branch sess/older main');
    git(repo.dir, 'branch sess/latest main');
    const oldWt = join(repo.mcHome, 'worktrees', 'repo', 'older');
    const latestWt = join(repo.mcHome, 'worktrees', 'repo', 'latest');
    addWorktree(repo.dir, oldWt, 'sess/older');
    addWorktree(repo.dir, latestWt, 'sess/latest');
    writeRegistry(repo.mcHome, [
      makeEndEntry({
        name: 'older',
        branch: 'sess/older',
        worktree_path: oldWt,
        primary_worktree: repo.dir,
        last_opened_at: '2026-07-10T10:00:00.000Z',
        safety_verdict: 'SAFE_TO_END',
      }),
      makeEndEntry({
        name: 'latest',
        branch: 'sess/latest',
        worktree_path: latestWt,
        primary_worktree: repo.dir,
        last_opened_at: '2026-07-11T10:00:00.000Z',
        safety_verdict: 'SAFE_TO_END',
      }),
    ]);

    const r = runMc(['end', '--json', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr} stdout:${r.stdout}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j?.ok, true);
    assert.equal(j.name, 'latest');
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.match(wts, /older/);
    assert.doesNotMatch(wts, /latest/);
  });

  test('`mc end .` auto-detects the current registered worktree', () => {
    git(repo.dir, 'branch sess/dot main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'dot');
    addWorktree(repo.dir, wtPath, 'sess/dot');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'dot',
      branch: 'sess/dot',
      worktree_path: wtPath,
      primary_worktree: repo.dir,
      safety_verdict: 'SAFE_TO_END',
    })]);

    const r = runMc(['end', '.', '--json', '--force'], {
      cwd: wtPath, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j?.ok, true);
    assert.equal(j.name, 'dot');
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('/dot'), `worktree should be gone; got:\n${wts}`);
  });

  test('uses an opaque id to target another repository without guessing by name', () => {
    const other = makeTempRepo({ name: 'end-other' });
    try {
      git(other.dir, 'config --local mc.repositoryId repo_cccccccccccccccccccccccc');
      git(other.dir, 'branch sess/cross main');
      const wtPath = join(repo.mcHome, 'worktrees', 'other', 'cross');
      addWorktree(other.dir, wtPath, 'sess/cross');
      writeRegistry(repo.mcHome, [makeEndEntry({
        name: 'cross',
        session_id: 'mcs_cccccccccccccccccccccccc',
        repository_id: 'repo_cccccccccccccccccccccccc',
        repository_identity: { schema: 1, kind: 'local', canonical: null },
        branch: 'sess/cross',
        repo_slug: 'other',
        worktree_path: wtPath,
        primary_worktree: other.dir,
        safety_verdict: 'SAFE_TO_END',
      })]);

      const r = runMc(['end', 'mcs_cccccccccccccccccccccccc', '--json', '--force'], {
        cwd: repo.dir, env: { MC_HOME: repo.mcHome },
      });
      assert.equal(r.status, 0, `stderr:${r.stderr} stdout:${r.stdout}`);
      const j = parseJsonOrNull(r.stdout);
      assert.equal(j?.ok, true);
      const wts = git(other.dir, 'worktree list --porcelain');
      assert.ok(!wts.includes('/cross'), `other repo worktree should be gone; got:\n${wts}`);
    } finally {
      other.cleanup();
    }
  });

  test('--force removes an unmerged branch instead of leaving partial state', () => {
    makeBranchWithCommit(repo.dir, 'sess/unmerged', 'unmerged.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'unmerged');
    addWorktree(repo.dir, wtPath, 'sess/unmerged');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'unmerged',
      branch: 'sess/unmerged',
      worktree_path: wtPath,
      primary_worktree: repo.dir,
      ahead: 1,
      safety_verdict: 'HAS_UNMERGED_WORK',
    })]);

    const r = runMc(['end', 'unmerged', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mc: ended unmerged/);
    assert.doesNotMatch(git(repo.dir, 'branch --list'), /sess\/unmerged/);
  });

  test('ending a worktree removes the matching broker session first', async () => {
    git(repo.dir, 'branch sess/broker-clean main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'broker-clean');
    addWorktree(repo.dir, wtPath, 'sess/broker-clean');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'broker-clean',
      branch: 'sess/broker-clean',
      worktree_path: wtPath,
      coding_session_id: 'sess_broker_clean',
      safety_verdict: 'SAFE_TO_END',
    })]);
    const requests = [];

    const { result } = await runEndInProcess(repo, ['broker-clean'], 'y', {
      resolveSessionControllerCapability: async () => ({
        ok: true,
        capability: 'b'.repeat(64),
      }),
      requestBroker: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') {
          return { ok: true, sessions: [{ id: 'sess_broker_clean', cwd: wtPath, session_state: 'live' }] };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        throw new Error(`unexpected broker request: ${message.type}`);
      },
    });

    assert.equal(result, 0);
    assert.deepEqual(requests, [
      { type: 'sessions' },
      {
        type: 'remove_session',
        id: 'sess_broker_clean',
        session_controller_capability: 'b'.repeat(64),
      },
    ]);
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('broker-clean'), `worktree should be gone; got:\n${wts}`);
  });

  test('--keep-branch retains the bootstrap branch after end', () => {
    git(repo.dir, 'branch sess/keep main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'keep');
    addWorktree(repo.dir, wtPath, 'sess/keep');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'keep', branch: 'sess/keep',
      worktree_path: wtPath, safety_verdict: 'SAFE_TO_END',
    })]);
    const r = runMc(['end', 'keep', '--keep-branch', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const branches = git(repo.dir, 'branch --list');
    assert.match(branches, /sess\/keep/,
      `branch should be kept; got:\n${branches}`);
  });

  // §9b: squash-phantom detection ---------------------------------------------

  test('reports a squash-merge phantom while explicit automation tears it down', () => {
    makeSquashPhantom(repo.dir, 'sess/phantom', 'phantom.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'phantom');
    addWorktree(repo.dir, wtPath, 'sess/phantom');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'phantom', branch: 'sess/phantom',
      worktree_path: wtPath, ahead: 1,
      safety_verdict: 'IS_SQUASH_PHANTOM',
    })]);
    const r = runMc(['end', 'phantom', '--json', '--force'], {
      cwd: repo.dir,
      env: {
        MC_HOME: repo.mcHome,
        MC_TEST_GH_PHANTOM: '1', // stub gh pr list as "merged"
      },
    });
    assert.equal(r.status, 0,
      `phantom should end cleanly; stderr:${r.stderr} stdout:${r.stdout}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.ok, true);
    // Verdict surfaces in the JSON so the user knows why it was OK.
    assert.equal(j.verdict, 'IS_SQUASH_PHANTOM');
  });

  // §9c: bulk + dry-run -------------------------------------------------------

  test('--dry-run reports per-target verdict and changes nothing', () => {
    git(repo.dir, 'branch sess/a main');
    git(repo.dir, 'branch sess/b main');
    const wtA = join(repo.mcHome, 'worktrees', 'repo', 'a');
    const wtB = join(repo.mcHome, 'worktrees', 'repo', 'b');
    addWorktree(repo.dir, wtA, 'sess/a');
    addWorktree(repo.dir, wtB, 'sess/b');
    writeFileSync(join(wtB, 'dirty.txt'), 'uncommitted\n');
    writeRegistry(repo.mcHome, [
      makeEndEntry({ name: 'a', branch: 'sess/a', worktree_path: wtA, safety_verdict: 'SAFE_TO_END' }),
      makeEndEntry({ name: 'b', branch: 'sess/b', worktree_path: wtB,
        safety_verdict: 'NEEDS_REVIEW', dirty_files: 1 }),
    ]);
    const r = runMc(['end', 'a', 'b', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.dry_run, true);
    assert.ok(Array.isArray(j.targets), 'dry-run output must include targets[]');
    const byName = Object.fromEntries(j.targets.map(t => [t.name, t]));
    assert.equal(byName.a.verdict, 'SAFE_TO_END');
    assert.equal(byName.b.verdict, 'NEEDS_REVIEW');
    // Side-effect check: worktrees still present.
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(wts.includes('/a') || wts.includes('worktrees/repo/a'));
    assert.ok(wts.includes('/b') || wts.includes('worktrees/repo/b'));
  });

  test('--dry-run refuses a safe classification when the default branch is unknown', () => {
    git(repo.dir, 'branch sess/unknown main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'unknown');
    addWorktree(repo.dir, wt, 'sess/unknown');
    git(repo.dir, 'branch competing main');
    git(repo.dir, 'push -q origin competing');
    git(repo.dir, 'fetch -q origin');
    git(repo.dir, 'remote set-head origin -d');
    writeRegistry(repo.mcHome, [makeEndEntry({
      name: 'unknown',
      branch: 'sess/unknown',
      worktree_path: wt,
      safety_verdict: 'SAFE_TO_END',
    })]);

    const r = runMc(['end', 'unknown', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.targets[0].verdict, 'NEEDS_REVIEW');
    assert.equal(j.targets[0].commits_ahead, null);
    assert.equal(j.targets[0].default_branch, null);
    assert.match(j.targets[0].reason, /refusing merged classification/);
    assert.match(git(repo.dir, 'worktree list --porcelain'), /unknown/);
  });

  test('bulk `mc end a b c` operates sequentially', () => {
    for (const n of ['x', 'y', 'z']) {
      git(repo.dir, `branch sess/${n} main`);
      const wt = join(repo.mcHome, 'worktrees', 'repo', n);
      addWorktree(repo.dir, wt, `sess/${n}`);
    }
    writeRegistry(repo.mcHome, ['x', 'y', 'z'].map(n => makeEndEntry({
      name: n, branch: `sess/${n}`,
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', n),
      safety_verdict: 'SAFE_TO_END',
    })));
    const r = runMc(['end', 'x', 'y', 'z', '--json', '--force'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.ok(Array.isArray(j.results));
    assert.equal(j.results.length, 3);
    for (const res of j.results) {
      assert.equal(res.ok, true, `${res.name} should end OK; got ${JSON.stringify(res)}`);
    }
    // All three worktrees gone from git.
    const wts = git(repo.dir, 'worktree list --porcelain');
    for (const n of ['x', 'y', 'z']) {
      assert.ok(!wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should be removed; got:\n${wts}`);
    }
  });
});

function makeEndEntry(patch = {}) {
  return makeEntry({
    session_state: 'no-session-yet',
    ...patch,
  });
}

async function runEndInProcess(repo, argv, answer, extraDeps = {}) {
  const oldMcHome = process.env.MC_HOME;
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: { isTTY: true, write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  };
  process.env.MC_HOME = repo.mcHome;
  try {
    const result = await runEnd(argv, {
      cwd: repo.dir,
      stdout: streams.stdout,
      stderr: streams.stderr,
      deps: {
        isTTY: true,
        readLine: async () => answer,
        inspectOwnedToolArtifacts: async () => ({
          state: 'none',
          safe_to_delete: true,
          source: null,
          session_id: null,
          transcript_path: null,
          transcript_root: null,
          artifacts: [],
          totals: { paths: 0, files: 0, bytes: 0 },
          issues: [],
        }),
        deleteOwnedToolArtifacts: async () => ({
          ok: true,
          removed: [],
          leftovers: [],
          verification: { state: 'none', safe_to_delete: true, artifacts: [] },
        }),
        inspectBrokerSessionAbsence: async () => ({ ok: true, state: 'absent', issues: [] }),
        shredForSession: async () => ({ ok: true, shredded: [] }),
        runSessionUploadSync: async () => ({ ok: true }),
        ...extraDeps,
      },
    });
    return { result, stdout, stderr };
  } finally {
    if (oldMcHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = oldMcHome;
  }
}
