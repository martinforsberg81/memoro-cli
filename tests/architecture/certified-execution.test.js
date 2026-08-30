import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('active lifecycle surfaces expose no selectable execution mode', () => {
  // `mc new`, `mc open` and `mc resume` were cut 2026-08-30; the invariant is
  // about whatever surface is live, and these are what is left of it.
  const sources = read([
    'src/mc/help-text.js',
    'src/mc/session-runtime-v1.js',
    'src/runtime/certified-execution/launch-plan.js',
  ]);
  assert.equal(sources.includes(`--${'native'}`), false);
  assert.equal(sources.includes(`--${'managed-portable'}`), false);
});

test('local orchestration has no host gh authority fallback', () => {
  const sources = read([
    'src/cli/gather.js',
    'src/mc/reconcile.js',
    'src/mc/squash-phantom.js',
  ]);
  assert.doesNotMatch(sources, /spawn(?:Sync)?\(\s*['"]gh['"]/u);
  assert.doesNotMatch(sources, /execFile(?:Sync)?\(\s*['"]gh['"]/u);
  assert.doesNotMatch(sources, /MC_TEST_GH_PHANTOM/u);
});

test('certified execution cannot import the global broker launch path', () => {
  const sources = read([
    'src/adapters/certified/registry.js',
    'src/runtime/certified-execution/github-socket-host.js',
    'src/runtime/certified-execution/launch-plan.js',
  ]);
  assert.doesNotMatch(sources, /runtime\/broker\/launch-client/u);
  assert.doesNotMatch(sources, /session-sidecars/u);
  assert.doesNotMatch(sources, /githubTransportReady/u);
});

function read(paths) {
  return paths.map((path) => readFileSync(join(root, path), 'utf8')).join('\n');
}
