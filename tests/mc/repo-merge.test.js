/**
 * The round that lands the change — and everything that has to stop it.
 *
 * A verb that merges is the one place in mc where being wrong costs somebody
 * else's main branch, so most of what is asserted here is refusal: a red gate
 * cannot be overruled, a base that moved while the suites ran is measured again
 * rather than merged on, a lease taken away mid-round invalidates the result,
 * and no path exists that reaches the merge without a green verdict from a
 * module that has no ability to merge.
 *
 * The drift case is not hypothetical. During this feature's own development a
 * round measured against one main while a person merged another change into it
 * — the lease serialises gate rounds against each other and does nothing about
 * a human with a keyboard.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { claimLease, readLease, releaseLease } from '../../src/mc/repo-lease.js';
import { parseArgs } from '../../src/mc/commands/repo.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';

const AREA = { name: 'klient-guard', kind: 'work-area' };
const OTHER = { name: 'pm', kind: 'work-area' };
const BASE = 'aaaa111';
const HEAD = 'bbbb222';
const LANDED = 'cccc333';

/** A green gate verdict, in the shape `runGate` returns one. */
function green({ baseCommit = BASE } = {}) {
  return {
    ok: true,
    stopped_at: null,
    reason: null,
    merged: false,
    pr: { number: 400, head: 'feature', base: 'main', head_sha: HEAD, title: 'a change' },
    baseline: { commit: baseCommit, red: ['old world › one', 'old world'], totals: { tests: 100, fail: 2 } },
    candidate: { commit: 'dddd444', red: ['old world › one', 'old world'], totals: { tests: 104, fail: 2 } },
    broke: [],
    fixed: [],
  };
}

function red() {
  return {
    ...green(),
    ok: false,
    stopped_at: 'red',
    reason: '1 test red on the candidate and green on the baseline',
    broke: ['new thing › broke'],
  };
}

/**
 * A repository, a lease store, and a git/gh the test decides the answers for.
 * `baseAfterGate` is what `origin/main` reads as when the round re-checks it —
 * the drift the lease cannot prevent.
 */
function fixture({ verdict = green(), baseAfterGate = BASE, mergeFails = false, pullFails = false, defaultBranch = 'origin/main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-repo-merge-'));
  const repoPath = join(root, 'repo');
  const mcHome = join(root, 'home');
  const logPath = join(root, 'merge-log.md');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  writeFileSync(logPath, '| Datum | PR | Kontroller | Klass | Beslut | Anteckning |\n|---|---|---|---|---|---|\n');

  const calls = [];
  let merged = false;
  const git = (args, opts = {}) => {
    calls.push({ tool: 'git', args, cwd: opts.cwd });
    if (args[0] === 'symbolic-ref') {
      return defaultBranch ? { status: 0, stdout: `${defaultBranch}\n` } : { status: 1, stdout: '', stderr: 'not a symbolic ref' };
    }
    if (args[0] === 'rev-parse' && args[1] === `origin/${verdict.pr.base}`) {
      return { status: 0, stdout: `${merged ? LANDED : baseAfterGate}\n` };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${LANDED}\n` };
    if (args[0] === 'pull') {
      return pullFails ? { status: 1, stderr: 'diverged' } : { status: 0, stdout: 'Updating\n' };
    }
    return { status: 0, stdout: '' };
  };
  const gh = (args, opts = {}) => {
    calls.push({ tool: 'gh', args, cwd: opts.cwd });
    if (args[0] === 'pr' && args[1] === 'view') {
      // What the forge says after a failed merge call: the truth, or nothing.
      if (mergeFails === 'timed-out-merged') { merged = true; return { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-22T21:30:00Z' }) }; }
      if (mergeFails === 'timed-out-unknown') return { status: 1, stderr: 'Post "https://api.github.com/graphql": read: operation timed out' };
      return { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) };
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeFails === 'timed-out-merged' || mergeFails === 'timed-out-unknown') return { status: 1, stderr: 'Post "https://api.github.com/graphql": read tcp: operation timed out' };
      if (mergeFails) return { status: 1, stderr: 'Pull request is not mergeable' };
      merged = true;
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };

  return {
    root,
    repoPath,
    mcHome,
    logPath,
    calls,
    ran: (tool) => calls.filter((call) => call.tool === tool),
    log: () => readFileSync(logPath, 'utf8'),
    lease: () => readLease(repoPath, { root: mcHome }),
    run: (extra = {}) => runMergeRound({
      repoPath,
      pr: 400,
      holder: AREA,
      root: mcHome,
      env: { PATH: '/nonexistent' },
      git,
      gh,
      gate: async () => verdict,
      mergeLog: logPath,
      clock: () => Date.parse('2026-08-17T09:00:00.000Z'),
      ...extra,
    }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('a green gate lands the change', () => {
  it('merges as a squash, records the commit, and reports it', async () => {
    const fx = fixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.merge_commit, LANDED);

      const merge = fx.ran('gh').find((call) => call.args[1] === 'merge');
      assert.deepEqual(merge.args, ['pr', 'merge', '400', '--squash']);
    } finally { fx.cleanup(); }
  });

  it('writes one line to the merge log, with both red counts', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const rows = fx.log().trim().split('\n');
      assert.equal(rows.length, 3, 'expected exactly one row appended');
      const line = rows[2];
      assert.match(line, /#400/u);
      // "red before" was the same understatement as the verdict's "green":
      // those two were standing red on main and this change did not touch them.
      assert.match(line, /2 standing red before · 2 after · 0 new/u);
      assert.match(line, /Squash-merge into `main` → `ccc/u);
      assert.match(line, /klient-guard/u);
    } finally { fx.cleanup(); }
  });

  it('a repository with no log to write to still merges and says so', async () => {
    const fx = fixture();
    try {
      const report = await fx.run({ mergeLog: null });
      assert.equal(report.merged, true);
      assert.equal(report.log_path, null);
    } finally { fx.cleanup(); }
  });
});

