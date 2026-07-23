import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import {
  classifyToolArtifactAuthority,
  deleteOwnedToolArtifacts,
  inspectOwnedToolArtifacts,
  nodeFsPortal,
  TOOL_ARTIFACT_AUTHORITY_VERSION,
} from '../../src/mc/tool-artifact-ownership.js';

let tmp = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function fixtureRoots() {
  tmp = mkdtempSync(join(tmpdir(), 'mc-tool-artifacts-'));
  const codexHome = join(tmp, '.codex');
  const claudeHome = join(tmp, '.claude');
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
      provider_root: claudeHome,
      transcript_roots: [join(claudeHome, 'projects')],
      file_history_root: join(claudeHome, 'file-history'),
      session_env_root: join(claudeHome, 'session-env'),
      tasks_root: join(claudeHome, 'tasks'),
    },
  };
  return { roots, codexHome, claudeHome };
}

function codexEntry(path, id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c') {
  return {
    name: 'codex-session',
    tool: 'codex',
    session_state: 'idle',
    tool_session_source: 'codex',
    tool_session_id: id,
    tool_transcript_path: path,
  };
}

function claudeEntry(path, id = 'bd7ee52d-bd2d-48e0-90a7-1423e6f92a8c') {
  return {
    name: 'claude-session',
    tool: 'claude',
    session_state: 'idle',
    tool_session_source: 'claude-code',
    tool_session_id: id,
    tool_transcript_path: path,
  };
}

