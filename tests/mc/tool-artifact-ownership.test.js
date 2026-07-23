import assert from 'node:assert/strict';
import {
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
  inspectOwnedToolArtifacts,
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
      transcript_roots: [
        join(codexHome, 'sessions'),
        join(codexHome, 'archived_sessions'),
      ],
    },
    'claude-code': {
      transcript_roots: [join(claudeHome, 'projects')],
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
  test('returns only the exact Codex registry transcript when provider siblings exist', async () => {
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
    writeFileSync(join(snapshots, 'other-session.123.sh'), 'other');

    const result = await inspectOwnedToolArtifacts(codexEntry(transcript, id), { roots });

    assert.equal(result.state, 'owned');
    assert.equal(result.safe_to_delete, true);
    assert.deepEqual(result.artifacts, [{
      kind: 'transcript',
      path: transcript,
      type: 'file',
      bytes: readFileSync(transcript).byteLength,
      file_count: 1,
      ownership: 'verified',
    }]);
    assert.deepEqual(result.totals, {
      paths: 1,
      files: 1,
      bytes: readFileSync(transcript).byteLength,
    });
  });

  test('returns only the exact Claude registry transcript when its sibling directory exists', async () => {
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

    const result = await inspectOwnedToolArtifacts(claudeEntry(transcript, id), { roots });

    assert.equal(result.state, 'owned');
    assert.equal(result.safe_to_delete, true);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), [transcript]);
    assert.equal(result.totals.paths, 1);
    assert.equal(result.totals.files, 1);
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
