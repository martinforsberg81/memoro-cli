/** Claude's trust record: a real temporary config file; only the clock and sleep are injected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigPath, trustClaudeFolder } from '../../src/mc/claude-trust.js';

function fixture(config) {
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'mc-claude-trust-')));
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const folder = join(root, 'programme');
  mkdirSync(folder);
  const path = claudeConfigPath(env);
  if (config !== undefined) writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
  return { env, folder, path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

test('an untrusted launch folder is recorded trusted and every other key is kept', () => {
  const f = fixture({ numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } });
  const result = trustClaudeFolder(f.folder, { env: f.env });
  assert.deepEqual(result, { ok: true, folder: f.folder, changed: true });
  assert.deepEqual(f.read(), { numStartups: 3, projects: {
    '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
    [f.folder]: { hasTrustDialogAccepted: true } } });
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
});

test('an already trusted folder is not rewritten', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ projects: {} }));
  trustClaudeFolder(f.folder, { env: f.env });
  const before = readFileSync(f.path, 'utf8');
  const inode = statSync(f.path).ino;
  assert.equal(trustClaudeFolder(f.folder, { env: f.env }).changed, false);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(statSync(f.path).ino, inode);
});

test('a lock Claude holds is waited on and then refused without writing; a stale one is taken over', () => {
  const f = fixture({ projects: {} });
  mkdirSync(`${f.path}.lock`);
  const now = Date.now();
  const held = trustClaudeFolder(f.folder, { env: f.env, now: () => now, sleep: () => {} });
  assert.equal(held.ok, false);
  assert.match(held.reason, /stayed held/u);
  assert.deepEqual(f.read(), { projects: {} });
  const old = new Date(now - 60_000);
  utimesSync(`${f.path}.lock`, old, old);
  assert.equal(trustClaudeFolder(f.folder, { env: f.env, now: () => now, sleep: () => {} }).changed, true);
  assert.equal(f.read().projects[f.folder].hasTrustDialogAccepted, true);
});

test('an unreadable config is refused and left untouched', () => {
  const f = fixture('{ not json');
  const result = trustClaudeFolder(f.folder, { env: f.env });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(f.path, 'utf8'), '{ not json');
});
