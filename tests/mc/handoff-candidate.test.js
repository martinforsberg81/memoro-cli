import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicHandoff,
  parseChangedPaths,
} from '../../src/mc/handoff-candidate.js';

const entry = {
  coding_session_id: 'sess_candidate1',
  worktree_path: '/repo',
  session_objective: {
    text: 'Build the provider handoff.',
    authority: 'explicit',
  },
};

test('deterministic candidate uses only explicit objective and bounded git facts', async () => {
  const gitCalls = [];
  const result = await buildDeterministicHandoff({
    entry,
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: 'claude-code',
      runtimeGeneration: 'generation-1',
    },
    sequence: 1,
    parentDigest: null,
    repoContext: {
      toplevel: '/repo',
      branch: 'sess/handoff',
      remoteUrl: 'https://user:credential@example.test/team/memoro.git',
    },
    deps: {
      git: async (args) => {
        gitCalls.push(args);
        return args[0] === 'rev-parse'
          ? '1'.repeat(40)
          : ' M src/mc/handoff.js\0?? tests/mc/handoff.test.js\0';
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(gitCalls, [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  ]);
  assert.equal(result.handoff.content.goal, 'Build the provider handoff.');
  assert.deepEqual(result.handoff.content.changed_paths, [
    'src/mc/handoff.js',
    'tests/mc/handoff.test.js',
  ]);
  assert.match(result.handoff.workspace.anchor.repo_id, /^repo_[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(result.handoff), /credential|example\.test|\/repo/);
});

test('legacy sessions receive a visible static objective and malformed git state fails closed', async () => {
  const result = await buildDeterministicHandoff({
    entry: { ...entry, session_objective: null },
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: 'codex',
      runtimeGeneration: 'generation-1',
    },
    sequence: 1,
    parentDigest: null,
    repoContext: {
      toplevel: '/repo',
      branch: 'main',
      remoteUrl: '/repo',
    },
    deps: {
      git: async (args) => args[0] === 'rev-parse' ? '1'.repeat(40) : '',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.handoff.content.goal, 'Continue the existing mc coding session.');
  assert.equal(parseChangedPaths('not porcelain\0').ok, false);
});

test('rename records preserve both bounded path identities', () => {
  assert.deepEqual(parseChangedPaths(
    'R  src/new.js\0src/old.js\0?? tests/new.test.js\0',
  ), {
    ok: true,
    paths: ['src/new.js', 'src/old.js', 'tests/new.test.js'],
  });
});
