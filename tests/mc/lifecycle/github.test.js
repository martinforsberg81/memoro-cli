import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { run as runAuth } from '../../../src/mc/commands/auth.js';
import { run as runGitHub } from '../../../src/mc/commands/github.js';

const REPOSITORY = Object.freeze({
  id: 301,
  full_name: 'acme/widgets',
  owner: 'acme',
  name: 'widgets',
  private: true,
  archived: false,
  account: 'acme',
});

function statusResponse(state = 'ready', repairAction = null, overrides = {}) {
  return {
    ok: true,
    github: {
      schema: 1,
      state,
      repair_action: repairAction,
      actor: { type: 'installation', login: 'memoro[bot]' },
      accounts: state === 'disconnected' ? [] : [{ login: 'acme', type: 'Organization' }],
      repository: state === 'ready' ? REPOSITORY : null,
      repositories: state === 'disconnected' ? [] : [REPOSITORY],
      operations: state === 'ready' ? ['repository.metadata', 'pull_request.list'] : [],
      ...overrides,
    },
  };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += String(value); }, isTTY: false },
    stderr: { write: (value) => { stderr += String(value); }, isTTY: false },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function deps({ response = statusResponse(), interactive = false, calls = [] } = {}) {
  const io = capture();
  const portal = {
    stdout: io.stdout,
    stderr: io.stderr,
    cwd: '/repo',
    stdin: { isTTY: interactive },
    isInteractive: interactive,
    identityBroker: {
      withGrant: async (_request, use) => use({
        token: 'short-lived-grant-kept-inside-portal',
        apiUrl: 'https://meetmemoro.test',
      }),
    },
    readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
    getRepoContext: async () => ({
      toplevel: '/repo',
      branch: 'main',
      remoteUrl: 'git@github.com:acme/widgets.git',
    }),
    memoroFetch: async (_apiUrl, path, options) => {
      calls.push({ kind: 'request', path, method: options.method || 'GET' });
      return typeof response === 'function' ? response(path, options) : response;
    },
    openBrowser: async (url) => {
      calls.push({ kind: 'browser', url });
      return true;
    },
  };
  Object.defineProperties(portal, {
    stdoutText: { get: () => io.stdoutText },
    stderrText: { get: () => io.stderrText },
  });
  return portal;
}

describe('mc github status', () => {
  test('renders stable JSON on stdout only and derives repository identity locally', async () => {
    const calls = [];
    const portal = deps({
      calls,
      response: statusResponse('ready', null, { approval_mode: 'prompt' }),
    });
    const code = await runGitHub(['status', '--json'], portal);

    assert.equal(code, 0);
    assert.equal(portal.stderrText, '');
    const body = JSON.parse(portal.stdoutText);
    assert.equal(body.github.state, 'ready');
    assert.equal(body.github.repository.id, 301);
    assert.equal(Object.hasOwn(body.github, 'approval_mode'), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'request');
    assert.equal(calls[0].path, '/api/mc/github/status?repository=acme%2Fwidgets');
    assert.equal(calls.some((call) => call.kind === 'browser'), false);
    assert.equal(portal.stdoutText.includes('memoro-token-kept-inside-portal'), false);
  });

  test('renders human readiness without provider-specific login advice', async () => {
    const portal = deps();
    const code = await runGitHub(['status'], portal);

    assert.equal(code, 0);
    assert.match(portal.stdoutText, /Memoro GitHub App/);
    assert.match(portal.stdoutText, /ready for acme\/widgets/);
    assert.doesNotMatch(portal.stdoutText, /gh auth|keyring|Claude|Codex/);
    assert.equal(portal.stderrText, '');
  });

  test('covers every connection repair action with provider-independent commands', async () => {
    const cases = [
      ['disconnected', 'connect', 'mc github connect'],
      ['connecting', 'continue_connect', 'mc github connect'],
      ['repo_not_installed', 'select_repository', 'mc github connect'],
      ['permission_missing', 'update_installation', 'mc github connect'],
      ['suspended', 'resume_installation', 'mc github connect'],
      ['revoked', 'reconnect', 'mc github connect'],
      ['unavailable', 'retry', 'mc github status'],
    ];

    for (const [state, repairAction, command] of cases) {
      const portal = deps({ response: statusResponse(state, repairAction) });
      const code = await runGitHub(['status'], portal);
      assert.equal(code, 1, state);
      assert.match(portal.stdoutText, new RegExp(command.replaceAll(' ', '\\s+')), state);
      assert.doesNotMatch(portal.stdoutText, /gh auth|keyring|Claude|Codex/, state);
      assert.equal(portal.stderrText, '', state);
    }
  });

  test('fails a server/local repository mismatch closed', async () => {
    const portal = deps({ response: statusResponse('ready', null, {
      repository: { ...REPOSITORY, id: 302, full_name: 'acme/other', name: 'other' },
    }) });
    const code = await runGitHub(['status', '--json'], portal);
    const body = JSON.parse(portal.stdoutText);

    assert.equal(code, 1);
    assert.equal(body.github.state, 'repo_not_installed');
    assert.equal(body.github.repair_action, 'select_repository');
    assert.equal(body.github.repository, null);
  });

  test('rejects credential-shaped server fields and redacts the human error path', async () => {
    const secret = 'ghp_must_never_render';
    const portal = deps({ response: statusResponse('ready', null, {
      nested: { access_token: secret },
    }) });
    const code = await runGitHub(['status'], portal);

    assert.equal(code, 1);
    assert.equal(portal.stdoutText, '');
    assert.match(portal.stderrText, /could not be verified through Memoro/i);
    assert.equal(portal.stderrText.includes(secret), false);
  });

  test('JSON failures remain machine-only and redact rejected descriptor material', async () => {
    const secret = 'github_pat_must_never_render';
    const portal = deps({ response: statusResponse('ready', null, {
      nested: { credential: secret },
    }) });
    const code = await runGitHub(['status', '--json'], portal);
    const body = JSON.parse(portal.stdoutText);

    assert.equal(code, 1);
    assert.equal(portal.stderrText, '');
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'unavailable');
    assert.equal(portal.stdoutText.includes(secret), false);
  });

  test('rejects bad argv before keychain, network, or browser side effects', async () => {
    const calls = [];
    const portal = deps({ calls });
    portal.getSecret = async () => { calls.push({ kind: 'keychain' }); return 'token'; };
    const code = await runGitHub(['status', '--unknown'], portal);

    assert.equal(code, 2);
    assert.equal(portal.stdoutText, '');
    assert.match(portal.stderrText, /unknown flag/);
    assert.deepEqual(calls, []);
  });
});

