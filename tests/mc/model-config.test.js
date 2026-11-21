/**
 * The model catalog's review list (model-config.js) and the `mc model` verb
 * that changes it (commands/model.js), on a work root of its own in a tmpdir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const OLD = { schema: 'mc-models', version: 1, ...LISTS, review: { tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' } };
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
    assert.deepEqual(readModels(c.env).review, [{ tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    const listed = await c.verb('list');
    assert.equal(listed.code, 0);
    assert.match(listed.out, /\nreview\n {2}1 {2}codex:gpt-6\.2-sol:high\nfinish\n/u);
    assert.deepEqual(c.file().review, OLD.review, 'reading leaves the file as it was');

    assert.equal((await c.verb('add', 'review', 'claude:opus:high')).code, 0);
    assert.deepEqual(c.file().review, [OLD.review, { tool: 'claude', model: 'opus', effort: 'high' }]);
  } finally {
    c.done();
  }
});

test('mc model add and remove review change the list as they do build; set review replaces it whole', async () => {
  const c = catalogAt(null);
  try {
    assert.equal((await c.verb('remove', 'review', 'agy:gemini-4-argon-high')).code, 0);
    assert.equal((await c.verb('remove', 'review', 'codex:gpt-6.2-sol')).code, 0);
    const added = await c.verb('add', 'review', 'codex:gpt-6.2-sol:high');
    assert.equal(added.code, 0, added.err);
    assert.equal(added.out, 'mc: added codex:gpt-6.2-sol:high to review — review is now claude:opus:medium, codex:gpt-6.2-sol:high\n');
    assert.match((await c.verb('list')).out, /\nreview\n {2}1 {2}claude:opus:medium\n {2}2 {2}codex:gpt-6\.2-sol:high\nfinish\n/u);

    const twice = await c.verb('add', 'review', 'codex:gpt-6.2-sol:low');
    assert.equal(twice.code, 1);
    assert.match(twice.err, /review already has codex:gpt-6\.2-sol/u);

    const removed = await c.verb('remove', 'review', 'claude:opus');
    assert.equal(removed.code, 0, removed.err);
    assert.deepEqual(c.file().review, [{ tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    const last = await c.verb('remove', 'review', 'codex:gpt-6.2-sol');
    assert.equal(last.code, 1);
    assert.match(last.err, /the only review candidate, and review needs one/u);

    await c.verb('add', 'review', 'claude:opus:high');
    const set = await c.verb('set', 'review', 'claude:fable:high');
    assert.equal(set.code, 0, set.err);
    assert.equal(set.out, 'mc: review is now claude:fable:high alone\n');
    assert.deepEqual(c.file().review, [{ tool: 'claude', model: 'fable', effort: 'high' }]);
    assert.deepEqual(c.file().build, readModels(c.env).build, 'the build list is untouched');

    const unknown = await c.verb('add', 'slow', 'claude:opus:high');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /"slow" is not a list: add takes build, review, finish, mend, plan, manager/u);
  } finally {
    c.done();
  }
});

test('a file without the role lists reads them as the defaults; mc model lists every list and writes them back on a change', async () => {
  const c = catalogAt({ ...OLD, review: [OLD.review] });
  try {
    const models = readModels(c.env);
    assert.deepEqual(models.finish, [{ tool: 'claude', model: 'opus', effort: 'high' }, { tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    assert.deepEqual(models.mend, [{ tool: 'claude', model: 'sonnet', effort: 'medium' }, { tool: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }]);
    assert.deepEqual(models.plan, [{ tool: 'claude', model: 'opus', effort: 'high' }, { tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    assert.deepEqual(models.manager, [{ tool: 'claude', model: 'opus', effort: 'medium' }, { tool: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }]);
    const listed = (await c.verb('list')).out;
    for (const list of ['build', 'review', 'finish', 'mend', 'plan', 'manager']) assert.match(listed, new RegExp(`\\n${list}\\n {2}1 `, 'u'));
    assert.equal(c.file().finish, undefined, 'reading writes nothing');

    const set = await c.verb('set', 'finish', 'codex:gpt-6.2-sol:high');
    assert.equal(set.code, 0, set.err);
    assert.equal(set.out, 'mc: finish is now codex:gpt-6.2-sol:high alone\n');
    assert.deepEqual(c.file().finish, [{ tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    assert.deepEqual(c.file().mend, models.mend, 'a change writes every list');
    assert.equal((await c.verb('add', 'manager', 'claude:sonnet:high')).code, 0);
    assert.equal((await c.verb('remove', 'manager', 'claude:opus')).code, 0);
    assert.deepEqual(c.file().manager.map((item) => item.model), ['gpt-6.2-sol', 'sonnet']);
    const classSet = await c.verb('set', 'build', 'claude:opus:high');
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

test('a catalog written with fast, medium and large reads build as its large list, then is written with build only when it changes', async () => {
  const older = { ...BEFORE_MEDIUM, medium: [{ tool: 'claude', model: 'sonnet', effort: 'high' }, { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' }] };
  const c = catalogAt(older);
  try {
    const original = readFileSync(modelsPath(c.env), 'utf8');
    const models = readModels(c.env);
    assert.deepEqual(models.build, older.large);
    assert.equal(models.fast, undefined);
    const listed = await c.verb('list');
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /\nbuild\n  1  claude:opus:medium\nreview\n/u);
    assert.doesNotMatch(listed.out, /\n(fast|medium|large)\n/u);
    assert.equal(readFileSync(modelsPath(c.env), 'utf8'), original, 'reading the old file does not rewrite it');

    const added = await c.verb('add', 'build', 'codex:gpt-6.2-sol:high');
    assert.equal(added.code, 0, added.err);
    assert.deepEqual(c.file().build, [{ tool: 'claude', model: 'opus', effort: 'medium' }, { tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' }]);
    for (const key of ['fast', 'medium', 'large']) assert.equal(c.file()[key], undefined, `${key} is not written back`);
    for (const key of ['review', 'finish', 'mend', 'plan', 'manager']) assert.deepEqual(c.file()[key], BEFORE_MEDIUM[key]);
    assert.equal((await c.verb('remove', 'build', 'claude:opus')).code, 0);
    assert.deepEqual(c.file().build.map((candidate) => candidate.model), ['gpt-6.2-sol']);
    const set = await c.verb('set', 'build', 'claude:opus:high');
    assert.equal(set.code, 2);
    assert.match(set.err, /mc model set review\|finish\|mend\|plan\|manager/u);
    assert.equal((await c.verb('add', 'fast', 'claude:opus:high')).code, 2, 'the retired classes are no lists');
  } finally { c.done(); }
});

test('a catalog without build or any retired class reads the default build list; one with only medium reads it as build', () => {
  const none = catalogAt(null);
  const onlyMedium = catalogAt({ ...BEFORE_MEDIUM, fast: undefined, large: undefined, medium: [{ tool: 'claude', model: 'sonnet', effort: 'high' }] });
  try {
    assert.deepEqual(readModels(none.env).build, [
      { tool: 'codex', model: 'gpt-6.2-sol', effort: 'high' },
      { tool: 'claude', model: 'sonnet', effort: 'high' },
    ]);
    assert.deepEqual(readModels(onlyMedium.env).build, [{ tool: 'claude', model: 'sonnet', effort: 'high' }]);
  } finally { none.done(); onlyMedium.done(); }
});

test('a catalog with an unknown key remains refused and is not rewritten', () => {
  const c = catalogAt({ ...BEFORE_MEDIUM, surprise: true });
  try {
    const before = readFileSync(modelsPath(c.env), 'utf8');
    assert.throws(() => readModels(c.env), /surprise: unknown key/u);
    assert.equal(readFileSync(modelsPath(c.env), 'utf8'), before);
  } finally { c.done(); }
});

test('a review list that is empty or repeats a model is refused, not read as the defaults', () => {
  for (const [review, why] of [[[], /review: a list of at least one candidate/u], [[OLD.review, OLD.review], /review: codex:gpt-6\.2-sol is listed twice/u]]) {
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
    for (const priority of ['codex', 'claude', 'agy', 'auto']) {
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
    await c.verb('add', 'build', 'codex:gpt-6-luna:high');
    await c.verb('remove', 'build', 'codex:gpt-6-luna');
    await c.verb('set', 'review', 'claude:opus:high');
    assert.equal(c.file().provider_priority, 'auto');
    assert.deepEqual(c.file().build, OLD.large);
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


test('decision defaults read without rewriting old catalogs and mc model lists and changes them', async () => {
  const c = catalogAt(BEFORE_MEDIUM);
  try {
    const before = readFileSync(modelsPath(c.env),'utf8');
    assert.deepEqual(readModels(c.env).decision,[{tool:'claude',model:'opus',effort:'high'},{tool:'codex',model:'gpt-6.2-sol',effort:'high'}]);
    assert.match((await c.verb('list')).out,/decision\n  1  claude:opus:high\n  2  codex:gpt-6\.2-sol:high/u);
    assert.equal(readFileSync(modelsPath(c.env),'utf8'),before);
    assert.equal((await c.verb('set','decision','codex:gpt-6.2-sol:high')).code,0);
    assert.deepEqual(c.file().decision,[{tool:'codex',model:'gpt-6.2-sol',effort:'high'}]);
  } finally { c.done(); }
});

test('the default review list starts with agy:gemini-4-argon-high:high', () => {
  const c = catalogAt(null);
  try {
    assert.deepEqual(readModels(c.env).review.map(({ tool, model, effort }) => `${tool}:${model}:${effort}`), ['agy:gemini-4-argon-high:high', 'claude:opus:medium', 'codex:gpt-6.2-sol:medium']);
  } finally { c.done(); }
});

test('an agy candidate whose effort contradicts its model\'s level is refused at add and set (exit 2, nothing written) and as a document problem; a slug without a level takes any effort', async () => {
  const c = catalogAt(null);
  try {
    for (const verb of ['add', 'set']) {
      const refused = await c.verb(verb, 'review', 'agy:gemini-4-argon-high:medium');
      assert.equal(refused.code, 2, refused.err);
      assert.match(refused.err, /effort: gemini-4-argon-high carries level high in its name, so the effort is high, not medium/u);
    }
    assert.equal(existsSync(modelsPath(c.env)), false, 'nothing was written');
    assert.throws(() => readModels(catalogAt({ ...OLD, review: [{ tool: 'agy', model: 'gemini-4-argon-low', effort: 'high' }] }).env), /review\[0\]\.effort: gemini-4-argon-low carries level low/u);
    assert.equal((await c.verb('add', 'review', 'agy:gemini-4-argon-low:low')).code, 0);
    assert.equal((await c.verb('add', 'review', 'agy:gemini-4-carbon:medium')).code, 0, 'a name with no level suffix takes any effort');
    assert.equal((await c.verb('add', 'review', 'claude:opus-high:low')).code, 0, 'another tool is not held to the rule');
  } finally { c.done(); }
});
