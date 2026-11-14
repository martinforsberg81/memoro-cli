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
const BEFORE_MEDIUM = {
  schema: 'mc-models', version: 1,
  fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }],
  large: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
  review: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
  finish: [{ tool: 'claude', model: 'opus', effort: 'high' }],
  mend: [{ tool: 'claude', model: 'sonnet', effort: 'medium' }],
  plan: [{ tool: 'claude', model: 'opus', effort: 'high' }],
  manager: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
};

test('a catalog whose review is one object reads as a list of it, and is written back as a list only when changed', async () => {
  const c = catalogAt(OLD);
  try {
    assert.deepEqual(readModels(c.env).review, [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    const listed = await c.verb('list');
    assert.equal(listed.code, 0);
    assert.match(listed.out, /\nreview\n {2}1 {2}codex:gpt-6\.1-sol:high\nfinish\n/u);
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
    assert.equal((await c.verb('remove', 'review', 'codex:gpt-6.1-sol')).code, 0);
    const added = await c.verb('add', 'review', 'codex:gpt-6.1-sol:high');
    assert.equal(added.code, 0, added.err);
    assert.equal(added.out, 'mc: added codex:gpt-6.1-sol:high to review — review is now claude:opus:medium, codex:gpt-6.1-sol:high\n');
    assert.match((await c.verb('list')).out, /\nreview\n {2}1 {2}claude:opus:medium\n {2}2 {2}codex:gpt-6\.1-sol:high\nfinish\n/u);

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
    assert.match(unknown.err, /"slow" is not a list: add takes fast, medium, large, review, finish, mend, plan, manager/u);
  } finally {
    c.done();
  }
});

test('a file without the role lists reads them as the defaults; mc model lists every list and writes them back on a change', async () => {
  const c = catalogAt({ ...OLD, review: [OLD.review] });
  try {
    const models = readModels(c.env);
    assert.deepEqual(models.finish, [{ tool: 'claude', model: 'opus', effort: 'high' }, { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    assert.deepEqual(models.mend, [{ tool: 'claude', model: 'sonnet', effort: 'medium' }, { tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }]);
    assert.deepEqual(models.plan, [{ tool: 'claude', model: 'opus', effort: 'high' }, { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    assert.deepEqual(models.manager, [{ tool: 'claude', model: 'opus', effort: 'medium' }, { tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }]);
    const listed = (await c.verb('list')).out;
    for (const list of ['fast', 'medium', 'large', 'review', 'finish', 'mend', 'plan', 'manager']) assert.match(listed, new RegExp(`\\n${list}\\n {2}1 `, 'u'));
    assert.equal(c.file().finish, undefined, 'reading writes nothing');

    const set = await c.verb('set', 'finish', 'codex:gpt-6.1-sol:high');
    assert.equal(set.code, 0, set.err);
    assert.equal(set.out, 'mc: finish is now codex:gpt-6.1-sol:high alone\n');
    assert.deepEqual(c.file().finish, [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    assert.deepEqual(c.file().mend, models.mend, 'a change writes every list');
    assert.equal((await c.verb('add', 'manager', 'claude:sonnet:high')).code, 0);
    assert.equal((await c.verb('remove', 'manager', 'claude:opus')).code, 0);
    assert.deepEqual(c.file().manager.map((item) => item.model), ['gpt-6.1-sol', 'sonnet']);
    const classSet = await c.verb('set', 'fast', 'claude:opus:high');
    assert.equal(classSet.code, 2);
    assert.match(classSet.err, /mc model set review\|finish\|mend\|plan\|manager/u);
  } finally {
    c.done();
  }
  const bad = catalogAt({ ...OLD, finish: [] });
  try {
    assert.throws(() => readModels(bad.env), /finish: a list of at least one candidate/u);
  } finally {
    bad.done();
  }
});

test('a pre-medium catalog reads the two medium defaults unchanged, then writes every list when medium changes', async () => {
  const c = catalogAt(BEFORE_MEDIUM);
  try {
    const original = readFileSync(modelsPath(c.env), 'utf8');
    const models = readModels(c.env);
    assert.deepEqual(models.medium, [
      { tool: 'claude', model: 'sonnet', effort: 'high' },
      { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' },
    ]);
    const listed = await c.verb('list');
    assert.equal(listed.code, 0, listed.err);
    assert.ok(listed.out.indexOf('\nfast\n') < listed.out.indexOf('\nmedium\n'));
    assert.ok(listed.out.indexOf('\nmedium\n') < listed.out.indexOf('\nlarge\n'));
    assert.match(listed.out, /\nmedium\n  1  claude:sonnet:high\n  2  codex:gpt-6\.1-terra:high\n/u);
    assert.equal(readFileSync(modelsPath(c.env), 'utf8'), original, 'reading the old file does not rewrite it');

    const added = await c.verb('add', 'medium', 'codex:gpt-6-luna:high');
    assert.equal(added.code, 0, added.err);
    assert.deepEqual(c.file().medium.map(({ tool, model, effort }) => ({ tool, model, effort })), [
      { tool: 'claude', model: 'sonnet', effort: 'high' },
      { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' },
      { tool: 'codex', model: 'gpt-6-luna', effort: 'high' },
    ]);
    for (const key of ['fast', 'large', 'review', 'finish', 'mend', 'plan', 'manager']) assert.deepEqual(c.file()[key], BEFORE_MEDIUM[key]);
    assert.equal((await c.verb('remove', 'medium', 'codex:gpt-6-luna')).code, 0);
    assert.deepEqual(c.file().medium.map((candidate) => candidate.model), ['sonnet', 'gpt-6.1-terra']);
    const set = await c.verb('set', 'medium', 'claude:opus:high');
    assert.equal(set.code, 2);
    assert.match(set.err, /mc model set review\|finish\|mend\|plan\|manager/u);
  } finally { c.done(); }
});

test('an absent catalog has the same ordered medium defaults', () => {
  const c = catalogAt(null);
  try {
    assert.deepEqual(readModels(c.env).medium, [
      { tool: 'claude', model: 'sonnet', effort: 'high' },
      { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' },
    ]);
  } finally { c.done(); }
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

test('provider priority reads as auto, roundtrips reversibly, and catalog edits preserve it and every list', async () => {
  const c = catalogAt(OLD);
  try {
    assert.equal(readModels(c.env).providerPriority, 'auto');
    for (const priority of ['codex', 'claude', 'auto']) {
      const set = await c.verb('priority', priority);
      assert.equal(set.code, 0, set.err);
      assert.equal(set.out, `provider priority: ${priority}\n`);
      assert.equal(readModels(c.env).providerPriority, priority);
      assert.equal((await c.verb('priority')).out, `provider priority: ${priority}\n`);
      const listed = JSON.parse((await c.verb('list', '--json')).out);
      assert.equal(listed.providerPriority, priority);
      assert.equal(c.file().provider_priority, priority);
    }
    const before = c.file();
    assert.equal((await c.verb('priority', 'nobody')).code, 2);
    assert.deepEqual(c.file(), before, 'invalid command does not modify the file');
    await c.verb('add', 'fast', 'codex:gpt-6-luna:high');
    await c.verb('remove', 'fast', 'codex:gpt-6-luna');
    await c.verb('set', 'review', 'claude:opus:high');
    assert.equal(c.file().provider_priority, 'auto');
    assert.deepEqual(c.file().large, before.large);
    assert.deepEqual(c.file().fast, before.fast);
  } finally { c.done(); }
});

test('an invalid persisted provider priority is refused without replacing the catalog', async () => {
  const invalid = { ...OLD, provider_priority: 'openai' };
  const c = catalogAt(invalid);
  try {
    const before = readFileSync(modelsPath(c.env), 'utf8');
    assert.throws(() => readModels(c.env), /provider_priority: one of auto, codex, claude/u);
    const refusal = await c.verb('priority', 'claude');
    assert.equal(refusal.code, 1);
    assert.equal(readFileSync(modelsPath(c.env), 'utf8'), before);
  } finally { c.done(); }
});