describe('mc github read operations', () => {
  test('maps PR list, view, and checks to the session broker without authority fields', async () => {
    const portal = deps();
    const calls = [];
    portal.executeGitHubOperation = async ({ operation, params }) => {
      calls.push({ operation, params });
      return {
        ok: true,
        request_id: `request_${calls.length}abcdef`,
        data: operation === 'pull_request.list'
          ? { pull_requests: [] }
          : (operation === 'checks.list'
            ? { pull_number: 7, checks: [], statuses: [] }
            : { number: 7, title: 'Seven' }),
      };
    };

    assert.equal(await runGitHub(['pr', 'list', '--state', 'all', '--limit', '5', '--json'], portal), 0);
    assert.equal(await runGitHub(['pr', 'view', '7', '--json'], portal), 0);
    assert.equal(await runGitHub(['pr', 'checks', '7', '--json'], portal), 0);
    assert.deepEqual(calls, [
      { operation: 'pull_request.list', params: { state: 'all', limit: 5 } },
      { operation: 'pull_request.view', params: { pull_number: 7 } },
      { operation: 'checks.list', params: { pull_number: 7 } },
    ]);
    assert.doesNotMatch(portal.stdoutText, /source_id|coding_session_id|installation_id|access_token/);
  });

  test('rejects write, repository selection, and unknown flags before broker access', async () => {
    const cases = [
      ['pr', 'create'],
      ['pr', 'merge', '7', '--admin'],
      ['pr', 'list', '--repo', 'acme/other'],
      ['pr', 'view'],
      ['pr', 'checks', '7', '--watch'],
    ];
    for (const argv of cases) {
      const portal = deps();
      let calls = 0;
      portal.executeGitHubOperation = async () => { calls += 1; };
      assert.equal(await runGitHub(argv, portal), 2, argv.join(' '));
      assert.equal(calls, 0, argv.join(' '));
      assert.match(portal.stderrText, /mc github/i, argv.join(' '));
    }
  });

  test('renders stable broker failures without suggesting native login or a token', async () => {
    const portal = deps();
    portal.executeGitHubOperation = async () => ({
      ok: false,
      request_id: 'request_abcdefgh',
      error: { code: 'unavailable', message: 'Hostile secret detail', repair_action: 'retry' },
    });
    assert.equal(await runGitHub(['pr', 'view', '7'], portal), 1);
    assert.equal(portal.stdoutText, '');
    assert.match(portal.stderrText, /mc github status/);
    assert.doesNotMatch(portal.stderrText, /Hostile secret detail|gh auth login|token/i);
  });
});

