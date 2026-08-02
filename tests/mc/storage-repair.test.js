import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyStorageRepairPlan,
  buildStorageRepairPlan,
} from '../../src/mc/storage-repair.js';
import { makeEntry } from './_helpers/registry-fixture.js';

describe('storage repair planning', () => {
  test('preserves registry-live sessions when the host socket answers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-storage-repair-'));
    const previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = root;
    try {
      mkdirSync(join(root, 'hosts', 'sess_live'), { recursive: true });
      writeFileSync(join(root, 'hosts', 'sess_live', 'broker.sock'), '');
      const registry = {
        entries: [
          makeEntry({
            name: 'live-host',
            worktree_path: null,
            session_state: 'live',
            coding_session_id: 'sess_live',
            tool: 'codex',
            tool_session_id: 'cx_live',
          }),
        ],
      };

      const plan = await buildStorageRepairPlan({
        registry,
        listSessions: async () => [],
        request: async (message) => (message.type === 'status' ? { ok: true } : { ok: false }),
      });

      assert.equal(plan.counts.total, 0);
    } finally {
      if (previousMcHome == null) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('marks live entries idle when the host pid lingers without a socket', async () => {
    // A daemon pid alive with a missing (or dead) socket is unattachable —
    // trusting pids kept such sessions marked live forever while mc list
    // correctly showed them stale.
    const root = mkdtempSync(join(tmpdir(), 'mc-storage-repair-'));
    const previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = root;
    try {
      mkdirSync(join(root, 'hosts', 'sess_zombie'), { recursive: true });
      writeFileSync(join(root, 'hosts', 'sess_zombie', 'broker.pid'), `${process.pid}\n`);
      const registry = {
        entries: [
          makeEntry({
            name: 'zombie-host',
            worktree_path: null,
            session_state: 'live',
            coding_session_id: 'sess_zombie',
            tool: 'claude',
            tool_session_id: 'cl_zombie',
          }),
        ],
      };

      const plan = await buildStorageRepairPlan({
        registry,
        listSessions: async () => [],
        request: async () => { throw new Error('no socket'); },
      });

      assert.equal(plan.counts.total, 1);
      assert.equal(plan.actions[0].type, 'mark-idle');
      assert.equal(plan.actions[0].name, 'zombie-host');
    } finally {
      if (previousMcHome == null) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips provider transcript scans unless provider backfill is requested', async () => {
    const registry = {
      entries: [
        makeEntry({
          session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
          repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
          name: 'needs-provider',
          worktree_path: null,
          session_state: 'idle',
          coding_session_id: 'sess_needs_provider',
          tool: 'codex',
          tool_session_id: null,
        }),
      ],
    };
    let scanned = false;

    const plan = await buildStorageRepairPlan({
      registry,
      listSessions: async () => [],
      resolveToolSession: async () => {
        scanned = true;
        return { ok: true, sessionId: 'cx_should_not_scan' };
      },
    });

    assert.equal(scanned, false);
    assert.equal(plan.counts.total, 0);
  });

  test('plans and applies provider-native session id backfills', async () => {
    const registry = {
      entries: [
        makeEntry({
          session_id: 'mcs_cccccccccccccccccccccccc',
          repository_id: 'repo_dddddddddddddddddddddddd',
          name: 'needs-provider',
          worktree_path: null,
          session_state: 'idle',
          coding_session_id: 'sess_needs_provider',
          tool: 'codex',
          tool_session_id: null,
        }),
      ],
    };

    const plan = await buildStorageRepairPlan({
      registry,
      now: Date.parse('2026-07-18T10:00:00.000Z'),
      listSessions: async () => [],
      includeProviderBackfill: true,
      resolveToolSession: async ({ entry, launchTool }) => ({
        ok: true,
        source: launchTool.shortName,
        sessionId: `cx_${entry.name}`,
        transcriptPath: '/tmp/codex-session.jsonl',
        from: 'transcript',
      }),
    });

    assert.equal(plan.counts.total, 1);
    assert.equal(plan.actions[0].type, 'backfill-tool-session');
    assert.equal(plan.actions[0].patch.tool_session_id, 'cx_needs-provider');
    assert.equal(plan.actions[0].patch.tool_session_source, 'codex');

    let written = null;
    const result = applyStorageRepairPlan(registry, plan, {
      write: (next) => { written = next; },
    });

    assert.equal(result.ok, true);
    assert.equal(written.entries[0].tool_session_id, 'cx_needs-provider');
    assert.equal(written.entries[0].tool_transcript_path, '/tmp/codex-session.jsonl');
  });
});

describe('storage repair consumes the liveness engine', () => {
  const LIFECYCLE = (id, state) => JSON.stringify({
    schema: 'mc-broker-lifecycle-journal',
    version: 1,
    coding_session_id: id,
    runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
    state,
    observed_at: '2026-08-02T10:00:00.000Z',
    ...(state === 'exited' ? { exit_code: 0 } : {}),
  });

  test('a restarted empty host proves the live row stale — socket answering is not liveness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-storage-repair-'));
    const previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = root;
    try {
      const hostDir = join(root, 'hosts', 'sess_restarted');
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(join(hostDir, 'broker.sock'), '');
      writeFileSync(join(hostDir, 'lifecycle.json'), LIFECYCLE('sess_restarted', 'live'), { mode: 0o600 });
      const registry = {
        entries: [makeEntry({
          name: 'restarted-host',
          worktree_path: null,
          session_state: 'live',
          coding_session_id: 'sess_restarted',
          tool: 'codex',
          tool_session_id: 'cx_restarted',
        })],
      };

      const plan = await buildStorageRepairPlan({
        registry,
        listSessions: async () => [],
        request: async (message) => (message.type === 'status'
          ? { ok: true }
          : { ok: true, sessions: [] }),
      });

      assert.equal(plan.actions.length, 1);
      assert.equal(plan.actions[0].type, 'mark-idle');
    } finally {
      if (previousMcHome == null) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a live journal without exit proof keeps the row — repair fails closed on unreachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-storage-repair-'));
    const previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = root;
    try {
      const hostDir = join(root, 'hosts', 'sess_unreach');
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(join(hostDir, 'lifecycle.json'), LIFECYCLE('sess_unreach', 'live'), { mode: 0o600 });
      const registry = {
        entries: [makeEntry({
          name: 'unreachable-host',
          worktree_path: null,
          session_state: 'live',
          coding_session_id: 'sess_unreach',
          tool: 'codex',
          tool_session_id: 'cx_unreach',
        })],
      };

      const plan = await buildStorageRepairPlan({
        registry,
        listSessions: async () => [],
        request: async () => {
          throw Object.assign(new Error('connect EPERM'), { code: 'EPERM' });
        },
      });

      assert.equal(plan.counts.total, 0);
    } finally {
      if (previousMcHome == null) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
