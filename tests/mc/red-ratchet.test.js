/**
 * The word, and the ratchet under it.
 *
 * Two things are under test and they are one change. The verdict may not say
 * GREEN over a baseline that is red — that word is what somebody quotes when
 * they decide to merge, and it had been printed over 55 standing red names for
 * a week. And the standing red, once written down, may go down and may not go
 * up: a test that is already red can never report a new bug in itself, so the
 * standing set is not only debt, it is that many places the suite has gone
 * blind.
 *
 * The load-sensitive case is the one the design turns on. Measured twice hours
 * apart, main gave 55 names and then 56, and the 56th was green again next
 * run. A ratchet on the *number* fails good pull requests at random; a ratchet
 * on the *names* asks for one reviewable line and is then quiet for ever. Both
 * halves of that are asserted below.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  RATCHET_PATH, compareRatchet, ratchetFileText, ratchetLines, readRatchet,
} from '../../src/mc/red-ratchet.js';
import { gateLines, verdictLines } from '../../src/mc/commands/repo.js';
import { compareRed, redNames } from '../../src/mc/tap-red.js';
import { runGate } from '../../src/mc/repo-gate.js';

/** A checkout with — or without — a ratchet file in it. */
function checkout(contents = null) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ratchet-'));
  if (contents !== null) {
    mkdirSync(join(dir, '.mc'), { recursive: true });
    writeFileSync(join(dir, RATCHET_PATH), contents);
  }
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

function recorded(names) {
  return JSON.stringify({ standing_red: names.length, names }, null, 2);
}

function round({ recorded: file, measured }) {
  return compareRatchet({ recorded: file, measured });
}

describe('the verdict does not say green over a red baseline', () => {
  it('says GREEN only when the baseline had nothing red', () => {
    const line = verdictLines({ verdict: 'green', standing_red: 0, pr: { base: 'main' } }).join(' ');
    assert.match(line, /GREEN/u);
  });

  it('says NO NEW RED with the number, and never the word green, when it did', () => {
    const line = verdictLines({ verdict: 'no-new-red', standing_red: 55, pr: { base: 'main' } }).join(' ');
    assert.doesNotMatch(line, /green/iu, 'the word is what somebody quotes when they merge');
    assert.match(line, /NO NEW RED/u);
    // The number has to be in the line itself, not in a footnote somewhere:
    // "no new red" on its own invites the reader to supply "and the rest is
    // fine", which is the sentence being corrected.
    assert.match(line, /55 standing red on main/u);
  });
});

describe('the ratchet binds names, because a count moves under load', () => {
  it('a name that was recorded and is still red changes nothing', () => {
    const outcome = round({
      recorded: { adopted: true, names: ['a', 'b'], standing_red: 2, malformed: null, path: RATCHET_PATH },
      measured: ['a', 'b'],
    });
    assert.deepEqual(outcome.rose, []);
    assert.deepEqual(outcome.fell, []);
    assert.equal(outcome.blocks, false);
  });

  it('a name nobody recorded stops the round, and is named', () => {
    const outcome = round({
      recorded: { adopted: true, names: ['a'], standing_red: 1, malformed: null, path: RATCHET_PATH },
      measured: ['a', 'fails explicitly when workspace preparation never settles'],
    });
    assert.equal(outcome.blocks, true);
    assert.deepEqual(outcome.rose, ['fails explicitly when workspace preparation never settles']);
    const said = ratchetLines(outcome).join('\n');
    assert.match(said, /fails explicitly when workspace preparation never settles/u, 'names carry information; a number does not');
    // The pull request in front of the gate did not cause a red on main, and
    // being stopped without being told that reads as an accusation.
    assert.match(said, /main getting worse rather than this change breaking it/u);
  });

  it('once that name is acknowledged it never fires again', () => {
    const flake = 'fails explicitly when workspace preparation never settles';
    const measured = ['a', flake];
    const before = round({ recorded: { adopted: true, names: ['a'], standing_red: 1, malformed: null, path: RATCHET_PATH }, measured });
    assert.equal(before.blocks, true);

    // One reviewable line added to the file — the whole of the fix.
    const after = round({ recorded: { adopted: true, names: ['a', flake], standing_red: 2, malformed: null, path: RATCHET_PATH }, measured });
    assert.equal(after.blocks, false);
    // And the round after that, with the flake green again, is a fall — never
    // a rise. A load-sensitive test costs one acknowledgement, not a failure
    // every time the machine is busy.
    const quiet = round({ recorded: { adopted: true, names: ['a', flake], standing_red: 2, malformed: null, path: RATCHET_PATH }, measured: ['a'] });
    assert.equal(quiet.blocks, false);
    assert.deepEqual(quiet.fell, [flake]);
  });

  it('a set that shrank stops nothing and says exactly what to write', () => {
    const outcome = round({
      recorded: { adopted: true, names: ['a', 'b', 'c'], standing_red: 3, malformed: null, path: RATCHET_PATH },
      measured: ['a'],
    });
    assert.equal(outcome.blocks, false, 'a change that repairs tests must never be refused');
    assert.deepEqual(outcome.fell, ['b', 'c']);
    assert.match(ratchetLines(outcome).join('\n'), /should say 1/u);
  });
});

