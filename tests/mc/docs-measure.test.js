/**
 * The documents' measure — what it runs on a candidate, and what it says about it.
 *
 * Every step is a fake here: no git, no test run, no npm. What is asserted is
 * the order the steps run in, which step stops the measure and how it is named,
 * and that the candidate is taken away whatever happened to it. The selector
 * and the TAP reading have their own tests; this one only needs their answers.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { measureDocs } from '../../src/mc/docs-measure.js';
import { repoFileSlug } from '../../src/mc/repo-snapshot.js';

const GATE = mkdtempSync(join(tmpdir(), 'docs-measure-'));
const REPO = '/repos/memoro';
const PR = 14188;
const DIR = join(GATE, repoFileSlug(REPO), `docs-${PR}`);
const FILES = ['tests/docs/doc-links.test.js', 'tests/docs/msr.test.js'];

const GREEN = 'TAP version 13\n# Subtest: a\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 0';
const RED = 'TAP version 13\nnot ok 1 - tests/docs/doc-links.test.js\n1..1\n# tests 1\n# pass 0\n# fail 1';
const UNFINISHED = 'TAP version 13\n# Subtest: a\nnot ok 1 - a\n';
const OK = { status: 0, stdout: '', stderr: '' };
const DECLARED = { ok: true, declaration: { select: 'npm run select:docs', pr_tests_flags: ['--import', './tests/_isolate-home.mjs'] } };
const SELECTED = { ok: true, files: FILES, commands: [] };

after(() => rmSync(GATE, { recursive: true, force: true }));

function recorder() {
  return { git: [], shell: [], select: [], tests: [], prepare: [], say: [] };
}

/** A git that records its calls and makes the candidate's directory, as `worktree add` does. */
function gitWith(log, answer = () => null) {
  return async (args, { cwd }) => {
    log.git.push({ args, cwd });
    if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[3], { recursive: true });
    return answer(args) || OK;
  };
}

function fakes(log) {
  return {
    declaration: () => DECLARED,
    git: gitWith(log),
    shell: async (command, { cwd }) => { log.shell.push({ command, cwd }); return OK; },
    select: async (args) => { log.select.push(args); return SELECTED; },
    tests: async (args) => { log.tests.push(args); return { tap: GREEN, timedOut: false }; },
    prepare: async (args) => { log.prepare.push(args); return { status: 0, stderr: '', cached: false }; },
    cacheDir: join(GATE, 'cache'),
    gateDir: GATE,
    clock: () => 0,
    takeLane: async () => {},
    releaseLane: () => {},
    outputDir: join(GATE, 'output'),
  };
}

function measure(log, overrides = {}) {
  return measureDocs({
    repoPath: REPO,
    pr: PR,
    headSha: 'f00ba4',
    headRef: 'docs/msr',
    base: 'main',
    say: (line) => log.say.push(line),
    deps: { ...fakes(log), ...overrides },
  });
}

