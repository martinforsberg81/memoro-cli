/**
 * `mc gate` — the command is the repository's, the output is bounded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAILURE_LINES, OUTPUT_CAP, failingNames, gateCommand, gateLines, namePattern, namedCommand, redFiles, rerunLine, summarizeGate, testFlags } from '../../src/mc/gate-local.js';

describe('gateCommand', () => {
  it('is npm run ci with the base where there is a ci script, npm test otherwise, null with neither', () => {
    assert.deepEqual(gateCommand({ scripts: { ci: 'node scripts/testing/ci.mjs', test: 'node scripts/testing/ci.mjs' } }),
      { run: 'npm run ci -- --base-ref origin/main', script: 'node scripts/testing/ci.mjs', source: 'ci' });
    assert.equal(gateCommand({ scripts: { ci: 'x' } }, { base: 'origin/release' }).run, 'npm run ci -- --base-ref origin/release');
    assert.deepEqual(gateCommand({ scripts: { test: 'node --test' } }), { run: 'npm test', script: 'node --test', source: 'test' });
    assert.equal(gateCommand({ scripts: {} }), null);
    assert.equal(gateCommand(null), null);
  });
});

describe('summarizeGate', () => {
  it('reads node\'s spec reporter: counts, the failing names, and the location under each', () => {
    const output = [
      '✔ green one (1.2ms)',
      '✖ red one (3.4ms)',
      '  AssertionError [ERR_ASSERTION]: 1 == 2',
      '      at TestContext.<anonymous> (file:///w/tests/mc/x.test.js:12:5)',
      '      at Test.run (node:internal/test_runner/test:1106:25)',
      'ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1', 'ℹ skipped 0',
    ].join('\n');
    const summary = summarizeGate(output, { exitCode: 1 });
    assert.equal(summary.ok, false);
    assert.deepEqual(summary.counts, { tests: 2, pass: 1, fail: 1, skipped: 0 });
    assert.deepEqual(summary.failures, ['✖ red one', '  AssertionError [ERR_ASSERTION]: 1 == 2', '    file:///w/tests/mc/x.test.js:12']);
    assert.equal(summary.more, 0);
  });

  it('reads memoro\'s ci summary and TAP, and is green only by exit code', () => {
    const ci = ['Memoro CI result', '  status: fail', '  tests: ran 12/12 files in 40.00 s (10 in passed batches, 2 in failed batches)', '  command sql:pr-ci: fail in 3.00 s'].join('\n');
    const s = summarizeGate(ci, { exitCode: 1 });
    assert.deepEqual(s.counts, { files: 12, selected: 12 });
    assert.deepEqual(s.failures, ['  status: fail', '  command sql:pr-ci: fail in 3.00 s']);
    assert.deepEqual(summarizeGate('not ok 3 - the thing\nok 4 - other', { exitCode: 1 }).failures, ['not ok 3 - the thing']);
    // A crash before any summary: red, no counts, nothing named.
    assert.deepEqual(summarizeGate('', { exitCode: 2 }), { ok: false, counts: {}, gates: [], failures: [], more: 0 });
    assert.equal(summarizeGate('✖ looks red but the process said 0', { exitCode: 0 }).ok, true);
  });

  it('names at most FAILURE_LINES lines and counts the rest', () => {
    const output = Array.from({ length: 30 }, (_, i) => `✖ test ${i}`).join('\n');
    const s = summarizeGate(output, { exitCode: 1 });
    assert.equal(s.failures.length, FAILURE_LINES);
    assert.equal(s.more, 30 - FAILURE_LINES);
  });

  it('adds up every reporter block: one per lane, not the last one', () => {
    const output = ['ℹ tests 10', 'ℹ fail 1', 'ℹ tests 5', 'ℹ fail 0'].join('\n');
    assert.deepEqual(summarizeGate(output, { exitCode: 1 }).counts, { tests: 15, fail: 1 });
  });

  it('names a failed command gate, once each, in order', () => {
    const output = ['command sql:pr-ci: fail in 3.00 s', 'command lint: fail', 'command sql:pr-ci: fail in 1.00 s'].join('\n');
    assert.deepEqual(summarizeGate(output, { exitCode: 1 }).gates, ['sql:pr-ci', 'lint']);
  });

  it('a ci runner refusal and the paths under it are the failure', () => {
    const output = [
      'ci runner: Affected test selection has unmapped changes:',
      '- tests/_helpers/x.mjs',
      '- scripts/new.mjs',
      'done in 2.00 s',
    ].join('\n');
    const s = summarizeGate(output, { exitCode: 1 });
    assert.deepEqual(s.failures, ['ci runner: Affected test selection has unmapped changes:', '- tests/_helpers/x.mjs', '- scripts/new.mjs']);
  });

  it('names at most ten paths under a ci runner refusal', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `- tests/p${i}.mjs`);
    const s = summarizeGate(['ci runner: Affected test selection has unmapped changes:', ...paths].join('\n'), { exitCode: 1 });
    assert.equal(s.failures.length, 11);
    assert.equal(s.more, 0);
  });
});

describe('named test files', () => {
  it('failingNames: the names the reporter printed, the duration and the summary heading left out, once each', () => {
    const output = [
      '✖ adds up (2.1ms)',
      '✖ parses 1+1 [x] (0.4ms)',
      '  ✖ handles (case) (3ms)',
      '✖ adds up (2.1ms)',
      '✖ failing tests:',
    ].join('\n');
    assert.deepEqual(failingNames(output), ['adds up', 'parses 1+1 [x]', 'handles (case)']);
    assert.equal(namePattern(failingNames(output)), 'adds up|parses 1\\+1 \\[x\\]|handles \\(case\\)');
    assert.equal(namePattern(['a', 'b', 'c', 'd', 'e', 'f']), 'a|b|c|d|e');
  });

  it('testFlags: the --import and --experimental arguments of a node --test script, in order; none otherwise', () => {
    assert.deepEqual(testFlags('node --test --import ./tests/_isolate-home.mjs \'tests/**/*.test.js\''), ['--import', './tests/_isolate-home.mjs']);
    assert.deepEqual(testFlags('node --test --experimental-strip-types --import=./x.mjs --test-reporter spec tests/a.js'), ['--experimental-strip-types', '--import=./x.mjs']);
    assert.deepEqual(testFlags('vitest run'), []);
  });

  it('namedCommand: node --test, the flags, the files, the pattern', () => {
    const manifest = { scripts: { test: 'node --test --import ./tests/_isolate-home.mjs tests/**/*.test.js' } };
    assert.equal(namedCommand(manifest, ['a.test.js', 'tests/b x.test.js']).run, 'node --test --import ./tests/_isolate-home.mjs a.test.js \'tests/b x.test.js\'');
    assert.equal(namedCommand(null, ['a.test.js'], { pattern: 'it\'s' }).run, 'node --test a.test.js --test-name-pattern \'it\'\\\'\'s\'');
  });

  it('rerunLine: none without files; the files and the failing names otherwise', () => {
    assert.equal(rerunLine(undefined, '✖ a'), null);
    assert.equal(rerunLine(['a.test.js'], 'ℹ tests 1'), 're-run: mc gate a.test.js');
    assert.equal(rerunLine(['a.test.js'], '✖ adds up (2ms)'), 're-run: mc gate a.test.js --test-name-pattern \'adds up\'');
  });
});

