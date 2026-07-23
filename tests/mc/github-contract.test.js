import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  GITHUB_CONNECTION_SCHEMA,
  GITHUB_OPERATION_EFFECTS,
  GITHUB_OPERATION_SCHEMA,
  GITHUB_STABLE_ERRORS,
  GITHUB_WRITE_OPERATIONS,
  buildSessionCapabilities,
  decodeGitHubConnectionResponse,
  decodeGitHubOperationRequest,
  decodeGitHubOperationResponse,
  decodeSessionCapabilities,
  encodeGitHubOperationRequest,
} from '../../src/mc/github-contract.js';

const REPOSITORY = Object.freeze({
  id: 301,
  full_name: 'acme/widgets',
  owner: 'acme',
  name: 'widgets',
  private: true,
  archived: false,
  account: 'acme',
});

function readyConnection(overrides = {}) {
  return {
    schema: GITHUB_CONNECTION_SCHEMA,
    state: 'ready',
    repair_action: null,
    actor: { type: 'installation', login: 'memoro[bot]' },
    accounts: [{ login: 'acme', type: 'Organization' }],
    repository: REPOSITORY,
    repositories: [REPOSITORY],
    operations: [
      'repository.metadata',
      'pull_request.list',
      'pull_request.view',
      'checks.list',
    ],
    ...overrides,
  };
}