describe('mc github write operations', () => {
  test('creates a draft PR from locally-derived branch state without authority fields', async () => {
    const portal = deps();
    const calls = [];
    portal.resolveGitHubCreateContext = async ({ base }) => ({
      head: 'agent/local-write',
      base,
      expected_head_sha: 'a'.repeat(40),
      expected_base_sha: 'b'.repeat(40),
    });
    portal.makeRequestId = (() => {
      let next = 0;
      return () => `request_local_${++next}abcdef`;
    })();
    portal.executeGitHubOperation = async (request) => {
      calls.push(request);
      if (request.operation === 'repository.metadata') {
        return {
          ok: true,
          request_id: request.requestId,
          data: { default_branch: 'main' },
        };
      }
      return {
        ok: true,
        request_id: request.requestId,
        data: {
          number: 17,
          title: 'Local draft',
          state: 'open',
          draft: true,
          url: 'https://github.com/acme/widgets/pull/17',
        },
      };
    };

    const code = await runGitHub([
      'pr', 'create',
      '--title', 'Local draft',
      '--body', 'Exact body',
      '--draft',
      '--json',
    ], portal);

    assert.equal(code, 0);
    assert.equal(portal.stderrText, '');
    assert.equal(JSON.parse(portal.stdoutText).number, 17);
    assert.deepEqual(calls[1], {
      operation: 'pull_request.create',
      params: {
        title: 'Local draft',
        body: 'Exact body',
        head: 'agent/local-write',
        base: 'main',
        draft: true,
        expected_head_sha: 'a'.repeat(40),
        expected_base_sha: 'b'.repeat(40),
      },
      requestId: 'request_local_2abcdef',
    });
    assert.deepEqual(Object.keys(calls[1]).sort(), ['operation', 'params', 'requestId']);
    assert.doesNotMatch(
      JSON.stringify(calls[1]),
      /source_id|coding_session_id|installation_id|access_token|authorization/i,
    );
  });

  test('updates a PR from a brokered current-state precondition', async () => {
    const portal = deps();
    const calls = [];
    portal.makeRequestId = (() => {
      let next = 0;
      return () => `request_update_${++next}abcdef`;
    })();
    portal.executeGitHubOperation = async (request) => {
      calls.push(request);
      if (request.operation === 'pull_request.view') {
        return {
          ok: true,
          request_id: request.requestId,
          data: {
            number: 7,
            title: 'Before',
            head: { ref: 'agent/local-write', sha: 'a'.repeat(40) },
            updated_at: '2026-07-23T08:00:00.000Z',
          },
        };
      }
      return {
        ok: true,
        request_id: request.requestId,
        data: { number: 7, title: 'After', state: 'open', draft: true },
      };
    };

    const code = await runGitHub([
      'pr', 'update', '7',
      '--title', 'After',
      '--body', 'Updated body',
      '--json',
    ], portal);

    assert.equal(code, 0);
    assert.deepEqual(calls[1], {
      operation: 'pull_request.update',
      params: {
        pull_number: 7,
        title: 'After',
        body: 'Updated body',
        expected_head_sha: 'a'.repeat(40),
        expected_updated_at: '2026-07-23T08:00:00.000Z',
      },
      requestId: 'request_update_2abcdef',
    });
  });

  test('fails closed on stale state and never produces browser approval state', async () => {
    const portal = deps();
    portal.makeRequestId = () => 'request_stale_abcdefgh';
    portal.executeGitHubOperation = async (request) => {
      if (request.operation === 'pull_request.view') {
        return {
          ok: true,
          request_id: request.requestId,
          data: {
            number: 7,
            head: { sha: 'a'.repeat(40) },
            updated_at: '2026-07-23T08:00:00.000Z',
          },
        };
      }
      return {
        ok: false,
        request_id: request.requestId,
        error: { code: 'stale_state', message: 'changed', repair_action: 'retry' },
      };
    };

    const code = await runGitHub(['pr', 'update', '7', '--title', 'After'], portal);
    assert.equal(code, 1);
    assert.match(portal.stderrText, /state changed/i);
    assert.doesNotMatch(`${portal.stdoutText}${portal.stderrText}`, /approval|browser|https:\/\/meetmemoro/i);
  });

  test('rejects arbitrary write flags before git or broker access', async () => {
    for (const argv of [
      ['pr', 'create', '--title', 'x', '--body', 'y', '--head', 'other'],
      ['pr', 'create', '--title', 'x', '--body-file', 'secret.txt'],
      ['pr', 'update', '7', '--state', 'closed'],
      ['pr', 'update', '7', '--repo', 'acme/other'],
    ]) {
      const portal = deps();
      let brokerCalls = 0;
      let gitCalls = 0;
      portal.executeGitHubOperation = async () => { brokerCalls += 1; };
      portal.resolveGitHubCreateContext = async () => { gitCalls += 1; };
      assert.equal(await runGitHub(argv, portal), 2, argv.join(' '));
      assert.equal(brokerCalls, 0);
      assert.equal(gitCalls, 0);
    }
  });
});

