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
import { parseMergeArgs } from '../../src/mc/commands/repo.js';

const parseArgs = (argv) => parseMergeArgs(argv.slice(1));
import { readMainRed, recordMainRed } from '../../src/mc/selector-miss.js';
import { measureDocs } from '../../src/mc/docs-measure.js';
import { runDocsMerge } from '../../src/mc/docs-merge.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { landJob, serve } from '../../src/mc/merger.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';

const AREA = { name: 'klient-guard', kind: 'work-area' };
const OTHER = { name: 'pm', kind: 'work-area' };
const BASE = 'aaaa111';
const HEAD = 'bbbb222';
const LANDED = 'cccc333';
// What gh prints when the forge cannot be reached at all (not a refusal from GitHub).
const CONNECT = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';

/** A green gate verdict, in the shape `runGate` returns one. */
function green({ baseCommit = BASE } = {}) {
  return {
    ok: true,
    stopped_at: null,
    reason: null,
    merged: false,
    full: false,
    pr: { number: 400, head: 'feature', base: 'main', head_sha: HEAD, title: 'a change' },
    // The ground the candidate was built on — not a measurement of it. It is
    // what the drift check compares against once the round has run.
    base: { ref: 'main', commit: baseCommit },
    selection: null,
    candidate: { commit: 'dddd444', red: [], totals: { tests: 104, fail: 0 } },
    extra_gates: [],
  };
}

function red() {
  return {
    ...green(),
    ok: false,
    stopped_at: 'red',
    reason: '1 test red: new thing › broke',
    candidate: { commit: 'dddd444', red: ['new thing › broke'], totals: { tests: 104, fail: 1 } },
  };
}

/**
 * A repository, a lease store, and a git/gh the test decides the answers for.
 * `baseAfterGate` is what `origin/main` reads as when the round re-checks it —
 * the drift the lease cannot prevent.
 *
 * `ancestor`, `movedFiles` and `candidateFiles` are what the round asks git
 * once the base has moved: was it a fast-forward, what did it move over, and
 * what does this change touch. The defaults are what an unteachable git said
 * before those questions existed — a fast-forward over nothing, with no
 * candidate files readable — which is a refusal, so every test written before
 * this still means what it meant.
 */
