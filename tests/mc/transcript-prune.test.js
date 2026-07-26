/**
 * Provider transcript hygiene: orphans are prunable, resumable/live/recent
 * transcripts and non-transcript provider data are never touched.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyTranscriptPrunePlan,
  buildTranscriptPrunePlan,
} from '../../src/mc/transcript-prune.js';

const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const UUID_A = '019f0000-0000-7000-8000-00000000000a';
const UUID_B = '019f0000-0000-7000-8000-00000000000b';
const UUID_C = '019f0000-0000-7000-8000-00000000000c';
const UUID_D = '019f0000-0000-7000-8000-00000000000d';

function makeStores(root) {
  const codex = join(root, 'codex-sessions');
  const claude = join(root, 'claude-projects');
  mkdirSync(join(codex, '2026', '06', '15'), { recursive: true });
  mkdirSync(join(claude, '-Users-me-repo'), { recursive: true });
  return { codexSessionsDir: codex, claudeProjectsDir: claude };
}

function writeOld(path, content = 'x') {
  writeFileSync(path, content);
  utimesSync(path, OLD, OLD);
}

describe('transcript prune', () => {
  test('classifies orphans and protects resumable, live, and recent transcripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-transcripts-'));
    try {
      const roots = makeStores(root);
      const day = join(roots.codexSessionsDir, '2026', '06', '15');
      writeOld(join(day, `rollout-2026-06-15T10-00-00-${UUID_A}.jsonl`), 'orphan');
      writeOld(join(day, `rollout-2026-06-15T11-00-00-${UUID_B}.jsonl`), 'resumable');
      writeOld(join(day, `rollout-2026-06-15T12-00-00-${UUID_C}.jsonl`), 'live');
      writeFileSync(join(day, `rollout-2026-06-15T13-00-00-${UUID_D}.jsonl`), 'recent');

      const plan = buildTranscriptPrunePlan({
        roots,
        registry: { entries: [{ name: 'kept', tool: 'codex', tool_session_id: UUID_B }] },
        ps: () => `codex resume ${UUID_C} --sandbox workspace-write\n`,
      });

      assert.deepEqual(plan.candidates.map((item) => item.id), [UUID_A]);
      assert.equal(plan.counts.kept.protected, 2);
      assert.equal(plan.counts.kept.recent, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('claude transcripts prune with their aux dir; memory and other files survive', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-transcripts-claude-'));
    try {
      const roots = makeStores(root);
      const project = join(roots.claudeProjectsDir, '-Users-me-repo');
      writeOld(join(project, `${UUID_A}.jsonl`), 'orphan transcript');
      mkdirSync(join(project, UUID_A, 'subagents'), { recursive: true });
      writeOld(join(project, UUID_A, 'subagents', 'agent.jsonl'));
      mkdirSync(join(project, 'memory'), { recursive: true });
      writeOld(join(project, 'memory', 'MEMORY.md'), 'precious');
      writeOld(join(project, 'notes.txt'), 'not a transcript');

      const plan = buildTranscriptPrunePlan({ roots, registry: { entries: [] }, ps: () => '' });
      assert.deepEqual(plan.candidates.map((item) => item.id), [UUID_A]);
      assert.deepEqual(plan.candidates[0].aux_paths, [join(project, UUID_A)]);

      const result = applyTranscriptPrunePlan(plan, { roots });
      assert.equal(result.ok, true);
      assert.equal(existsSync(join(project, `${UUID_A}.jsonl`)), false);
      assert.equal(existsSync(join(project, UUID_A)), false);
      assert.equal(existsSync(join(project, 'memory', 'MEMORY.md')), true);
      assert.equal(existsSync(join(project, 'notes.txt')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('apply removes pruned codex files and their emptied date directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-transcripts-apply-'));
    try {
      const roots = makeStores(root);
      const day = join(roots.codexSessionsDir, '2026', '06', '15');
      writeOld(join(day, `rollout-2026-06-15T10-00-00-${UUID_A}.jsonl`));

      const plan = buildTranscriptPrunePlan({ roots, registry: { entries: [] }, ps: () => '' });
      const result = applyTranscriptPrunePlan(plan, { roots });

      assert.equal(result.ok, true);
      assert.equal(result.counts.total, 1);
      assert.equal(existsSync(day), false);
      assert.equal(existsSync(join(roots.codexSessionsDir, '2026')), false);
      // The store root itself always survives.
      assert.equal(existsSync(roots.codexSessionsDir), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an aggressive retention override still never touches protected ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-transcripts-retention-'));
    try {
      const roots = makeStores(root);
      const day = join(roots.codexSessionsDir, '2026', '06', '15');
      writeFileSync(join(day, `rollout-2026-06-15T10-00-00-${UUID_B}.jsonl`), 'fresh but resumable');

      const plan = buildTranscriptPrunePlan({
        roots,
        registry: { entries: [{ name: 'kept', tool: 'codex', tool_session_id: UUID_B }] },
        ps: () => '',
        olderThanMs: 0,
      });
      assert.deepEqual(plan.candidates, []);
      assert.equal(plan.counts.kept.protected, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
