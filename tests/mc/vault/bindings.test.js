import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectBoundLabels,
  filterMatchesByRepoBindings,
  mergeSecretBindings,
  persistSecretBindingPlan,
  planSecretBindingPersistence,
  secretBindingsPath,
} from '../../../src/mc/vault/bindings.js';

describe('vault secret bindings', () => {
  it('persists a value-free .mc/secrets.json binding file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bindings-'));
    const binding = {
      version: 1,
      sources: [
        {
          file: '.dev.vars',
          format: 'dotenv',
          materialise: 'file',
          keys: {
            OPENAI_API_KEY: 'wrangler:memoro:OPENAI_API_KEY',
          },
        },
      ],
    };

    const plan = await planSecretBindingPersistence(binding, { cwd: dir });
    const res = await persistSecretBindingPlan(plan);

    assert.equal(res.action, 'created');
    assert.equal(res.path, '.mc/secrets.json');
    assert.equal(existsSync(secretBindingsPath(dir)), true);
    const body = readFileSync(secretBindingsPath(dir), 'utf8');
    assert.ok(!body.includes('sk-live-secret-value'), `binding leaked a value: ${body}`);
    assert.deepEqual(JSON.parse(body), binding);
  });

  it('merges a new source without clobbering existing repo bindings', () => {
    const existing = {
      version: 1,
      sources: [
        {
          file: '.env',
          format: 'dotenv',
          materialise: 'file',
          keys: {
            OPENAI_API_KEY: 'env:memoro-cli:OPENAI_API_KEY',
          },
        },
      ],
    };
    const incoming = {
      version: 1,
      sources: [
        {
          file: '.dev.vars',
          format: 'dotenv',
          materialise: 'file',
          keys: {
            GOOGLE_AI_API_KEY: 'wrangler:memoro:GOOGLE_AI_API_KEY',
          },
        },
      ],
    };

    const merged = mergeSecretBindings(existing, incoming);

    assert.deepEqual(merged.sources.map((s) => s.file), ['.env', '.dev.vars']);
    assert.equal(merged.sources[0].keys.OPENAI_API_KEY, 'env:memoro-cli:OPENAI_API_KEY');
    assert.equal(merged.sources[1].keys.GOOGLE_AI_API_KEY, 'wrangler:memoro:GOOGLE_AI_API_KEY');
  });

  it('filters materialisation candidates to labels bound by the current repo', async () => {
    const memoro = mkdtempSync(join(tmpdir(), 'mc-vault-bind-memoro-'));
    const memoroCli = mkdtempSync(join(tmpdir(), 'mc-vault-bind-cli-'));
    const binding = {
      version: 1,
      sources: [
        {
          file: '.dev.vars',
          format: 'dotenv',
          materialise: 'file',
          keys: {
            OPENAI_API_KEY: 'wrangler:memoro:OPENAI_API_KEY',
          },
        },
      ],
    };
    mkdirSync(dirname(secretBindingsPath(memoro)), { recursive: true });
    writeFileSync(secretBindingsPath(memoro), JSON.stringify(binding, null, 2));

    const matches = [
      { label: 'wrangler:memoro:OPENAI_API_KEY', payload: { token: 'memoro-secret' } },
      { label: 'wrangler:memoro-cli:OPENAI_API_KEY', payload: { token: 'cli-secret' } },
      { label: 'hook-test-openai', payload: { token: 'other-secret' } },
    ];

    const bound = await filterMatchesByRepoBindings(matches, { cwd: memoro });
    const unbound = await filterMatchesByRepoBindings(matches, { cwd: memoroCli });

    assert.deepEqual(bound.map((m) => m.label), ['wrangler:memoro:OPENAI_API_KEY']);
    assert.deepEqual(unbound, []);
    assert.deepEqual([...collectBoundLabels(binding)], ['wrangler:memoro:OPENAI_API_KEY']);
  });
});
