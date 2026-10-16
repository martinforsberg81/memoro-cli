/**
 * `mc gate` — the command is the repository's, the output is bounded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAILURE_LINES, OUTPUT_CAP, gateCommand, gateLines, summarizeGate } from '../../src/mc/gate-local.js';

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

