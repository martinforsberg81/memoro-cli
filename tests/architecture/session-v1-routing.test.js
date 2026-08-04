import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const activeSources = [
  'src/mc-cli.js',
  'src/cli/new.js',
  'src/cli/open.js',
  'src/cli/resume.js',
  'src/cli/list.js',
  'src/cli/status.js',
  'src/cli/rename.js',
  'src/cli/cd.js',
  'src/cli/attach.js',
  'src/cli/dispatch.js',
  'src/cli/read.js',
  'src/mc/commands/end.js',
  'src/mc/commands/delete.js',
  'src/mc/commands/cleanup.js',
  'src/mc/commands/gc.js',
  'src/mc/commands/storage.js',
  'src/mc/commands/doctor.js',
  'src/mc/local-source.js',
  'src/mc/session-v1.js',
  'src/mc/session-v1-list.js',
  'src/mc/session-runtime-v1.js',
  'src/mc/session-lifecycle-v1.js',
  'src/mc/session-maintenance-v1.js',
  'src/mc/owned-resource-cleanup.js',
  'src/runtime/session-host/terminal-client.js',
];

test('active V1 lifecycle commands have no legacy lifecycle transport imports', () => {
  const sources = read(activeSources);
  assert.doesNotMatch(sources, /from ['"][^'"]*mc\/registry\.js['"]/u);
  assert.doesNotMatch(sources, /from ['"][^'"]*runtime\/broker\//u);
  assert.doesNotMatch(sources, /from ['"][^'"]*commands\/ws-client\.js['"]/u);
  assert.doesNotMatch(sources, /from ['"][^'"]*wrap-ws\.js['"]/u);
  assert.doesNotMatch(sources, /from ['"][^'"]*local-auth-mode\.js['"]/u);
  assert.doesNotMatch(sources, /CliWsClient|UserSession/iu);
});

test('both command dispatchers route destructive maintenance through V1 modules', () => {
  const entrypoint = read(['src/mc-cli.js']);
  const fallbackDispatcher = read(['src/bin-mc.js']);
  for (const [command, modulePath] of [
    ['end', 'mc/commands/end.js'],
    ['delete', 'mc/commands/delete.js'],
    ['cleanup', 'mc/commands/cleanup.js'],
    ['gc', 'mc/commands/gc.js'],
    ['storage', 'mc/commands/storage.js'],
    ['doctor', 'mc/commands/doctor.js'],
  ]) {
    const escapedModule = modulePath.replaceAll('/', '\\/');
    assert.match(
      fallbackDispatcher,
      new RegExp(`^\\s*${command}:\\s*\\(\\) => import\\('\\./${escapedModule}'\\),$`, 'mu'),
      `${command} must use ${modulePath} in bin-mc`,
    );
    assert.match(
      entrypoint,
      new RegExp(`^\\s*${command}:\\s*'\\./${escapedModule}',$`, 'mu'),
      `${command} must use ${modulePath} in mc-cli`,
    );
  }
});

test('machine-local runtime protocol contains no heartbeat message types', () => {
  const sources = read([
    'src/runtime/session-host/protocol.js',
    'src/runtime/session-host/client.js',
    'src/runtime/session-host/server.js',
    'src/runtime/session-host/runtime-host.js',
    'src/runtime/session-host/terminal-client.js',
  ]);
  for (const word of [['pi', 'ng'].join(''), ['po', 'ng'].join('')]) {
    assert.equal(new RegExp(`\\b${word}\\b`, 'u').test(sources), false);
  }
});

test('local list implementation contains no socket, network, or runtime probe', () => {
  const sources = read([
    'src/cli/list.js',
    'src/mc/session-v1-list.js',
    'src/mc/session-v1.js',
  ]);
  assert.doesNotMatch(sources, /createConnection|runtimeHostSocket|probeSessionRuntime|WebSocket/iu);
  assert.doesNotMatch(sources, /memoroFetch|fetch\(/u);
});

function read(paths) {
  return paths.map((path) => readFileSync(join(root, path), 'utf8')).join('\n');
}