describe('a repository that has not adopted it is not judged by it', () => {
  it('decides nothing without the file, however red the baseline is', () => {
    const outcome = round({
      recorded: { adopted: false, names: [], standing_red: null, malformed: null, path: RATCHET_PATH },
      measured: ['a', 'b', 'c'],
    });
    // On the day this ships no repository has the file. A ratchet that binds
    // in its absence stops every merge everywhere — including the pull request
    // that would introduce it.
    assert.equal(outcome.blocks, false);
    assert.deepEqual(outcome.rose, []);
    assert.match(ratchetLines(outcome).join('\n'), /has not adopted/u);
    assert.match(ratchetLines(outcome).join('\n'), /3 standing red/u);
  });

  it('a file that exists and cannot be read stops the round instead', () => {
    const outcome = round({
      recorded: { adopted: true, names: [], standing_red: null, malformed: 'it is not JSON', path: RATCHET_PATH },
      measured: ['a'],
    });
    assert.equal(outcome.blocks, true, 'a broken guard that waves things through is not a guard');
    // No deadlock: the file is read from the candidate, so the change that
    // repairs it is exactly the one that passes.
    assert.match(ratchetLines(outcome).join('\n'), /reads it from the candidate, so the fix passes/u);
  });
});

describe('reading the file', () => {
  it('an absent file is "not adopted", not an error', () => {
    const c = checkout();
    try {
      const read = readRatchet(c.dir);
      assert.equal(read.adopted, false);
      assert.equal(read.malformed, null);
    } finally { c.cleanup(); }
  });

  it('reads the names and the number when they agree', () => {
    const c = checkout(recorded(['a', 'b']));
    try {
      const read = readRatchet(c.dir);
      assert.equal(read.adopted, true);
      assert.equal(read.standing_red, 2);
      assert.deepEqual(read.names, ['a', 'b']);
    } finally { c.cleanup(); }
  });

  it('a number that disagrees with its own names is malformed', () => {
    const c = checkout(JSON.stringify({ standing_red: 55, names: ['a', 'b'] }));
    try {
      // Letting this through would put the exact confusion being fixed — a
      // number nobody can check against what it counts — inside the fix.
      assert.match(readRatchet(c.dir).malformed, /but there are 2 names/u);
    } finally { c.cleanup(); }
  });

  it('junk and a missing names array are malformed too', () => {
    const bad = checkout('{not json');
    const empty = checkout(JSON.stringify({ standing_red: 0 }));
    try {
      assert.match(readRatchet(bad.dir).malformed, /not JSON/u);
      assert.match(readRatchet(empty.dir).malformed, /no "names" array/u);
    } finally { bad.cleanup(); empty.cleanup(); }
  });

  it('the file it prints is the file it reads back', () => {
    const c = checkout(ratchetFileText(['b', 'a']));
    try {
      const read = readRatchet(c.dir);
      assert.equal(read.malformed, null);
      assert.deepEqual(read.names, ['a', 'b'], 'sorted, so a diff of names is readable');
      assert.equal(read.standing_red, 2);
    } finally { c.cleanup(); }
  });

  it('every round carries that file, so nobody has to count by hand', () => {
    // The count is not something a person can measure reliably — two full
    // suite runs under a TAP reporter did not print their own summaries. The
    // round measured it; the round hands it over.
    const outcome = round({
      recorded: { adopted: false, names: [], standing_red: null, malformed: null, path: RATCHET_PATH },
      measured: ['b', 'a'],
    });
    const c = checkout(outcome.file_text);
    try {
      assert.deepEqual(readRatchet(c.dir).names, ['a', 'b']);
      assert.equal(readRatchet(c.dir).malformed, null, 'what it hands over is a file it accepts');
    } finally { c.cleanup(); }
  });
});

