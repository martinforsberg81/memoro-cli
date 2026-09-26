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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deleteConversation, listConversations, SESSION_ID, treeBytes } from '../../src/mc/conversations.js';

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