describe('gateLines', () => {
  it('green is one line and the log path; red names the failures; never more than the cap', () => {
    const green = gateLines({ ok: true, counts: { tests: 1992, fail: 0, skipped: 9 }, failures: [], more: 0 }, { command: 'npm test', seconds: 89, logPath: '/s/gate-1.log' });
    assert.equal(green, 'GREEN — npm test — 1992 tests, 0 failed, 9 skipped — 89s\nwhole output: /s/gate-1.log');
    const red = gateLines({ ok: false, counts: {}, failures: ['✖ a', '    f.js:3'], more: 2 }, { command: 'npm test', seconds: 5, logPath: '/s/g.log' });
    assert.equal(red, 'RED — npm test — 0 tests counted — the failure is below — 5s\n✖ a\n    f.js:3\n… and 2 more failing lines\nwhole output: /s/g.log');
    const long = gateLines({ ok: false, counts: {}, failures: Array.from({ length: 20 }, (_, i) => `✖ ${'x'.repeat(200)} ${i}`), more: 0 }, { command: 'npm test', seconds: 5, logPath: '/s/g.log' });
    assert.ok(Buffer.byteLength(long) <= OUTPUT_CAP, `${Buffer.byteLength(long)} bytes`);
    assert.match(long, /capped at 2048 bytes\)\nwhole output: \/s\/g\.log$/u);
  });

  it('a failed command gate is named in the RED line', () => {
    const summary = summarizeGate(['ℹ tests 414', 'ℹ fail 0', 'command sql:pr-ci: fail'].join('\n'), { exitCode: 1 });
    const red = gateLines(summary, { command: 'npm run ci', seconds: 9, logPath: '/s/g.log' });
    assert.equal(red.split('\n')[0], 'RED — npm run ci — 414 tests, 0 failed; command gate failed: sql:pr-ci — 9s');
  });

  it('a ci runner refusal and its paths are the failure, not "names no failing test"', () => {
    const summary = summarizeGate(['ci runner: Affected test selection has unmapped changes:', '- tests/_helpers/x.mjs'].join('\n'), { exitCode: 1 });
    const red = gateLines(summary, { command: 'npm run ci', seconds: 9, logPath: '/s/g.log' });
    assert.match(red, /^RED — npm run ci — 0 tests counted — the failure is below — 9s$/mu);
    assert.match(red, /^- tests\/_helpers\/x\.mjs$/mu);
    assert.doesNotMatch(red, /names no failing test/u);
  });
});


