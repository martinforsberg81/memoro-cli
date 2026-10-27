/**
 * `mc test dev --here --url` — stdout is the answer.
 *
 * Callers read it as `URL=$(mc test dev --here --url)`. A wait for a slot
 * printed to stdout ended up in that URL, and the theme matrix navigated to
 * `mc: static tier — …mc: waiting for a slot — …http://127.0.0.1:8920`
 * (2026-10-27). The lines a person waits through belong on stderr.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../../../src/mc/commands/test.js';

const DECLARATION = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-worker', profile: 'agent', static_service: 'memoro-static' } },
  base_url_env: 'MEMORO_BASE_URL',
  suites: [
    { name: 'signs-in', argv: ['npm', 'run', 'test:signs-in'], server: 'app' },
    { name: 'harness', argv: ['npm', 'run', 'test:harness'], server: 'static' },
  ],
};

/** The same repository before it had a static tier. */
const APP_ONLY = {
  ...DECLARATION,
  environments: { dev: { service: 'memoro-worker', profile: 'agent' } },
  suites: [DECLARATION.suites[0]],
};

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

async function urlRun(t, declaration) {
  const worktree = mkdtempSync(join(tmpdir(), 'mc-test-url-'));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: worktree });
  mkdirSync(join(worktree, '.mc'));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(declaration));

  const servers = {
    'memoro-static': { instance_id: 'static-1', url: 'http://127.0.0.1:8910' },
    'memoro-worker': { instance_id: 'measure-1', url: 'http://127.0.0.1:8920/' },
  };
  const ensureDevServer = async (_worktree, _declaration, options) => {
    const service = options.service || 'memoro-worker';
    if (service === 'memoro-worker') {
      options.onWaiting?.({ holders: [{ instance_id: 'measure-0', worktree_path: '/elsewhere' }] });
      options.onRegistered?.(servers[service]);
    }
    return { ok: true, started: true, server: servers[service] };
  };

  const stdout = sink();
  const stderr = sink();
  const code = await run(['dev', '--here', '--url'], { cwd: worktree, stdout, stderr, ensureDevServer });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

test('--url prints the URL alone on stdout; the wait for a slot and the start go to stderr', async (t) => {
  const { code, stdout, stderr } = await urlRun(t, APP_ONLY);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'http://127.0.0.1:8920\n');
  assert.match(stderr, /waiting for a slot/u);
  assert.match(stderr, /started one — http:\/\/127\.0\.0\.1:8920/u);
});

test('--url with a static tier: its line goes to stderr too, and stdout is still the app URL alone', async (t) => {
  const { code, stdout, stderr } = await urlRun(t, DECLARATION);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'http://127.0.0.1:8920\n');
  assert.match(stderr, /static tier — http:\/\/127\.0\.0\.1:8910/u);
});
