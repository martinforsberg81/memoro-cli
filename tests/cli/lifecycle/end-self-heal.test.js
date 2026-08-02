import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import { run as runEnd } from '../../../src/cli/end.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { makeEntry, writeRegistry } from '../../mc/_helpers/registry-fixture.js';

describe('mc end self-heal and loss-free teardown', () => {
  let repo;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'end-self-heal' });
  });

  afterEach(() => {
    repo.cleanup();
  });

  test('a stale live registry row with a dead broker is repaired inline and torn down', async () => {
    const target = makeTarget('stale-live', { session_state: 'live' });
    const repairPlans = [];

    const result = await invoke(['stale-live'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        removeBrokerSessionForEntry: async () => ({
          ok: false,
          reason: 'broker-unavailable',
        }),
        buildStorageRepairPlan: async (arg) => {
          repairPlans.push(arg);
          // session_id is minted by the registry migration inside run(),
          // so resolve the row from the arg instead of the fixture.
          const row = (arg.registry?.entries || [])
            .find((candidate) => candidate.session_id === arg.names?.[0]);
          assert.ok(row, 'repair plan must be scoped to the target row');
          return {
            ok: true,
            actions: [{
              type: 'mark-idle',
              name: row.name,
              session_id: row.session_id,
              repository_id: row.repository_id,
              reason: 'registry-live-without-local-broker',
              worktree_path: row.worktree_path,
              patch: {
                session_state: 'idle',
                last_storage_repair_reason: 'registry-live-without-local-broker',
              },
            }],
          };
        },
        applyStorageRepairPlan: () => ({ ok: true, applied: [] }),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(repairPlans.length, 1);
    assert.equal(repairPlans[0].names?.length, 1);
    assert.equal(existsSync(target.worktree), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('a genuinely live session still fails closed when the broker is unreachable', async () => {
    const target = makeTarget('really-live', { session_state: 'live' });

    const result = await invoke(['really-live'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        removeBrokerSessionForEntry: async () => ({
          ok: false,
          reason: 'broker-unavailable',
        }),
        // The repair plan finds no mark-idle action: the probe says the
        // session is still attachable.
        buildStorageRepairPlan: async () => ({ ok: true, actions: [] }),
        applyStorageRepairPlan: () => assert.fail('must not apply an empty repair'),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /broker cleanup failed/);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
  });

  test('one failing target no longer strands the rest of the batch', async () => {
    const failing = makeTarget('batch-fail');
    const passing = makeTarget('batch-pass');

    const result = await invoke(['batch-fail', 'batch-pass'], {
      answer: 'y',
      entries: [failing.entry, passing.entry],
      roots: failing.roots,
      deps: {
        shredForSession: async ({ worktreePath }) => (
          worktreePath === failing.worktree
            ? { ok: false, failures: [{ reason: 'vault-locked' }] }
            : { ok: true, shredded: [] }
        ),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout + result.stderr, /batch-fail/);
    // The failing target kept its artifacts…
    assert.equal(existsSync(failing.worktree), true);
    // …but the passing target was fully torn down anyway.
    assert.equal(existsSync(passing.worktree), false);
    assert.equal(existsSync(passing.transcript), false);
    assert.deepEqual(registryEntries().map((entry) => entry.name), ['batch-fail']);
  });

  test('the transcript is distilled before deletion and passes exact identity', async () => {
    const target = makeTarget('distill-first');
    const uploads = [];
    const order = [];

    const result = await invoke(['distill-first'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        runSessionUploadSync: async (arg) => {
          uploads.push(arg);
          order.push('distill');
          assert.equal(existsSync(target.transcript), true, 'transcript must still exist at distill time');
          return { ok: true };
        },
        removeBrokerSessionForEntry: async () => {
          order.push('broker');
          return { ok: false, skipped: true, reason: 'not-found' };
        },
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(order, ['distill', 'broker']);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].transcriptPath, target.transcript);
    assert.equal(uploads[0].source, 'codex');
    assert.equal(uploads[0].codingSessionId, target.entry.coding_session_id);
    assert.equal(existsSync(target.transcript), false);
  });

  test('a failed distill aborts the target before anything is destroyed', async () => {
    const target = makeTarget('distill-fail');

    const result = await invoke(['distill-fail'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        runSessionUploadSync: async () => ({ ok: false, reason: 'upload-exit-1' }),
        removeBrokerSessionForEntry: async () => assert.fail('nothing may be destroyed after a failed distill'),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /transcript distill failed before deletion \(upload-exit-1\)/);
    assert.match(result.stderr, /--no-distill/);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('a failed distill surfaces the upload child\'s real error, not just the exit code', async () => {
    const target = makeTarget('distill-detail');

    const result = await invoke(['distill-detail'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        runSessionUploadSync: async () => ({
          ok: false,
          reason: 'upload-exit-1',
          output: 'uploading…\nError: Memoro 413: Payload exceeds 32768 bytes\n    at request (file:///x.js:1:1)\n',
        }),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /upload-exit-1: Error: Memoro 413: Payload exceeds 32768 bytes/);
  });

  test('a transcript shared by two sessions is retained until the last holder ends', async () => {
    const first = makeTarget('shared-a');
    const second = makeTarget('shared-b', { shareTranscriptOf: first });

    const result = await invoke(['shared-a'], {
      answer: 'y',
      entries: [first.entry, second.entry],
      roots: first.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /retained: tool-artifacts:shared-with:shared-b/);
    // The sibling still distills from this transcript — it must survive…
    assert.equal(existsSync(first.transcript), true);
    // …while the session's own artifacts are fully gone.
    assert.equal(existsSync(first.worktree), false);
    assert.deepEqual(registryEntries().map((entry) => entry.name), ['shared-b']);

    // The last holder out deletes the shared transcript.
    const last = await invoke(['shared-b'], {
      answer: 'y',
      entries: registryEntries(),
      roots: second.roots,
    });
    assert.equal(last.code, 0, last.stderr);
    assert.equal(existsSync(first.transcript), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('--no-distill skips the upload gate explicitly', async () => {
    const target = makeTarget('distill-optout');

    const result = await invoke(['distill-optout', '--no-distill'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        runSessionUploadSync: async () => assert.fail('--no-distill must not upload'),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(target.transcript), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('a session that never launched skips the distill gate', async () => {
    const target = makeTarget('never-launched', { coding_session_id: null });

    const result = await invoke(['never-launched'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        runSessionUploadSync: async () => assert.fail('nothing to distill without a coding session'),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(registryEntries(), []);
  });

  function makeTarget(name, {
    session_state = 'idle',
    coding_session_id = `coding_${name.replaceAll('-', '_')}`,
    shareTranscriptOf = null,
  } = {}) {
    const branch = `sess/${name}`;
    git(repo.dir, `branch ${branch} main`);
    const worktree = join(repo.mcHome, 'worktrees', 'repo', name);
    addWorktree(repo.dir, worktree, branch);

    const codexHome = join(repo.root, '.codex');
    const transcriptDir = join(codexHome, 'sessions', '2026', '07', '23');
    const sessionId = shareTranscriptOf
      ? shareTranscriptOf.entry.tool_session_id
      : `session_${name.replaceAll('-', '_')}`;
    const transcript = shareTranscriptOf
      ? shareTranscriptOf.transcript
      : join(transcriptDir, `rollout-2026-07-23T12-00-00-${sessionId}.jsonl`);
    if (!shareTranscriptOf) {
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd: worktree },
      })}\n`);
    }

    const roots = {
      codex: {
        provider_root: codexHome,
        transcript_roots: [
          join(codexHome, 'sessions'),
          join(codexHome, 'archived_sessions'),
        ],
        generated_images_root: join(codexHome, 'generated_images'),
        shell_snapshots_root: join(codexHome, 'shell_snapshots'),
      },
      'claude-code': {
        provider_root: join(repo.root, '.claude'),
        transcript_roots: [join(repo.root, '.claude', 'projects')],
        file_history_root: join(repo.root, '.claude', 'file-history'),
        session_env_root: join(repo.root, '.claude', 'session-env'),
        tasks_root: join(repo.root, '.claude', 'tasks'),
      },
    };
    return {
      branch,
      worktree,
      transcript,
      roots,
      entry: makeEntry({
        name,
        branch,
        tool: 'codex',
        worktree_path: worktree,
        primary_worktree: repo.dir,
        session_state,
        coding_session_id,
        tool_session_source: 'codex',
        tool_session_id: sessionId,
        tool_transcript_path: transcript,
      }),
    };
  }

  async function invoke(argv, {
    answer = null,
    isTTY = true,
    entries,
    roots,
    deps = {},
  }) {
    writeRegistry(repo.mcHome, entries);
    const previousMcHome = process.env.MC_HOME;
    let stdout = '';
    let stderr = '';
    process.env.MC_HOME = repo.mcHome;
    try {
      const code = await runEnd(argv, {
        cwd: repo.dir,
        stdin: { isTTY },
        stdout: { isTTY, write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
        deps: {
          isTTY,
          readLine: async () => answer || '',
          toolArtifactRoots: roots,
          removeBrokerSessionForEntry: async () => ({
            ok: false,
            skipped: true,
            reason: 'not-found',
          }),
          shredForSession: async () => ({ ok: true, shredded: [] }),
          runSessionUploadSync: async () => ({ ok: true }),
          ...deps,
        },
      });
      return { code, stdout, stderr };
    } finally {
      if (previousMcHome === undefined) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
    }
  }

  function registryEntries() {
    return JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8')).entries;
  }
});
