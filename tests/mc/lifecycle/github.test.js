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
      approval_mode: 'prompt',
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
    getSecret: async () => 'memoro-token-kept-inside-portal',
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
    const portal = deps({ calls });
    const code = await runGitHub(['status', '--json'], portal);

    assert.equal(code, 0);
    assert.equal(portal.stderrText, '');
    const body = JSON.parse(portal.stdoutText);
    assert.equal(body.github.state, 'ready');
    assert.equal(body.github.repository.id, 301);
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
