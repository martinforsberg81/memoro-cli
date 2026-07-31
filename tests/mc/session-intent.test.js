import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCloudSessionEnv,
  buildCloudSessionLaunchIntent,
  buildNewSessionLaunchIntent,
  buildResumeSessionLaunchIntent,
  cloudPolicyForLaunch,
  MC_SESSION_LAUNCH_MODES,
} from '../../src/mc/session-intent.js';
import { LOCAL_AUTH_MODES } from '../../src/mc/local-auth-mode.js';

describe('mc session launch intents', () => {
  test('new sessions use the normal broker launch shape with startup grounding enabled', () => {
    const intent = buildNewSessionLaunchIntent({
      entry: { name: 'data', tool: 'codex' },
      worktreePath: '/repo-data',
      focus: 'build the map',
      launchTool: { id: 'codex' },
      apiArgv: ['--api-url', 'https://memoro.test'],
      env: { PATH: '/bin' },
    });

    assert.equal(intent.mode, MC_SESSION_LAUNCH_MODES.NEW);
    assert.equal(intent.cwd, '/repo-data');
    assert.equal(intent.sessionName, 'data');
    assert.equal(intent.focus, 'build the map');
    assert.equal(intent.tool, 'codex');
    assert.deepEqual(intent.argv, []);
    assert.deepEqual(intent.apiArgv, ['--api-url', 'https://memoro.test']);
    assert.equal(intent.sendStartupMessage, true);
    assert.equal(intent.attachAfterLaunch, true);
    assert.equal(intent.localAuthMode, LOCAL_AUTH_MODES.NATIVE);
    assert.deepEqual(intent.env, { PATH: '/bin' });
    // No bound id by default → launcher mints a fresh coding session.
    assert.equal(intent.codingSessionId, null);
  });

  test('new intent carries a bound coding_session_id (tool switch keeps continuity)', () => {
    const intent = buildNewSessionLaunchIntent({
      entry: { name: 'data', tool: 'claude' },
      worktreePath: '/repo-data',
      launchTool: { id: 'claude-code' },
      codingSessionId: 'sess_keepme',
    });
    assert.equal(intent.mode, MC_SESSION_LAUNCH_MODES.NEW);
    assert.equal(intent.codingSessionId, 'sess_keepme');
  });

  test('resume sessions are the same broker launch with resume argv and no startup prompt', () => {
    const intent = buildResumeSessionLaunchIntent({
      entry: {
        name: 'data',
        tool: 'claude',
        label: 'identity cleanup',
        worktree_path: '/repo-data',
        coding_session_id: 'sess_resume_data',
      },
      launchTool: { id: 'claude-code' },
      env: { PATH: '/bin' },
    });

    assert.equal(intent.mode, MC_SESSION_LAUNCH_MODES.RESUME);
    assert.equal(intent.cwd, '/repo-data');
    assert.equal(intent.codingSessionId, 'sess_resume_data');
    assert.equal(intent.sessionName, 'data');
    assert.equal(intent.label, 'identity cleanup');
    assert.equal(intent.focus, 'identity cleanup');
    assert.equal(intent.tool, 'claude-code');
    assert.deepEqual(intent.argv, ['--resume']);
    assert.equal(intent.sendStartupMessage, false);
    assert.equal(intent.attachAfterLaunch, true);
    assert.equal(intent.localAuthMode, LOCAL_AUTH_MODES.NATIVE);
  });

  test('resume sessions can carry adapter-native resume argv', () => {
    const intent = buildResumeSessionLaunchIntent({
      entry: {
        name: 'data',
        tool: 'codex',
        worktree_path: '/repo-data',
      },
      launchTool: { id: 'codex' },
      resumeArgv: ['resume', 'cx_123'],
    });

    assert.equal(intent.mode, MC_SESSION_LAUNCH_MODES.RESUME);
    assert.deepEqual(intent.argv, ['resume', 'cx_123']);
    assert.equal(intent.sendStartupMessage, false);
  });

  test('local intents carry an explicit managed request without changing cloud intents', () => {
    const managedNew = buildNewSessionLaunchIntent({
      entry: { name: 'data', tool: 'codex' },
      worktreePath: '/repo-data',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    });
    const managedResume = buildResumeSessionLaunchIntent({
      entry: {
        name: 'data',
        tool: 'codex',
        worktree_path: '/repo-data',
        coding_session_id: 'sess_managed_data',
      },
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    });
    const cloud = buildCloudSessionLaunchIntent({
      cwd: '/workspace/repo',
      cloud: { cloudSessionId: 'cld_123456', tool: 'codex' },
    });

    assert.equal(managedNew.localAuthMode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.equal(managedResume.localAuthMode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.equal(managedResume.codingSessionId, 'sess_managed_data');
    assert.equal(Object.hasOwn(cloud, 'localAuthMode'), false);
  });

  test('cloud sessions are headless broker launches with explicit source identity', () => {
    const intent = buildCloudSessionLaunchIntent({
      cwd: '/workspace/repo',
      env: { PATH: '/bin', MEMORO_TOKEN: 'mem_runtime' },
      cloud: {
        cloudSessionId: 'cld_123456',
        codingSessionId: 'sess_server123',
        name: 'cloud_coord',
        task: 'Analyse cloud mc',
        tool: 'codex',
        launchTool: 'codex',
        policy: 'read-only',
      },
    });

    assert.equal(intent.mode, MC_SESSION_LAUNCH_MODES.CLOUD);
    assert.equal(intent.cwd, '/workspace/repo');
    assert.equal(intent.codingSessionId, 'sess_server123');
    assert.equal(intent.sessionName, 'cloud_coord');
    assert.equal(intent.focus, 'Analyse cloud mc');
    assert.equal(intent.tool, 'codex');
    assert.deepEqual(intent.argv, []);
    assert.deepEqual(intent.apiArgv, []);
    assert.equal(intent.sendStartupMessage, true);
    assert.equal(intent.attachAfterLaunch, false);
    assert.deepEqual(intent.cloudBroker, {
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Memoro Cloud',
      cloudSessionId: 'cld_123456',
    });
    assert.equal(intent.env.MC_SOURCE_ID, 'cloud:cld_123456');
    assert.equal(intent.env.MC_SOURCE_KIND, 'cloud');
    assert.equal(intent.env.MC_SOURCE_NAME, 'Memoro Cloud');
    assert.equal(intent.env.MC_CLOUD_SESSION_ID, 'cld_123456');
    assert.equal(intent.env.MC_CODING_SESSION_ID, 'sess_server123');
    assert.equal(intent.env.MC_CLOUD_SESSION_POLICY, 'read-only');
    assert.equal(intent.env.MEMORO_TOKEN, 'mem_runtime');

    const policy = intent.deps.resolvePolicyForWrap({ tool: 'codex' });
    assert.equal(policy.permissions.workspace, 'read-only');
    assert.deepEqual(policy.explicit_permissions, ['workspace']);
  });

  test('cloud launch env preserves base env while adding mc source fields', () => {
    const env = buildCloudSessionEnv({ PATH: '/bin', TERM: 'xterm' }, {
      sourceId: 'cloud:cld_abcdef',
      sourceName: 'Cloud Source',
      cloudSessionId: 'cld_abcdef',
      codingSessionId: 'sess_env123',
      policy: 'workspace-write',
    });

    assert.deepEqual(env, {
      PATH: '/bin',
      TERM: 'xterm',
      MC_SOURCE_ID: 'cloud:cld_abcdef',
      MC_SOURCE_KIND: 'cloud',
      MC_SOURCE_NAME: 'Cloud Source',
      MC_CLOUD_SESSION_ID: 'cld_abcdef',
      MC_CODING_SESSION_ID: 'sess_env123',
      MC_CLOUD_SESSION_POLICY: 'workspace-write',
    });
  });

  test('cloud policy helper maps mc policy to adapter launch policy', () => {
    const write = cloudPolicyForLaunch('workspace-write', 'codex');
    assert.equal(write.permissions.workspace, 'worktree');
    assert.deepEqual(write.explicit_permissions, ['workspace']);

    const readOnly = cloudPolicyForLaunch('read-only', 'codex');
    assert.equal(readOnly.permissions.workspace, 'read-only');
    assert.deepEqual(readOnly.explicit_permissions, ['workspace']);
  });
});