function fixture({ verdict = green(), baseAfterGate = BASE, mergeFails = false, pullFails = false, defaultBranch = 'origin/main', ancestor = true, movedFiles = [], candidateFiles = [], net = { fetch: false, forge: false, merge: false } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-repo-merge-'));
  const repoPath = join(root, 'repo');
  const mcHome = join(root, 'home');
  const logPath = join(root, 'merge-log.md');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  writeFileSync(logPath, '| Datum | PR | Kontroller | Klass | Beslut | Anteckning |\n|---|---|---|---|---|---|\n');

  const calls = [];
  let merged = false;
  // The head GitHub reports for the pull request — the measured one until a
  // test says a push has moved it.
  const forge = { head: verdict.pr.head_sha };
  const git = (args, opts = {}) => {
    calls.push({ tool: 'git', args, cwd: opts.cwd });
    // `net` is the network failing under the round: switched by a test while it runs.
    if (args[0] === 'fetch' && net.fetch) return { status: 128, stderr: "fatal: unable to access 'https://github.com/example/memoro-cli.git/': Could not resolve host: github.com" };
    if (args[0] === 'symbolic-ref') {
      return defaultBranch ? { status: 0, stdout: `${defaultBranch}\n` } : { status: 1, stdout: '', stderr: 'not a symbolic ref' };
    }
    if (args[0] === 'rev-parse' && args[1] === `origin/${verdict.pr.base}`) {
      return { status: 0, stdout: `${merged ? LANDED : baseAfterGate}\n` };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${LANDED}\n` };
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return ancestor ? { status: 0, stdout: '' } : { status: 1, stdout: '' };
    }
    if (args[0] === 'diff' && args[1] === '--name-only') {
      // `a..b` is what the base moved over; `a...b` is what the candidate
      // changes against it. One dot apart, opposite questions.
      const three = String(args[2] || '').includes('...');
      return { status: 0, stdout: `${(three ? candidateFiles : movedFiles).join('\n')}\n` };
    }
    if (args[0] === 'pull') {
      return pullFails ? { status: 1, stderr: 'diverged' } : { status: 0, stdout: 'Updating\n' };
    }
    return { status: 0, stdout: '' };
  };
  const gh = (args, opts = {}) => {
    calls.push({ tool: 'gh', args, cwd: opts.cwd });
    if (net.forge && args[0] === 'pr' && args[1] === 'view') return { status: 1, stderr: CONNECT };
    if (net.merge && args[0] === 'pr' && args[1] === 'merge') return { status: 1, stderr: CONNECT };
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: forge.head }) };
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
    forge,
    net,
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
      sleep: async () => {},
      ...extra,
    }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('identical landings write main coverage', () => {
  const selected = ['tests/selected.test.js', 'tests/standing.test.js'];
  const standing = { file: selected[1], name: 'standing red', diagnostic: 'digest' };
  // What the round ran is its coverage (`candidate.covered`); the selection as such is not.
  const verdict = () => ({ ...green(), selection: { selected }, candidate: { ...green().candidate, tree: LANDED, covered: selected },
    main_red: { tests: [standing] } });

  it('a green identical landing writes merge_commit coverage, carries main_red tests and inherits the base record', async () => {
    const fx = fixture({ verdict: verdict() });
    try {
      const inherited = { file: 'tests/outside.test.js', name: 'outside red', diagnostic: 'outside' };
      recordMainRed({ root: fx.mcHome, repo: fx.repoPath, commit: BASE, covered: ['tests/outside.test.js', 'tests/base-green.test.js', selected[0]],
        result: { totals: { finished: true }, red_tests: [inherited, { file: selected[0], name: 'now fixed', diagnostic: 'old' }] } });
      const report = await fx.run();
      assert.equal(report.tree_identical, true);
      const proof = readMainRed({ root: fx.mcHome, repo: fx.repoPath, baseCommit: report.merge_commit,
        files: [...selected, inherited.file, 'tests/base-green.test.js', 'tests/unknown.test.js'] });
      assert.equal(proof.cached, true, 'the landing writes evidence for merge_commit');
      assert.deepEqual(proof.red_on_main, [selected[1], inherited.file]);
      assert.deepEqual(proof.green_on_main, [selected[0], 'tests/base-green.test.js']);
      assert.deepEqual(proof.not_covered, ['tests/unknown.test.js']);
      assert.deepEqual(proof.tests, [inherited, standing]);
      assert.equal(proof.inherited_from, BASE);
      assert.equal(proof.from, 'landing');
      assert.equal(proof.at, '2026-08-17T09:00:00.000Z');
    } finally { fx.cleanup(); }
  });

  it('a non-identical landed tree writes no main evidence', async () => {
    const gate = verdict();
    gate.candidate.tree = 'different-tree';
    const fx = fixture({ verdict: gate });
    try {
      const report = await fx.run();
      assert.equal(report.tree_identical, false);
      assert.equal(existsSync(join(fx.mcHome, 'main-red/repo', `${report.merge_commit}.json`)), false);
      assert.equal(readMainRed({ root: fx.mcHome, repo: fx.repoPath, baseCommit: report.merge_commit, files: selected }).cached, false);
    } finally { fx.cleanup(); }
  });

  it('a reused round covers the receipt members and what it ran, never a selected file it neither ran nor reused', async () => {
    // memoro#15193's delta round, 2026-11-10: 293 selected, 11 run, the rest from
    // a receipt that did not hold subject-context.test.js — which then read green
    // on main while it was red.
    const gate = verdict();
    gate.selection = { selected: [...selected, 'tests/selected-not-run.test.js'] };
    gate.candidate.covered = [selected[0]];
    gate.reused = { mode: 'delta', covered: ['tests/receipt-member.test.js'] };
    const fx = fixture({ verdict: gate });
    try {
      const report = await fx.run();
      const proof = readMainRed({ root: fx.mcHome, repo: fx.repoPath, baseCommit: report.merge_commit,
        files: [...selected, ...gate.reused.covered, 'tests/selected-not-run.test.js', 'tests/unknown.test.js'] });
      assert.deepEqual(proof.green_on_main, [selected[0], ...gate.reused.covered]);
      assert.deepEqual(proof.red_on_main, [standing.file]);
      assert.deepEqual(proof.not_covered, ['tests/selected-not-run.test.js', 'tests/unknown.test.js']);
      assert.equal(proof.inherited_from, null);
    } finally { fx.cleanup(); }
  });

  it('a measured documents-only identical landing writes the same inherited coverage; a mismatch writes nothing', async () => {
    const fx = fixture();
    try {
      recordMainRed({ root: fx.mcHome, repo: fx.repoPath, commit: BASE, covered: ['tests/unchanged.test.js'], result: { totals: { finished: true } } });
      for (const identical of [true, false]) {
        const commit = identical ? 'docs-identical' : 'docs-mismatch';
        const gh = args => ({ ok: true, stdout: JSON.stringify(args.at(-1).includes('files')
          ? { number: 400, title: 'Documents', state: 'OPEN', baseRefName: 'main', headRefName: 'docs', headRefOid: HEAD, files: [{ path: 'docs/technical/example.md' }] }
          : args.at(-1) === 'mergeable' ? { mergeable: 'MERGEABLE' }
            : args.at(-1) === 'headRefOid' ? { headRefOid: HEAD } : { state: 'MERGED', mergeCommit: { oid: commit } }), stderr: '' });
        const report = await runDocsMerge({ repoPath: fx.repoPath, pr: 400, root: fx.mcHome, gh,
          git: async args => ({ status: 0, stdout: args[0] === 'rev-parse' ? (identical ? 'measured-tree' : 'different-tree') : '' }),
          measure: args => measureDocs({ ...args, env: { MC_HOME: fx.mcHome, MC_WORK_ROOT: fx.root }, deps: {
            git: async args => {
              if (args[0] === 'worktree' && args[1] === 'add') {
                mkdirSync(args[3], { recursive: true });
                writeFileSync(join(args[3], '.git'), 'gitdir: fake\n');
              }
              return { status: args.includes('--verify') ? 1 : 0,
                stdout: args[1] === 'origin/main' ? BASE : args[1] === 'HEAD^{tree}' ? 'measured-tree' : '' };
            },
            candidateCwds: () => [], takeLane: async () => {}, releaseLane: () => {},
            declaration: () => ({ ok: true, declaration: { select: 'select' } }),
            select: async () => ({ ok: true, files: [selected[0]] }),
            tests: async () => ({ code: 0, tap: 'TAP version 13\nok 1 - documents\n1..1\n# tests 1\n# pass 1\n# fail 0' }),
          } }) });
        assert.equal(report.tree_identical, identical);
        const proof = readMainRed({ root: fx.mcHome, repo: fx.repoPath, baseCommit: commit, files: [selected[0], 'tests/unchanged.test.js'] });
        assert.equal(proof.cached, identical);
        assert.deepEqual(proof.green_on_main, identical ? [selected[0], 'tests/unchanged.test.js'] : []);
      }
    } finally { fx.cleanup(); }
  });
});

describe('a green gate lands the change', () => {
  it('a dropped owner persisted while the real gate runs prevents the GitHub merge', async () => {
    const fx = fixture();
    const owner = { stage: 'review' };
    try {
      const report = await fx.run({
        gate: async () => { owner.stage = 'dropped'; return green(); },
        beforeMerge: async () => owner.stage !== 'dropped',
      });
      assert.equal(report.stopped_at, 'dropped');
      assert.equal(report.merged, false);
      assert.equal(fx.ran('gh').some(({ args }) => args[1] === 'merge'), false, 'the actual round stops before GitHub merge');
    } finally { fx.cleanup(); }
  });

  it('merges as a squash, records the commit, and reports it', async () => {
    const fx = fixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.merge_commit, LANDED);

      const merge = fx.ran('gh').find((call) => call.args[1] === 'merge');
      assert.deepEqual(merge.args, ['pr', 'merge', '400', '--squash', '--match-head-commit', HEAD]);
    } finally { fx.cleanup(); }
  });

  it('writes one line to the merge log, saying what ran and what it found', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const rows = fx.log().trim().split('\n');
      assert.equal(rows.length, 3, 'expected exactly one row appended');
      const line = rows[2];
      assert.match(line, /#400/u);
      // One tree, so one number. "2 standing red before · 2 after · 0 new"
      // described a comparison that no longer happens.
      assert.match(line, /full suite, against aaaa111 · 0 red/u);
      assert.match(line, /Squash-merge into `main` → `ccc/u);
      assert.match(line, /klient-guard/u);
    } finally { fx.cleanup(); }
  });

  it('a selected round says how many files it reached, not "full suite"', async () => {
    const fx = fixture({ verdict: { ...green(), selection: { files: 17, commands: 2 } } });
    try {
      await fx.run();
      assert.match(fx.log().trim().split('\n')[2], /17 test files this change reaches, against aaaa111 · 0 red/u);
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

/**
 * The squash takes the head the round measured, or freshened, and no other
 * (ruling 43): a push that lands during a round is a commit nobody measured.
 */
describe('the squash lands the head the round measured', () => {
  it('the landing pins the measured head', async () => {
    const fx = fixture();
    try {
      const report = await fx.run();
      assert.equal(report.merged, true, report.reason || '');
      const merge = fx.ran('gh').find((call) => call.args[1] === 'merge');
      assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], HEAD);
    } finally { fx.cleanup(); }
  });

  it('a freshened branch is landed at the freshened head', async () => {
    const freshSha = 'f'.repeat(40);
    const fx = fixture({ verdict: { ...green(), derived: { commit: 'eeee555', regenerated: ['docs/sql/x.json'] } } });
    try {
      const report = await fx.run({
        refresh: () => { fx.forge.head = freshSha; return { ok: true, at: 'fffffff', sha: freshSha }; },
      });
      assert.equal(report.merged, true, report.reason || '');
      const merge = fx.ran('gh').find((call) => call.args[1] === 'merge');
      assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], freshSha);
    } finally { fx.cleanup(); }
  });

  it('a head GitHub never reports is drift, and nothing is merged', async () => {
    const fx = fixture();
    fx.forge.head = 'd'.repeat(40);
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.equal(report.reason, `#400 is at ddddddd on GitHub, not the ${HEAD} this round measured — not merged`);
      assert.equal(report.merged, false);
      assert.equal(fx.ran('gh').filter((call) => call.args[1] === 'view' && call.args.includes('headRefOid')).length, 6, 'read six times, then stopped');
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
    } finally { fx.cleanup(); }
  });
});

