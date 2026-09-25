/**
 * `mc gate` — the command is the repository's, the output is bounded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAILURE_LINES, OUTPUT_CAP, gateCommand, gateLines, summarizeGate } from '../../src/mc/gate-local.js';
import { run } from '../../src/mc/commands/gate.js';

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
    assert.deepEqual(summarizeGate('', { exitCode: 2 }), { ok: false, counts: {}, failures: [], more: 0 });
    assert.equal(summarizeGate('✖ looks red but the process said 0', { exitCode: 0 }).ok, true);
  });

  it('names at most FAILURE_LINES lines and counts the rest', () => {
    const output = Array.from({ length: 30 }, (_, i) => `✖ test ${i}`).join('\n');
    const s = summarizeGate(output, { exitCode: 1 });
    assert.equal(s.failures.length, FAILURE_LINES);
    assert.equal(s.more, 30 - FAILURE_LINES);
  });
});

describe('gateLines', () => {
  it('green is one line and the log path; red names the failures; never more than the cap', () => {
    const green = gateLines({ ok: true, counts: { tests: 1992, fail: 0, skipped: 9 }, failures: [], more: 0 }, { command: 'npm test', seconds: 89, logPath: '/s/gate-1.log' });
    assert.equal(green, 'GREEN — npm test — 1992 tests, 0 failed, 9 skipped — 89s\nwhole output: /s/gate-1.log');
    const red = gateLines({ ok: false, counts: {}, failures: ['✖ a', '    f.js:3'], more: 2 }, { command: 'npm test', seconds: 5, logPath: '/s/g.log' });
    assert.equal(red, 'RED — npm test — no counts in the output — 5s\n✖ a\n    f.js:3\n… and 2 more failing lines\nwhole output: /s/g.log');
    const long = gateLines({ ok: false, counts: {}, failures: Array.from({ length: 20 }, (_, i) => `✖ ${'x'.repeat(200)} ${i}`), more: 0 }, { command: 'npm test', seconds: 5, logPath: '/s/g.log' });
    assert.ok(Buffer.byteLength(long) <= OUTPUT_CAP, `${Buffer.byteLength(long)} bytes`);
    assert.match(long, /capped at 2048 bytes\)\nwhole output: \/s\/g\.log$/u);
  });
});

describe('mc gate', () => {
  function io(shell, { manifest = { scripts: { test: 'node --test' } } } = {}) {
    const out = { stdout: '', stderr: '', written: {}, dirs: [] };
    const deps = {
      stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } },
      cwd: '/w/x', env: { MC_SCRATCH: '/scratch' }, now: () => new Date('2026-09-25T10:00:00Z'),
      git: (cwd, args) => (args[0] === 'rev-parse' ? '/w/x' : null),
      read: (path) => { if (path === '/w/x/package.json' && manifest) return JSON.stringify(manifest); throw new Error('ENOENT'); },
      shell: (command, opts) => { out.command = command; out.cwd = opts.cwd; return shell(command); },
      mkdir: (p) => out.dirs.push(p), write: (p, text) => { out.written[p] = text; },
    };
    return { out, deps };
  }

  it('runs the repository\'s command in the worktree root, writes the whole output under MC_SCRATCH, prints the verdict', async () => {
    const { out, deps } = io(() => ({ status: 0, stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n', stderr: '' }));
    assert.equal(await run([], deps), 0);
    assert.equal(out.command, 'npm test');
    assert.equal(out.cwd, '/w/x');
    assert.deepEqual(out.dirs, ['/scratch']);
    assert.deepEqual(Object.keys(out.written), ['/scratch/gate-20260925T100000Z.log']);
    assert.equal(out.stdout, 'GREEN — npm test — 3 tests, 0 failed — 0s\nwhole output: /scratch/gate-20260925T100000Z.log\n');
  });

  it('red is exit 1 with the failing lines; --json is the object; --base reaches the ci script', async () => {
    const { out, deps } = io(() => ({ status: 1, stdout: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n', stderr: 'boom' }), { manifest: { scripts: { ci: 'node ci.mjs' } } });
    assert.equal(await run(['--base', 'origin/dev'], deps), 1);
    assert.equal(out.command, 'npm run ci -- --base-ref origin/dev');
    assert.match(out.stdout, /^RED — npm run ci -- --base-ref origin\/dev — 1 tests, 1 failed — 0s\n✖ a\n/u);
    assert.match(out.written['/scratch/gate-20260925T100000Z.log'], /--- stderr ---\nboom/u);
    const j = io(() => ({ status: 1, stdout: '✖ a\n', stderr: '' }));
    assert.equal(await run(['--json'], j.deps), 1);
    const parsed = JSON.parse(j.out.stdout);
    assert.deepEqual([parsed.ok, parsed.failures, parsed.command, parsed.exit], [false, ['✖ a'], 'npm test', 1]);
  });

  it('is 2 outside a worktree, with nothing to run, and on a positional', async () => {
    const none = io(() => ({ status: 0, stdout: '', stderr: '' }), { manifest: { scripts: {} } });
    assert.equal(await run([], none.deps), 2);
    assert.match(none.out.stderr, /no ci or test script/u);
    const outside = io(() => ({ status: 0, stdout: '', stderr: '' }));
    outside.deps.git = () => null;
    assert.equal(await run([], outside.deps), 2);
    const pos = io(() => ({ status: 0, stdout: '', stderr: '' }));
    assert.equal(await run(['memoro'], pos.deps), 2);
  });
});
