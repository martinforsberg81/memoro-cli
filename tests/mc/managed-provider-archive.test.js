import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  inspectManagedProviderAbsence,
  persistManagedProviderArchive,
  restoreManagedProviderArchive,
} from '../../src/mc/managed-provider-archive.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-provider-archive-')));
  chmodSync(root, 0o700);
  const providerRoot = join(root, 'executor-a', 'provider');
  const relative = join('projects', 'repo', 'native-session.jsonl');
  const transcript = join(providerRoot, relative);
  mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 });
  writeFileSync(transcript, '{"type":"provider-event"}\n', { mode: 0o600 });
  return {
    root,
    providerRoot,
    transcript,
    descriptor: { session_id: 'sess_provider_archive' },
    artifact: {
      tool: 'future-provider',
      coding_session_id: 'sess_provider_archive',
      runtime_generation: '687c338a-1ed4-4c20-9828-1f9a39d37067',
      provider_session_id: 'native-session',
      transcript_path: transcript,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('managed archive core persists and restores a future provider without tool branches', () => {
  const built = fixture();
  try {
    const persisted = persistManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerArtifact: built.artifact,
      providerRoot: built.providerRoot,
    });
    assert.equal(persisted.ok, true);
    assert.equal(persisted.state.provider_session_id, 'native-session');

    const nextProviderRoot = join(built.root, 'executor-b', 'provider');
    mkdirSync(nextProviderRoot, { recursive: true, mode: 0o700 });
    const restored = restoreManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      codingSessionId: built.descriptor.session_id,
      providerSessionId: 'native-session',
      providerRoot: nextProviderRoot,
    });
    assert.equal(restored.ok, true);
    assert.equal(
      readFileSync(restored.transcript_path, 'utf8'),
      '{"type":"provider-event"}\n',
    );
  } finally {
    built.cleanup();
  }
});

test('managed archive core is idempotent but rejects conflicting immutable content', () => {
  const built = fixture();
  try {
    const first = persistManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerArtifact: built.artifact,
      providerRoot: built.providerRoot,
    });
    assert.equal(first.ok, true);
    const duplicate = persistManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerArtifact: built.artifact,
      providerRoot: built.providerRoot,
    });
    assert.equal(duplicate.ok, true);

    writeFileSync(built.transcript, '{"type":"changed"}\n', { mode: 0o600 });
    const conflict = persistManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerArtifact: built.artifact,
      providerRoot: built.providerRoot,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'managed-provider-archive-persist-failed');
  } finally {
    built.cleanup();
  }
});

test('provider absence accepts only an empty fresh transcript tree', () => {
  const built = fixture();
  const freshRoot = join(built.root, 'fresh-provider');
  try {
    mkdirSync(freshRoot, { recursive: true, mode: 0o700 });
    const input = {
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerRoot: freshRoot,
      transcriptRoot: join(freshRoot, 'projects'),
      generation: {
        intent: {
          data: {
            mode: 'fresh',
            tool: 'future-provider',
            resume_provider_session_id: null,
          },
        },
      },
    };
    const empty = inspectManagedProviderAbsence(input);
    assert.equal(empty.ok, true);
    assert.match(empty.evidence_digest, /^[a-f0-9]{64}$/u);

    const unexpected = join(freshRoot, 'projects', 'repo', 'unexpected.jsonl');
    mkdirSync(dirname(unexpected), { recursive: true, mode: 0o700 });
    writeFileSync(unexpected, '{}\n', { mode: 0o600 });
    assert.equal(
      inspectManagedProviderAbsence(input).reason,
      'managed-provider-absence-artifact-present',
    );
  } finally {
    built.cleanup();
  }
});

test('provider absence accepts one exact restored archive and rejects mutation', () => {
  const built = fixture();
  try {
    assert.equal(persistManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerArtifact: built.artifact,
      providerRoot: built.providerRoot,
    }).ok, true);
    const resumedRoot = join(built.root, 'resumed-provider');
    mkdirSync(resumedRoot, { recursive: true, mode: 0o700 });
    const restored = restoreManagedProviderArchive({
      root: built.root,
      tool: 'future-provider',
      codingSessionId: built.descriptor.session_id,
      providerSessionId: 'native-session',
      providerRoot: resumedRoot,
    });
    assert.equal(restored.ok, true);
    const input = {
      root: built.root,
      tool: 'future-provider',
      descriptor: built.descriptor,
      providerRoot: resumedRoot,
      transcriptRoot: join(resumedRoot, 'projects'),
      generation: {
        intent: {
          data: {
            mode: 'resume',
            tool: 'future-provider',
            resume_provider_session_id: 'native-session',
          },
        },
      },
    };
    assert.equal(inspectManagedProviderAbsence(input).ok, true);
    writeFileSync(restored.transcript_path, '{"type":"changed"}\n', { mode: 0o600 });
    assert.equal(
      inspectManagedProviderAbsence(input).reason,
      'managed-provider-absence-restored-state-changed',
    );
  } finally {
    built.cleanup();
  }
});
