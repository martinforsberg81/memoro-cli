import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildVaultImportDryRun,
  classifyEnvEntry,
  parseDotenv,
  scanVaultImportFiles,
} from '../../../src/mc/vault/import-scan.js';

describe('vault import scan — dotenv parser', () => {
  it('parses dotenv-shaped keys without expanding values', () => {
    const entries = parseDotenv(`
# comment
export OPENAI_API_KEY="sk-test-secret"
PUBLIC_API_URL=http://localhost:8787 # local
PLAIN='literal $OPENAI_API_KEY'
BAD LINE
`);

    assert.deepEqual(entries.map((e) => ({
      key: e.key,
      value: e.value,
      exported: e.exported,
      line: e.line,
    })), [
      { key: 'OPENAI_API_KEY', value: 'sk-test-secret', exported: true, line: 3 },
      { key: 'PUBLIC_API_URL', value: 'http://localhost:8787', exported: false, line: 4 },
      { key: 'PLAIN', value: 'literal $OPENAI_API_KEY', exported: false, line: 5 },
    ]);
  });
});

describe('vault import scan — classification', () => {
  it('classifies obvious secrets and public config', () => {
    assert.deepEqual(classifyEnvEntry({ key: 'OPENAI_API_KEY', value: 'sk-live-abc' }), {
      classification: 'secret',
      confidence: 'high',
      reason: 'secret-like key name',
    });
    assert.deepEqual(classifyEnvEntry({ key: 'PUBLIC_API_URL', value: 'https://example.test' }), {
      classification: 'config',
      confidence: 'high',
      reason: 'public key prefix',
    });
  });

  it('treats URLs with credentials as secrets', () => {
    assert.deepEqual(classifyEnvEntry({ key: 'DATABASE_URL', value: 'postgres://user:pass@example.test/db' }), {
      classification: 'secret',
      confidence: 'high',
      reason: 'url contains credentials',
    });
  });
});

describe('vault import scan — no value output', () => {
  it('returns key metadata only from file scans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-scan-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${secret}\nPUBLIC_API_URL=http://localhost:8787\n`);

    const scan = scanVaultImportFiles(['.env'], { cwd: dir });
    const json = JSON.stringify(scan);

    assert.equal(scan.ok, true);
    assert.equal(scan.files[0].ok, true);
    assert.deepEqual(scan.files[0].keys.map((k) => k.name), ['OPENAI_API_KEY', 'PUBLIC_API_URL']);
    assert.ok(!json.includes(secret), `scan leaked secret value: ${json}`);
    assert.ok(!json.includes('value'), `scan JSON should not expose a value field: ${json}`);
  });
});

describe('vault import dry-run — binding preview', () => {
  it('plans deterministic labels and value-free bindings for selected secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.dev.vars'), [
      `CLOUDFLARE_API_TOKEN=${secret}`,
      'PUBLIC_API_URL=http://localhost:8787',
      'DATABASE_URL=postgres://user:pass@example.test/db',
      '',
    ].join('\n'));

    const plan = buildVaultImportDryRun('.dev.vars', { cwd: dir, repoName: 'Memoro App' });
    const json = JSON.stringify(plan);

    assert.equal(plan.ok, true);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.format, 'wrangler-dotenv');
    assert.deepEqual(plan.candidates.map((k) => [k.name, k.selected, k.label]), [
      ['CLOUDFLARE_API_TOKEN', true, 'wrangler:memoro-app:CLOUDFLARE_API_TOKEN'],
      ['PUBLIC_API_URL', false, null],
      ['DATABASE_URL', true, 'wrangler:memoro-app:DATABASE_URL'],
    ]);
    assert.deepEqual(plan.binding, {
      version: 1,
      sources: [
        {
          file: '.dev.vars',
          format: 'dotenv',
          materialise: 'file',
          keys: {
            CLOUDFLARE_API_TOKEN: 'wrangler:memoro-app:CLOUDFLARE_API_TOKEN',
            DATABASE_URL: 'wrangler:memoro-app:DATABASE_URL',
          },
        },
      ],
    });
    assert.deepEqual(plan.writes, []);
    assert.ok(!json.includes(secret), `dry-run leaked secret value: ${json}`);
    assert.ok(!json.includes('value'), `dry-run JSON should not expose a value field: ${json}`);
  });
});
