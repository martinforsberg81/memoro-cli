/**
 * Whose red it is: the walk back along main, and what is kept of it.
 *
 * The round's half is in `repo-gate.test.js` — the verdict unchanged, the
 * reason naming the landing. This file is the walk itself, where the cases
 * that are easy to get wrong live: a test red for several landings, a test
 * that did not exist yet, a history too long to walk, and a landing whose
 * round kept no selection to check against.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { mainRedClause } from '../../src/mc/repo-gate.js';
import { classify, docsOnly, probeMainRed, readSelectorMisses, selectorMissReading } from '../../src/mc/selector-miss.js';
import { redFiles } from '../../src/mc/tap-red.js';

function located(files) {
  const lines = ['TAP version 13'];
  files.forEach((file, index) => {
    lines.push(`not ok ${index + 1} - a test`, '  ---', `  location: '/tmp/candidate/${file}:9:1'`, '  ...');
  });
  lines.push(`1..${files.length}`, '# tests 5', `# fail ${files.length}`);
  return lines.join('\n');
}

/**
 * main, newest first, and which files are red at each commit. A file missing
 * from `present` did not exist at that commit. `visits` gives a commit a red
 * list per run there, the last one repeating — a test that flips.
 */
function repo({ history, redAt, present = {}, subjects = {}, changed = {}, visits = {} }) {
  let at = null;
  const runs = [];
  const seen = {};
  const git = (args) => {
    if (args[0] === 'checkout') { at = args.at(-1); return { status: 0 }; }
    if (args[0] === 'rev-list') return { status: 0, stdout: history.join('\n') };
    if (args[0] === 'cat-file') {
      const [commit, file] = args[2].split(':');
      return { status: (present[commit] || [file]).includes(file) ? 0 : 128 };
    }
    if (args[0] === 'log') return { status: 0, stdout: `${subjects[args.at(-1)] || 'a landing'}\n` };
    if (args[0] === 'diff-tree') return { status: 0, stdout: `${(changed[args.at(-1)] || ['src/x.js']).join('\n')}\n` };
    return { status: 0, stdout: '' };
  };
  const tests = ({ files }) => {
    runs.push({ at, files: [...files] });
    const visit = seen[at] = (seen[at] ?? -1) + 1;
    const red = visits[at] ? visits[at][Math.min(visit, visits[at].length - 1)] : redAt[at] || [];
    return Promise.resolve({ code: 0, tap: located(red.filter((file) => files.includes(file))) });
  };
  return { git, tests, runs };
}

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-selector-miss-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function rounds(root, lines) {
  writeFileSync(join(root, 'gate-rounds.jsonl'), lines.map((line) => JSON.stringify({ schema: 'mc-gate-round', version: 1, phase: 'end', ...line })).join('\n'));
}

describe('the walk finds the landing that broke each file', () => {
  it('walks past landings that were already red, to the first green one', async () => {
    const h = home();
    const fx = repo({
      history: ['c3', 'c2', 'c1', 'c0'],
      redAt: { c3: ['t/a.test.js', 't/b.test.js'], c2: ['t/a.test.js', 't/b.test.js'], c1: ['t/a.test.js'] },
      subjects: { c3: 'three (#30)', c2: 'two (#20)', c1: 'one (#10)' },
    });
    try {
      rounds(h.root, [
        { merged: [20], selected: ['t/b.test.js'] },
        { merged: [10], selected: ['t/other.test.js'] },
      ]);
      const probe = await probeMainRed({ ...fx, cwd: '/x', baseCommit: 'c3', files: ['t/a.test.js', 't/b.test.js'], root: h.root, repo: '/r/memoro' });
      assert.deepEqual(probe.red_on_main, ['t/a.test.js', 't/b.test.js']);
      // b went green one landing earlier than a: b broke in #20, a in #10.
      assert.deepEqual(probe.breaks.map((found) => [found.file, found.pr, found.kind]), [
        ['t/b.test.js', 20, 'selected'],
        ['t/a.test.js', 10, 'not-selected'],
      ]);
      // Each step runs only what is still red.
      assert.deepEqual(fx.runs.map((run) => [run.at, run.files.length]), [['c3', 2], ['c2', 2], ['c1', 2], ['c0', 1]]);
      assert.deepEqual(readSelectorMisses({ root: h.root }).map((line) => line.kind), ['selected', 'not-selected']);
    } finally { h.cleanup(); }
  });

  it('a file that did not exist yet was added red by the landing after', async () => {
    const h = home();
    const fx = repo({
      history: ['c1', 'c0'],
      redAt: { c1: ['t/new.test.js'] },
      present: { c0: [] },
      subjects: { c1: 'adds it (#5)' },
    });
    try {
      const probe = await probeMainRed({ ...fx, cwd: '/x', baseCommit: 'c1', files: ['t/new.test.js'], root: h.root });
      assert.equal(probe.breaks[0].pr, 5);
      assert.equal(probe.breaks[0].kind, 'no-round');
      assert.equal(fx.runs.length, 1, 'nothing is run at a commit where the file is absent');
    } finally { h.cleanup(); }
  });

  it('stops at the limit and says what it could not date', async () => {
    const h = home();
    const fx = repo({ history: ['c2', 'c1', 'c0'], redAt: { c2: ['t/a.test.js'], c1: ['t/a.test.js'], c0: ['t/a.test.js'] } });
    try {
      const probe = await probeMainRed({ ...fx, cwd: '/x', baseCommit: 'c2', files: ['t/a.test.js'], root: h.root, limit: 2 });
      assert.deepEqual(probe.breaks, []);
      assert.deepEqual(probe.unresolved, ['t/a.test.js']);
    } finally { h.cleanup(); }
  });

  it('a run that never summarised is not evidence, and blames nobody', async () => {
    const h = home();
    const git = (args) => (args[0] === 'rev-list' ? { status: 0, stdout: 'c1\nc0' } : { status: 0, stdout: '' });
    const tests = () => Promise.resolve({ code: 1, tap: 'TAP version 13\nnot ok 1 - crashed' });
    try {
      const probe = await probeMainRed({ git, tests, cwd: '/x', baseCommit: 'c1', files: ['t/a.test.js'], root: h.root });
      assert.ok(probe.stopped);
      assert.deepEqual(probe.breaks, []);
      assert.deepEqual(readSelectorMisses({ root: h.root }), []);
    } finally { h.cleanup(); }
  });
});

