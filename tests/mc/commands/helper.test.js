/**
 * `mc helper` — the verb: what it accepts, what it refuses, and the two
 * lines it leaves behind for a runner log to carry — the digest's delta, and
 * what the turn proposed.
 *
 * No model here: the turn is a stub. `--collect` must not reach it at all,
 * which is the whole difference between the two halves.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describe as describeRun, run, turnLine, unreadable } from '../../../src/mc/commands/helper.js';

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

const TURN = (over = {}) => ({
  ok: true, note: 'success', tool: 'claude', model: 'sonnet', groundNotes: [],
  wrote: [], waiting: [], ...over,
});

async function invoke(argv, data = {}, turn = TURN()) {
  const stdout = sink();
  const stderr = sink();
  const seen = {};
  const turned = {};
  const code = await run(argv, {
    stdout,
    stderr,
    collect: async (options) => { Object.assign(seen, options); return RESULT(data); },
    turn: async (options) => { Object.assign(turned, options, { called: true }); return turn; },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, seen, turned };
}

describe('mc helper', () => {
  it('collects and then runs the turn over the digest it just wrote', async () => {
    const result = await invoke([], {}, TURN({
      wrote: [{ file: '2026-08-29-expose-operations.md', title: 'The nightly outcomes reach no script' }],
      waiting: [{ file: '2026-08-29-expose-operations.md' }],
    }));
    assert.equal(result.code, 0);
    assert.equal(result.turned.called, true);
    assert.equal(result.turned.digestPath, '/tmp/mc/intake/errors-2026-08-29.md');
    assert.equal(result.turned.digestText, '# Errors and maintenance');
    assert.match(result.stdout, /1 proposal, 1 waiting \(\d+\.\ds, claude sonnet\)/u);
    assert.match(result.stdout, /2026-08-29-expose-operations\.md — The nightly outcomes reach no script/u);
    assert.match(result.stdout, /read them at the next brief/u);
  });

  it('--collect is the script half and never reaches the model', async () => {
    const result = await invoke(['--collect']);
    assert.equal(result.code, 0);
    assert.equal(result.turned.called, undefined);
  });

  it('says a quiet day cost nothing, and is still a success', async () => {
    const result = await invoke([], {}, TURN({ waiting: [{ file: 'old.md' }] }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no proposal — nothing in the digest warranted one \(1 still waiting\)/u);
    assert.doesNotMatch(result.stdout, /next brief/u);
  });

  it('fails when the turn did not finish, and says what the session said', async () => {
    const result = await invoke([], {}, TURN({ ok: false, note: 'quota', stderr: 'x\nweekly limit reached' }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the helper turn did not finish — quota/u);
    assert.match(result.stderr, /weekly limit reached/u);
  });

  it('passes --model through to the turn', async () => {
    const result = await invoke(['--model', 'opus']);
    assert.equal(result.turned.model, 'opus');
  });

  it('repeats what the ground could not be read from', async () => {
    const result = await invoke([], {}, TURN({ groundNotes: ['memoro: could not list plans on origin/main'] }));
    assert.match(result.stderr, /could not list plans on origin\/main/u);
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
    assert.match((await invoke(['--collect', '--purge'])).stderr, /usage — mc helper \[--collect\]/u);
  });

  it('says what the turn produced in one line', () => {
    assert.equal(turnLine({ wrote: [], waiting: [] }), 'no proposal — nothing in the digest warranted one (0 still waiting)');
    assert.equal(turnLine({ wrote: [1, 2], waiting: [1, 2, 3] }), '2 proposals, 3 waiting');
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
