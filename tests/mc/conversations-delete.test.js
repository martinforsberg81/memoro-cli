/**
 * Deleting a Claude conversation takes its whole footprint and nothing else.
 *
 * Claude Code keeps a `<uuid>/` directory (subagents, tool results) beside
 * each `<uuid>.jsonl`. `mc work discard ytor --apply` removed five transcripts
 * and left 203 MB of those behind (2026-09-26). The same day a hand-written
 * cleanup removed every project's `memory/` — so these tests prove both
 * halves: the sibling goes, `memory/` stays.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deleteConversation, deleteConversations, listConversations, SESSION_ID, treeBytes } from '../../src/mc/conversations.js';
import { agyStore } from './_helpers/agy-store.js';

const ID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const HEAD = `${JSON.stringify({ cwd: '/tmp/area' })}\n`;

function fixture({ id = ID, memory = true, sibling = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mc-conv-delete-'));
  const project = join(home, 'projects', '-tmp-area');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, HEAD);
  if (sibling) {
    mkdirSync(join(project, id, 'subagents'), { recursive: true });
    writeFileSync(join(project, id, 'subagents', 'a.jsonl'), 'x'.repeat(1000));
  }
  if (memory) {
    mkdirSync(join(project, 'memory'));
    writeFileSync(join(project, 'memory', 'MEMORY.md'), '# Memory index\n');
  }
  const env = { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'no-codex') };
  return { home, project, path, env, entry: { tool: 'claude-code', id, path } };
}

describe('deleteConversation (claude)', () => {
  it('removes the transcript and its <uuid>/ sibling, and memory/ survives', () => {
    const { project, path, env, entry } = fixture();
    assert.deepEqual(deleteConversation(entry, env), { ok: true });
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(project, ID)), false);
    assert.equal(existsSync(join(project, 'memory', 'MEMORY.md')), true);
    assert.equal(existsSync(project), true);
  });

  it('removes the project directory when nothing else is left in it', () => {
    const { project, env, entry } = fixture({ memory: false });
    assert.deepEqual(deleteConversation(entry, env), { ok: true });
    assert.equal(existsSync(project), false);
  });

  it('an id that is not a uuid removes only its .jsonl', () => {
    const id = 'memory';
    assert.equal(SESSION_ID.test(id), false);
    const { project, path, env, entry } = fixture({ id, memory: false });
    assert.deepEqual(deleteConversation(entry, env), { ok: true });
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(project, id, 'subagents', 'a.jsonl')), true);
  });
});

describe('listConversations (claude) bytes', () => {
  it('counts the <uuid>/ sibling in bytes', () => {
    const { env } = fixture();
    const found = listConversations('/tmp/area', env);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, ID);
    assert.equal(found[0].bytes, HEAD.length + 1000);
  });

  it('treeBytes of a missing path is 0', () => {
    assert.equal(treeBytes(join(tmpdir(), 'mc-no-such-path', ID)), 0);
  });
});

describe('deleteConversation (agy)', () => {
  const OTHER = 'ffffffff-0000-1111-2222-333333333333';
  const AREA = '/work/plan/example';
  const closed = { heldOpen: () => false };

  function two() {
    const store = agyStore();
    for (const id of [ID, OTHER]) {
      store.addConversation({ id, workspace: AREA });
      writeFileSync(join(store.home, 'conversations', `${id}.db-wal`), 'w');
      writeFileSync(join(store.home, 'conversations', `${id}.db-shm`), 's');
    }
    const own = (id) => [join(store.brain, id), join(store.home, 'conversations', `${id}.db`), join(store.home, 'conversations', `${id}.db-wal`),
      join(store.home, 'conversations', `${id}.db-shm`), join(store.home, 'annotations', `${id}.pbtxt`)];
    return { store, own, entry: { tool: 'antigravity-cli', id: ID } };
  }

  it('removes exactly the named conversation: brain, database with its wal and shm, annotations; the other stays whole', () => {
    const { store, own, entry } = two();
    writeFileSync(join(store.home, 'settings.json'), '{}');
    assert.deepEqual(deleteConversation(entry, store.env, closed), { ok: true });
    for (const path of own(ID)) assert.equal(existsSync(path), false, path);
    for (const path of own(OTHER)) assert.equal(existsSync(path), true, path);
    assert.equal(existsSync(join(store.home, 'settings.json')), true);
  });

  it('asks about the files and the brain directory, and an open one stops it with everything in place', () => {
    const { store, own, entry } = two();
    const asked = [];
    const result = deleteConversation(entry, store.env, { heldOpen: (what) => { asked.push(what); return true; } });
    assert.equal(result.ok, false);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].directory, join(store.brain, ID));
    assert.deepEqual(asked[0].files, own(ID).slice(1));
    for (const path of own(ID)) assert.equal(existsSync(path), true, path);
  });

  it('what cannot be shown closed is not removed: an unknown answer refuses too', () => {
    const { store, own, entry } = two();
    assert.equal(deleteConversation(entry, store.env, { heldOpen: () => null }).ok, false);
    for (const path of own(ID)) assert.equal(existsSync(path), true, path);
  });

  it('a symlink where agy keeps a file, or a file where it keeps a directory, is refused whole', () => {
    for (const shape of ['link', 'file-as-directory', 'directory-as-file']) {
      const { store, own, entry } = two();
      const db = join(store.home, 'conversations', `${ID}.db`);
      const outside = join(store.root, 'outside.txt');
      writeFileSync(outside, 'keep me');
      if (shape === 'link') { rmSync(db); symlinkSync(outside, db); }
      if (shape === 'file-as-directory') { rmSync(join(store.brain, ID), { recursive: true }); writeFileSync(join(store.brain, ID), 'x'); }
      if (shape === 'directory-as-file') { rmSync(db); mkdirSync(db); }
      const result = deleteConversation(entry, store.env, closed);
      assert.equal(result.ok, false, shape);
      assert.equal(readFileSync(outside, 'utf8'), 'keep me', shape);
      assert.equal(existsSync(join(store.home, 'annotations', `${ID}.pbtxt`)), true, shape);
      assert.equal(existsSync(own(OTHER)[0]), true, shape);
    }
  });

  it('an id that is not a conversation id is refused before anything is looked at', () => {
    const { store } = two();
    let asked = false;
    const result = deleteConversation({ tool: 'antigravity-cli', id: '../brain' }, store.env, { heldOpen: () => { asked = true; return false; } });
    assert.equal(result.ok, false);
    assert.equal(asked, false);
    assert.equal(existsSync(store.brain), true);
  });

  it('a conversation already partly gone is removed from what is left', () => {
    const { store, own, entry } = two();
    rmSync(join(store.home, 'annotations', `${ID}.pbtxt`));
    assert.deepEqual(deleteConversation(entry, store.env, closed), { ok: true });
    for (const path of own(ID)) assert.equal(existsSync(path), false, path);
  });

  it('deleteConversations reports the one that stayed and still removes the next', () => {
    const { store, own } = two();
    const held = (what) => what.directory.endsWith(ID);
    const outcome = deleteConversations([{ tool: 'antigravity-cli', id: ID }, { tool: 'antigravity-cli', id: OTHER }], store.env, { heldOpen: held });
    assert.deepEqual(outcome.removed.map((entry) => entry.id), [OTHER]);
    assert.deepEqual(outcome.failed.map((entry) => entry.id), [ID]);
    for (const path of own(OTHER)) assert.equal(existsSync(path), false, path);
    for (const path of own(ID)) assert.equal(existsSync(path), true, path);
  });
});
