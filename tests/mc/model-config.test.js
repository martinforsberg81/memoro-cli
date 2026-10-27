import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_CATALOG, ModelConfigError, addCandidate, changeModels, modelsPath, parseCandidate, parseTarget,
  readModels, removeCandidate, setReview, withCatalogLock,
} from '../../src/mc/model-config.js';

const roots = [];

/** An isolated work root: the catalog lives under it, and nothing else does. */
function isolated() {
  const root = mkdtempSync(join(tmpdir(), 'mc-models-'));
  roots.push(root);
  return { root, env: { MC_WORK_ROOT: root } };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const specs = (list) => list.map((value) => `${value.tool}:${value.model}:${value.effort}`);

describe('defaults', () => {
  it('an absent file reads the defaults and writes nothing', () => {
    const { env } = isolated();
    const models = readModels(env);
    assert.equal(models.source, 'defaults');
    assert.deepEqual(specs(models.fast), ['claude:haiku:high', 'codex:gpt-6-luna:high']);
    assert.deepEqual(specs(models.large), ['claude:opus:medium', 'codex:gpt-6.1-sol:high']);
    assert.deepEqual(specs([models.review]), ['claude:opus:high']);
    assert.equal(existsSync(modelsPath(env)), false);
  });

  it('the defaults are not shared: a read copy can be edited without touching them', () => {
    const { env } = isolated();
    const models = readModels(env);
    models.fast.push({ tool: 'codex', model: 'x', effort: 'low' });
    assert.equal(DEFAULT_CATALOG.fast.length, 2);
    assert.equal(readModels(env).fast.length, 2);
  });
});

describe('writes', () => {
  it('a change is written to models.json under the work root, with schema and version', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => addCandidate(catalog, 'fast', parseCandidate('codex:gpt-6-future:low')));
    const document = JSON.parse(readFileSync(modelsPath(env), 'utf8'));
    assert.equal(document.schema, 'mc-models');
    assert.equal(document.version, 1);
    assert.deepEqual(Object.keys(document), ['schema', 'version', 'fast', 'large', 'review']);
    assert.equal(modelsPath(env), join(env.MC_WORK_ROOT, 'runner', 'models.json'));
  });

  it('an added candidate goes to the end of its class, and reads back in that order', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => addCandidate(catalog, 'fast', parseCandidate('claude:sonnet-5-5:low')));
    const models = readModels(env);
    assert.equal(models.source, 'config');
    assert.deepEqual(specs(models.fast), ['claude:haiku:high', 'codex:gpt-6-luna:high', 'claude:sonnet-5-5:low']);
    assert.deepEqual(specs(models.large), specs(DEFAULT_CATALOG.large));
  });

  it('a future model name is accepted, not refused for being off a list', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => addCandidate(catalog, 'large', parseCandidate('claude:opus-9.1-preview:max')));
    assert.equal(specs(readModels(env).large).at(-1), 'claude:opus-9.1-preview:max');
  });

  it('the same model may sit in both classes', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => addCandidate(catalog, 'large', parseCandidate('claude:haiku:low')));
    assert.ok(specs(readModels(env).large).includes('claude:haiku:low'));
  });

  it('remove takes exactly tool and model, and the class keeps its order', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => removeCandidate(catalog, 'fast', parseTarget('claude:haiku')));
    assert.deepEqual(specs(readModels(env).fast), ['codex:gpt-6-luna:high']);
  });

  it('set review replaces the review candidate and nothing else', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => setReview(catalog, parseCandidate('codex:gpt-6.1-sol:xhigh')));
    const models = readModels(env);
    assert.deepEqual(specs([models.review]), ['codex:gpt-6.1-sol:xhigh']);
    assert.deepEqual(specs(models.fast), specs(DEFAULT_CATALOG.fast));
  });

  it('a refused change writes nothing: the file keeps its bytes', () => {
    const { env } = isolated();
    changeModels(env, (catalog) => addCandidate(catalog, 'fast', parseCandidate('codex:gpt-6-future:low')));
    const before = readFileSync(modelsPath(env), 'utf8');
    assert.throws(
      () => changeModels(env, (catalog) => addCandidate(catalog, 'fast', parseCandidate('claude:haiku:low'))),
      ModelConfigError,
    );
    assert.equal(readFileSync(modelsPath(env), 'utf8'), before);
  });
});

describe('refusals', () => {
  it('a duplicate tool and model in one class is refused, whatever its effort', () => {
    const catalog = readModels({ MC_WORK_ROOT: isolated().root });
    assert.throws(() => addCandidate(catalog, 'fast', parseCandidate('claude:haiku:low')), /fast already has claude:haiku at claude:haiku:high/u);
    assert.throws(() => addCandidate(catalog, 'large', parseCandidate('codex:gpt-6.1-sol:low')), /already has codex:gpt-6.1-sol/u);
  });

  it('removing the final candidate of a class is refused', () => {
    const catalog = readModels({ MC_WORK_ROOT: isolated().root });
    removeCandidate(catalog, 'fast', parseTarget('claude:haiku'));
    assert.throws(() => removeCandidate(catalog, 'fast', parseTarget('codex:gpt-6-luna')), /only fast candidate/u);
    assert.deepEqual(specs(catalog.fast), ['codex:gpt-6-luna:high']);
  });

  it('removing a candidate that is not there is refused', () => {
    const catalog = readModels({ MC_WORK_ROOT: isolated().root });
    assert.throws(() => removeCandidate(catalog, 'large', parseTarget('codex:gpt-6-luna')), /has no codex:gpt-6-luna/u);
  });

  it('a class other than fast or large is refused', () => {
    const catalog = readModels({ MC_WORK_ROOT: isolated().root });
    assert.throws(() => addCandidate(catalog, 'review', parseCandidate('claude:opus:high')), /is not a class/u);
  });
});

