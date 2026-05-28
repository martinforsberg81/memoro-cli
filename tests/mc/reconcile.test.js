/**
 * Pure-helper tests for `mc reconcile` classifier (§9e).
 *
 * Every external dep is injected, so the classifier is driven without
 * a real `gh`, real squash-phantom run, or real ~/.claude/projects
 * filesystem.
 *
 * Buckets covered:
 *   - safe_to_end           (squash-phantom branch)
 *   - branch_merged_recently (gh PR list hit)
 *   - verify_and_end         (transcript mention + recent merged PR)
 *   - skipped                (no signals, missing branch, missing repo)
 *   - 7-day cutoff edge case (PR merged 8 days ago must NOT classify)
 *   - gh soft-degrade (gh throws → bucket empty, not crash)
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyEntries, findPrMentions, MAX_TRANSCRIPT_BYTES } from '../../src/mc/reconcile.js';

const NOW = Date.parse('2026-05-28T12:00:00Z');
const RECENT_ISO = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
const OLD_ISO    = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago

function entry(name, extra = {}) {
  return {
    name, branch: `sess/${name}`,
    worktree_path: `/tmp/wt/${name}`,
    primary_worktree: `/tmp/primary`,
    kind: 'work',
    ...extra,
  };
}

describe('findPrMentions', () => {
  test('extracts unique #NNNN mentions in insertion order', () => {
    const t = 'see #34 and #36, also #34 again, then #1';
    assert.deepEqual(findPrMentions(t), [34, 36, 1]);
  });
  test('drops zero/leading-zero/over-limit hits', () => {
    assert.deepEqual(findPrMentions('#0 #007 #1000000 #99'), [99]);
  });
  test('returns [] for empty or non-string input', () => {
    assert.deepEqual(findPrMentions(''), []);
    assert.deepEqual(findPrMentions(null), []);
  });
});

describe('classifyEntries — bucket routing', () => {
  test('squash-phantom → safe_to_end', async () => {
    const result = await classifyEntries([entry('a')], {
      detectPhantom: async () => ({ isPhantom: true, cherryConfirms: true }),
      gh: { prListMerged: async () => [], prInfo: async () => null },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.actions.safe_to_end.length, 1);
    assert.equal(result.actions.safe_to_end[0].entry.name, 'a');
    assert.equal(result.actions.safe_to_end[0].confidence, 'high');
    assert.equal(result.actions.branch_merged_recently.length, 0);
    assert.equal(result.actions.verify_and_end.length, 0);
  });

  test('phantom without cherry confirm → medium confidence', async () => {
    const result = await classifyEntries([entry('b')], {
      detectPhantom: async () => ({ isPhantom: true, cherryConfirms: false }),
      gh: { prListMerged: async () => [], prInfo: async () => null },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.actions.safe_to_end[0].confidence, 'medium');
  });

  test('recent gh branch match → branch_merged_recently', async () => {
    const result = await classifyEntries([entry('c')], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: {
        prListMerged: async () => [{ number: 42, mergedAt: RECENT_ISO }],
        prInfo: async () => null,
      },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.actions.branch_merged_recently.length, 1);
    assert.equal(result.actions.branch_merged_recently[0].prs[0].number, 42);
  });

  test('gh match > 7 days old → not classified', async () => {
    const result = await classifyEntries([entry('d')], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: {
        prListMerged: async () => [{ number: 99, mergedAt: OLD_ISO }],
        prInfo: async () => null,
      },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.actions.branch_merged_recently.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'no-signals');
  });

  test('transcript mention + recent merge → verify_and_end', async () => {
    const result = await classifyEntries([entry('e')], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: {
        prListMerged: async () => [],
        prInfo: async (n) => n === 34
          ? { number: 34, mergedAt: RECENT_ISO, title: 'orphan reap', state: 'MERGED' }
          : null,
      },
      readTranscript: async () => 'we landed #34 earlier today',
      now: NOW,
    });
    assert.equal(result.actions.verify_and_end.length, 1);
    assert.equal(result.actions.verify_and_end[0].prs[0].number, 34);
  });

  test('transcript mention but PR not merged → not classified', async () => {
    const result = await classifyEntries([entry('f')], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: {
        prListMerged: async () => [],
        prInfo: async () => ({ number: 50, mergedAt: null, state: 'OPEN' }),
      },
      readTranscript: async () => 'see #50',
      now: NOW,
    });
    assert.equal(result.actions.verify_and_end.length, 0);
  });

  test('gh throws on prListMerged → soft-degrade, not crash', async () => {
    const result = await classifyEntries([entry('g')], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: {
        prListMerged: async () => { throw new Error('gh: auth required'); },
        prInfo: async () => null,
      },
      readTranscript: async () => null,
      now: NOW,
    });
    // No crash; entry ends up skipped (no signals).
    assert.equal(result.actions.branch_merged_recently.length, 0);
    assert.equal(result.skipped.length, 1);
  });

  test('missing branch → skipped with reason', async () => {
    const result = await classifyEntries([{ name: 'no-branch', worktree_path: '/x' }], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: { prListMerged: async () => [], prInfo: async () => null },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.skipped[0].reason, 'no-branch');
  });

  test('missing repo dir → skipped with reason', async () => {
    const result = await classifyEntries([{ name: 'no-repo', branch: 'sess/x' }], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: { prListMerged: async () => [], prInfo: async () => null },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.equal(result.skipped[0].reason, 'no-repo-dir');
  });

  test('deferred_categories surfaced in result', async () => {
    const result = await classifyEntries([], {
      detectPhantom: async () => ({ isPhantom: false }),
      gh: { prListMerged: async () => [], prInfo: async () => null },
      readTranscript: async () => null,
      now: NOW,
    });
    assert.deepEqual(result.deferred_categories, ['file-overlap']);
  });
});

describe('MAX_TRANSCRIPT_BYTES', () => {
  test('exposes the 200 KB cap per coordinator', () => {
    assert.equal(MAX_TRANSCRIPT_BYTES, 200 * 1024);
  });
});