describe('a landing that changed only docs/ is measured again before it is named', () => {
  // 2026-10-06, `mc merge memoro 12720`: a wall-clock budget test, red under
  // load at both commits, was blamed on #12727 — six files under docs/.
  // 2026-10-10: #13310, an archive under docs/, deleted files a test reads,
  // and ruling it out by path left the red unexplained.
  async function walk(changed, visits = {}) {
    const h = home();
    const fx = repo({
      history: ['c1', 'c0'],
      redAt: { c1: ['t/budget.test.js'] },
      visits,
      subjects: { c1: 'staff notes (#12727)' },
      changed: { c1: changed },
    });
    try {
      rounds(h.root, [{ merged: [12727], selected: [] }]);
      const probe = await probeMainRed({ ...fx, cwd: '/x', baseCommit: 'c1', files: ['t/budget.test.js'], root: h.root, repo: '/r/memoro' });
      const now = Date.now();
      return { probe, runs: fx.runs, kept: readSelectorMisses({ root: h.root }), reading: selectorMissReading('/r/memoro', { root: h.root, now }) };
    } finally { h.cleanup(); }
  }
  const docs = ['docs/project/staff/a.md', 'docs/project/staff/b.md'];

  it('red at the landing and green at its parent both times names it, as landed without the suite, and records a miss', async () => {
    const { probe, runs, kept, reading } = await walk(docs);
    assert.deepEqual(probe.breaks[0].paths, docs);
    assert.equal(probe.breaks[0].kind, 'docs-only-landing');
    assert.deepEqual(probe.unresolved, []);
    // The walk's run at each commit, then one more at each.
    assert.deepEqual(runs.map((run) => run.at), ['c1', 'c0', 'c1', 'c0']);
    assert.equal(kept[0].kind, 'docs-only-landing');
    assert.equal(reading.misses, 1);
    assert.equal(mainRedClause(probe),
      ' — 1 of the red files is red on main too, broken by #12727 (#12727 changed only docs/ and landed without the suite)');
  });

  it('a second measure that flips is flaky: nobody is named, nothing is recorded, the file is unresolved', async () => {
    // Red at c1, green at c0, then green at c1 when measured again.
    const { probe, kept, reading } = await walk(docs, { c1: [['t/budget.test.js'], []] });
    assert.equal(probe.breaks[0].kind, 'flaky');
    assert.deepEqual(probe.unresolved, ['t/budget.test.js']);
    assert.deepEqual(kept, []);
    assert.equal(reading.misses, 0);
    assert.equal(mainRedClause(probe), ' — 1 of the red files is red on main too — 1 flaky under load');
    assert.doesNotMatch(mainRedClause(probe), /broken by/u);
  });

  it('red at the parent on the second measure is flaky too', async () => {
    const { probe } = await walk(docs, { c0: [[], ['t/budget.test.js']] });
    assert.equal(probe.breaks[0].kind, 'flaky');
  });

  it('a landing with one path outside docs/ is named as before, and not measured again', async () => {
    const { probe, runs } = await walk(['docs/project/staff/a.md', 'src/budget.js']);
    assert.deepEqual(probe.breaks[0].paths, ['docs/project/staff/a.md', 'src/budget.js']);
    assert.equal(probe.breaks[0].kind, 'not-selected');
    assert.equal(runs.length, 2);
    assert.equal(mainRedClause(probe),
      ' — 1 of the red files is red on main too, broken by #12727 (its selection did not reach it: a selector miss)');
  });

  it('names the landing that broke one file, and says the other is flaky', () => {
    const probe = {
      red_on_main: ['t/a.test.js', 't/b.test.js'],
      breaks: [
        { file: 't/a.test.js', commit: 'c2', pr: 20, kind: 'selected', paths: ['src/a.js'] },
        { file: 't/b.test.js', commit: 'c1', pr: 10, kind: 'flaky', paths: ['docs/x.md'] },
      ],
    };
    assert.equal(mainRedClause(probe),
      ' — 2 of the red files are red on main too, broken by #20 — 1 flaky under load');
  });

  it('paths that could not be read are not called docs-only', () => {
    assert.equal(docsOnly([]), false);
    assert.equal(docsOnly(undefined), false);
    assert.equal(docsOnly(['docs/a.md']), true);
    assert.equal(docsOnly(['docs/a.md', 'package.json']), false);
  });
});