describe('a red gate cannot be overruled', () => {
  it('does not merge, and says nothing was merged', async () => {
    const fx = fixture({ verdict: red() });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
      assert.equal(fx.log().trim().split('\n').length, 2, 'a stopped round wrote a log line');
    } finally { fx.cleanup(); }
  });

  it('a gate that stopped before measuring does not merge either', async () => {
    for (const stopped of ['lease', 'pr', 'worktree', 'merge', 'suite', 'fetch']) {
      const fx = fixture({ verdict: { ok: false, stopped_at: stopped, reason: 'no', pr: { number: 400 } } });
      try {
        const report = await fx.run();
        assert.equal(report.merged, false, stopped);
        assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), [], stopped);
      } finally { fx.cleanup(); }
    }
  });

  it('has no override in its source — not a flag, not an option', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'src', 'mc', 'repo-merge.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    for (const escape of [/force/iu, /anyway/iu, /skipGate/u, /ignoreRed/iu, /--admin/u]) {
      assert.doesNotMatch(code, escape, `an override matching ${escape} exists`);
    }
    // And the only route to the merge is through a verdict marked ok.
    assert.match(code, /if \(!verdict\.ok\)/u);
  });
});

describe('the ground is checked before the verdict is acted on', () => {
  it('stops when the base moved while the suites ran', async () => {
    // The case seen for real: the lease serialises gate rounds, and does
    // nothing about a person merging by hand while one is running.
    const fx = fixture({ baseAfterGate: 'eeee555' });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /moved from aaaa111 to eeee555/u);
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
    } finally { fx.cleanup(); }
  });

  it('re-reads the base rather than trusting the gate’s own fetch', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const order = fx.calls.map((call) => call.args.join(' '));
      const fetched = order.findIndex((line) => line.startsWith('fetch origin'));
      const mergedAt = order.findIndex((line) => line.startsWith('pr merge'));
      assert.ok(fetched !== -1 && fetched < mergedAt, 'it merged without re-checking the base');
    } finally { fx.cleanup(); }
  });

  it('stops when the lease was taken away during the round', async () => {
    // `--force` hands the repository to somebody else mid-round. A merge landed
    // after that is one nobody was holding the round for.
    const fx = fixture();
    try {
      const report = await fx.run({
        gate: async () => {
          releaseLease({ repoPath: fx.repoPath, holder: AREA, root: fx.mcHome });
          claimLease({ repoPath: fx.repoPath, errand: 'took over', holder: OTHER, root: fx.mcHome });
          return green();
        },
      });
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'lease');
      assert.match(report.reason, /taken from klient-guard/u);
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('refuses to start when somebody else already holds it', async () => {
    const fx = fixture();
    try {
      claimLease({ repoPath: fx.repoPath, errand: 'their round', holder: OTHER, root: fx.mcHome });
      const report = await fx.run();
      assert.equal(report.stopped_at, 'lease');
      assert.equal(report.merged, false);
      assert.equal(fx.lease().holder, 'pm', 'it released somebody else’s lease');
    } finally { fx.cleanup(); }
  });
});