describe('GitHub connection/session descriptors', () => {
  test('decodes the versioned token-free server response and preserves numeric repository identity', () => {
    const decoded = decodeGitHubConnectionResponse({
      ok: true,
      github: readyConnection(),
    }, { expectedRepository: 'ACME/widgets' });

    assert.equal(decoded.ok, true);
    assert.equal(decoded.github.schema, 1);
    assert.equal(decoded.github.repository.id, 301);
    assert.equal(decoded.github.repository.full_name, 'acme/widgets');
    assert.equal(JSON.stringify(decoded).includes('installation_id'), false);
    assert.equal(JSON.stringify(decoded).includes('token'), false);
  });

  test('accepts and discards the bounded legacy control-plane approval field', () => {
    const decoded = decodeGitHubConnectionResponse({
      ok: true,
      github: readyConnection({ approval_mode: 'prompt' }),
    });

    assert.equal(Object.hasOwn(decoded.github, 'approval_mode'), false);
    assert.throws(
      () => decodeGitHubConnectionResponse({
        ok: true,
        github: readyConnection({ approval_mode: 'automatic' }),
      }),
      (error) => error?.code === 'invalid_descriptor',
    );
  });

  test('fails closed on unknown fields at every descriptor depth', () => {
    const cases = [
      { ...readyConnection(), surprise: true },
      { ...readyConnection(), actor: { ...readyConnection().actor, surprise: true } },
      { ...readyConnection(), repository: { ...REPOSITORY, surprise: true } },
      { ...readyConnection(), accounts: [{ login: 'acme', type: 'Organization', surprise: true }] },
    ];

    for (const github of cases) {
      assert.throws(
        () => decodeGitHubConnectionResponse({ ok: true, github }),
        (error) => error?.code === 'invalid_descriptor',
      );
    }
  });

  test('rejects recursive credential and authority-shaped fields without echoing values', () => {
    const secret = 'ghp_do_not_echo_this_value';
    const cases = [
      { ...readyConnection(), access_token: secret },
      { ...readyConnection(), actor: { ...readyConnection().actor, credential: secret } },
      { ...readyConnection(), repository: { ...REPOSITORY, installation_id: 999 } },
      { ...readyConnection(), repositories: [{ ...REPOSITORY, private_key: secret }] },
      { ...readyConnection(), accounts: [{ login: 'acme', type: 'Organization', oauth: { token: secret } }] },
    ];

    for (const github of cases) {
      assert.throws(
        () => decodeGitHubConnectionResponse({ ok: true, github }),
        (error) => error?.code === 'forbidden_descriptor_field'
          && !error.message.includes(secret),
      );
    }
  });

  test('fails a mismatched locally-derived repository closed as repo_not_installed', () => {
    const decoded = decodeGitHubConnectionResponse({
      ok: true,
      github: readyConnection(),
    }, { expectedRepository: 'acme/other' });

    assert.equal(decoded.github.state, 'repo_not_installed');
    assert.equal(decoded.github.repair_action, 'select_repository');
    assert.equal(decoded.github.repository, null);
  });

  test('builds the same informational session descriptor for every source/provider', () => {
    const connection = readyConnection();
    const localCodex = buildSessionCapabilities(connection);
    const cloudClaude = buildSessionCapabilities(connection);

    assert.deepEqual(localCodex, cloudClaude);
    assert.deepEqual(localCodex, {
      schema: 1,
      github: {
        state: 'ready',
        transport: 'mc-broker-v1',
        actor: 'installation',
        account: 'acme',
        repository: REPOSITORY,
        operations: connection.operations,
      },
    });
    assert.equal('source_id' in localCodex.github, false);
    assert.equal('coding_session_id' in localCodex.github, false);
    assert.equal('user_id' in localCodex.github, false);
  });

  test('degrades account-level ready metadata without a repository before session projection', () => {
    const accountReady = readyConnection({ repository: null });
    const connection = decodeGitHubConnectionResponse({ ok: true, github: accountReady });

    assert.equal(connection.github.state, 'ready');
    assert.equal(connection.github.repository, null);
    assert.deepEqual(buildSessionCapabilities(accountReady), {
      schema: 1,
      github: {
        state: 'repo_not_installed',
        transport: 'mc-broker-v1',
        actor: 'installation',
        account: 'acme',
        repository: null,
        operations: [],
      },
    });
  });

  test('rejects an incoming ready session descriptor without numeric repository metadata', () => {
    const descriptor = buildSessionCapabilities(readyConnection());
    assert.throws(
      () => decodeSessionCapabilities({
        ...descriptor,
        github: { ...descriptor.github, repository: null, operations: [] },
      }),
      (error) => error?.code === 'invalid_descriptor',
    );
  });

  test('copied session descriptors remain data only and reject added identity/credential fields', () => {
    const descriptor = buildSessionCapabilities(readyConnection());
    assert.deepEqual(decodeSessionCapabilities(JSON.parse(JSON.stringify(descriptor))), descriptor);

    assert.throws(
      () => decodeSessionCapabilities({
        ...descriptor,
        github: { ...descriptor.github, source_id: 'local:other' },
      }),
      (error) => error?.code === 'invalid_descriptor',
    );
    assert.throws(
      () => decodeSessionCapabilities({
        ...descriptor,
        github: { ...descriptor.github, nested: { refresh_token: 'secret' } },
      }),
      (error) => error?.code === 'forbidden_descriptor_field',
    );
  });
});