describe('mc github connect/repos and auth alias', () => {
  const connectResponse = {
    ok: true,
    schema: 1,
    state: 'connecting',
    connect_url: 'https://github.com/apps/memoro-coding/installations/new?state=gha_safe_state',
    expires_at: '2026-07-22T12:00:00.000Z',
  };

  test('noninteractive connect prints the URL and never opens a browser', async () => {
    const calls = [];
    const portal = deps({ response: connectResponse, interactive: false, calls });
    const code = await runGitHub(['connect'], portal);

    assert.equal(code, 0);
    assert.match(portal.stdoutText, /https:\/\/github\.com\/apps\/memoro-coding/);
    assert.equal(calls.some((call) => call.kind === 'browser'), false);
  });

  test('JSON connect never opens a browser even on an interactive terminal', async () => {
    const calls = [];
    const portal = deps({ response: connectResponse, interactive: true, calls });
    const code = await runGitHub(['connect', '--json'], portal);

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(portal.stdoutText), connectResponse);
    assert.equal(portal.stderrText, '');
    assert.equal(calls.some((call) => call.kind === 'browser'), false);
  });

  test('an explicit interactive connect may open the verified URL', async () => {
    const calls = [];
    const portal = deps({ response: connectResponse, interactive: true, calls });
    const code = await runGitHub(['connect'], portal);

    assert.equal(code, 0);
    assert.equal(calls.filter((call) => call.kind === 'browser').length, 1);
    assert.match(portal.stdoutText, /Opened the Memoro GitHub connection flow/);
  });

  test('an unsafe connect URL fails before browser side effects and is redacted', async () => {
    const secret = 'ghp_never_open_or_render';
    const calls = [];
    const portal = deps({
      response: {
        ...connectResponse,
        connect_url: `https://github.com/apps/memoro-coding/installations/new?access_token=${secret}`,
      },
      interactive: true,
      calls,
    });
    const code = await runGitHub(['connect'], portal);

    assert.equal(code, 1);
    assert.equal(calls.some((call) => call.kind === 'browser'), false);
    assert.equal(`${portal.stdoutText}${portal.stderrText}`.includes(secret), false);
    assert.match(portal.stderrText, /could not be verified through Memoro/i);
  });

  test('a GitHub connect URL on a nonstandard port is never opened', async () => {
    const calls = [];
    const portal = deps({
      response: {
        ...connectResponse,
        connect_url: 'https://github.com:444/apps/memoro-coding/installations/new?state=gha_safe_state',
      },
      interactive: true,
      calls,
    });
    const code = await runGitHub(['connect'], portal);

    assert.equal(code, 1);
    assert.equal(calls.some((call) => call.kind === 'browser'), false);
    assert.equal(portal.stdoutText, '');
  });

  test('repos renders token-free JSON and human repository metadata', async () => {
    const response = {
      ok: true,
      state: 'ready',
      repair_action: null,
      repositories: [REPOSITORY],
    };
    const jsonPortal = deps({ response });
    const humanPortal = deps({ response });

    assert.equal(await runGitHub(['repos', '--json'], jsonPortal), 0);
    assert.deepEqual(JSON.parse(jsonPortal.stdoutText), response);
    assert.equal(await runGitHub(['repos'], humanPortal), 0);
    assert.match(humanPortal.stdoutText, /acme\/widgets/);
    assert.match(humanPortal.stdoutText, /private/);
  });

  test('mc auth github is byte-for-byte the canonical status surface', async () => {
    const direct = deps();
    const alias = deps();

    const directCode = await runGitHub(['status', '--json'], direct);
    const aliasCode = await runAuth(['github', '--json'], { github: alias });

    assert.equal(aliasCode, directCode);
    assert.equal(alias.stdoutText, direct.stdoutText);
    assert.equal(alias.stderrText, direct.stderrText);
  });

  test('provider/adapter environment cannot change the command contract', async () => {
    const codex = deps();
    const claude = deps();
    codex.env = { MC_TOOL: 'codex' };
    claude.env = { MC_TOOL: 'claude' };

    assert.equal(await runGitHub(['status', '--json'], codex), 0);
    assert.equal(await runGitHub(['status', '--json'], claude), 0);
    assert.equal(codex.stdoutText, claude.stdoutText);
  });
});
