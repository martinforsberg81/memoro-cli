import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import { run as runEnd } from '../../../src/mc/commands/end.js';
import { inspectOwnedToolArtifacts } from '../../../src/mc/tool-artifact-ownership.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { makeEntry, writeRegistry } from '../_helpers/registry-fixture.js';

describe('mc end confirmed teardown', () => {
  let repo;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'end-confirmed' });
  });

  afterEach(() => {
    repo.cleanup();
  });

  test('one y removes a dirty, unmerged worktree, branch, registry entry, and exact transcript', async () => {
    const target = makeTarget('confirmed', {
      dirty: true,
      unmerged: true,
    });
    const sibling = join(target.transcriptDir, 'sibling.jsonl');
    const sharedDb = join(target.codexHome, 'state_5.sqlite');
    writeFileSync(sibling, 'other session');
    writeFileSync(sharedDb, 'shared');

    const result = await invoke(['confirmed'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(promptCount(result.stdout), 1);
    assert.match(result.stdout, /confirmed/);
    assert.match(result.stdout, /dirty: 1/);
    assert.match(result.stdout, /ahead: 1/);
    assert.match(result.stdout, new RegExp(escapeRegExp(target.transcript)));
    assert.equal(existsSync(target.worktree), false);
    assert.equal(branchExists('sess/confirmed'), false);
    assert.equal(existsSync(target.transcript), false);
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(sharedDb), true);
    assert.deepEqual(registryEntries(), []);
  });

  test('a live session needs only the same single y confirmation', async () => {
    const target = makeTarget('live', {
      session_state: 'live',
    });

    const result = await invoke(['live'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(promptCount(result.stdout), 1);
    assert.match(result.stdout, /session: live/);
    assert.equal(existsSync(target.worktree), false);
  });

  test('n aborts the whole operation without side effects', async () => {
    const target = makeTarget('declined', {
      dirty: true,
      unmerged: true,
      session_state: 'live',
    });
    let brokerCalls = 0;
    let shredCalls = 0;

    const result = await invoke(['declined'], {
      answer: 'n',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        removeBrokerSessionForEntry: async () => {
          brokerCalls += 1;
          return { ok: true };
        },
        shredForSession: async () => {
          shredCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.equal(promptCount(result.stdout), 1);
    assert.match(result.stderr, /avbrutet|aborted/i);
    assert.equal(brokerCalls, 0);
    assert.equal(shredCalls, 0);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(branchExists('sess/declined'), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('--force performs the complete teardown without a TTY or prompt', async () => {
    const target = makeTarget('automated', {
      dirty: true,
      unmerged: true,
    });

    const result = await invoke(['automated', '--force', '--json'], {
      isTTY: false,
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(promptCount(result.stdout), 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.results[0].status.transcript.path, target.transcript);
    assert.equal(existsSync(target.transcript), false);
    assert.equal(existsSync(target.worktree), false);
    assert.equal(branchExists('sess/automated'), false);
  });

  test('--keep-branch is shown in status and preserves only the branch', async () => {
    const target = makeTarget('keep', { unmerged: true });

    const result = await invoke(['keep', '--keep-branch'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /branch: sess\/keep.*keep/i);
    assert.equal(branchExists('sess/keep'), true);
    assert.equal(existsSync(target.worktree), false);
    assert.equal(existsSync(target.transcript), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('an unverified transcript blocks the entire batch before any side effect', async () => {
    const safe = makeTarget('safe');
    const unsafe = makeTarget('unsafe', {
      transcriptPatch: { tool_transcript_path: join(repo.root, 'outside.jsonl') },
    });
    let brokerCalls = 0;

    const result = await invoke(['safe', 'unsafe'], {
      answer: 'y',
      entries: [safe.entry, unsafe.entry],
      roots: safe.roots,
      deps: {
        removeBrokerSessionForEntry: async () => {
          brokerCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.equal(promptCount(result.stdout), 0);
    assert.match(result.stderr, /unverified|ownership|authority|allowlist/i);
    assert.equal(brokerCalls, 0);
    assert.equal(existsSync(safe.worktree), true);
    assert.equal(existsSync(safe.transcript), true);
    assert.equal(registryEntries().length, 2);
  });

  test('an unsafe mc-owned sidecar path blocks before broker or teardown side effects', async () => {
    const target = makeTarget('unsafe-sidecar');
    target.entry.coding_session_id = 'coding_unsafe_sidecar';
    const outside = join(repo.root, 'outside-hosts');
    mkdirSync(join(outside, target.entry.coding_session_id), { recursive: true });
    symlinkSync(outside, join(repo.mcHome, 'hosts'));
    let brokerCalls = 0;

    const result = await invoke(['unsafe-sidecar'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        removeBrokerSessionForEntry: async () => {
          brokerCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.equal(promptCount(result.stdout), 0);
    assert.match(result.stderr, /mc-owned artifact paths|symlink-not-allowed/i);
    assert.equal(brokerCalls, 0);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('authority is revalidated for the whole batch before destructive teardown', async () => {
    const first = makeTarget('first');
    const second = makeTarget('second');
    let inspections = 0;
    let brokerCalls = 0;

    const result = await invoke(['first', 'second'], {
      answer: 'y',
      entries: [first.entry, second.entry],
      roots: first.roots,
      deps: {
        inspectOwnedToolArtifacts: async (entry, options) => {
          inspections += 1;
          if (inspections === 4) {
            return {
              state: 'unverified',
              safe_to_delete: false,
              artifacts: [],
              totals: { paths: 0, files: 0, bytes: 0 },
              issues: [{ code: 'transcript-id-mismatch' }],
            };
          }
          return inspectOwnedToolArtifacts(entry, options);
        },
        removeBrokerSessionForEntry: async () => {
          brokerCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.equal(inspections, 4);
    assert.equal(brokerCalls, 0);
    assert.equal(existsSync(first.worktree), true);
    assert.equal(existsSync(second.worktree), true);
    assert.equal(registryEntries().length, 2);
  });

  test('a transcript replaced after batch revalidation is rejected by the final inspection', async () => {
    const target = makeTarget('late-swap');
    const otherSessionId = 'session_other_owner';

    const result = await invoke(['late-swap'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        shredForSession: async ({ retainManifestOnFailure }) => {
          assert.equal(retainManifestOnFailure, true);
          writeFileSync(target.transcript, `${JSON.stringify({
            type: 'session_meta',
            payload: { id: otherSessionId, cwd: target.worktree },
          })}\n`);
          return { ok: true, shredded: [] };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /transcript.*mismatch|authority|ownership/i);
    assert.match(result.stderr, /leftovers:.*transcript/i);
    assert.equal(existsSync(target.transcript), true);
    assert.match(readFileSync(target.transcript, 'utf8'), new RegExp(otherSessionId));
    assert.equal(existsSync(target.worktree), true);
    assert.equal(branchExists('sess/late-swap'), true);
    assert.equal(registryEntries().length, 1);
  });

  test('a verified transcript already absent at final inspection remains idempotent', async () => {
    const target = makeTarget('late-absent');

    const result = await invoke(['late-absent'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        shredForSession: async () => {
          rmSync(target.transcript);
          return { ok: true, shredded: [] };
        },
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(target.worktree), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('bulk status is followed by one prompt and one decision for all targets', async () => {
    const a = makeTarget('bulk-a');
    const b = makeTarget('bulk-b');

    const result = await invoke(['bulk-a', 'bulk-b'], {
      answer: 'y',
      entries: [a.entry, b.entry],
      roots: a.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(promptCount(result.stdout), 1);
    assert.match(result.stdout, /bulk-a/);
    assert.match(result.stdout, /bulk-b/);
    assert.equal(existsSync(a.worktree), false);
    assert.equal(existsSync(b.worktree), false);
  });

  test('JSON mutation without --force returns confirmation-required and changes nothing', async () => {
    const target = makeTarget('json-confirm');

    const result = await invoke(['json-confirm', '--json'], {
      isTTY: false,
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'confirmation-required');
    assert.equal(body.confirmation_required, true);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('JSON authority failure names the unsafe target and performs no teardown', async () => {
    const target = makeTarget('json-unsafe', {
      transcriptPatch: { tool_transcript_path: join(repo.root, 'outside.jsonl') },
    });

    const result = await invoke(['json-unsafe', '--json', '--force'], {
      isTTY: false,
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, 'tool-artifact-authority-unverified');
    assert.equal(body.unsafe_targets[0].name, 'json-unsafe');
    assert.equal(existsSync(target.worktree), true);
    assert.equal(registryEntries().length, 1);
  });

  test('--dry-run reports status and authority verdict with zero side effects', async () => {
    const target = makeTarget('preview', { dirty: true, unmerged: true });

    const result = await invoke(['preview', '--dry-run', '--json'], {
      isTTY: false,
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.dry_run, true);
    assert.equal(body.targets[0].dirty_files, 1);
    assert.equal(body.targets[0].commits_ahead, 1);
    assert.equal(body.targets[0].transcript.bytes, readFileSync(target.transcript).byteLength);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('a bounded status scan reports truncation and blocks teardown without side effects', async () => {
    const target = makeTarget('bounded-status');
    const images = join(target.codexHome, 'generated_images', target.sessionId);
    mkdirSync(images, { recursive: true });
    writeFileSync(join(images, 'one.png'), 'one');
    writeFileSync(join(images, 'two.png'), 'two');

    const result = await invoke(['bounded-status', '--dry-run', '--json'], {
      isTTY: false,
      entries: [target.entry],
      roots: target.roots,
      deps: {
        toolArtifactScanPolicy: {
          max_entries: 1,
          max_depth: 8,
          max_bytes: 1024,
          max_duration_ms: 1_000,
        },
      },
    });

    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, 'tool-artifact-authority-unverified');
    assert.equal(body.targets[0].auxiliary.bounded, true);
    assert.equal(body.targets[0].auxiliary.truncated, true);
    assert.equal(body.targets[0].auxiliary.reason, 'max-entries');
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('historical entries receive exact in-memory authority backfill before status', async () => {
    const target = makeTarget('historical');
    const historical = {
      ...target.entry,
      tool_session_source: null,
      tool_session_id: null,
      tool_transcript_path: null,
    };
    let resolverCalls = 0;

    const result = await invoke(['historical'], {
      answer: 'y',
      entries: [historical],
      roots: target.roots,
      deps: {
        resolveToolSessionForResume: async () => {
          resolverCalls += 1;
          return {
            ok: true,
            from: 'transcript',
            source: 'codex',
            sessionId: target.sessionId,
            transcriptPath: target.transcript,
          };
        },
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(resolverCalls, 1);
    assert.match(result.stdout, new RegExp(escapeRegExp(target.transcript)));
    assert.equal(existsSync(target.transcript), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('a missing transcript path is repaired from the exact stored session id', async () => {
    const target = makeTarget('missing-path');
    const incomplete = {
      ...target.entry,
      tool_transcript_path: null,
    };
    let lookup = null;

    const result = await invoke(['missing-path'], {
      answer: 'y',
      entries: [incomplete],
      roots: target.roots,
      deps: {
        findTranscriptForToolSession: async (args) => {
          lookup = args;
          return {
            path: target.transcript,
            sessionId: target.sessionId,
          };
        },
      },
    });

    assert.equal(lookup.sessionId, target.sessionId);
    assert.equal(lookup.source, 'codex');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(escapeRegExp(target.transcript)));
    assert.equal(existsSync(target.transcript), false);
    assert.deepEqual(registryEntries(), []);
  });

  test('a teardown failure reports leftovers and preserves the registry for retry', async () => {
    const target = makeTarget('partial');
    let shredArgs = null;

    const result = await invoke(['partial'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        shredForSession: async (args) => {
          shredArgs = args;
          return {
            ok: false,
            failures: [{ reason: 'adapter-missing' }],
          };
        },
      },
    });

    assert.equal(result.code, 1);
    assert.equal(shredArgs.retainManifestOnFailure, true);
    assert.match(result.stderr, /failed|misslyckades/i);
    assert.match(result.stderr, /registry|worktree|transcript/i);
    assert.equal(existsSync(target.worktree), true);
    assert.equal(existsSync(target.transcript), true);
    assert.equal(registryEntries().length, 1);
  });

  test('confirmed teardown removes exact broker sidecars and the vault manifest', async () => {
    const target = makeTarget('runtime-owned');
    target.entry.coding_session_id = 'coding_runtime_owned';
    const host = join(repo.mcHome, 'hosts', target.entry.coding_session_id);
    const guard = join(repo.mcHome, 'guard-bin', target.entry.coding_session_id);
    const sibling = join(repo.mcHome, 'hosts', 'coding_other');
    const manifest = join(repo.mcHome, 'state', 'runtime-owned-materialised.json');
    mkdirSync(host, { recursive: true });
    mkdirSync(guard, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(repo.mcHome, 'state'), { recursive: true });
    writeFileSync(join(host, 'host.json'), '{}');
    writeFileSync(join(guard, 'node'), 'guard');
    writeFileSync(manifest, JSON.stringify({ materialised: [] }));

    const result = await invoke(['runtime-owned'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        shredForSession: async () => {
          rmSync(manifest);
          return {
            ok: true,
            shredded: [],
            verification: {
              manifest_path: manifest,
              manifest_absent: true,
              leftovers: [],
            },
          };
        },
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(host), false);
    assert.equal(existsSync(guard), false);
    assert.equal(existsSync(manifest), false);
    assert.equal(existsSync(sibling), true);
  });

  test('a vault manifest leftover fails final verification and keeps the registry retry recipe', async () => {
    const target = makeTarget('vault-leftover');
    const manifest = join(repo.mcHome, 'state', 'vault-leftover-materialised.json');
    mkdirSync(join(repo.mcHome, 'state'), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ materialised: [] }));

    const result = await invoke(['vault-leftover'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        shredForSession: async () => ({ ok: true, shredded: [] }),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /vault-manifest/);
    assert.equal(existsSync(manifest), true);
    assert.equal(registryEntries().length, 1);
    assert.equal(
      registryEntries()[0].tool_artifact_authority_verified.transcript_path,
      target.transcript,
    );
  });

  test('a lingering broker row fails final verification and keeps the registry', async () => {
    const target = makeTarget('broker-leftover');

    const result = await invoke(['broker-leftover'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        inspectBrokerSessionAbsence: async () => ({
          ok: false,
          state: 'present',
          issues: [{ code: 'broker-session-leftover' }],
        }),
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /broker-session-leftover/);
    assert.equal(registryEntries().length, 1);
  });

  test('a retry accepts an exact transcript already removed after recorded verification', async () => {
    const target = makeTarget('retry');

    const first = await invoke(['retry'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
      deps: {
        removeEntry: () => false,
      },
    });

    assert.equal(first.code, 1);
    assert.equal(existsSync(target.transcript), false);
    assert.equal(registryEntries().length, 1);
    assert.equal(
      registryEntries()[0].tool_artifact_authority_verified.transcript_path,
      target.transcript,
    );

    const second = await invoke(['retry', '--force'], {
      isTTY: false,
      entries: registryEntries(),
      roots: target.roots,
    });

    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(registryEntries(), []);
  });

  test('Codex teardown removes verified auxiliary artifacts and leaves siblings and shared DBs', async () => {
    const target = makeTarget('codex-auxiliary');
    const imageDir = join(target.codexHome, 'generated_images', target.sessionId);
    const imageSibling = join(target.codexHome, 'generated_images', 'other-session');
    const snapshots = join(target.codexHome, 'shell_snapshots');
    const ownedSnapshot = join(snapshots, `${target.sessionId}.123.sh`);
    const siblingSnapshot = join(snapshots, 'other-session.123.sh');
    const sharedDb = join(target.codexHome, 'logs_2.sqlite');
    mkdirSync(imageDir, { recursive: true });
    mkdirSync(imageSibling, { recursive: true });
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(imageDir, 'image.png'), 'owned');
    writeFileSync(join(imageSibling, 'image.png'), 'sibling');
    writeFileSync(ownedSnapshot, 'owned');
    writeFileSync(siblingSnapshot, 'sibling');
    writeFileSync(sharedDb, 'shared');

    const result = await invoke(['codex-auxiliary'], {
      answer: 'y',
      entries: [target.entry],
      roots: target.roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /auxiliary: 2 paths, 2 files/);
    assert.equal(existsSync(imageDir), false);
    assert.equal(existsSync(ownedSnapshot), false);
    assert.equal(existsSync(imageSibling), true);
    assert.equal(existsSync(siblingSnapshot), true);
    assert.equal(existsSync(sharedDb), true);
  });

  test('Claude teardown removes its exact transcript and all verified session directories', async () => {
    const name = 'claude-owned';
    const branch = `sess/${name}`;
    git(repo.dir, `branch ${branch} main`);
    const worktree = join(repo.mcHome, 'worktrees', 'repo', name);
    addWorktree(repo.dir, worktree, branch);
    const sessionId = 'bd7ee52d-bd2d-48e0-90a7-1423e6f92a8c';
    const projectDir = join(repo.root, '.claude', 'projects', '-repo');
    const transcript = join(projectDir, `${sessionId}.jsonl`);
    const auxiliary = join(projectDir, sessionId, 'subagents', 'agent.jsonl');
    const fileHistory = join(repo.root, '.claude', 'file-history', sessionId);
    const sessionEnv = join(repo.root, '.claude', 'session-env', sessionId);
    const tasks = join(repo.root, '.claude', 'tasks', sessionId);
    const sibling = join(repo.root, '.claude', 'tasks', 'other-session');
    const sharedMemory = join(projectDir, 'memory');
    mkdirSync(join(projectDir, sessionId, 'subagents'), { recursive: true });
    mkdirSync(fileHistory, { recursive: true });
    mkdirSync(sessionEnv, { recursive: true });
    mkdirSync(tasks, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(sharedMemory, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({
      type: 'user',
      sessionId,
      message: { role: 'user', content: 'hello' },
    })}\n`);
    writeFileSync(auxiliary, 'provider-owned auxiliary data');
    writeFileSync(join(fileHistory, 'file@v1'), 'history');
    writeFileSync(join(sessionEnv, 'env.sh'), 'env');
    writeFileSync(join(tasks, '1.json'), 'task');
    writeFileSync(join(sibling, '1.json'), 'sibling');
    writeFileSync(join(sharedMemory, 'MEMORY.md'), 'shared');
    const roots = {
      codex: {
        provider_root: join(repo.root, '.codex'),
        transcript_roots: [
          join(repo.root, '.codex', 'sessions'),
          join(repo.root, '.codex', 'archived_sessions'),
        ],
        generated_images_root: join(repo.root, '.codex', 'generated_images'),
        shell_snapshots_root: join(repo.root, '.codex', 'shell_snapshots'),
      },
      'claude-code': {
        provider_root: join(repo.root, '.claude'),
        transcript_roots: [join(repo.root, '.claude', 'projects')],
        file_history_root: join(repo.root, '.claude', 'file-history'),
        session_env_root: join(repo.root, '.claude', 'session-env'),
        tasks_root: join(repo.root, '.claude', 'tasks'),
      },
    };
    const entry = makeEntry({
      name,
      branch,
      tool: 'claude',
      worktree_path: worktree,
      primary_worktree: repo.dir,
      session_state: 'idle',
      tool_session_source: 'claude-code',
      tool_session_id: sessionId,
      tool_transcript_path: transcript,
    });

    const result = await invoke([name], {
      answer: 'y',
      entries: [entry],
      roots,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(join(projectDir, sessionId)), false);
    assert.equal(existsSync(fileHistory), false);
    assert.equal(existsSync(sessionEnv), false);
    assert.equal(existsSync(tasks), false);
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(sharedMemory), true);
  });

  function makeTarget(name, {
    dirty = false,
    unmerged = false,
    session_state = 'idle',
    transcriptPatch = {},
  } = {}) {
    const branch = `sess/${name}`;
    git(repo.dir, `branch ${branch} main`);
    const worktree = join(repo.mcHome, 'worktrees', 'repo', name);
    addWorktree(repo.dir, worktree, branch);
    if (unmerged) {
      writeFileSync(join(worktree, `${name}.txt`), `${name}\n`);
      git(worktree, `add ${name}.txt`);
      git(worktree, `commit -m "${name}"`);
    }
    if (dirty) writeFileSync(join(worktree, 'dirty.txt'), 'dirty\n');

    const codexHome = join(repo.root, '.codex');
    const transcriptDir = join(codexHome, 'sessions', '2026', '07', '23');
    const sessionId = `session_${name.replaceAll('-', '_')}`;
    const transcript = join(
      transcriptDir,
      `rollout-2026-07-23T12-00-00-${sessionId}.jsonl`,
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: worktree },
    })}\n`);

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
      codexHome,
      transcriptDir,
      transcript,
      sessionId,
      roots,
      entry: makeEntry({
        name,
        branch,
        tool: 'codex',
        worktree_path: worktree,
        primary_worktree: repo.dir,
        session_state,
        dirty_files: dirty ? 1 : 0,
        ahead: unmerged ? 1 : 0,
        safety_verdict: unmerged
          ? 'HAS_UNMERGED_WORK'
          : dirty
            ? 'NEEDS_REVIEW'
            : 'SAFE_TO_END',
        tool_session_source: 'codex',
        tool_session_id: sessionId,
        tool_transcript_path: transcript,
        ...transcriptPatch,
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
          ...deps,
        },
      });
      return { code, stdout, stderr };
    } finally {
      if (previousMcHome === undefined) delete process.env.MC_HOME;
      else process.env.MC_HOME = previousMcHome;
    }
  }

  function branchExists(branch) {
    return git(repo.dir, `branch --list ${branch}`).trim() !== '';
  }

  function registryEntries() {
    return JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8')).entries;
  }
});

function promptCount(output) {
  return (output.match(/Avsluta och ta bort allt sessionsbundet lokalt\? y\/n/g) || []).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