describe('LLM tool artifact ownership', () => {
  test('returns the exact Codex transcript, generated images, and matching shell snapshots', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );
    mkdirSync(join(codexHome, 'sessions', '2026', '07', '23'), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd: '/repo' },
    })}\n`);

    const imageDir = join(codexHome, 'generated_images', id);
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'image.png'), 'image');
    const snapshots = join(codexHome, 'shell_snapshots');
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, `${id}.123.sh`), 'env');
    writeFileSync(join(snapshots, `${id}.456.sh`), 'more env');
    writeFileSync(join(snapshots, 'other-session.123.sh'), 'other');

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'owned');
    assert.equal(result.safe_to_delete, true);
    assert.deepEqual(result.artifacts.map((artifact) => [artifact.kind, artifact.path]), [
      ['transcript', transcript],
      ['codex-generated-images', imageDir],
      ['codex-shell-snapshot', join(snapshots, `${id}.123.sh`)],
      ['codex-shell-snapshot', join(snapshots, `${id}.456.sh`)],
    ]);
    assert.deepEqual(result.totals, {
      paths: 4,
      files: 4,
      bytes: readFileSync(transcript).byteLength + 5 + 3 + 8,
    });
    assert.equal(result.scan.truncated, false);
  });

  test('returns exact Claude project and global session directories while excluding shared memory', async () => {
    const { roots, claudeHome } = fixtureRoots();
    const id = 'bd7ee52d-bd2d-48e0-90a7-1423e6f92a8c';
    const project = join(claudeHome, 'projects', '-Users-me-repo');
    const transcript = join(project, `${id}.jsonl`);
    mkdirSync(project, { recursive: true });
    writeFileSync(transcript, [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', sessionId: id }),
    ].join('\n'));
    const auxiliary = join(project, id, 'subagents');
    mkdirSync(auxiliary, { recursive: true });
    writeFileSync(join(auxiliary, 'agent-a.jsonl'), 'agent');
    const fileHistory = join(claudeHome, 'file-history', id);
    const sessionEnv = join(claudeHome, 'session-env', id);
    const tasks = join(claudeHome, 'tasks', id);
    mkdirSync(fileHistory, { recursive: true });
    mkdirSync(sessionEnv, { recursive: true });
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(fileHistory, 'file@v1'), 'history');
    writeFileSync(join(sessionEnv, 'env.sh'), 'env');
    writeFileSync(join(tasks, '1.json'), 'task');
    const sharedMemory = join(project, 'memory');
    mkdirSync(sharedMemory, { recursive: true });
    writeFileSync(join(sharedMemory, 'MEMORY.md'), 'shared');

    const result = await inspectOwnedToolArtifacts(claudeEntry(transcript, id), { roots });

    assert.equal(result.state, 'owned');
    assert.equal(result.safe_to_delete, true);
    assert.deepEqual(result.artifacts.map((artifact) => [artifact.kind, artifact.path]), [
      ['transcript', transcript],
      ['claude-file-history', fileHistory],
      ['claude-project-session-data', join(project, id)],
      ['claude-session-env', sessionEnv],
      ['claude-tasks', tasks],
    ]);
    assert.equal(result.totals.paths, 5);
    assert.equal(result.totals.files, 5);
    assert.equal(result.artifacts.some((artifact) => artifact.path === sharedMemory), false);
  });

  test('fails closed when an auxiliary tree contains a symlink', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );
    mkdirSync(join(codexHome, 'sessions', '2026', '07', '23'), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
    const imageDir = join(codexHome, 'generated_images', id);
    const outside = join(tmp, 'outside.png');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(imageDir, 'escape.png'));

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'symlink-not-allowed');
    assert.deepEqual(result.artifacts, []);
  });

  test('reports a bounded auxiliary scan as truncated instead of walking indefinitely', async () => {
    const { roots, claudeHome } = fixtureRoots();
    const id = 'bd7ee52d-bd2d-48e0-90a7-1423e6f92a8c';
    const project = join(claudeHome, 'projects', '-Users-me-repo');
    const transcript = join(project, `${id}.jsonl`);
    const auxiliary = join(project, id);
    mkdirSync(auxiliary, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: id })}\n`);
    writeFileSync(join(auxiliary, 'one.jsonl'), 'one');
    writeFileSync(join(auxiliary, 'two.jsonl'), 'two');

    const result = await inspectOwnedToolArtifacts(claudeEntry(transcript, id), {
      roots,
      scanPolicy: {
        max_entries: 1,
        max_depth: 8,
        max_bytes: 1024,
        max_duration_ms: 1_000,
      },
    });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'artifact-scan-truncated');
    assert.equal(result.issues[0].reason, 'max-entries');
    assert.equal(result.scan.truncated, true);
  });

  test('detects a late inode swap immediately before deletion', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );
    mkdirSync(join(codexHome, 'sessions', '2026', '07', '23'), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
    const base = nodeFsPortal();
    let swapped = false;
    const fs = {
      ...base,
      async removeFile(path, fingerprint) {
        if (!swapped) {
          swapped = true;
          rmSync(path);
          writeFileSync(path, `${JSON.stringify({
            type: 'session_meta',
            payload: { id: 'other-session' },
          })}\n`);
        }
        return base.removeFile(path, fingerprint);
      },
    };

    const result = await deleteOwnedToolArtifacts(codexEntry(transcript, id), { roots, fs });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'artifact-delete-failed');
    assert.equal(result.issues[0].fs_code, 'ARTIFACT_CHANGED');
    assert.equal(existsSync(transcript), true);
  });

  test('a recorded authority can inventory auxiliary leftovers after transcript deletion', async () => {
    const { roots, claudeHome } = fixtureRoots();
    const id = 'bd7ee52d-bd2d-48e0-90a7-1423e6f92a8c';
    const project = join(claudeHome, 'projects', '-Users-me-repo');
    const transcript = join(project, `${id}.jsonl`);
    const tasks = join(claudeHome, 'tasks', id);
    mkdirSync(project, { recursive: true });
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, '1.json'), 'leftover');
    const entry = {
      ...claudeEntry(transcript, id),
      tool_artifact_authority_verified: {
        version: TOOL_ARTIFACT_AUTHORITY_VERSION,
        source: 'claude-code',
        session_id: id,
        transcript_path: transcript,
      },
    };

    const result = await inspectOwnedToolArtifacts(entry, {
      roots,
      allowVerifiedMissingTranscript: true,
    });

    assert.equal(result.state, 'owned');
    assert.equal(result.transcript_missing, true);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), [tasks]);
  });

  test('rejects a registry tool that does not match its provider source', () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );

    const result = classifyToolArtifactAuthority({
      ...codexEntry(transcript, id),
      tool: 'claude',
    }, { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'tool-source-mismatch');
  });

  test('rejects a transcript path outside the provider allowlist', () => {
    const { roots } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const result = classifyToolArtifactAuthority(
      codexEntry(join(tmp, 'state_5.sqlite'), id),
      { roots },
    );

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'transcript-outside-allowlist');
  });

  test('rejects provider id mismatch even when the filename matches registry', async () => {
    const { roots, codexHome } = fixtureRoots();
    const registryId = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const fileId = '019f8f5d-9734-7cc0-94f7-d3d406305c1d';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${registryId}.jsonl`,
    );
    mkdirSync(join(codexHome, 'sessions', '2026', '07', '23'), { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: fileId },
    })}\n`);

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, registryId), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'transcript-id-mismatch');
    assert.deepEqual(result.artifacts, []);
  });

  test('reports a missing exact transcript as unverified and non-deletable', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const transcript = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'transcript-missing');
  });

  test('rejects a symlinked transcript without following it', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const sessions = join(codexHome, 'sessions', '2026', '07', '23');
    const transcript = join(sessions, `rollout-2026-07-23T12-00-00-${id}.jsonl`);
    const outside = join(tmp, 'outside.jsonl');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(outside, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);
    symlinkSync(outside, transcript);

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'symlink-not-allowed');
  });

  test('rejects a symlinked parent that escapes the allowlist', async () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const sessionsRoot = join(codexHome, 'sessions');
    const outsideYear = join(tmp, 'outside-year');
    const outsideDay = join(outsideYear, '07', '23');
    mkdirSync(sessionsRoot, { recursive: true });
    mkdirSync(outsideDay, { recursive: true });
    symlinkSync(outsideYear, join(sessionsRoot, '2026'));
    const transcript = join(
      sessionsRoot,
      '2026',
      '07',
      '23',
      `rollout-2026-07-23T12-00-00-${id}.jsonl`,
    );
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`);

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'symlink-not-allowed');
  });

  test('rejects lexical traversal before any filesystem inspection', () => {
    const { roots, codexHome } = fixtureRoots();
    const id = '019f8f5d-9734-7cc0-94f7-d3d406305c1c';
    const traversal = `${join(codexHome, 'sessions', '2026', '07', '23')}/../23/rollout-${id}.jsonl`;

    const result = classifyToolArtifactAuthority(codexEntry(traversal, id), { roots });

    assert.equal(result.state, 'unverified');
    assert.equal(result.safe_to_delete, false);
    assert.equal(result.issues[0].code, 'invalid-transcript-path');
  });

  test('recognizes a never-launched registry entry as having no tool artifacts', async () => {
    const { roots } = fixtureRoots();
    const result = await inspectOwnedToolArtifacts({
      name: 'not-launched',
      tool: 'codex',
      session_state: 'no-session-yet',
      tool_session_source: null,
      tool_session_id: null,
      tool_transcript_path: null,
    }, { roots });

    assert.equal(result.state, 'none');
    assert.equal(result.safe_to_delete, true);
    assert.deepEqual(result.totals, { paths: 0, files: 0, bytes: 0 });
  });
});
