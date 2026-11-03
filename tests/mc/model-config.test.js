/**
 * The model catalog's review list (model-config.js) and the `mc model` verb
 * that changes it (commands/model.js), on a work root of its own in a tmpdir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modelsPath, readModels } from '../../src/mc/model-config.js';
import { run } from '../../src/mc/commands/model.js';

/** A work root whose models.json is `document` (none when null), and the verb run against it. */
function catalogAt(document) {
  const root = mkdtempSync(join(tmpdir(), 'mc-models-'));
  const env = { MC_WORK_ROOT: root };
  if (document) {
    mkdirSync(join(modelsPath(env), '..'), { recursive: true });
    writeFileSync(modelsPath(env), `${JSON.stringify(document, null, 2)}\n`);
  }
  const verb = async (...argv) => {
    let out = '';
    let err = '';
    const code = await run(argv, { env, stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } } });
    return { code, out, err };
  };
  const file = () => JSON.parse(readFileSync(modelsPath(env), 'utf8'));
  return { env, verb, file, done: () => rmSync(root, { recursive: true, force: true }) };
}

const LISTS = {
  fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }],
  large: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
};
const OLD = { schema: 'mc-models', version: 1, ...LISTS, review: { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' } };

test('a catalog whose review is one object reads as a list of it, and is written back as a list only when changed', async () => {
  const c = catalogAt(OLD);
  try {
    assert.deepEqual(readModels(c.env).review, [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    const listed = await c.verb('list');
    assert.equal(listed.code, 0);
    assert.match(listed.out, /\nreview\n {2}1 {2}codex:gpt-6\.1-sol:high\n$/u);
    assert.deepEqual(c.file().review, OLD.review, 'reading leaves the file as it was');

    assert.equal((await c.verb('add', 'review', 'claude:opus:high')).code, 0);
    assert.deepEqual(c.file().review, [OLD.review, { tool: 'claude', model: 'opus', effort: 'high' }]);
  } finally {
    c.done();
  }
});

test('mc model add and remove review change the list as they do fast and large; set review replaces it whole', async () => {
  const c = catalogAt(null);
  try {
    const added = await c.verb('add', 'review', 'codex:gpt-6.1-sol:high');
    assert.equal(added.code, 0, added.err);
    assert.equal(added.out, 'mc: added codex:gpt-6.1-sol:high to review — review is now claude:opus:high, codex:gpt-6.1-sol:high\n');
    assert.match((await c.verb('list')).out, /\nreview\n {2}1 {2}claude:opus:high\n {2}2 {2}codex:gpt-6\.1-sol:high\n$/u);

    const twice = await c.verb('add', 'review', 'codex:gpt-6.1-sol:low');
    assert.equal(twice.code, 1);
    assert.match(twice.err, /review already has codex:gpt-6\.1-sol/u);

    const removed = await c.verb('remove', 'review', 'claude:opus');
    assert.equal(removed.code, 0, removed.err);
    assert.deepEqual(c.file().review, [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    const last = await c.verb('remove', 'review', 'codex:gpt-6.1-sol');
    assert.equal(last.code, 1);
    assert.match(last.err, /the only review candidate, and review needs one/u);

    await c.verb('add', 'review', 'claude:opus:high');
    const set = await c.verb('set', 'review', 'claude:fable:high');
    assert.equal(set.code, 0, set.err);
    assert.equal(set.out, 'mc: review is now claude:fable:high alone\n');
    assert.deepEqual(c.file().review, [{ tool: 'claude', model: 'fable', effort: 'high' }]);
    assert.deepEqual(c.file().fast, readModels(c.env).fast, 'the classes are untouched');

    const unknown = await c.verb('add', 'slow', 'claude:opus:high');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /"slow" is not a list: add takes fast, large or review/u);
  } finally {
    c.done();
  }
});

test('a review list that is empty or repeats a model is refused, not read as the defaults', () => {
  for (const [review, why] of [[[], /review: a list of at least one candidate/u], [[OLD.review, OLD.review], /review: codex:gpt-6\.1-sol is listed twice/u]]) {
    const c = catalogAt({ ...OLD, review });
    try {
      assert.throws(() => readModels(c.env), why);
    } finally {
      c.done();
    }
  }
});