describe('validation', () => {
  it('a candidate is tool:model:effort, with a tool mc launches and an effort the schema names', () => {
    assert.deepEqual(parseCandidate('claude:haiku:high'), { tool: 'claude', model: 'haiku', effort: 'high' });
    assert.throws(() => parseCandidate('claude:haiku'), /is not tool:model:effort/u);
    assert.throws(() => parseCandidate('claude:haiku:high:x'), /is not tool:model:effort/u);
    assert.throws(() => parseCandidate('gemini:flash:high'), /tool: one of claude, codex/u);
    assert.throws(() => parseCandidate('claude:haiku:extreme'), /effort: one of low, medium, high, xhigh, max/u);
    assert.throws(() => parseCandidate('claude:Haiku:high'), /model: a model name/u);
    assert.throws(() => parseCandidate('claude::high'), /model: a model name/u);
  });

  it('a target is tool:model, and its tool is checked too', () => {
    assert.deepEqual(parseTarget('codex:gpt-6-luna'), { tool: 'codex', model: 'gpt-6-luna' });
    assert.throws(() => parseTarget('codex'), /is not tool:model/u);
    assert.throws(() => parseTarget('gemini:flash'), /tool: one of claude, codex/u);
  });
});

describe('a catalog mc cannot read', () => {
  const bad = {
    'not JSON': '{ fast: ',
    'a newer version': JSON.stringify({ schema: 'mc-models', version: 2, fast: [], large: [], review: null }),
    'the wrong schema': JSON.stringify({ schema: 'mc-plan', version: 1 }),
    'an unknown key': JSON.stringify({ schema: 'mc-models', version: 1, fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }], large: [{ tool: 'claude', model: 'opus', effort: 'high' }], review: { tool: 'claude', model: 'opus', effort: 'high' }, extra: 1 }),
    'an empty class': JSON.stringify({ schema: 'mc-models', version: 1, fast: [], large: [{ tool: 'claude', model: 'opus', effort: 'high' }], review: { tool: 'claude', model: 'opus', effort: 'high' } }),
    'a model listed twice': JSON.stringify({ schema: 'mc-models', version: 1, fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }, { tool: 'claude', model: 'haiku', effort: 'low' }], large: [{ tool: 'claude', model: 'opus', effort: 'high' }], review: { tool: 'claude', model: 'opus', effort: 'high' } }),
    'a bad effort': JSON.stringify({ schema: 'mc-models', version: 1, fast: [{ tool: 'claude', model: 'haiku', effort: 'turbo' }], large: [{ tool: 'claude', model: 'opus', effort: 'high' }], review: { tool: 'claude', model: 'opus', effort: 'high' } }),
    'no review': JSON.stringify({ schema: 'mc-models', version: 1, fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }], large: [{ tool: 'claude', model: 'opus', effort: 'high' }] }),
  };

  for (const [label, text] of Object.entries(bad)) {
    it(`${label} is refused with the path and a way out — never the defaults`, () => {
      const { env } = isolated();
      mkdirSync(join(env.MC_WORK_ROOT, 'runner'), { recursive: true });
      writeFileSync(modelsPath(env), text);
      assert.throws(() => readModels(env), (error) => error instanceof ModelConfigError
        && error.message.includes(modelsPath(env))
        && /move it aside to read the defaults/u.test(error.message));
      assert.throws(() => changeModels(env, (catalog) => setReview(catalog, parseCandidate('claude:opus:high'))), ModelConfigError);
      assert.equal(readFileSync(modelsPath(env), 'utf8'), text);
    });
  }
});

describe('the lock', () => {
  it('a lock whose pid is dead is taken over', () => {
    const { root } = isolated();
    const lock = join(root, 'runner', 'models.json.lock');
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(lock, '2147483646');
    let ran = false;
    withCatalogLock(join(root, 'runner'), () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(existsSync(lock), false);
  });

  it('a live holder is waited on, then refused — and its lock is left alone', () => {
    const { root } = isolated();
    const dir = join(root, 'runner');
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'models.json.lock');
    writeFileSync(lock, String(process.pid));
    assert.throws(() => withCatalogLock(dir, () => {}, { waitMs: 20 }), /being changed by pid/u);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
    rmSync(lock, { force: true });
  });

  it('the lock is released after the change, even when the change throws', () => {
    const { env, root } = isolated();
    assert.throws(() => changeModels(env, () => { throw new ModelConfigError('refused'); }), /refused/u);
    assert.equal(existsSync(join(root, 'runner', 'models.json.lock')), false);
  });
});

describe('isolation', () => {
  it('two work roots keep two catalogs', () => {
    const a = isolated();
    const b = isolated();
    changeModels(a.env, (catalog) => setReview(catalog, parseCandidate('codex:gpt-6.1-sol:low')));
    assert.deepEqual(specs([readModels(b.env).review]), ['claude:opus:high']);
    assert.deepEqual(specs([readModels(a.env).review]), ['codex:gpt-6.1-sol:low']);
  });
});
