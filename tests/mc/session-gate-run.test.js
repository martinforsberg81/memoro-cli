import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runSessionGate, selectorCommand } from '../../src/mc/session-gate-run.js';

const GREEN = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n';

it('the automatic gate runs affected tests and command gates, including a project larger than 30 files', async () => {
  const files = Array.from({ length: 42 }, (_, i) => `tests/${i}.test.js`);
  const classes = { [files[0]]: 'heavy' };
  const calls = [];
  const result = await runSessionGate({ cwd: '/work', select: 'selector', base: 'origin/dev' }, {
    write: () => {},
    select: async () => ({ ok: true, files, classes, commands: [{ packageScript: 'lint', passBaseRef: true }] }),
    tests: async (args) => { calls.push(args); return { tap: GREEN, code: 0 }; },
    shell: async (cmd) => { calls.push(cmd); return { status: 1, stderr: 'broken contract' }; },
  });
  assert.deepEqual(calls[0].files, files);
  assert.deepEqual(calls[0].classes, classes);
  assert.equal(calls[1], "npm run 'lint' -- --base-ref 'origin/dev'");
  assert.equal(result.ok, false);
});

it('an empty, failed or invalid selection never reports green', async () => {
  for (const selected of [{ ok: true, files: [] }, { ok: false, reason: 'unmapped path' }, { ok: true, files: ['../outside.test.js'] }]) {
    const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: () => {}, select: async () => selected, tests: () => { throw new Error('must not run'); },
    });
    assert.equal(result.ok, false);
  }
});

it('a nonzero test process is not green just because it printed passing counts', async () => {
  const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
    write: () => {}, tests: async () => ({ tap: GREEN, code: 1 }),
  });
  assert.equal(result.ok, false);
});

it('new untracked tests are included even when the selector only knows tracked files', async () => {
  let files;
  const result = await runSessionGate({ cwd: '/work', select: 'selector', addedTests: ['new.test.js'] }, {
    write: () => {}, select: async () => ({ ok: true, files: ['old.test.js'], commands: [] }),
    tests: async (args) => { files = args.files; return { tap: GREEN, code: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(files, ['old.test.js', 'new.test.js']);
});

it('an interruption cannot become green even if a child reports success', async () => {
  const controller = new AbortController();
  const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
    write: () => {}, signal: controller.signal,
    tests: async () => { controller.abort(); return { tap: GREEN, code: 0 }; },
  });
  assert.equal(result.ok, false);
});

it('test-name filters reach node as flags, before the test paths', async () => {
  let args;
  await runSessionGate({ cwd: '/work', files: ['a.test.js'], pattern: 'one|two', flags: ['--import', './loader.mjs'] }, {
    write: () => {}, tests: async (value) => { args = value; return { tap: GREEN, code: 0 }; },
  });
  assert.deepEqual(args.flags, ['--import', './loader.mjs', '--test-name-pattern=one|two']);
});

it('selection replaces the old base and quotes every changed path', () => {
  assert.equal(selectorCommand('node select.js --base-ref origin/main', { base: 'origin/topic', changed: ["src/it's.js", 'src/new.js'] }),
    "node select.js --base-ref 'origin/topic' --changed-path 'src/it'\\''s.js' --changed-path 'src/new.js'");
});
