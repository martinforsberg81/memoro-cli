/**
 * `mc layout` names the layout and its three roots; `mc layout migrate`, the
 * one-time move to layout 2, is gone and says so.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { run } from '../../src/mc/commands/layout.js';

const root = mkdtempSync(join(tmpdir(), 'mc-layout-'));
after(() => rmSync(root, { recursive: true, force: true }));

async function verb(argv) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    root, home: root,
    stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } },
  });
  return { code, out, err };
}

test('mc layout names layout 1 and its three roots, and no register', async () => {
  const { code, out } = await verb([]);
  assert.equal(code, 0);
  assert.equal(out.split('\n')[0], 'layout 1');
  assert.match(out, /planning sessions {2}~\/plan\n/u);
  assert.match(out, /step areas {9}~\/step\n/u);
  assert.doesNotMatch(out, /registers/u);
});

test('in layout 2 the step areas are under runner/, and --json says the same', async () => {
  mkdirSync(join(root, 'runner'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  const shown = await verb([]);
  assert.equal(shown.out.split('\n')[0], 'layout 2');
  assert.match(shown.out, /step areas {9}~\/runner\/step\n/u);
  const json = JSON.parse((await verb(['--json'])).out);
  assert.deepEqual(Object.keys(json), ['layout', 'planAreaRoot', 'stepAreaRoot', 'depsRoot']);
  assert.equal(json.layout, 2);
});

test('migrate says it is gone, and a stray word or --apply is refused', async () => {
  const migrate = await verb(['migrate']);
  assert.equal(migrate.code, 2);
  assert.match(migrate.err, /mc layout migrate is gone/u);
  assert.equal((await verb(['move'])).code, 2);
  assert.equal((await verb(['--apply'])).code, 2);
});