describe('what the differential gate already catches, and what it does not', () => {
  /**
   * The question the order asked, answered with code: `broke` is documented as
   * "red on the candidate and green on the baseline", and a brand new test born
   * red is red on the candidate and *absent* from the baseline. Does it fall
   * out?
   *
   * It does not. The implementation is "red on the candidate and not red on
   * the baseline", which is wider than the words and covers absent — so a new
   * red test cannot arrive that way, whether it is born inside a suite that
   * already fails or in a file nobody has seen before.
   */
  it('a test born red is caught by broke — in a red suite and in a new file alike', () => {
    const baseline = redNames([
      '# Subtest: tests/a.test.js',
      '    # Subtest: old suite',
      '        # Subtest: already red',
      '        not ok 1 - already red',
      '    not ok 1 - old suite',
      'not ok 1 - tests/a.test.js',
    ].join('\n'));
    const candidate = redNames([
      '# Subtest: tests/a.test.js',
      '    # Subtest: old suite',
      '        # Subtest: already red',
      '        not ok 1 - already red',
      '        # Subtest: born red today',
      '        not ok 2 - born red today',
      '    not ok 1 - old suite',
      'not ok 1 - tests/a.test.js',
      '# Subtest: tests/brand-new.test.js',
      '    # Subtest: also born red',
      '    not ok 1 - also born red',
      'not ok 2 - tests/brand-new.test.js',
    ].join('\n'));

    const { broke } = compareRed(baseline, candidate);
    assert.ok(broke.includes('tests/a.test.js › old suite › born red today'));
    assert.ok(broke.includes('tests/brand-new.test.js › also born red'));
  });

  /**
   * So the ratchet is not a patch for a hole in `broke`. What it is for is the
   * red that arrives by every other route — a merge that skipped the gate,
   * main rotting on its own — which the differential comparison cannot see
   * because it only ever compares one change against the main under it.
   */
  it('but a baseline that got worse on its own is invisible to broke, and not to the ratchet', () => {
    const measured = ['a', 'b'];
    const { broke } = compareRed(measured, measured);
    assert.deepEqual(broke, [], 'the differential gate has nothing to say about it');

    const outcome = round({
      recorded: { adopted: true, names: ['a'], standing_red: 1, malformed: null, path: RATCHET_PATH },
      measured,
    });
    assert.equal(outcome.blocks, true);
    assert.deepEqual(outcome.rose, ['b']);
  });
});

/**
 * The wiring, through the real round.
 *
 * The unit tests above decide what the ratchet means; these decide that the
 * gate asks it the right question about the right tree. Reading the file from
 * the baseline instead of the candidate is the mistake that would look right
 * in review and make the one pull request that acknowledges a red name the one
 * thing the ratchet could never accept.
 */
