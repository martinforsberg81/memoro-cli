import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeClaudeProjectPath,
  findClaudeSessionById,
  findLatestClaudeSession,
} from '../../src/lib/claude.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memoro-claude-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('Claude transcript lookup', () => {
  test('encodes project paths the same way Claude projects dirs do', () => {
    assert.equal(
      encodeClaudeProjectPath('/Users/me/project.with.dots'),
      '-Users-me-project-with-dots',
    );
  });

  test('findLatestClaudeSession returns the newest jsonl for a workspace', async () => withTempDir(async (dir) => {
    const workspace = join(dir, 'repo.with.dot');
    const projectsDir = join(dir, 'projects');
    const projectDir = join(projectsDir, encodeClaudeProjectPath(workspace));
    mkdirSync(projectDir, { recursive: true });

    const older = join(projectDir, 'older.jsonl');
    const newer = join(projectDir, 'newer.jsonl');
    writeFileSync(older, '{"type":"user","text":"old"}\n');
    writeFileSync(newer, '{"type":"user","text":"new"}\n');
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-01-02T00:00:00Z');
    utimesSync(older, oldDate, oldDate);
    utimesSync(newer, newDate, newDate);

    const found = await findLatestClaudeSession({ cwd: workspace, projectsDir });

    assert.equal(found.path, newer);
    assert.equal(found.cwd, workspace);
    assert.equal(found.sessionId, 'newer');
  }));

  test('findLatestClaudeSession honours newerThanMs', async () => withTempDir(async (dir) => {
    const workspace = join(dir, 'repo');
    const projectsDir = join(dir, 'projects');
    const projectDir = join(projectsDir, encodeClaudeProjectPath(workspace));
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'session.jsonl');
    writeFileSync(file, '{}\n');
    const when = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, when, when);

    const found = await findLatestClaudeSession({
      cwd: workspace,
      projectsDir,
      newerThanMs: when.getTime() + 1,
    });

    assert.equal(found, null);
  }));

  test('findClaudeSessionById resolves the exact workspace transcript', async () => withTempDir(async (dir) => {
    const workspace = join(dir, 'repo');
    const projectsDir = join(dir, 'projects');
    const projectDir = join(projectsDir, encodeClaudeProjectPath(workspace));
    mkdirSync(projectDir, { recursive: true });
    const wanted = join(projectDir, 'cl_wanted.jsonl');
    writeFileSync(wanted, '{}\n');
    writeFileSync(join(projectDir, 'cl_other.jsonl'), '{}\n');

    const found = await findClaudeSessionById({
      sessionId: 'cl_wanted',
      cwd: workspace,
      projectsDir,
    });

    assert.equal(found.sessionId, 'cl_wanted');
    assert.equal(found.path, wanted);
  }));
});
