import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMcContextPath,
  buildMcContextQuery,
  fetchMcContextData,
  renderMcContextMarkdown,
} from '../../src/mc/context.js';

const VALID_CONTEXT = {
  version: 'mc-context-v1',
  user_profile: {
    display_name: 'Martin',
    locale: 'sv-SE',
    timezone: 'Europe/Stockholm',
  },
  coding_profile: {
    revision: 3,
    markdown: '# Coding Profile\n\nPrefer Swedish collaboration.',
  },
  repo: {
    name: 'memoro',
    tool: 'codex',
    selected_docs: ['docs/plans/profile.md'],
  },
  session: {
    mc_session_name: 'update-memoro',
    branch: 'agent/mc-context',
  },
};

describe('mc context client', () => {
  it('builds a compact query from non-empty parameters only', () => {
    const query = buildMcContextQuery({
      repoId: 'repo_123',
      repo: 'meetmemoro/memoro',
      tool: 'codex',
      sessionName: 'update-memoro',
      branch: 'agent/mc-context',
    });
    const params = new URLSearchParams(query);

    assert.equal(params.get('repo_id'), 'repo_123');
    assert.equal(params.get('repo'), 'meetmemoro/memoro');
    assert.equal(params.get('tool'), 'codex');
    assert.equal(params.get('session_name'), 'update-memoro');
    assert.equal(params.get('branch'), 'agent/mc-context');
    assert.equal(buildMcContextPath({ repo: 'memoro' }), '/api/mc/context?repo=memoro');
    assert.equal(buildMcContextPath(), '/api/mc/context');
  });

  it('renders user profile, coding profile, repo, and session context', () => {
    const out = renderMcContextMarkdown(VALID_CONTEXT);

    assert.match(out, /### User Profile/);
    assert.match(out, /- Name: Martin/);
    assert.match(out, /- Locale: sv-SE/);
    assert.match(out, /### Coding Profile/);
    assert.match(out, /Approved revision: 3/);
    assert.match(out, /Prefer Swedish collaboration/);
    assert.match(out, /### Repo/);
    assert.match(out, /- Selected docs: `docs\/plans\/profile\.md`/);
    assert.match(out, /### Session/);
    assert.doesNotMatch(out, /Brief/);
  });

  it('fetches context with token, API URL, and safe repo metadata', async () => {
    const calls = [];
    const context = await fetchMcContextData({
      repoContext: {
        toplevel: '/tmp/memoro',
        branch: 'agent/mc-context',
        remoteUrl: 'git@github.com:meetmemoro/memoro.git',
      },
      tool: 'codex',
      sessionName: 'update-memoro',
      deps: {
        apiUrl: 'https://meetmemoro.test',
        token: 'mem_token',
        memoroFetch: async (apiUrl, path, opts) => {
          calls.push({ apiUrl, path, opts });
          return { ok: true, context: VALID_CONTEXT };
        },
      },
    });

    assert.equal(context, VALID_CONTEXT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiUrl, 'https://meetmemoro.test');
    assert.equal(calls[0].opts.token, 'mem_token');
    const url = new URL(calls[0].path, 'https://meetmemoro.test');
    assert.equal(url.pathname, '/api/mc/context');
    assert.equal(url.searchParams.get('repo'), 'meetmemoro/memoro');
    assert.equal(url.searchParams.get('tool'), 'codex');
    assert.equal(url.searchParams.get('session_name'), 'update-memoro');
    assert.equal(url.searchParams.get('branch'), 'agent/mc-context');
  });

  it('soft-degrades to null when auth or request fails', async () => {
    const noToken = await fetchMcContextData({
      deps: {
        getSecret: async () => null,
        memoroFetch: async () => { throw new Error('should not call'); },
      },
    });
    assert.equal(noToken, null);

    const requestFailure = await fetchMcContextData({
      deps: {
        apiUrl: 'https://meetmemoro.test',
        token: 'mem_token',
        memoroFetch: async () => { throw new Error('offline'); },
      },
    });
    assert.equal(requestFailure, null);
  });
});
