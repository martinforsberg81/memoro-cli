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
        if (args[0] === 'rev-parse') return '1'.repeat(40);
        if (args[0] === 'log') return 'Add the provider handoff';
        if (args[0] === 'rev-list') return '2';
        return ' M src/mc/handoff.js\0?? tests/mc/handoff.test.js\0';
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(gitCalls, [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['log', '-1', '--format=%s'],
    ['rev-list', '--count', '@{upstream}..HEAD'],
  ]);
  assert.equal(result.handoff.content.goal, 'Build the provider handoff.');
  assert.deepEqual(result.handoff.content.changed_paths, [
    'src/mc/handoff.js',
    'tests/mc/handoff.test.js',
  ]);
  assert.match(result.handoff.content.state, /2 changed paths/);
  assert.match(result.handoff.content.state, /2 commits ahead of upstream/);
  assert.match(result.handoff.content.state, /latest commit: "Add the provider handoff"/);
  assert.match(result.handoff.workspace.anchor.repo_id, /^repo_[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(result.handoff), /credential|example\.test|\/repo/);
});

test('the state names branch, ref, and distilled Memoro continuity instead of a stock phrase', async () => {
  const contextRequests = [];
  const result = await buildDeterministicHandoff({
    entry,
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: 'codex',
      runtimeGeneration: 'generation-1',
    },
    sequence: 1,
    parentDigest: null,
    auth: { token: 'token-in-memory', apiUrl: 'https://meetmemoro.test' },
    repoContext: {
      toplevel: '/repo',
      branch: 'fix/native-note-actions-toggle',
      remoteUrl: 'https://example.test/team/memoro.git',
    },
    deps: {
      git: async (args) => {
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (args[0] === 'log') return 'Toggle native note actions';
        if (args[0] === 'rev-list') return '1';
        return '';
      },
      fetchMcContextData: async (arg) => {
        contextRequests.push(arg);
        return {
          session_continuity: [
            {
              brief: 'Implemented the actions toggle and its tests',
              source: 'codex',
              ended_at: '2026-07-31',
            },
            { brief: '', source: 'codex' },
          ],
        };
      },
    },
  });

  assert.equal(result.ok, true);
  const state = result.handoff.content.state;
  assert.doesNotMatch(state, /ended with a clean workspace/);
  assert.match(state, /Workspace on branch fix\/native-note-actions-toggle at a{12}: clean working tree/);
  assert.match(state, /1 commit ahead of upstream/);
  assert.match(state, /latest commit: "Toggle native note actions"/);
  assert.match(state, /Distilled prior work on this coding session \(from Memoro\): Implemented the actions toggle and its tests \(codex, ended 2026-07-31\)/);
  assert.equal(contextRequests[0].codingSessionId, entry.coding_session_id);
  assert.equal(contextRequests[0].deps.token, 'token-in-memory');
});

test('a failing context fetch degrades to git facts and never blocks the switch', async () => {
  const result = await buildDeterministicHandoff({
    entry,
    source: { kind: 'local', id: 'device:laptop', tool: 'codex', runtimeGeneration: 'g1' },
    sequence: 1,
    parentDigest: null,
    auth: { token: 'token-in-memory', apiUrl: 'https://meetmemoro.test' },
    repoContext: { toplevel: '/repo', branch: 'main', remoteUrl: '/repo' },
    deps: {
      git: async (args) => {
        if (args[0] === 'rev-parse') return 'b'.repeat(40);
        if (args[0] === 'log') return null;
        if (args[0] === 'rev-list') return null;
        return '';
      },
      fetchMcContextData: async () => { throw new Error('offline'); },
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.handoff.content.state, /Workspace on branch main at b{12}: clean working tree\./);
  assert.doesNotMatch(result.handoff.content.state, /Distilled prior work/);
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
      git: async (args) => (args[0] === 'rev-parse' ? '1'.repeat(40) : args[0] === 'status' ? '' : null),
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
