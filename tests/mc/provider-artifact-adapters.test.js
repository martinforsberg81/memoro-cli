import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  PROVIDER_ARTIFACT_ADAPTER_SCHEMA,
  createProviderArtifactAdapterRegistry,
  providerArtifactContextForLaunch,
  validateProviderArtifactEvidence,
} from '../../src/mc/provider-artifact-adapters/index.js';
import {
  captureContext as captureClaudeContext,
  validate as validateClaudeArtifact,
} from '../../src/mc/provider-artifact-adapters/claude-code.js';
import { encodeClaudeProjectPath } from '../../src/lib/claude.js';
import {
  observe as observeCodexArtifact,
} from '../../src/mc/provider-artifact-adapters/codex.js';

function fixtureAdapter({ toolId = 'future-provider-v1', calls = [] } = {}) {
  return {
    schema: PROVIDER_ARTIFACT_ADAPTER_SCHEMA,
    tool_id: toolId,
    captureContext(input) {
      calls.push(['context', input]);
      return { root: '/provider/sessions' };
    },
    validate(input) {
      calls.push(['validate', input]);
      return input.context?.root === '/provider/sessions'
        ? { ok: true, workspace: '/repo', transcriptPath: '/provider/sessions/exact.jsonl' }
        : { ok: false, reason: 'context-mismatch' };
    },
  };
}

test('provider artifact core routes a future tool through one registered adapter', () => {
  const calls = [];
  const registry = createProviderArtifactAdapterRegistry([
    fixtureAdapter({ calls }),
  ]);
  const context = providerArtifactContextForLaunch({
    registry,
    tool: 'future-provider-v1',
    provider: { opaque: true },
  });
  assert.deepEqual(context, { root: '/provider/sessions' });
  const checked = validateProviderArtifactEvidence({
    registry,
    tool: 'future-provider-v1',
    evidence: { providerSessionId: 'native-id' },
    context,
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(calls.map(([operation]) => operation), ['context', 'validate']);
});

test('provider artifact registry rejects partial, duplicate, and unregistered adapters', () => {
  const adapter = fixtureAdapter();
  assert.throws(
    () => createProviderArtifactAdapterRegistry([adapter, adapter]),
    /duplicated/,
  );
  assert.throws(
    () => createProviderArtifactAdapterRegistry([{ ...adapter, validate: null }]),
    /contract is invalid/,
  );
  const registry = createProviderArtifactAdapterRegistry([adapter]);
  assert.equal(validateProviderArtifactEvidence({
    registry,
    tool: 'unregistered-provider',
    evidence: {},
    context: {},
  }).reason, 'provider-artifact-tool-unsupported');
});

test('provider artifact registry exposes metadata only', () => {
  const registry = createProviderArtifactAdapterRegistry([fixtureAdapter()]);
  assert.deepEqual(registry.list(), [{
    schema: PROVIDER_ARTIFACT_ADAPTER_SCHEMA,
    tool_id: 'future-provider-v1',
  }]);
  assert.doesNotMatch(JSON.stringify(registry.list()), /function|path|token|credential/i);
});

test('Claude artifact ownership follows the launch-scoped config directory', () => {
  assert.deepEqual(captureClaudeContext({
    provider: {
      env: {
        CLAUDE_CONFIG_DIR: '/managed/executor/claude-config',
      },
    },
    input: {
      env: {
        CLAUDE_CONFIG_DIR: '/caller/claude-config',
      },
    },
  }), {
    projects_dir: '/managed/executor/claude-config/projects',
  });
});

test('Codex observation accepts one exact private transcript and rejects ambiguity', () => {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'mc-codex-artifact-observer-',
  )));
  const sessionsDir = join(root, 'sessions');
  const cwd = join(root, 'workspace');
  const firstId = '019fade4-e16b-70f0-9e5f-559cf9454cf8';
  const secondId = '019fade7-639a-7a33-a5d8-7e49d575022a';
  const firstPath = join(
    sessionsDir,
    '2026',
    '07',
    '30',
    `rollout-2026-07-30T10-00-00-${firstId}.jsonl`,
  );
  const secondPath = join(
    sessionsDir,
    '2026',
    '07',
    '30',
    `rollout-2026-07-30T11-00-00-${secondId}.jsonl`,
  );
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(firstPath), { recursive: true });
  writeFileSync(firstPath, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: firstId, cwd },
  })}\n`);
  try {
    const fresh = observeCodexArtifact({
      cwd,
      context: {
        sessions_dir: sessionsDir,
        expected_provider_session_id: null,
      },
    });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.evidence.providerSessionId, firstId);
    assert.equal(fresh.evidence.transcriptPath, firstPath);

    writeFileSync(secondPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: secondId, cwd },
    })}\n`);
    assert.equal(observeCodexArtifact({
      cwd,
      context: {
        sessions_dir: sessionsDir,
        expected_provider_session_id: null,
      },
    }).reason, 'provider-artifact-observation-ambiguous');

    const resumed = observeCodexArtifact({
      cwd,
      context: {
        sessions_dir: sessionsDir,
        expected_provider_session_id: secondId,
      },
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.evidence.providerSessionId, secondId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude artifact confirms before the transcript is written and stays path-bound', () => {
  // Claude Code creates its transcript on the first user turn — after the
  // SessionStart hook fires. The provider artifact must confirm at launch, so
  // it cannot require the file to exist yet; it must still bind the exact
  // constrained path so a hook cannot point the transcript elsewhere.
  const root = mkdtempSync(join(tmpdir(), 'claude-artifact-'));
  try {
    const projectsDir = join(root, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    const sessionId = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
    const workspace = realpathSync(cwd);
    const expectedDir = join(realpathSync(projectsDir), encodeClaudeProjectPath(workspace));
    const expected = join(expectedDir, `${sessionId}.jsonl`);

    // Pending transcript at the exact expected path: accepted.
    const pending = validateClaudeArtifact(
      { evidence: { cwd, providerSessionId: sessionId, transcriptPath: expected } },
      { projectsDir },
    );
    assert.equal(pending.ok, true);
    assert.equal(pending.pending, true);
    assert.equal(pending.transcriptPath, expected);
    assert.equal(pending.workspace, workspace);

    // A pending path anywhere else is rejected — the hook cannot redirect it.
    for (const wrong of [
      join(root, 'elsewhere', `${sessionId}.jsonl`),
      join(expectedDir, 'other-session.jsonl'),
      join(expectedDir, `${sessionId}.jsonl`, 'nested'),
    ]) {
      const bad = validateClaudeArtifact(
        { evidence: { cwd, providerSessionId: sessionId, transcriptPath: wrong } },
        { projectsDir },
      );
      assert.equal(bad.ok, false, `must reject ${wrong}`);
    }

    // Once the file exists at the expected path, it is confirmed non-pending
    // and the strict physical check still governs.
    mkdirSync(expectedDir, { recursive: true });
    writeFileSync(expected, '{"type":"summary"}\n');
    const written = validateClaudeArtifact(
      { evidence: { cwd, providerSessionId: sessionId, transcriptPath: expected } },
      { projectsDir },
    );
    assert.equal(written.ok, true);
    assert.notEqual(written.pending, true);
    assert.equal(written.transcriptPath, realpathSync(expected));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
