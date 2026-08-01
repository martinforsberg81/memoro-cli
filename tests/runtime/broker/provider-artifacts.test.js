import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateClaudeProviderArtifact,
  validateCodexProviderArtifact,
} from '../../../src/runtime/broker/provider-artifacts.js';

test('Claude artifact validation requires exact project path and native id', () => {
  const projects = '/claude/projects';
  const file = '/claude/projects/-repo/cl_abc.jsonl';
  const realpath = (value) => value;
  const fileStat = { dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false };
  const deps = {
    projectsDir: projects,
    realpath,
    lstat: () => fileStat,
    open: () => 7,
    fstat: () => fileStat,
    close: () => {},
  };
  assert.equal(validateClaudeProviderArtifact({ cwd: '/repo', providerSessionId: 'cl_abc', transcriptPath: file }, deps).ok, true);
  assert.equal(validateClaudeProviderArtifact({ cwd: '/repo', providerSessionId: 'cl_other', transcriptPath: file }, deps).ok, false);
});

test('Codex artifact validation binds hook path, native id, metadata, and workspace', () => {
  const sessions = '/codex/sessions';
  const file = '/codex/sessions/2026/07/28/rollout-2026-07-28T12-00-00-cx_abc.jsonl';
  const fileStat = { dev: 3, ino: 4, isFile: () => true, isSymbolicLink: () => false };
  const meta = `${JSON.stringify({
    type: 'session_meta',
    payload: { id: 'cx_abc', cwd: '/repo' },
  })}\n`;
  const deps = {
    sessionsDir: sessions,
    realpath: (value) => value,
    lstat: () => fileStat,
    open: () => 8,
    fstat: () => fileStat,
    read: (_fd, buffer) => Buffer.from(meta).copy(buffer),
    close: () => {},
  };
  assert.equal(validateCodexProviderArtifact({
    cwd: '/repo',
    providerSessionId: 'cx_abc',
    transcriptPath: file,
  }, deps).ok, true);
  assert.equal(validateCodexProviderArtifact({
    cwd: '/other',
    providerSessionId: 'cx_abc',
    transcriptPath: file,
  }, deps).reason, 'artifact-workspace-mismatch');
  assert.equal(validateCodexProviderArtifact({
    cwd: '/repo',
    providerSessionId: 'cx_other',
    transcriptPath: file,
  }, deps).reason, 'artifact-path-mismatch');
});
