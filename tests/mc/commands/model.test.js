import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run, usage } from '../../../src/mc/commands/model.js';
import { modelsPath } from '../../../src/mc/model-config.js';
import { runMc } from '../_helpers/cli.js';

const roots = [];

/** An isolated work root for one test: the catalog is written there and nowhere else. */
function isolated() {
  const root = mkdtempSync(join(tmpdir(), 'mc-model-cmd-'));
  roots.push(root);
  return { root, env: { MC_WORK_ROOT: root } };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One `mc model` call in-process, with its stdout and stderr captured. */
async function call(env, argv) {
  const out = [];
  const err = [];
  const status = await run(argv, {
    env,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
  });
  return { status, out: out.join(''), err: err.join('') };
}

describe('mc model list', () => {
  it('shows the defaults, by class and in order, and writes no file', async () => {
    const { env } = isolated();
    const { status, out } = await call(env, []);
    assert.equal(status, 0);
    assert.match(out, /\(defaults — no file there yet\)/u);
    assert.match(out, /fast\n {2}1 {2}claude:haiku:high\n {2}2 {2}codex:gpt-6-luna:high/u);
    assert.match(out, /large\n {2}1 {2}claude:opus:medium\n {2}2 {2}codex:gpt-6\.1-sol:high/u);
    assert.match(out, /review\n {2}claude:opus:high\n$/u);
    assert.equal(existsSync(modelsPath(env)), false);
  });

  it('--json says where the catalog came from, as data', async () => {
    const { env } = isolated();
    const { status, out } = await call(env, ['list', '--json']);
    const models = JSON.parse(out);
    assert.equal(status, 0);
    assert.equal(models.ok, true);
    assert.equal(models.source, 'defaults');
    assert.deepEqual(models.review, { tool: 'claude', model: 'opus', effort: 'high' });
    assert.equal(models.fast.length, 2);
  });
});

describe('mc model writes', () => {
  it('add appends, and the next list reads the file', async () => {
    const { env } = isolated();
    const added = await call(env, ['add', 'fast', 'codex:gpt-6-future:low']);
    assert.equal(added.status, 0);
    assert.match(added.out, /added codex:gpt-6-future:low to fast — fast is now claude:haiku:high, codex:gpt-6-luna:high, codex:gpt-6-future:low/u);
    const { out } = await call(env, ['--json']);
    const models = JSON.parse(out);
    assert.equal(models.source, 'config');
    assert.deepEqual(models.fast.at(-1), { tool: 'codex', model: 'gpt-6-future', effort: 'low' });
  });

  it('remove names exactly tool:model, and a class keeps its last candidate', async () => {
    const { env } = isolated();
    assert.equal((await call(env, ['remove', 'fast', 'claude:haiku'])).status, 0);
    const refused = await call(env, ['remove', 'fast', 'codex:gpt-6-luna']);
    assert.equal(refused.status, 1);
    assert.match(refused.err, /only fast candidate/u);
    const { out } = await call(env, ['list', '--json']);
    assert.deepEqual(JSON.parse(out).fast.map((value) => value.model), ['gpt-6-luna']);
  });

  it('set review replaces the review model', async () => {
    const { env } = isolated();
    const set = await call(env, ['set', 'review', 'codex:gpt-6.1-sol:xhigh']);
    assert.equal(set.status, 0);
    assert.equal(set.out, 'mc: review is now codex:gpt-6.1-sol:xhigh\n');
    const { out } = await call(env, ['list', '--json']);
    assert.deepEqual(JSON.parse(out).review, { tool: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  });

  it('a duplicate is refused with exit 1, and the file keeps its bytes', async () => {
    const { env } = isolated();
    await call(env, ['add', 'large', 'claude:sonnet-5-5:low']);
    const before = readFileSync(modelsPath(env), 'utf8');
    const refused = await call(env, ['add', 'large', 'claude:opus:low']);
    assert.equal(refused.status, 1);
    assert.match(refused.err, /large already has claude:opus at claude:opus:medium/u);
    assert.equal(readFileSync(modelsPath(env), 'utf8'), before);
  });
});

describe('mc model usage errors', () => {
  const misuse = [
    [['add', 'review', 'claude:opus:high'], /"review" is not a class/u],
    [['add', 'fast'], /mc model add fast\|large/u],
    [['remove', 'fast'], /mc model remove fast\|large/u],
    [['set', 'fast', 'claude:haiku:high'], /mc model set review/u],
    [['add', 'fast', 'claude:haiku:high', '--json'], /--json is for mc model list/u],
    [['list', 'extra'], /unexpected arg: extra/u],
    [['--bogus'], /unknown flag: --bogus/u],
    [['frobnicate'], /unknown model command "frobnicate"/u],
  ];

  for (const [argv, message] of misuse) {
    it(`mc model ${argv.join(' ')} is a usage error, exit 2`, async () => {
      const { env } = isolated();
      const { status, err } = await call(env, argv);
      assert.equal(status, 2);
      assert.match(err, message);
      assert.match(err, /usage — mc model/u);
    });
  }

  it('usage names every form of the command', () => {
    const text = usage();
    assert.match(text, /mc model \[list\] \[--json\]/u);
    assert.match(text, /mc model add fast\|large <tool>:<model>:<effort>/u);
    assert.match(text, /mc model remove fast\|large <tool>:<model>/u);
    assert.match(text, /mc model set review <tool>:<model>:<effort>/u);
  });
});

describe('mc model with a catalog it cannot read', () => {
  it('list and add both exit 1 with the path, and neither falls back to the defaults', async () => {
    const { env, root } = isolated();
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(modelsPath(env), '{ "schema": "mc-models", ');
    const listed = await call(env, ['list']);
    assert.equal(listed.status, 1);
    assert.ok(listed.err.includes(`${modelsPath(env)} is not JSON`), listed.err);
    assert.equal(listed.out, '');
    const added = await call(env, ['add', 'fast', 'codex:gpt-6-future:low']);
    assert.equal(added.status, 1);
    assert.equal(readFileSync(modelsPath(env), 'utf8'), '{ "schema": "mc-models", ');
  });
});

describe('mc model through the mc command line', () => {
  it('add, list --json and remove round-trip in an isolated root', () => {
    const { root } = isolated();
    const env = { MC_WORK_ROOT: root };
    const added = runMc(['model', 'add', 'large', 'claude:opus-9.1-preview:max'], { env });
    assert.equal(added.status, 0, added.stderr);
    const listed = runMc(['model', 'list', '--json'], { env });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).large.at(-1), { tool: 'claude', model: 'opus-9.1-preview', effort: 'max' });
    const removed = runMc(['model', 'remove', 'large', 'claude:opus-9.1-preview'], { env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(modelsPath(env), 'utf8')).large.map((value) => value.model), ['opus', 'gpt-6.1-sol']);
  });

  it('mc model --help prints the usage', () => {
    const help = runMc(['model', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /mc model set review <tool>:<model>:<effort>/u);
  });
});