describe('redFiles', () => {
  // The closing summary of node's spec reporter, as memoro's ci prints it
  // (a gate log of 2026-10-18), with a passing file's chatter around it.
  const SPEC = [
    '✔ a succession fails without a contracting same-module predecessor (3.597ms)',
    '[ERROR] [compute-canary] check failed { requested: \'render_pdf\' }',
    '✖ every JavaScriptCore result says what the JavaScript engine\'s says (2524.093417ms)',
    'ℹ tests 3',
    'ℹ fail 2',
    '✖ failing tests:',
    '',
    'test at tests/architecture/card-corpus.test.js:519:1',
    '✖ every JavaScriptCore result says what the JavaScript engine\'s says (2524.093417ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '      at TestContext.<anonymous> (file:///Users/m/memoro/tests/architecture/card-corpus.test.js:530:12)',
    '      at file:///Users/m/memoro/tests/_helpers/corpus.mjs:44:3',
    '',
    'test at tests/ui/media-viewer-openers.test.js:88:3',
    '✖ markdown picture: a click opens MediaViewer (6952.554334ms)',
    '',
    'test at tests/architecture/card-corpus.test.js:600:1',
    '✖ a second test in the same file (1ms)',
  ].join('\n');

  it('names each failing file from the spec summary once, in order, and no helper', () => {
    assert.deepEqual(redFiles(SPEC, { root: '/Users/m/memoro' }), [
      'tests/architecture/card-corpus.test.js',
      'tests/ui/media-viewer-openers.test.js',
    ]);
  });

  it('reads TAP: only a not-ok block\'s location, made relative to the root', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - passes',
      '  ---',
      "  location: '/w/x/tests/mc/a.test.js:3:1'",
      '  ...',
      'not ok 2 - fails',
      '  ---',
      "  location: '/w/x/tests/mc/b.test.js:9:1'",
      "  failureType: 'testCodeFailure'",
      '  ...',
      'ok 3 - passes again',
      '  ---',
      "  location: '/w/x/tests/mc/c.test.mjs:1:1'",
      '  ...',
      'not ok 4 - /w/x/tests/mc/d.test.mjs',
      '  ---',
      "  location: '/w/x/tests/mc/d.test.mjs:1:1'",
    ].join('\n');
    assert.deepEqual(redFiles(tap, { root: '/w/x' }), ['tests/mc/b.test.js', 'tests/mc/d.test.mjs']);
  });

  it('a file that failed outside any test is named by its ✖ line', () => {
    assert.deepEqual(redFiles('✖ tests/mc/broken.test.js (12ms)\n  SyntaxError: Unexpected token\n'), ['tests/mc/broken.test.js']);
  });

  it('is empty for a red with no test file in it — a failed command gate, a crash', () => {
    assert.deepEqual(redFiles('Memoro CI result\n  status: fail\n  command sql:reference:postgres: fail in 1.41 s\n'), []);
    assert.deepEqual(redFiles('Error: Cannot find module \'x\'\n    at node:internal/modules/cjs/loader:1:1\n'), []);
    assert.deepEqual(redFiles(''), []);
  });

  it('keeps nothing outside the worktree or under node_modules', () => {
    const text = '✖ x\n    at f (/elsewhere/tests/a.test.js:1:1)\n    at g (file:///w/x/node_modules/p/tests/b.test.js:2:2)\n';
    assert.deepEqual(redFiles(text, { root: '/w/x' }), []);
  });
});

describe('namedCommand flags', () => {
  it('declared flags replace the test script\'s', () => {
    assert.equal(namedCommand({ scripts: { test: 'node scripts/testing/ci.mjs' } }, ['tests/a.test.js'], { flags: ['--import', './tests/_helpers/browser-paths.mjs'] }).run,
      'node --test --import ./tests/_helpers/browser-paths.mjs tests/a.test.js');
  });
});

describe('gateLines label', () => {
  it('stands right after the verdict', () => {
    assert.match(gateLines({ ok: true, counts: { tests: 1, fail: 0 }, gates: [], failures: [], more: 0 }, { command: 'node --test 1 file', seconds: 1, logPath: '/l', label: 'INCREMENTAL — x' }),
      /^GREEN INCREMENTAL — x — node --test 1 file — 1 tests, 0 failed — 1s\n/u);
  });
});