describe('one lease across the whole round', () => {
  it('holds it through the gate rather than around each half', async () => {
    const fx = fixture();
    let heldDuringGate = null;
    try {
      await fx.run({
        gate: async (options) => {
          heldDuringGate = fx.lease();
          // And the gate is told not to manage a lease it does not own.
          assert.equal(options.holdLease, false, 'the gate would have taken its own lease');
          return green();
        },
      });
      assert.equal(heldDuringGate.held, true);
      assert.equal(heldDuringGate.holder, 'klient-guard');
    } finally { fx.cleanup(); }
  });

  it('gives it back after a merge, after a stop, and after a throw', async () => {
    for (const [name, options] of [
      ['merged', {}],
      ['stopped', { gate: async () => red() }],
      ['threw', { gate: async () => { throw new Error('the machine went away'); } }],
    ]) {
      const fx = fixture();
      try {
        if (name === 'threw') await assert.rejects(() => fx.run(options), /the machine went away/u);
        else await fx.run(options);
        assert.equal(fx.lease().held, false, `the lease outlived the ${name} round`);
      } finally { fx.cleanup(); }
    }
  });
});

describe('deploying is part of the round, and never undoes it', () => {
  it('pulls nothing when no installation runs from this checkout', async () => {
    const fx = fixture();
    try {
      const report = await fx.run();
      assert.equal(report.deploy.attempted, false);
      assert.deepEqual(fx.ran('git').filter((call) => call.args[0] === 'pull'), []);
    } finally { fx.cleanup(); }
  });

  it('pulls the installation that does run from it', async () => {
    const fx = fixture();
    try {
      const report = await fx.run({
        installs: () => [{ root: fx.repoPath, command: 'mc', bin: '/usr/local/bin/mc', source: 'x' }],
      });
      assert.equal(report.deploy.attempted, true);
      assert.equal(report.deploy.ok, true);
      const pull = fx.ran('git').find((call) => call.args[0] === 'pull');
      assert.deepEqual(pull.args, ['pull', '--ff-only']);
      assert.equal(pull.cwd, fx.repoPath);
      assert.match(fx.log(), /Live via deploy pull/u);
    } finally { fx.cleanup(); }
  });

  it('a failed pull leaves the merge standing and says to pull by hand', async () => {
    // The merge has landed and cannot be taken back. A round that reported
    // failure here would describe a repository state that is not the one on
    // disk, which is worse than a machine one commit behind.
    const fx = fixture({ pullFails: true });
    try {
      const report = await fx.run({
        installs: () => [{ root: fx.repoPath, command: 'mc', bin: '/usr/local/bin/mc', source: 'x' }],
      });
      assert.equal(report.merged, true, 'a failed pull must not unmake the merge');
      assert.equal(report.ok, true, 'a failed pull must not fail the round');
      assert.equal(report.deploy.ok, false);
      assert.match(report.deploy.reason, /diverged/u);
      assert.match(fx.log(), /Deploy pull failed .* pull by hand/u);
    } finally { fx.cleanup(); }
  });
});

describe('a merge that gh refuses', () => {
  it('is reported, and nothing downstream of it runs', async () => {
    const fx = fixture({ mergeFails: true });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /not mergeable/u);
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('git').filter((call) => call.args[0] === 'pull'), [], 'it deployed a merge that never happened');
      assert.equal(fx.log().trim().split('\n').length, 2, 'it logged a merge that never happened');
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });
});

/**
 * What the verb says about itself has to be true.
 *
 * In this codebase the comments are the design record, so a stale one claiming
 * a safety property misleads the next reviewer more than no comment would — and
 * the file that dispatches the merge is the worst place to have one. This was a
 * review finding after the merge landed: the dispatcher still said "there is no
 * merge in the code behind it", the check-only run printed "this verb does not
 * merge", and the usage in the error messages read as though `--check` were
 * required.
 *
 * The claims that must stay true are asserted against the source rather than
 * remembered, because remembering is what failed.
 */