describe('measureDocs — the tests the selector draws for a documents-only pull request', () => {
  it('reserves its declared lane before preparation and releases it after cleanup, even on failure', async () => {
    const log = recorder();
    const events = [];
    const result = await measure(log, {
      declaration: () => ({ ok: true, declaration: { select: 'select', gate_lane: 'light' } }),
      takeLane: async ({ lane }) => { assert.equal(lane, 'light'); events.push('reserved'); },
      select: async () => { assert.deepEqual(events, ['reserved']); throw new Error('selector crashed'); },
      releaseLane: ({ lane }) => { assert.equal(lane, 'light'); assert.equal(existsSync(DIR), false); events.push('released'); },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(events, ['reserved', 'released']);
  });

  it('keeps assertion diagnostics and the raw output after removing the candidate', async () => {
    const log = recorder();
    const tap = `TAP version 13
not ok 1 - a link resolves
  ---
  location: 'tests/docs/doc-links.test.js:12:3'
  failureType: 'testCodeFailure'
  error: 'missing docs/target.md'
  ...
1..1
# tests 1
# pass 0
# fail 1
`;
    const result = await measure(log, { tests: async () => ({ tap, code: 1 }) });
    assert.equal(result.ok, false);
    assert.equal(existsSync(DIR), false);
    assert.match(readFileSync(result.log, 'utf8'), /missing docs\/target.md/u);
    assert.deepEqual(result.red_files, [FILES[0]]);
    assert.equal(result.red_tests[0].file, FILES[0]);
    assert.match(result.red_tests[0].error.join('\n'), /missing docs\/target.md/u);
  });

  it('a declaration with no select measures nothing, and makes no candidate', async () => {
    const log = recorder();
    const result = await measure(log, { declaration: () => ({ ok: true, declaration: {} }) });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'no select declared — nothing to measure');
    assert.equal(result.files, 0);
    assert.deepEqual(log.git, []);
  });

  it('a declaration that is not ok stops before anything else', async () => {
    const log = recorder();
    const result = await measure(log, { declaration: () => ({ ok: false, reason: 'the table cannot be read' }) });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'declaration');
    assert.equal(result.reason, 'the table cannot be read');
    assert.deepEqual(log.git, []);
  });

  it('a red test stops the merge, names it, and takes the candidate away', async () => {
    const log = recorder();
    const result = await measure(log, { tests: async (args) => { log.tests.push(args); return { tap: RED, timedOut: false }; } });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'red');
    assert.equal(result.reason, '1 test(s) red: tests/docs/doc-links.test.js');
    assert.equal(result.files, 2);
    assert.deepEqual(result.red, ['tests/docs/doc-links.test.js']);
    assert.deepEqual(result.commands, []);
    assert.equal(log.tests[0].cwd, DIR);
    assert.deepEqual(log.tests[0].files, FILES);
    assert.deepEqual(log.tests[0].flags, ['--import', './tests/_isolate-home.mjs']);
    assert.deepEqual(log.git.at(-1), { args: ['worktree', 'remove', '--force', DIR], cwd: REPO });
    assert.equal(existsSync(DIR), false);
  });

  it('all green is ok, with the files it ran', async () => {
    const log = recorder();
    const result = await measure(log);
    assert.equal(result.ok, true);
    assert.equal(result.stopped_at, null);
    assert.equal(result.reason, null);
    assert.equal(result.files, 2);
    assert.deepEqual(result.red, []);
    assert.deepEqual(result.commands, []);
    assert.equal(log.tests.length, 1);
    assert.equal(existsSync(DIR), false);
  });

  it('a merge that does not go clean stops before the selection', async () => {
    const log = recorder();
    const result = await measure(log, {
      git: gitWith(log, (args) => (args[0] === 'merge' ? { status: 1, stderr: 'CONFLICT (content)' } : null)),
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'merge');
    assert.equal(result.reason, '#14188 does not merge cleanly with main — merge main in and push');
    assert.equal(log.select.length, 0);
    assert.equal(log.tests.length, 0);
    assert.equal(existsSync(DIR), false);
  });

  it('a prepare that fails stops before the selection, and every line it says carries the prefix', async () => {
    const log = recorder();
    const result = await measure(log, {
      declaration: () => ({ ok: true, declaration: { select: 'npm run select:docs', prepare: 'npm ci' } }),
      prepare: async (args) => {
        log.prepare.push(args);
        args.say('prepare: cache miss');
        return { status: 1, stderr: 'npm ERR! lock is out of date', cached: false };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'prepare');
    assert.equal(result.reason, 'npm ci failed in the candidate — npm ERR! lock is out of date');
    assert.equal(log.prepare[0].headDir, DIR);
    assert.equal(log.select.length, 0);
    assert.ok(log.say.length > 0);
    assert.ok(log.say.every((line) => line.startsWith("documents' tests: ")));
  });

  it('a selected command that exits 1 is red, and is named', async () => {
    const log = recorder();
    const result = await measure(log, {
      select: async (args) => {
        log.select.push(args);
        return { ok: true, files: [FILES[0]], commands: [{ id: 'i18n', packageScript: 'i18n:check', passBaseRef: true, unavailableExitCode: null }] };
      },
      shell: async (command, { cwd }) => { log.shell.push({ command, cwd }); return { status: 1, stderr: '' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'red');
    assert.equal(result.reason, 'command gate(s) failed: i18n');
    assert.deepEqual(result.commands, ['i18n']);
    assert.deepEqual(result.red, []);
    assert.equal(log.shell[0].command, 'npm run i18n:check -- --base-ref origin/main');
    assert.equal(log.shell[0].cwd, DIR);
  });

  it('a selected command that exits its unavailable code is not red', async () => {
    const log = recorder();
    const result = await measure(log, {
      select: async (args) => {
        log.select.push(args);
        return { ok: true, files: [], commands: [{ id: 'pg', packageScript: 'sql:reference:postgres', passBaseRef: false, unavailableExitCode: 69 }] };
      },
      shell: async (command, { cwd }) => { log.shell.push({ command, cwd }); return { status: 69, stderr: '' }; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.commands, []);
    assert.equal(log.tests.length, 0);
  });

  it('a selection that fails stops with its reason', async () => {
    const log = recorder();
    const result = await measure(log, {
      select: async (args) => { log.select.push(args); return { ok: false, reason: 'npm run select:docs failed in the candidate — boom' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'selection');
    assert.equal(result.reason, 'npm run select:docs failed in the candidate — boom');
    assert.equal(log.tests.length, 0);
  });

  it('a run that never reached its summary is not green', async () => {
    const log = recorder();
    const result = await measure(log, { tests: async (args) => { log.tests.push(args); return { tap: UNFINISHED, timedOut: false }; } });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'suite');
    assert.equal(result.reason, "the documents' tests never reached their summary");
  });

  it('a run that timed out is not green', async () => {
    const log = recorder();
    const result = await measure(log, { tests: async (args) => { log.tests.push(args); return { tap: '', timedOut: true }; } });
    assert.equal(result.ok, false);
    assert.equal(result.stopped_at, 'suite');
    assert.equal(result.reason, "the documents' tests ran past their time");
  });

  it('seconds is the clock\'s elapsed time, in whole seconds', async () => {
    const ticks = [0, 7400];
    const log = recorder();
    const result = await measure(log, { clock: () => ticks.shift() });
    assert.equal(result.seconds, 7);
  });
});
