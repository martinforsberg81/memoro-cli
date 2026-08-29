/**
 * `mc helper` — the verb: what it accepts, what it refuses, and what one
 * line it leaves behind for a runner log to carry.
 *
 * The proposal turn is step 2 of the plan and does not exist; the bare verb
 * has to say so rather than exit 0 having done nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describe as describeRun, run, unreadable } from '../../../src/mc/commands/helper.js';

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), get text() { return chunks.join(''); } };
}

const RESULT = (data) => ({
  path: '/tmp/mc/intake/errors-2026-08-29.md',
  text: '# Errors and maintenance',
  data: {
    notes: [],
    errors: { rows: [], byStatus: {} },
    analysis: { rows: [] },
    provider: { reasons: [] },
    health: {},
    deploy: { silent: false, stale: false, consecutiveFailures: 0 },
    delta: { first: false, fingerprints: [], failing: [] },
    ...data,
  },
});

async function invoke(argv, data = {}) {
  const stdout = sink();
  const stderr = sink();
  const seen = {};
  const code = await run(argv, {
    stdout,
    stderr,
    collect: async (options) => { Object.assign(seen, options); return RESULT(data); },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, seen };
}

describe('mc helper', () => {
  it('refuses the bare verb — the proposal turn is not built', async () => {
    const result = await invoke([]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /the proposal turn is not built yet/u);
    assert.match(result.stderr, /usage — mc helper --collect/u);
  });

  it('collects and prints the path, the time and the delta', async () => {
    const result = await invoke(['--collect'], {
      delta: { first: false, fingerprints: [{ fingerprint: 'a', count: 40, loud: true }], failing: ['deploy-stale'] },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^mc: \/tmp\/mc\/intake\/errors-2026-08-29\.md \(\d+\.\ds\) — /u);
    assert.match(result.stdout, /1 new fingerprint, 1 above the threshold, 1 newly failing condition\n$/u);
  });

  it('says the first digest has no baseline instead of claiming a delta', async () => {
    const result = await invoke(['--collect'], {
      delta: { first: true, fingerprints: [], failing: [] },
      errors: { rows: [{ fingerprint: 'a' }, { fingerprint: 'b' }], byStatus: {} },
    });
    assert.match(result.stdout, /first digest, 2 fingerprints — no baseline yet/u);
  });

  it('complains on stderr about every section it could not read', async () => {
    const result = await invoke(['--collect'], {
      provider: { reasons: [], error: 'wrangler d1 execute failed (1)' },
      deploy: { error: '/admin/deploy/logs returned 401' },
    });
    assert.equal(result.code, 0, 'a partial digest is still a digest');
    assert.match(result.stderr, /AI-provider errors not read — wrangler d1 execute failed \(1\)/u);
    assert.match(result.stderr, /deploy logs not read — \/admin\/deploy\/logs returned 401/u);
  });

  it('normalises --since and passes the numbers through', async () => {
    const result = await invoke(['--collect', '--since', '2026-08-27', '--limit', '10', '--threshold', '3']);
    assert.equal(result.code, 0);
    assert.equal(result.seen.since, '2026-08-27T00:00:00.000Z');
    assert.equal(result.seen.limit, 10);
    assert.equal(result.seen.threshold, 3);
  });

  it('refuses a date it cannot read and a count that is not one', async () => {
    assert.equal((await invoke(['--collect', '--since', 'yesterday'])).code, 2);
    assert.equal((await invoke(['--collect', '--limit', '0'])).code, 2);
    assert.equal((await invoke(['--collect', '--threshold', 'many'])).code, 2);
    assert.equal((await invoke(['--collect', 'extra'])).code, 2);
    assert.equal((await invoke(['--collect', '--purge'])).code, 2);
  });

  it('lists the unreadable sections by name', () => {
    const found = unreadable({
      errors: { error: 'a' }, analysis: {}, provider: { error: 'b' }, health: {}, deploy: {},
    });
    assert.deepEqual(found.map(([name]) => name), ['error fingerprints', 'AI-provider errors']);
  });

  it('describes a quiet day as nothing new', () => {
    const line = describeRun({
      delta: { first: false, fingerprints: [], failing: [] },
      errors: { rows: [] },
    });
    assert.equal(line, '0 new fingerprints');
  });
});
