import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGED_CLAUDE_OAUTH_CLIENT_ID,
  MANAGED_CLAUDE_OAUTH_TOKEN_URL,
  managedClaudeRefreshDelay,
  parseManagedClaudeToolAuth,
  refreshManagedClaudeOauthGrant,
  replaceManagedClaudeToolAuthGrant,
} from '../../../src/mc/provider-adapters/claude-managed-refresh.js';

const now = 1_800_000_000_000;

function data(overrides = {}) {
  return {
    kind: 'tool_auth',
    tool: 'claude-code',
    source: 'keychain',
    body: JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: now + 10 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        ...overrides,
      },
    }),
  };
}

test('managed Claude auth requires one refreshable exact tool-auth payload', () => {
  const parsed = parseManagedClaudeToolAuth(data());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.grant.refreshToken, 'refresh-old');

  assert.equal(parseManagedClaudeToolAuth({
    ...data(),
    extra: true,
  }).reason, 'managed-claude-auth-invalid');
  assert.equal(parseManagedClaudeToolAuth(data({
    refreshToken: undefined,
  })).reason, 'managed-claude-refresh-grant-required');
  assert.equal(parseManagedClaudeToolAuth(data({
    scopes: [],
  })).reason, 'managed-claude-refresh-grant-required');
});

test('managed Claude refresh is fixed-destination and validates rotated grants', async () => {
  const parsed = parseManagedClaudeToolAuth(data());
  let request = null;
  const refreshed = await refreshManagedClaudeOauthGrant(parsed.grant, {
    now: () => now,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        status: 200,
        async json() {
          return {
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 3_600,
            scope: 'user:profile user:inference',
          };
        },
      };
    },
  });
  assert.equal(refreshed.ok, true);
  assert.equal(request.url, MANAGED_CLAUDE_OAUTH_TOKEN_URL);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    grant_type: 'refresh_token',
    refresh_token: 'refresh-old',
    client_id: MANAGED_CLAUDE_OAUTH_CLIENT_ID,
    scope: 'user:profile user:inference',
  });
  assert.equal(refreshed.grant.accessToken, 'access-new');
  assert.equal(refreshed.grant.refreshToken, 'refresh-new');
  assert.equal(refreshed.grant.expiresAt, now + 3_600_000);

  const nextData = replaceManagedClaudeToolAuthGrant(data(), refreshed.grant);
  const reparsed = parseManagedClaudeToolAuth(nextData);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.grant.accessToken, 'access-new');
});

test('managed Claude refresh fails closed on HTTP and response ambiguity', async () => {
  const grant = parseManagedClaudeToolAuth(data()).grant;
  assert.equal((await refreshManagedClaudeOauthGrant(grant, {
    fetchImpl: async () => ({ status: 401 }),
  })).reason, 'managed-claude-refresh-rejected');
  assert.equal((await refreshManagedClaudeOauthGrant(grant, {
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        access_token: 'access-new',
        expires_in: '3600',
      }),
    }),
  })).reason, 'managed-claude-refresh-response-invalid');
});

test('managed Claude refresh scheduling is bounded and refreshes before expiry', () => {
  const grant = parseManagedClaudeToolAuth(data()).grant;
  assert.equal(managedClaudeRefreshDelay(grant, { now }), 5 * 60_000);
  assert.equal(managedClaudeRefreshDelay({
    ...grant,
    expiresAt: now + 2 * 60_000,
  }, { now }), 0);
  assert.equal(managedClaudeRefreshDelay({
    ...grant,
    expiresAt: now + 60 * 60_000,
  }, { now }), 15 * 60_000);
});
