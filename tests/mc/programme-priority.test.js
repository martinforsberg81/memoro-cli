import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/mc/commands/programs.js';
import { readProgrammes } from '../../src/mc/page-collect.js';
import { PRIORITY_FILE, readProgrammePriority } from '../../src/mc/programme-priority.js';
import { beginBackup } from '../../src/mc/programme-lifecycle.js';
import { goalJson } from './_helpers/goal-file.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-priority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_HOME: join(root, 'state'), MC_WORK_ROOT: root };
  const home = join(root, 'programs');
  for (const name of ['alpha', 'beta', 'untouched']) {
    const dir = join(home, name, 'goals', 'first');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), goalJson());
  }
  const read = () => readProgrammes({ env, repos: [], alive: () => false });
  let out = ''; let err = '';
  const command = (args) => run(args, {
    env, read, stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } },
  });
  return { home, env, read, command, output: () => out, errors: () => err };
}

test('programme priority: real command persists several preferences, preserves others, exposes JSON and resets', async (t) => {
  const f = fixture(t);
  assert.equal(readProgrammePriority('alpha', { home: f.home }), 0);
  assert.equal(await f.command(['priority', 'untouched', '--set', '3']), 0);
  assert.equal(await f.command(['priority', 'alpha', 'beta', '--set', '10']), 0);
  assert.equal(readProgrammePriority('alpha', { home: f.home }), 10);
  assert.equal(readProgrammePriority('beta', { home: f.home }), 10);
  assert.equal(readProgrammePriority('untouched', { home: f.home }), 3);
  assert.deepEqual(f.read().section.programmes.map((item) => [item.programme, item.priority]), [['alpha', 10], ['beta', 10], ['untouched', 3]]);
  assert.match(f.output(), /alpha: priority 10\nbeta: priority 10/u);
  assert.equal(await f.command(['priority', 'alpha', '--set', '0']), 0);
  assert.equal(readProgrammePriority('alpha', { home: f.home }), 0);
  assert.equal(readProgrammePriority('beta', { home: f.home }), 10);
  const offset = f.output().length;
  assert.equal(await f.command(['list', '--json']), 0);
  assert.deepEqual(JSON.parse(f.output().slice(offset)).programmes.map((item) => [item.name, item.priority]), [['alpha', 0], ['beta', 10], ['untouched', 3]]);
  assert.equal(f.errors(), '');
});

test('programme priority: bad values, missing arguments and unknown programmes refuse before any write', async (t) => {
  const f = fixture(t);
  await f.command(['priority', 'alpha', '--set', '4']);
  const before = readFileSync(join(f.home, 'alpha', PRIORITY_FILE), 'utf8');
  for (const args of [
    ['alpha', '--set', '-1'], ['alpha', '--set', '1.5'], ['alpha', '--set', '9007199254740992'],
    ['alpha', '--set', 'NaN'], ['alpha', '--set', ''], ['alpha', '--set'], ['alpha'], ['--set', '1'],
    ['alpha', 'missing', '--set', '20'], ['alpha', '../escape', '--set', '20'],
  ]) {
    assert.equal(await f.command(['priority', ...args]), 2, args.join(' '));
    assert.equal(readFileSync(join(f.home, 'alpha', PRIORITY_FILE), 'utf8'), before);
  }
});

test('programme priority: malformed or absent files use zero without changing the files', (t) => {
  const f = fixture(t);
  const path = join(f.home, 'alpha', PRIORITY_FILE);
  for (const text of ['broken', 'null', '{}', '{"priority":-1}', '{"priority":"10"}', '{"priority":1.5}']) {
    writeFileSync(path, text);
    assert.equal(readProgrammePriority('alpha', { home: f.home }), 0);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('programme priority: a selected draining programme refuses the real priority write while unrelated work stays writable', async (t) => {
  const f = fixture(t);
  const alphaPath = join(f.home, 'alpha', PRIORITY_FILE);
  const betaPath = join(f.home, 'beta', PRIORITY_FILE);
  writeFileSync(alphaPath, '{"priority":1}\n');
  writeFileSync(betaPath, '{"priority":2}\n');
  const before = readFileSync(alphaPath, 'utf8');
  beginBackup(['alpha'], { env: f.env });
  assert.equal(await f.command(['priority', 'alpha', '--set', '8']), 1);
  assert.equal(readFileSync(alphaPath, 'utf8'), before);
  assert.equal(await f.command(['priority', 'beta', '--set', '9']), 0);
  assert.equal(readProgrammePriority('beta', { home: f.home }), 9);
});
