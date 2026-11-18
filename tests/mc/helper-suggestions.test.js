import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { collectImprovementSuggestions, suggestionReading } from '../../src/mc/helper-suggestions.js';

const row = (id, text = 'Keep my chat text intact') => ({ id, kind: 'bug', text, version: 27638, day: '2026-11-18' });
function fixture(t, rows = [row('a')]) {
  const root = mkdtempSync(join(tmpdir(), 'mc-suggestions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, args: { env: { MC_WORK_ROOT: root, MC_LAYOUT: '2' }, base: 'https://example.test', token: 'fixture',
    getJson: async () => ({ ok: true, json: { ok: true, suggestions: rows } }) } };
}

it('copies every original before receipt and merges identical texts, keeping other topics separate', async (t) => {
  const { root, args } = fixture(t, [row('a'), row('b'), row('c', 'A different topic')]);
  const result = await collectImprovementSuggestions({ ...args, postJson: async (_url, _token, ids) => {
    assert.deepEqual(ids, ['a', 'b', 'c']);
    const files = readdirSync(join(root, 'intake'));
    assert.equal(files.length, 2);
    const copies = files.map((file) => readFileSync(join(root, 'intake', file), 'utf8')).join('\n');
    for (const id of ids) assert.ok(copies.includes(`Original id: ${id}; build: 27638; UTC day: 2026-11-18`));
    assert.ok(copies.includes('Keep my chat text intact'));
    return { ok: true, json: { ok: true, deleted: 3 } };
  } });
  assert.equal(result.error, null);
  assert.equal(result.pending, 0);
});

it('never receipts a failed local copy or malformed server row', async (t) => {
  const { root, args } = fixture(t);
  let receipts = 0;
  const postJson = async () => { receipts++; throw new Error('must not receipt'); };
  const failed = await collectImprovementSuggestions({ ...args, postJson, write: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  assert.match(failed.error, /ENOSPC/u);
  assert.equal(receipts, 0);
  const malformed = await collectImprovementSuggestions({ ...args, postJson,
    getJson: async () => ({ ok: true, json: { ok: true, suggestions: [{ ...row('b'), id: '../escape' }] } }) });
  assert.match(malformed.error, /invalid/u);
  assert.equal(receipts, 0);
  assert.equal(readdirSync(join(root, 'helper', 'suggestions')).length, 1);
});

it('retries an uncertain receipt after the drain archives the copy, without requeuing it', async (t) => {
  const { root, args } = fixture(t);
  const first = await collectImprovementSuggestions({ ...args, postJson: async () => ({ ok: false }) });
  assert.equal(first.pending, 1);
  assert.match(suggestionReading({ env: args.env }).problems[0], /unconfirmed/u);
  const [name] = readdirSync(join(root, 'intake'));
  const archive = join(root, 'runner', 'log', 'intake', '2026-11-18');
  mkdirSync(archive, { recursive: true });
  renameSync(join(root, 'intake', name), join(archive, name));
  const second = await collectImprovementSuggestions({ ...args, postJson: async (_url, _token, ids) => {
    assert.deepEqual(ids, ['a']);
    assert.ok(readFileSync(join(archive, name), 'utf8').includes('Original id: a'));
    return { ok: true, json: { ok: true, deleted: 0 } };
  } });
  assert.equal(second.error, null);
  assert.deepEqual(readdirSync(join(root, 'intake')), []);
});

it('reports unreadable feedback as an error and successful empty feedback as empty', async (t) => {
  const { args } = fixture(t, []);
  assert.match(suggestionReading({ env: args.env }).summary, /not collected/u);
  const unavailable = await collectImprovementSuggestions({ ...args, getJson: async () => ({ ok: false }) });
  assert.ok(unavailable.error);
  assert.ok(suggestionReading({ env: args.env }).problems.length);
  const empty = await collectImprovementSuggestions(args);
  assert.equal(empty.error, null);
  assert.equal(empty.saved, 0);
  assert.equal(suggestionReading({ env: args.env }).count, 0);
});