/**
 * The network failing under a round is not the change's stop (merger-offline-requeue):
 * a failed fetch or a gh call that cannot connect is `offline`, read nothing, and
 * merges nothing; a fetch that works and shows the base moved is still `drift`.
 */
describe('a round the network stops is offline: nothing read, nothing merged', () => {
  it('a failed fetch after a green gate is offline, names the fetch, and merges nothing', async () => {
    const fx = fixture({ net: { fetch: true, forge: false, merge: false } });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /^git fetch origin --prune failed, so origin\/main could not be re-checked before merging \(fatal: unable to access/u);
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
    } finally { fx.cleanup(); }
  });

  it('the gate’s own fetch failing is offline too, and nothing is measured', async () => {
    const fx = fixture();
    try {
      const report = await fx.run({
        gate: async () => ({ ...green(), ok: false, stopped_at: 'fetch', reason: 'fatal: unable to access \'https://github.com/example/memoro-cli.git/\': Could not resolve host: github.com' }),
      });
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /git fetch origin --prune failed in the gate, so nothing was measured/u);
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
    } finally { fx.cleanup(); }
  });

  it('the gate’s read of the pull request that cannot connect is offline, and names gh pr view', async () => {
    const fx = fixture();
    try {
      const report = await fx.run({ gate: async () => ({ ...green(), ok: false, stopped_at: 'pr', reason: CONNECT }) });
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /^gh pr view could not reach GitHub \(error connecting to api\.github\.com/u);
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('a pull request GitHub refuses keeps its own stop: a refusal is not the network', async () => {
    const fx = fixture();
    try {
      const report = await fx.run({ gate: async () => ({ ...green(), ok: false, stopped_at: 'pr', reason: '#400 is closed, so there is nothing to gate' }) });
      assert.equal(report.stopped_at, 'pr');
    } finally { fx.cleanup(); }
  });

  it('a head read that cannot connect is offline after one read, not drift, and nothing merges', async () => {
    const fx = fixture({ net: { fetch: false, forge: true, merge: false } });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /^gh pr view 400 could not reach GitHub to read the head/u);
      assert.equal(fx.ran('gh').filter((call) => call.args.includes('headRefOid')).length, 1, 'no six-times reading through a dead connection');
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), []);
    } finally { fx.cleanup(); }
  });

  it('a merge call that cannot connect, with GitHub still saying open, is offline and nothing merged', async () => {
    const fx = fixture({ net: { fetch: false, forge: false, merge: true } });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /^gh pr merge #400 could not reach GitHub \(error connecting to api\.github\.com/u);
      assert.equal(report.merged, false);
      assert.equal(report.merge_error, null);
    } finally { fx.cleanup(); }
  });

  it('a fetch that works and shows the base moved is still drift', async () => {
    const fx = fixture({ baseAfterGate: 'eeee555' });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'drift');
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('through the merger: a round whose fetch fails leaves the goal and the requeue budget alone, and the next reachable round lands', async () => {
    const fx = fixture({ net: { fetch: true, forge: false, merge: false } });
    const queued = join(fx.root, 'queue');
    mkdirSync(join(queued, 'runner'), { recursive: true });
    writeFileSync(mergesPath(queued), JSON.stringify([{ repo: 'memoro-cli', repo_path: fx.repoPath, pr: 400, branch: 'feature', since: '2026-11-06T11:00:00Z', holder: AREA }]));
    const GOAL = { programme: 'mc', goal: 'g', dir: join(fx.root, 'goal') };
    const goal = { ...GOAL, stage: 'review', status: 'ready', prs: [{ repo: 'memoro-cli', pr: 400 }], log: [] };
    const goalWrites = [];
    let at = Date.parse('2026-11-06T12:00:00Z');
    const now = () => new Date(at);
    const land = (batch, lane, extra) => landJob(batch, {
      root: queued, lane, say: () => {}, now, sleep: async () => {}, lock: (_root, fn) => fn(),
      mergeRound: (options) => fx.run({ onProgress: options.onProgress, signal: options.signal }),
      gh: () => ({ status: 0, stdout: JSON.stringify({ headRefOid: fx.forge.head }) }),
      readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }),
      recordStart: () => {}, record: () => {}, goalsOf: () => [goal],
      setGoal: (change) => { goalWrites.push(change); return { goal }; },
      noteGoal: (change) => { goalWrites.push(change); },
      ...extra,
    });
    const serveOnce = () => serve({
      root: queued, lock: (_root, fn) => fn(), take: () => true, release: () => {},
      lanes: ['memoro-cli'], laneOf: () => 'memoro-cli', now, land,
    });
    try {
      await serveOnce();
      const [entry] = parseQueue(readFileSync(mergesPath(queued), 'utf8'));
      assert.equal(entry.state, 'queued', 'back in line, not red');
      assert.equal(entry.offline, 1);
      assert.equal(entry.requeues, 0, 'no requeue used');
      assert.equal(entry.not_before, '2026-11-06T12:01:00.000Z');
      assert.deepEqual(goalWrites, [], 'the goal is left as it was');
      assert.deepEqual(fx.ran('gh').filter((call) => call.args[1] === 'merge'), [], 'nothing merged');

      fx.net.fetch = false;
      at = Date.parse('2026-11-06T12:01:00Z');
      await serveOnce();
      assert.deepEqual(parseQueue(readFileSync(mergesPath(queued), 'utf8')), [], 'the next reachable round landed it');
      assert.equal(fx.ran('gh').filter((call) => call.args[1] === 'merge').length, 1);
    } finally { fx.cleanup(); }
  });

  it('after a failed fetch, the round that reaches the forge again lands', async () => {
    const fx = fixture({ net: { fetch: true, forge: false, merge: false } });
    try {
      assert.equal((await fx.run()).stopped_at, 'offline');
      fx.net.fetch = false;
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.merge_commit, LANDED);
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

  it('merges when the base only moved forward, over files this change does not touch', async () => {
    // The eight `drift` rounds in gate-rounds.jsonl on 2026-08-29 were all
    // this: one squash landing on main while a 4-to-101-minute gate ran. The
    // verdict is differential, so a commit elsewhere in the tree does not
    // change what it says about this candidate.
    const fx = fixture({
      baseAfterGate: 'eeee555',
      movedFiles: ['src/other/thing.js', 'tests/other/thing.test.js'],
      candidateFiles: ['src/mine/feature.js'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.stopped_at, null);
    } finally { fx.cleanup(); }
  });

  it('still stops when the forward move touches a file this change also touches', async () => {
    const fx = fixture({
      baseAfterGate: 'eeee555',
      movedFiles: ['src/mine/feature.js', 'docs/unrelated.md'],
      candidateFiles: ['src/mine/feature.js', 'src/mine/other.js'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /src\/mine\/feature\.js/u);
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('still stops when the base was rewritten rather than moved forward', async () => {
    const fx = fixture({
      baseAfterGate: 'eeee555',
      ancestor: false,
      movedFiles: ['src/other/thing.js'],
      candidateFiles: ['src/mine/feature.js'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /not an ancestor/u);
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('an unreadable candidate is a refusal, not an all-clear', async () => {
    const fx = fixture({ baseAfterGate: 'eeee555', movedFiles: ['src/other/thing.js'], candidateFiles: [] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /could not be read/u);
    } finally { fx.cleanup(); }
  });

  it('a red verdict never reaches the ground check at all', async () => {
    // The loosening above must not become a route around the gate: red stops
    // the round before anything asks where the base stands.
    const fx = fixture({
      verdict: red(),
      baseAfterGate: 'eeee555',
      movedFiles: ['src/other/thing.js'],
      candidateFiles: ['src/mine/feature.js'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(report.merged, false);
      assert.deepEqual(fx.ran('git').filter((call) => call.args[0] === 'merge-base'), []);
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
describe('a round stopped from outside ends gone, and lands nothing', () => {
  it('a green verdict that arrives after the stop is not merged', async () => {
    const controller = new AbortController();
    controller.abort(new Error('merged on GitHub'));
    const fx = fixture();
    try {
      const report = await fx.run({ signal: controller.signal });
      assert.equal(report.stopped_at, 'gone');
      assert.equal(report.reason, 'merged on GitHub');
      assert.equal(fx.ran('gh').filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge').length, 0);
    } finally { fx.cleanup(); }
  });
});

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
    const printed = [...source.matchAll(/'([^'\n]*mc merge <repo> <pr>[^'\n]*)'/gu)].map((m) => m[1]);
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
 * stacked base it was aimed at, which everyone read as main. The line names the
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
    verdict.pr.base = 'stacked-base';
    const fx = fixture({ verdict });
    try {
      const progress = [];
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.merged, true);
      assert.equal(report.merged_into, 'stacked-base');
      assert.equal(report.off_default, true);
      assert.ok(progress.some((line) => line.startsWith('merged #400 into stacked-base as')), progress.join('\n'));
      assert.ok(progress.some((line) => /WARNING: stacked-base is not the default branch \(main\) — this landed on a branch, not on main/u.test(line)), progress.join('\n'));
      assert.match(report.log_line, /Squash-merge into `stacked-base` → `ccc[0-9a-f]*` \(NOT main\)/u);
    } finally { fx.cleanup(); }
  });

  it('a default git cannot name is unknown, never assumed to be main', async () => {
    const verdict = green();
    verdict.pr.base = 'stacked-base';
    const fx = fixture({ verdict, defaultBranch: null });
    try {
      const report = await fx.run();
      assert.equal(report.default_branch, null);
      assert.equal(report.off_default, false, 'no warning on a guess');
      assert.equal(report.merged_into, 'stacked-base', 'but the base is still named');
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
      // The tree of main as landed: in this stub a commit IS its content,
      // so the tree hash is the same word.
      if (args[0] === 'rev-parse' && args[1] === 'origin/main^{tree}') return { status: 0, stdout: `${state.mainAt}\n` };
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
        if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: `sha${number}` }) };
        return landed.includes(number)
          ? { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: `landed${number}` } }) }
          : { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) };
      }
      return { status: 0, stdout: '' };
    };
    return {
      ...fx,
      landed,
      run: (extra = {}) => fx.run({ pr: 401, prs: PRS, git, gh, refresh: async () => ({ ok: true }), gate: gateFor ? (args) => gateFor(args, state) : (async () => verdict), ...extra }),
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

  it('a batch chains main evidence per landed commit in order, checking each measured prefix tree', async () => {
    // "Verified together" and "landed one at a time" are two claims; the
    // bridge is identity, measured, not assumed. The stub's rev-parse
    // answers LANDED for the tree reads, so prefix trees of LANDED are the
    // measured build reproduced exactly.
    const verdict = { ...greenBatch(), selection: { selected: ['tests/selected.test.js'] }, candidate_trees: ['landed401', 'landed402', 'landed403'] };
    verdict.candidate = { ...verdict.candidate, covered: ['tests/selected.test.js'] };
    const fx = batchFixture({ verdict });
    try {
      recordMainRed({ root: fx.mcHome, repo: fx.repoPath, commit: BASE, covered: ['tests/inherited.test.js'], result: { totals: { finished: true } } });
      // rev-parse origin/main^{tree} → the generic branch of the stub,
      // which answers what the last merge made: landedN.
      const progress = [];
      const report = await fx.run({ refresh: () => ({ ok: true, at: 'abc1234' }), onProgress: (line) => progress.push(line) });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.tree_identical, true);
      for (const [index, commit] of ['landed401', 'landed402', 'landed403'].entries()) {
        const proof = readMainRed({ root: fx.mcHome, repo: fx.repoPath, baseCommit: commit,
          files: ['tests/selected.test.js', 'tests/inherited.test.js'] });
        assert.deepEqual(proof.green_on_main, ['tests/selected.test.js', 'tests/inherited.test.js'], 'the chained landing inherits coverage outside its selection');
        assert.equal(proof.inherited_from, index === 0 ? BASE : `landed${400 + index}`);
      }
      assert.ok(progress.some((line) => /#401 landed byte-identical to the measured build/u.test(line)), progress.join('|'));
    } finally { fx.cleanup(); }
  });

  it('a landing whose tree is not the measured build\'s re-measures the rest in rounds of their own', async () => {
    const verdict = { ...greenBatch(), candidate_trees: ['landed401', 'expected-but-not-what-main-became', 'landed403'] };
    // The single rounds that re-measure land green against fresh main.
    const gateFor = async ({ prs, pr }, state) => (prs ? verdict : { ...green({ baseCommit: state.mainAt }), pr: { ...green().pr, number: pr, head_sha: `sha${pr}` } });
    const fx = batchFixture({ verdict, gateFor });
    const progress = [];
    try {
      const report = await fx.run({ refresh: () => ({ ok: true, at: 'abc1234' }), onProgress: (line) => progress.push(line) });
      assert.equal(report.tree_identical, false, 'identity failed at #402 and stays failed');
      assert.ok(progress.some((line) => /^WARNING: after #402, origin\/main's tree/u.test(line)), progress.join('|'));
      assert.ok(progress.some((line) => /re-measuring the remaining 1 in rounds of their own/u.test(line)));
      assert.equal(report.batch.fallback, true);
      assert.deepEqual(report.batch.merges.map((item) => [item.number, item.merged]), [[401, true], [402, true], [403, true]], 'everything landed — the last through its own measured round');
      assert.equal(report.batch.rounds.length, 1, 'one re-measured round, for the one after the mismatch');
      assert.equal(report.ok, true, report.reason);
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
      if (pr === 402) return { ...fresh, pr: { ...fresh.pr, number: 402, head_sha: 'sha402' }, ok: false, stopped_at: 'red', reason: '1 test red', broke: ['x › y'] };
      return { ...fresh, pr: { ...fresh.pr, number: pr, head_sha: `sha${pr}` } };
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

/**
 * One merge round at a time — the invariant, asserted rather than assumed.
 *
 * Two rounds writing to one repository at the same minute is not a git
 * problem: git merges the text fine. What breaks is that each one's "green"
 * was measured against a main the other has already moved. Martin,
 * 2026-08-30: *"Endast en instans mc merge åt gången. Det förhindrar
 * parallell skrivning."*
 *
 * Two leases carry it, and they are separate on purpose. The repository lease
 * is per repository; the suite right is per machine. Neither blocks git — they
 * refuse `mc`, and the refusal is the whole mechanism.
 */
describe('one round at a time', () => {
  it('a second round on the same repository is refused by name, and merges nothing', async () => {
    const fx = fixture();
    try {
      // Somebody else is already holding it.
      claimLease({
        repoPath: fx.repoPath, errand: 'merge round for #401',
        holder: { name: 'icon-assets', kind: 'work-area' }, ownerPid: process.pid, root: fx.mcHome,
      });
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'lease');
      assert.match(report.reason, /held by icon-assets/u);
      assert.match(report.reason, /merge round for #401/u, 'and what for');
      assert.equal(report.merged, false);
      assert.equal(report.gate, null, 'it stops before measuring anything');
    } finally { fx.cleanup(); }
  });

  it('the round takes the lease under its own pid, so a killed round is reapable', async () => {
    // A round that is killed runs no handler. The pid in the lease is what
    // lets the next claim tell "somebody is working" from "somebody died".
    const fx = fixture();
    try {
      await fx.run();
      const log = readFileSync(join(fx.mcHome, 'repo-leases', 'leases.log'), 'utf8');
      assert.match(log, new RegExp(`claim.*pid=${process.pid}`, 'u'));
    } finally { fx.cleanup(); }
  });

  it('gives the lease back whatever happened, so the next round is not blocked', async () => {
    for (const broken of [false, true]) {
      const fx = fixture(broken ? { gate: async () => ({ ok: false, stopped_at: 'red', reason: '1 red', pr: { base: 'main' } }) } : {});
      try {
        await fx.run();
        assert.equal(readLease(fx.repoPath, { root: fx.mcHome }).held, false, `lease left held (broken=${broken})`);
      } finally { fx.cleanup(); }
    }
  });
});

describe('a gate that regenerated derived artifacts', () => {
  it('freshens the branch with the declaration before its squash, so main is the measured tree', async () => {
    const verdict = { ...green(), declaration: { prepare: 'npm ci', derived: [{ command: 'regen', paths: ['docs/sql/'] }] }, derived: { commit: 'eeee555', regenerated: ['docs/sql/x.json'] } };
    const fx = fixture({ verdict });
    const freshened = [];
    try {
      const report = await fx.run({ refresh: (args) => { freshened.push(args); fx.calls.push({ tool: 'refresh' }); return { ok: true, at: 'abc1234' }; } });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(freshened.length, 1);
      assert.equal(freshened[0].branch, 'feature');
      assert.equal(freshened[0].declaration, verdict.declaration);
      const order = fx.calls.map((call) => (call.tool === 'gh' ? `gh:${call.args[1]}` : call.tool));
      assert.ok(order.indexOf('refresh') < order.indexOf('gh:merge'), 'freshened before the squash');
    } finally { fx.cleanup(); }
  });

  it('a branch that cannot carry the regeneration is not landed', async () => {
    const verdict = { ...green(), declaration: { derived: [{ command: 'regen', paths: ['docs/sql/'] }] }, derived: { commit: 'eeee555', regenerated: ['docs/sql/x.json'] } };
    const fx = fixture({ verdict });
    try {
      const report = await fx.run({ refresh: () => ({ ok: false, reason: 'regen failed' }) });
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /#400 could not be freshened for landing \(regen failed\)/u);
      assert.equal(fx.ran('gh').some((call) => call.args[1] === 'merge'), false);
    } finally { fx.cleanup(); }
  });

  it('a freshen the network stopped answers offline, not merge', async () => {
    const verdict = { ...green(), declaration: { derived: [{ command: 'regen', paths: ['docs/sql/'] }] }, derived: { commit: 'eeee555', regenerated: ['docs/sql/x.json'] } };
    const fx = fixture({ verdict });
    try {
      const report = await fx.run({ refresh: () => ({ ok: false, offline: true, reason: 'git fetch origin --prune failed before freshening h400 (exit 128)' }) });
      assert.equal(report.stopped_at, 'offline');
      assert.match(report.reason, /git fetch origin --prune failed before freshening/u);
      assert.equal(fx.ran('gh').some((call) => call.args[1] === 'merge'), false);
    } finally { fx.cleanup(); }
  });

  it('nothing regenerated, nothing freshened — a single round lands as it always did', async () => {
    const fx = fixture();
    let asked = 0;
    try {
      const report = await fx.run({ refresh: () => { asked += 1; return { ok: true }; } });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(asked, 0);
    } finally { fx.cleanup(); }
  });
});