describe('the gate round, with a ratchet in the tree', () => {
  function tapWith(red) {
    const lines = ['TAP version 13'];
    red.forEach((name, index) => {
      lines.push(`# Subtest: ${name}`, `not ok ${index + 1} - ${name}`);
    });
    lines.push(`1..${red.length}`, '# tests 100', `# pass ${100 - red.length}`, `# fail ${red.length}`);
    return lines.join('\n');
  }

  /** `baselineFile` and `candidateFile` land in their own worktrees. */
  function gateFixture({ baselineRed = [], candidateRed = [], baselineFile = null, candidateFile = null } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mc-ratchet-gate-'));
    const repoPath = join(root, 'repo');
    const mcHome = join(root, 'home');
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(mcHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'repo', scripts: { test: 'node --test' } }));

    const git = (args, opts = {}) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        const dir = args[args.length - 2];
        mkdirSync(dir, { recursive: true });
        const file = dir.endsWith('baseline') ? baselineFile : candidateFile;
        if (file !== null) {
          mkdirSync(join(dir, '.mc'), { recursive: true });
          writeFileSync(join(dir, RATCHET_PATH), file);
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(args[args.length - 1], { recursive: true, force: true });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: `${opts.cwd.endsWith('baseline') ? 'base1111' : 'cand2222'}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const gh = () => ({
      status: 0,
      stdout: JSON.stringify({
        number: 400, headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc1234', state: 'OPEN', title: 'a change',
      }),
      stderr: '',
    });
    const suite = ({ cwd }) => Promise.resolve({
      code: 1,
      tap: tapWith(cwd.endsWith('baseline') ? baselineRed : candidateRed),
    });

    return {
      run: () => runGate({
        repoPath, pr: 400, holder: { name: 'watch-pm', kind: 'work-area' }, root: mcHome, git, gh, suite,
      }),
      cleanup() { rmSync(root, { recursive: true, force: true }); },
    };
  }

  it('reads the ratchet from the candidate, so the change that acknowledges a name passes', async () => {
    const fx = gateFixture({
      baselineRed: ['a', 'b'],
      candidateRed: ['a', 'b'],
      // Main does not know about `b` yet. This pull request is the one adding
      // it — read from the baseline, it would be refused for saying so.
      baselineFile: recorded(['a']),
      candidateFile: recorded(['a', 'b']),
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.deepEqual(report.ratchet.rose, []);
    } finally { fx.cleanup(); }
  });

  it('stops the round when the candidate does not record a red name', async () => {
    const fx = gateFixture({
      baselineRed: ['a', 'b'],
      candidateRed: ['a', 'b'],
      candidateFile: recorded(['a']),
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'ratchet');
      assert.match(report.reason, /does not record/u);
      assert.deepEqual(report.ratchet.rose, ['b']);
      // And it is not the change's doing: nothing broke.
      assert.deepEqual(report.broke, []);
    } finally { fx.cleanup(); }
  });

  it('carries the verdict and the standing count, whatever the tree holds', async () => {
    const red = gateFixture({ baselineRed: ['a', 'b'], candidateRed: ['a', 'b'] });
    const clean = gateFixture({ baselineRed: [], candidateRed: [] });
    try {
      const standing = await red.run();
      assert.equal(standing.verdict, 'no-new-red');
      assert.equal(standing.standing_red, 2, 'standing red is main\'s, so it is the baseline\'s count');
      assert.equal(standing.ok, true, 'and an unadopted repository is not judged by the ratchet');

      const nothing = await clean.run();
      assert.equal(nothing.verdict, 'green');
      assert.equal(nothing.standing_red, 0);
    } finally { red.cleanup(); clean.cleanup(); }
  });

  it('a change that really did break something is still red, not a ratchet stop', async () => {
    const fx = gateFixture({
      baselineRed: ['a'],
      candidateRed: ['a', 'this change broke it'],
      candidateFile: recorded(['a']),
    });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'red', 'the change\'s own fault is reported as the change\'s own fault');
      assert.deepEqual(report.broke, ['this change broke it']);
      // The ratchet never ran: a round already stopped does not need a second
      // reason, and reporting two would blur whose fault it was.
      assert.equal(report.ratchet, null);
    } finally { fx.cleanup(); }
  });
});

/**
 * The page a person actually reads.
 *
 * The verdict and the ratchet are decided in the modules above; this is the
 * one place where being right and reading right are different things. A stop
 * that prints its reason but not its names would satisfy every assertion so
 * far and still be useless — which is exactly what the first version did, by
 * returning early on any stop that was not `red`.
 */
describe('what the round prints', () => {
  const round = (extra) => ({
    pr: { number: 400, head: 'feature', base: 'main' },
    baseline: { commit: 'base1111', red: ['a', 'b'], totals: { tests: 100 } },
    candidate: { commit: 'cand2222', red: ['a', 'b'], totals: { tests: 100 } },
    broke: [],
    fixed: [],
    stopped_at: null,
    reason: null,
    verdict: 'no-new-red',
    standing_red: 2,
    ratchet: null,
    extra_gates: [],
    declaration: {},
    ...extra,
  });

  it('a ratchet stop shows the names, not just the word', () => {
    const page = gateLines(round({
      stopped_at: 'ratchet',
      reason: '1 red name on main that .mc/red-ratchet.json does not record',
      ratchet: {
        adopted: true, malformed: null, path: RATCHET_PATH, recorded_count: 1,
        standing_red: 2, rose: ['b'], fell: [], blocks: true,
      },
    })).join('\n');

    assert.match(page, /RATCHET/u);
    assert.match(page, /^ {6}b$/mu, 'the name is the whole point of binding names');
    assert.match(page, /main getting worse rather than this change breaking it/u);
    assert.match(page, /not merged/u);
    // It stopped after both suites ran, so what was measured is still shown.
    assert.match(page, /baseline {2}base111/u);
    assert.match(page, /candidate cand222/u);
  });

  it('a passing round over standing red never prints the word green', () => {
    const page = gateLines(round({
      ratchet: {
        adopted: true, malformed: null, path: RATCHET_PATH, recorded_count: 2,
        standing_red: 2, rose: [], fell: [], blocks: false,
      },
    })).join('\n');

    assert.match(page, /NO NEW RED/u);
    assert.match(page, /2 standing red on main/u);
    assert.doesNotMatch(page, /GREEN/u);
    assert.match(page, /it says nothing about whether the change is right/u, 'the sentence that was always right stays');
  });

  it('a clean baseline still gets the word it earned', () => {
    const page = gateLines(round({
      baseline: { commit: 'base1111', red: [], totals: { tests: 100 } },
      candidate: { commit: 'cand2222', red: [], totals: { tests: 100 } },
      verdict: 'green',
      standing_red: 0,
      ratchet: { adopted: false, malformed: null, path: RATCHET_PATH, recorded_count: null, standing_red: 0, rose: [], fell: [], blocks: false },
    })).join('\n');
    assert.match(page, /GREEN — the test gate passes/u);
  });

  it('a stop before anything was measured still gets the short form', () => {
    const page = gateLines(round({
      stopped_at: 'lease', reason: 'held by somebody else', baseline: null, candidate: null,
    })).join('\n');
    assert.match(page, /stopped at lease/u);
    assert.match(page, /nothing was measured/u);
  });
});
