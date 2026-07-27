import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  scrubRuntimeSecretsFromEnv,
  scrubRuntimeSecretsInPlace,
} from '../../src/mc/runtime-secrets.js';

describe('runtime secret env scrubber', () => {
  test('removes explicit runtime credentials and authority handles while preserving terminal env', () => {
    const env = {
      MEMORO_TOKEN: 'mem_secret',
      MEMORO_BROKER_TOKEN: 'mem_broker_secret',
      MC_VAULT_PASSPHRASE: 'vault_secret',
      MC_CLOUD_GIT_TOKEN: 'managed_git_secret',
      MC_CLOUD_GIT_SECRET_CAPABILITY: 'managed_git_capability',
      MC_GIT_CLONE_TOKEN: 'managed_clone_secret',
      MC_SESSION_CAPABILITIES: '{"can_manage":true}',
      MC_GITHUB_BROKER_SOCKET: '/private/tmp/mc-github.sock',
      GH_TOKEN: 'gh_secret',
      GITHUB_TOKEN: 'github_secret',
      GH_ENTERPRISE_TOKEN: 'ghe_secret',
      GITHUB_ENTERPRISE_TOKEN: 'github_enterprise_secret',
      GH_CONFIG_DIR: '/private/tmp/gh-config',
      MC_CODEX_API_KEY: 'codex_secret',
      OPENAI_API_KEY: 'openai_secret',
      ANTHROPIC_API_KEY: 'anthropic_secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude_oauth_secret',
      GEMINI_API_KEY: 'gemini_secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/tmp/google.json',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
      AWS_SHARED_CREDENTIALS_FILE: '/private/tmp/aws-credentials',
      CLOUDFLARE_API_TOKEN: 'cloudflare_secret',
      SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
      SSH_ASKPASS: '/private/tmp/ssh-askpass',
      GIT_ASKPASS: '/private/tmp/git-askpass',
      GIT_CONFIG_GLOBAL: '/private/tmp/gitconfig',
      NETRC: '/private/tmp/netrc',
      PATH: '/bin',
      TERM: 'xterm',
    };
    const scrubbed = scrubRuntimeSecretsFromEnv(env);

    assert.equal(scrubbed.MEMORO_TOKEN, undefined);
    assert.equal(scrubbed.MEMORO_BROKER_TOKEN, undefined);
    assert.equal(scrubbed.MC_VAULT_PASSPHRASE, undefined);
    assert.equal(scrubbed.MC_CLOUD_GIT_TOKEN, undefined);
    assert.equal(scrubbed.MC_CLOUD_GIT_SECRET_CAPABILITY, undefined);
    assert.equal(scrubbed.MC_GIT_CLONE_TOKEN, undefined);
    assert.equal(scrubbed.MC_SESSION_CAPABILITIES, '{"can_manage":true}');
    assert.equal(scrubbed.MC_GITHUB_BROKER_SOCKET, '/private/tmp/mc-github.sock');
    assert.equal(scrubbed.GH_TOKEN, undefined);
    assert.equal(scrubbed.GITHUB_TOKEN, undefined);
    assert.equal(scrubbed.GH_ENTERPRISE_TOKEN, undefined);
    assert.equal(scrubbed.GITHUB_ENTERPRISE_TOKEN, undefined);
    assert.equal(scrubbed.GH_CONFIG_DIR, undefined);
    assert.equal(scrubbed.MC_CODEX_API_KEY, undefined);
    assert.equal(scrubbed.OPENAI_API_KEY, undefined);
    assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
    assert.equal(scrubbed.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(scrubbed.GEMINI_API_KEY, undefined);
    assert.equal(scrubbed.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(scrubbed.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(scrubbed.AWS_SHARED_CREDENTIALS_FILE, undefined);
    assert.equal(scrubbed.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(scrubbed.SSH_AUTH_SOCK, undefined);
    assert.equal(scrubbed.SSH_ASKPASS, undefined);
    assert.equal(scrubbed.GIT_ASKPASS, undefined);
    assert.equal(scrubbed.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(scrubbed.NETRC, undefined);
    assert.equal(scrubbed.PATH, '/bin');
    assert.equal(env.MEMORO_TOKEN, 'mem_secret');
  });

  test('can scrub launch env objects in place', () => {
    const env = { MEMORO_TOKEN: 'mem_secret', MEMORO_BROKER_TOKEN: 'mem_broker_secret', TERM: 'xterm' };

    assert.equal(scrubRuntimeSecretsInPlace(env), env);
    assert.deepEqual(env, { TERM: 'xterm' });
  });
});