describe('the verb describes itself accurately', () => {
  const read = (...parts) => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, '..', '..', 'src', 'mc', ...parts), 'utf8');
  };

  it('the dispatcher no longer claims it cannot merge', () => {
    const source = read('commands', 'repo.js');
    for (const stale of [
      /there is no merge in the code behind it/u,
      /Merging is its own step and is not built yet/u,
      /only runs the gate for now/u,
      /this verb does not merge/u,
    ]) {
      assert.doesNotMatch(source, stale, `a stale claim matching ${stale} survives`);
    }
  });

  it('its usage presents --check as one mode, not a requirement', () => {
    const source = read('commands', 'repo.js');
    // Only the strings the user is actually shown — prose about the verb is
    // free to describe it in sentences, and does.
    const printed = [...source.matchAll(/'([^'\n]*mc repo merge <repo> <pr>[^'\n]*)'/gu)].map((m) => m[1]);
    assert.ok(printed.length >= 3, `expected the usage strings, found ${printed.length}`);
    for (const usage of printed) {
      assert.match(usage, /\[--check\]/u, `printed usage "${usage}" presents --check as required`);
    }
  });

  it('the gate still says it cannot merge, because it still cannot', () => {
    // The one claim of this kind that is load-bearing and must not be softened
    // just because the sibling module now can.
    const gate = read('repo-gate.js');
    assert.match(gate, /There is no merge in here/u);
    const code = gate.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    assert.doesNotMatch(code, /pr['"\s,\]]+merge/u);
    assert.doesNotMatch(code, /['"]push['"]/u);
  });
});

/**
 * Into what. A round on #363 said "merged as 7dcbf96" — true, and into the
 * stacked base `pm-heartbeat`, which everyone read as main. The line names the
 * base every time, and says in its own words when it is not the default.
 */
describe('the merge line names the base', () => {
  it('on the default branch: into main, no warning', async () => {
    const fx = fixture();
    try {
      const progress = [];
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.merged_into, 'main');
      assert.equal(report.default_branch, 'main');
      assert.equal(report.off_default, false);
      assert.ok(progress.some((line) => line === `merged #400 into main as ${LANDED.slice(0, 7)}`), progress.join('\n'));
      assert.ok(!progress.some((line) => /WARNING/u.test(line)));
      assert.match(report.log_line, /Squash-merge into `main` → `ccc/u);
      assert.doesNotMatch(report.log_line, /NOT/u);
    } finally { fx.cleanup(); }
  });

  it('on a stacked base: into that branch, and a warning that it is not main', async () => {
    const verdict = green();
    verdict.pr.base = 'pm-heartbeat';
    const fx = fixture({ verdict });
    try {
      const progress = [];
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.merged, true);
      assert.equal(report.merged_into, 'pm-heartbeat');
      assert.equal(report.off_default, true);
      assert.ok(progress.some((line) => line.startsWith('merged #400 into pm-heartbeat as')), progress.join('\n'));
      assert.ok(progress.some((line) => /WARNING: pm-heartbeat is not the default branch \(main\) — this landed on a branch, not on main/u.test(line)), progress.join('\n'));
      assert.match(report.log_line, /Squash-merge into `pm-heartbeat` → `ccc[0-9a-f]*` \(NOT main\)/u);
    } finally { fx.cleanup(); }
  });

  it('a default git cannot name is unknown, never assumed to be main', async () => {
    const verdict = green();
    verdict.pr.base = 'pm-heartbeat';
    const fx = fixture({ verdict, defaultBranch: null });
    try {
      const report = await fx.run();
      assert.equal(report.default_branch, null);
      assert.equal(report.off_default, false, 'no warning on a guess');
      assert.equal(report.merged_into, 'pm-heartbeat', 'but the base is still named');
    } finally { fx.cleanup(); }
  });
});

/**
 * A failed merge call is not a failed merge (#10844, 2026-08-22): GitHub took
 * the call, performed it, and timed out on the reply. The round said "nothing
 * was merged" and the change was on main. Now the forge is asked before
 * anything is claimed, and when it cannot be asked the round says it does
 * not know — which is always true and always actionable.
 */
describe('a merge call that failed is asked about, not assumed', () => {
  it('timed out but merged: carried on as merged, the error kept beside it', async () => {
    const fx = fixture({ mergeFails: 'timed-out-merged' });
    try {
      const progress = [];
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.merge_commit, LANDED);
      assert.match(report.merge_error, /operation timed out/u);
      assert.ok(progress.some((line) => /gh pr merge failed .* but GitHub says #400 is merged, so it is/u.test(line)), progress.join('\n'));
      assert.ok(report.log_line, 'logged like any other merge');
    } finally { fx.cleanup(); }
  });

  it('timed out and cannot be read back: unknown, claimed neither way, nothing pulled or logged', async () => {
    const fx = fixture({ mergeFails: 'timed-out-unknown' });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'merge-unknown');
      assert.equal(report.merged, false);
      assert.match(report.reason, /whether it merged could not be read back .* check with gh pr view 400/u);
      assert.equal(report.log_line, null);
      assert.equal(report.deploy, null);
      assert.ok(!fx.ran('git').some((call) => call.args[0] === 'pull'), 'no deploy pull on an unknown');
    } finally { fx.cleanup(); }
  });

  it('a plain refusal with the pull request still open is the failed merge it always was', async () => {
    const fx = fixture({ mergeFails: true });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /not mergeable/u);
      assert.equal(report.merge_error, null);
    } finally { fx.cleanup(); }
  });
});

/**
 * Several pull requests in one round (A3, 2026-08-23): one gate, then each
 * landed in order on the main the one before it made; a batch that stopped
 * falls back to one round per pull request inside the same lease, and says
 * so. Nothing may read as "all landed" when one did not.
 */
describe('the words: several numbers are a batch, in the order given', () => {
  it('parses one number as before, several as a batch, and refuses a double', () => {
    const one = parseArgs(['merge', 'memoro', '400']);
    assert.equal(one.pr, 400);
    assert.equal(one.prs, null);
    const many = parseArgs(['merge', 'memoro', '#401', '402', '403']);
    assert.equal(many.pr, 401);
    assert.deepEqual(many.prs, [401, 402, 403]);
    assert.match(String(parseArgs(['merge', 'memoro', '401', '401']).error), /named twice/u);
    assert.match(String(parseArgs(['merge', 'memoro', '401', 'x']).error), /"x" is not a pull request number/u);
  });
});

describe('a batch lands in order, or falls back one by one', () => {
  const PRS = [401, 402, 403];
  function greenBatch() {
    return {
      ...green(),
      pr: { number: 401, head: 'one', base: 'main', head_sha: 'sha401', title: 'first' },
      prs: PRS.map((number) => ({ number, head: `h${number}`, base: 'main', head_sha: `sha${number}`, title: `pr ${number}`, pr_tests: { files: [], totals: null, red: [], exit_code: null } })),
    };
  }
  /** A git whose origin/main advances by one sha per merge — or by a stranger once. */
  function batchFixture({ verdict = greenBatch(), strangerAfter = null, gateFor = null } = {}) {
    const fx = fixture({ verdict });
    const landed = [];
    const state = { mainAt: BASE };
    const git = (args, opts = {}) => {
      fx.calls.push({ tool: 'git', args, cwd: opts.cwd });
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { status: 0, stdout: `${state.mainAt}\n` };
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n' };
      return { status: 0, stdout: '' };
    };
    const gh = (args, opts = {}) => {
      fx.calls.push({ tool: 'gh', args, cwd: opts.cwd });
      if (args[0] === 'pr' && args[1] === 'merge') {
        const number = Number(args[2]);
        landed.push(number);
        state.mainAt = `landed${number}`;
        if (strangerAfter === number) state.mainAt = 'stranger';
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const number = Number(args[2]);
        return landed.includes(number)
          ? { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: `landed${number}` } }) }
          : { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) };
      }
      return { status: 0, stdout: '' };
    };
    return {
      ...fx,
      landed,
      run: (extra = {}) => fx.run({ pr: 401, prs: PRS, git, gh, gate: gateFor ? (args) => gateFor(args, state) : (async () => verdict), ...extra }),
    };
  }

  it('one gate, three merges in order, each on the main the one before made', async () => {
    const fx = batchFixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason);
      assert.deepEqual(fx.landed, [401, 402, 403]);
      assert.deepEqual(report.batch.merges.map((item) => [item.number, item.merged, item.merge_commit]), [
        [401, true, 'landed401'], [402, true, 'landed402'], [403, true, 'landed403'],
      ]);
      assert.equal(report.merged, true);
      assert.equal(report.merge_commit, 'landed403');
      assert.equal(report.batch.fallback, false);
      // One line per pull request in the log, each saying it was a batch.
      const lines = fx.log().split('\n').filter((line) => line.includes('#40'));
      assert.equal(lines.length, 3);
      assert.match(lines[1], /#402 pr 402 .*Batch of 3 \(#401 #402 #403\)/u);
      assert.equal(fx.lease().held, false, 'the lease went back');
    } finally { fx.cleanup(); }
  });

  it('between landings, the next branch gets the just-made main merged in — and a refusal stops the batch honestly', async () => {
    // Measured on the first live batch: five verified green on one
    // candidate, one landed, the second refused by the forge — every
    // squash makes the next branch unmergeable until it carries the new
    // main. The freshen runs between landings; the batch already proved
    // the combination, so there is no affected here.
    const freshened = [];
    const fx = batchFixture();
    try {
      const report = await fx.run({ refresh: ({ branch, base }) => { freshened.push([branch, base]); return { ok: true, at: 'abc1234' }; } });
      assert.equal(report.ok, true, report.reason);
      assert.deepEqual(freshened, [['h402', 'main'], ['h403', 'main']], 'each later branch, before its own landing');
      assert.deepEqual(fx.landed, [401, 402, 403]);
    } finally { fx.cleanup(); }

    const fx2 = batchFixture();
    try {
      const report = await fx2.run({ refresh: ({ branch }) => (branch === 'h403' ? { ok: false, reason: 'h403 conflicts with main in artifacts/x.json — left exactly as it was' } : { ok: true, at: 'abc1234' }) });
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /#403 could not be freshened for landing \(h403 conflicts with main in artifacts\/x\.json — left exactly as it was\) — 2 of 3 landed before it/u);
      assert.deepEqual(fx2.landed, [401, 402], 'what landed stays landed and said');
      assert.deepEqual(report.batch.merges.map((item) => [item.number, item.merged]), [[401, true], [402, true], [403, false]]);
    } finally { fx2.cleanup(); }
  });

  it('main moved between two merges by somebody else: the rest is not merged, and it says how many did', async () => {
    const fx = batchFixture({ strangerAfter: 401 });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /moved to strange\w* between merges, and not by this round — #402 and 1 more not merged; 1 of 3 landed/u);
      assert.deepEqual(fx.landed, [401]);
      assert.deepEqual(report.batch.merges.map((item) => item.number), [401]);
    } finally { fx.cleanup(); }
  });

  it('a red batch falls back to one round per pull request, inside the same lease, and says so', async () => {
    const batchVerdict = { ...greenBatch(), ok: false, stopped_at: 'red', reason: '1 test red on the candidate and green on the baseline', broke: ['x › y'] };
    // The batch gate is red; each single gate is green except #402's.
    // A real single gate fetches the base afresh, so its baseline is the
    // main the batch's earlier merges made.
    const gateFor = async ({ prs, pr }, state) => {
      if (prs) return batchVerdict;
      const fresh = green({ baseCommit: state.mainAt });
      if (pr === 402) return { ...fresh, pr: { ...fresh.pr, number: 402 }, ok: false, stopped_at: 'red', reason: '1 test red', broke: ['x › y'] };
      return { ...fresh, pr: { ...fresh.pr, number: pr } };
    };
    const fx = batchFixture({ verdict: batchVerdict, gateFor });
    const progress = [];
    try {
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.batch.fallback, true);
      assert.ok(progress.some((line) => /^batch #401 #402 #403 stopped at red .* — falling back to one round per pull request$/u.test(line)), progress.join('\n'));
      assert.deepEqual(fx.landed, [401, 403], 'the green ones landed, the red one did not');
      assert.deepEqual(report.batch.merges.map((item) => [item.number, item.merged]), [[401, true], [402, false], [403, true]]);
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'batch');
      assert.match(report.reason, /1 of 3 did not land in its own round: #402 \(1 test red\)/u);
      assert.equal(report.batch.rounds.length, 3);
      // One lease for the whole thing: the single rounds took none of their own.
      assert.equal(fx.lease().held, false);
      assert.equal(progress.filter((line) => line === 'lease released').length, 1);
    } finally { fx.cleanup(); }
  });
});