describe('github-op-v1 codecs', () => {
  test('classifies every public operation through one provider-neutral effect registry', () => {
    assert.deepEqual(GITHUB_OPERATION_EFFECTS, {
      'connection.status': 'read',
      'repository.metadata': 'read',
      'pull_request.list': 'read',
      'pull_request.view': 'read',
      'checks.list': 'read',
      'pull_request.create': 'write',
      'pull_request.update': 'write',
    });
    assert.deepEqual(GITHUB_WRITE_OPERATIONS, [
      'pull_request.create',
      'pull_request.update',
    ]);
  });

  test('normalizes every read operation to the shared schema', () => {
    const cases = [
      ['connection.status', {}, {}],
      ['repository.metadata', {}, {}],
      ['pull_request.list', {}, {}],
      ['pull_request.list', { state: 'all', author: 'octocat', limit: 50 }, { state: 'all', author: 'octocat', limit: 50 }],
      ['pull_request.view', { pull_number: 42 }, { pull_number: 42 }],
      ['checks.list', { pull_number: 42 }, { pull_number: 42 }],
    ];

    for (const [operation, params, expectedParams] of cases) {
      const encoded = encodeGitHubOperationRequest({
        requestId: `request_${operation.replaceAll('.', '_')}`,
        operation,
        params,
      });
      assert.deepEqual(decodeGitHubOperationRequest(encoded), {
        type: 'github_operation',
        schema: GITHUB_OPERATION_SCHEMA,
        request_id: `request_${operation.replaceAll('.', '_')}`,
        operation,
        params: expectedParams,
      });
    }
  });

  test('normalizes exact provider-neutral PR write requests', () => {
    assert.deepEqual(encodeGitHubOperationRequest({
      requestId: 'request_create_abcdefgh',
      operation: 'pull_request.create',
      params: {
        title: '  Draft title  ',
        body: 'Exact body\n',
        head: 'agent/write',
        base: 'main',
        draft: true,
        expected_head_sha: 'A'.repeat(40),
        expected_base_sha: 'B'.repeat(40),
      },
    }).params, {
      title: 'Draft title',
      body: 'Exact body\n',
      head: 'agent/write',
      base: 'main',
      draft: true,
      expected_head_sha: 'a'.repeat(40),
      expected_base_sha: 'b'.repeat(40),
    });

    assert.deepEqual(encodeGitHubOperationRequest({
      requestId: 'request_update_abcdefgh',
      operation: 'pull_request.update',
      params: {
        pull_number: 7,
        title: '  Updated title  ',
        body: '',
        expected_head_sha: 'A'.repeat(40),
        expected_updated_at: '2026-07-23T10:00:00+02:00',
      },
    }).params, {
      pull_number: 7,
      title: 'Updated title',
      body: '',
      expected_head_sha: 'a'.repeat(40),
      expected_updated_at: '2026-07-23T08:00:00.000Z',
    });
  });

  test('rejects write authority fields and incomplete preconditions', () => {
    const base = {
      requestId: 'request_write_abcdefgh',
      operation: 'pull_request.create',
      params: {
        title: 'Draft',
        body: '',
        head: 'agent/write',
        base: 'main',
        draft: true,
        expected_head_sha: 'a'.repeat(40),
        expected_base_sha: 'b'.repeat(40),
      },
    };
    for (const params of [
      { ...base.params, repository: 'acme/other' },
      { ...base.params, head: 'agent/write', expected_head_sha: undefined },
      { ...base.params, force: true },
    ]) {
      assert.throws(() => encodeGitHubOperationRequest({ ...base, params }));
    }
  });

  test('omits absent PR-list options while preserving an explicit author', () => {
    const withoutAuthor = encodeGitHubOperationRequest({
      requestId: 'request_list_without_author',
      operation: 'pull_request.list',
      params: { state: 'open', limit: 2 },
    });
    assert.deepEqual(withoutAuthor.params, { state: 'open', limit: 2 });
    assert.equal(Object.hasOwn(withoutAuthor.params, 'author'), false);

    const withAuthor = encodeGitHubOperationRequest({
      requestId: 'request_list_with_author',
      operation: 'pull_request.list',
      params: { author: 'octocat' },
    });
    assert.deepEqual(withAuthor.params, { author: 'octocat' });
  });

  test('refuses repository/source/session selection, unknown operations, and credential fields', () => {
    const base = {
      type: 'github_operation',
      schema: 1,
      request_id: 'request_abcdefgh',
      operation: 'repository.metadata',
      params: {},
    };
    for (const extra of [
      { repository: 'acme/other' },
      { source_id: 'local:other' },
      { coding_session_id: 'sess_other' },
      { token: 'github_pat_secret' },
      { url: 'https://api.github.com/repos/acme/other' },
    ]) {
      assert.throws(() => decodeGitHubOperationRequest({ ...base, ...extra }));
    }
    assert.throws(() => decodeGitHubOperationRequest({
      ...base,
      operation: 'pull_request.create',
      params: { repository: 'acme/other' },
    }));
    assert.throws(() => decodeGitHubOperationRequest({
      ...base,
      operation: 'pull_request.list',
      params: { state: 'open', authorization: 'Bearer secret' },
    }));
  });

  test('strictly decodes success/failure envelopes and rejects recursive credentials', () => {
    assert.deepEqual(decodeGitHubOperationResponse({
      ok: true,
      request_id: 'request_abcdefgh',
      data: { id: 301, full_name: 'acme/widgets' },
    }), {
      ok: true,
      request_id: 'request_abcdefgh',
      data: { id: 301, full_name: 'acme/widgets' },
    });

    assert.deepEqual(decodeGitHubOperationResponse({
      ok: false,
      request_id: 'request_abcdefgh',
      error: { code: 'unavailable', message: 'Temporarily unavailable.', repair_action: 'retry' },
    }), {
      ok: false,
      request_id: 'request_abcdefgh',
      error: { code: 'unavailable', message: 'Temporarily unavailable.', repair_action: 'retry' },
    });

    assert.throws(() => decodeGitHubOperationResponse({
      ok: true,
      request_id: 'request_abcdefgh',
      data: { nested: { access_token: 'ghs_secret' } },
    }), (error) => error?.code === 'forbidden_descriptor_field');
    assert.throws(() => decodeGitHubOperationResponse({
      ok: true,
      request_id: 'request_abcdefgh',
      data: { note: 'provider returned Bearer credential_material' },
    }), (error) => error?.code === 'forbidden_descriptor_field'
      && !error.message.includes('credential_material'));
    assert.throws(() => decodeGitHubOperationResponse({
      ok: false,
      request_id: 'request_abcdefgh',
      error: { code: 'unavailable', message: 'x', repair_action: 'retry', raw: true },
    }), (error) => error?.code === 'invalid_descriptor');
  });

  test('rejects superseded approval errors and approval payload fields', () => {
    assert.equal(GITHUB_STABLE_ERRORS.includes('approval_required'), false);
    assert.equal(GITHUB_STABLE_ERRORS.includes('approval_expired'), false);

    for (const error of [
      {
        code: 'approval_required',
        message: 'Approval required.',
        repair_action: 'approve',
        approval_id: 'ghap_abcdefgh',
      },
      {
        code: 'approval_expired',
        message: 'Approval expired.',
        repair_action: 'retry',
      },
      {
        code: 'unavailable',
        message: 'Unavailable.',
        repair_action: 'retry',
        approval_id: 'ghap_abcdefgh',
      },
    ]) {
      assert.throws(
        () => decodeGitHubOperationResponse({
          ok: false,
          request_id: 'request_abcdefgh',
          error,
        }),
        (contractError) => contractError?.code === 'invalid_descriptor',
      );
    }
  });

  test('rejects normalized credential and authority key variants with opaque values', () => {
    const forbiddenKeys = [
      'oauth_token',
      'githubToken',
      'api-token',
      'githubCredentials',
      'httpAuthorization',
      'sessionCookie',
      'clientSecret',
      'databasePassword',
      'keyPassphrase',
      'privateKey',
      'installationId',
      'githubAppId',
      'oauthClientID',
    ];

    for (const key of forbiddenKeys) {
      assert.throws(() => decodeGitHubOperationResponse({
        ok: true,
        request_id: 'request_abcdefgh',
        data: { nested: { [key]: 'opaque-value' } },
      }), (error) => error?.code === 'forbidden_descriptor_field', key);
    }
  });

  test('allows non-credential token metrics and type metadata', () => {
    assert.deepEqual(decodeGitHubOperationResponse({
      ok: true,
      request_id: 'request_abcdefgh',
      data: {
        token_count: 42,
        token_type: 'parser',
      },
    }), {
      ok: true,
      request_id: 'request_abcdefgh',
      data: {
        token_count: 42,
        token_type: 'parser',
      },
    });
  });
});
