import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { prepareLocalClaudeCredentialDomain } from '../../../src/vault/credential-domain/local-claude.js';
import { prepareLocalCodexCredentialDomain } from '../../../src/vault/credential-domain/local-codex.js';

const mcSessionId = 'mcs_000000000000000000000011';
const root = '/tmp/mc-certified-boundary';
const githubSocketPath = join(root, 'run', 'sessions', mcSessionId, 'github.sock');

test('Codex accepts a V1 owner id and rejects a forged GitHub socket before readiness', async () => {
  let readinessCalls = 0;
  const deps = {
    inspectCodexRelease: () => {
      readinessCalls += 1;
      return { ok: false, reason: 'sentinel-codex-readiness' };
    },
  };
  const exact = await prepareLocalCodexCredentialDomain({
    codingSessionId: mcSessionId,
    githubSocketPath,
    cwd: '/tmp/workspace',
    tool: 'codex',
    root,
    deps,
  });
  assert.equal(exact.reason, 'sentinel-codex-readiness');
  assert.equal(readinessCalls, 1);

  const forged = await prepareLocalCodexCredentialDomain({
    codingSessionId: mcSessionId,
    githubSocketPath: join(root, 'forged.sock'),
    cwd: '/tmp/workspace',
    tool: 'codex',
    root,
    deps,
  });
  assert.equal(forged.reason, 'managed-portable-request-invalid');
  assert.equal(readinessCalls, 1);
});

test('Claude accepts a V1 owner id and rejects a forged GitHub socket before readiness', async () => {
  let readinessCalls = 0;
  const deps = {
    inspectCertification: () => {
      readinessCalls += 1;
      return { ok: false, reason: 'sentinel-claude-readiness' };
    },
  };
  const exact = await prepareLocalClaudeCredentialDomain({
    codingSessionId: mcSessionId,
    githubSocketPath,
    cwd: '/tmp/workspace',
    tool: 'claude-code',
    root,
    deps,
  });
  assert.equal(exact.reason, 'sentinel-claude-readiness');
  assert.equal(readinessCalls, 1);

  const forged = await prepareLocalClaudeCredentialDomain({
    codingSessionId: mcSessionId,
    githubSocketPath: join(root, 'forged.sock'),
    cwd: '/tmp/workspace',
    tool: 'claude-code',
    root,
    deps,
  });
  assert.equal(forged.reason, 'managed-claude-request-invalid');
  assert.equal(readinessCalls, 1);
});