describe('a landing is classified by its own round', () => {
  it('no pull request, no round, no selection, selected, not selected', () => {
    const lines = [
      { phase: 'end', merged: [1] },
      { phase: 'end', merged: [2], selected: ['t/a.test.js'] },
    ];
    assert.equal(classify({ pr: null, file: 't/a.test.js' }, lines).kind, 'no-round');
    assert.equal(classify({ pr: 9, file: 't/a.test.js' }, lines).kind, 'no-round');
    assert.equal(classify({ pr: 1, file: 't/a.test.js' }, lines).kind, 'no-selection');
    assert.equal(classify({ pr: 2, file: 't/a.test.js' }, lines).kind, 'selected');
    assert.equal(classify({ pr: 2, file: 't/b.test.js' }, lines).kind, 'not-selected');
  });
});

describe('the page reads misses, not every break', () => {
  it('counts not-selected for this repository within the window', () => {
    const h = home();
    try {
      const now = Date.parse('2026-09-26T12:00:00Z');
      writeFileSync(join(h.root, 'selector-misses.jsonl'), [
        { at: '2026-09-25T21:00:00Z', repo: 'memoro', file: 't/a.test.js', kind: 'not-selected', pr: 12106 },
        { at: '2026-09-25T21:00:00Z', repo: 'memoro', file: 't/b.test.js', kind: 'selected', pr: 12106 },
        { at: '2026-09-25T21:00:00Z', repo: 'memoro-cli', file: 't/c.test.js', kind: 'not-selected', pr: 700 },
        { at: '2026-08-01T21:00:00Z', repo: 'memoro', file: 't/d.test.js', kind: 'not-selected', pr: 9000 },
      ].map((line) => JSON.stringify({ schema: 'mc-selector-miss', version: 1, ...line })).join('\n'));
      const reading = selectorMissReading('/Users/x/mc/area/memoro', { root: h.root, now });
      assert.equal(reading.misses, 1);
      assert.equal(reading.recent[0].pr, 12106);
    } finally { h.cleanup(); }
  });
});

describe('red files are read from where node says the failure is', () => {
  it('matches a location by its tail, and only files the caller named', () => {
    const tap = [
      'TAP version 13',
      '# Subtest: suite',
      '    not ok 1 - inner',
      '      ---',
      "      location: '/private/var/gate/candidate/tests/a.test.js:12:3'",
      '      ...',
      'not ok 1 - suite',
      '  ---',
      "  location: '/private/var/gate/candidate/tests/a.test.js:10:1'",
      '  ...',
      'ok 2 - fine',
      '  ---',
      "  location: '/private/var/gate/candidate/tests/b.test.js:1:1'",
      '  ...',
      'not ok 3 - /private/var/gate/candidate/tests/c.test.js',
      'not ok 4 - todo # TODO later',
      '  ---',
      "  location: '/private/var/gate/candidate/tests/d.test.js:1:1'",
      '  ...',
      'not ok 5 - helper',
      '  ---',
      "  location: '/private/var/gate/candidate/tests/_helpers/x.js:1:1'",
      '  ...',
    ].join('\n');
    assert.deepEqual(
      redFiles(tap, ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/d.test.js']),
      ['tests/a.test.js', 'tests/c.test.js'],
    );
  });
});
