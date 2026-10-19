import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from '../../../src/mc/commands/project.js';
import { parseEntry, registerPath } from '../../../src/mc/register.js';

const ROOT = '/work';

function fixture(env = {}) {
  const files = {
    [registerPath(ROOT, 'p')]: JSON.stringify({
      project: 'p', repo: 'memoro', steps: [{ key: 'A', status: 'running' }],
      criteria: [{ criterion: 'a', met: false, at: null }, { criterion: 'b', met: false, at: null }],
    }),
  };
  const out = []; const err = [];
  const deps = {
    root: ROOT, env, now: () => new Date('2026-09-18T10:00:00Z'),
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
    read: (path) => files[path] ?? null,
    write: (path, value) => { files[path] = JSON.stringify(value); },
    lock: (_root, fn) => fn(),
  };
  return { deps, out, err, entry: () => parseEntry(files[registerPath(ROOT, 'p')]) };
}

test('criterion met and unmet write the register through updateCriterion, at the injected now', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'p', '2'], f.deps), 0);
  assert.equal(f.entry().criteria[1].met, true);
  assert.equal(f.entry().criteria[1].at, '2026-09-18T10:00:00Z');
  assert.equal(f.entry().criteria[0].met, false);
  assert.equal(f.out.join(''), 'mc: p criterion 2 — met\n');

  assert.equal(await run(['criterion', 'unmet', 'p', '2'], f.deps), 0);
  assert.equal(f.entry().criteria[1].met, false);
  assert.equal(f.out.join(''), 'mc: p criterion 2 — met\nmc: p criterion 2 — not met\n');
});

test('criterion with <n> alone takes its project from MC_STEP', async () => {
  const f = fixture({ MC_STEP: 'p:0' });
  assert.equal(await run(['criterion', 'met', '1'], f.deps), 0);
  assert.equal(f.entry().criteria[0].met, true);
});

test('criterion with <n> alone and no MC_STEP says which project, and writes nothing', async () => {
  const f = fixture({});
  assert.equal(await run(['criterion', 'met', '1'], f.deps), 2);
  assert.match(f.err.join(''), /which project\?/u);
  assert.equal(f.entry().criteria[0].met, false);
});

test('criterion refuses a number that is not one, and a criterion the register does not hold', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'p', 'x'], f.deps), 2);
  assert.match(f.err.join(''), /x is not a criterion number — 1 is the plan's first/u);

  assert.equal(await run(['criterion', 'met', 'p', '3'], f.deps), 1);
  assert.match(f.err.join(''), /no success criterion 3/u);
  assert.equal(f.entry().criteria.every((c) => c.met === false), true);
});

test('criterion names a project the register does not hold, and exits 1', async () => {
  const f = fixture();
  assert.equal(await run(['criterion', 'met', 'nope', '1'], f.deps), 1);
  assert.match(f.err.join(''), /mc: nope is not in the register/u);
});

test('anything but criterion met or unmet is usage, exit 2', async () => {
  const f = fixture();
  assert.equal(await run(['frobnicate'], f.deps), 2);
  assert.equal(await run(['criterion'], f.deps), 2);
  assert.match(f.err.join(''), /^usage/u);
  assert.equal(f.out.length, 0);
});
