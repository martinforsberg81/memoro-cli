import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseJsonOrNull, runMc } from '../_helpers/cli.js';

describe('mc deps CLI', () => {
  let root;
  let worktree;
  let mcHome;
  let bin;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-deps-cli-'));
    worktree = join(root, 'worktree');
    mcHome = join(root, 'mc-home');
    bin = join(root, 'bin');
    mkdirSync(join(worktree, '.mc'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'deps-cli' }));
    writeFileSync(join(worktree, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    writeFileSync(join(worktree, '.mc', 'dev.json'), JSON.stringify({
      schema_version: 1,
      default_service: 'web',
      services: {
        web: {
          default_profile: 'agent',
          profiles: {
            agent: {
              start: { argv: ['npm', 'run', 'dev'] },
              readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 90_000 },
              resource_class: 'standard',
            },
          },
          dependencies: {
            manager: 'npm',
            fingerprint_files: ['package.json', 'package-lock.json'],
            install: { argv: ['npm', 'ci'] },
          },
          managed_argv_prefixes: [['npm', 'run', 'dev']],
        },
      },
    }));
    const fakeNpm = join(bin, 'npm');
    writeFileSync(fakeNpm, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 11.4.2
  exit 0
fi
if [ "$1" = "ci" ]; then
  mkdir -p node_modules/fixture
  echo installed > node_modules/fixture/result.txt
  exit 0
fi
exit 64
`);
    chmodSync(fakeNpm, 0o755);
    const git = spawnSync('git', ['init', '-q'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('status is read-only and explicit hydrate installs once into the worktree', () => {
    const env = {
      MC_HOME: mcHome,
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    const before = runMc(['deps', 'status', '--json'], { cwd: worktree, env });
    assert.equal(before.status, 0, before.stderr);
    assert.equal(parseJsonOrNull(before.stdout).worktree.state, 'missing');
    assert.equal(existsSync(join(worktree, 'node_modules')), false);

    const hydrate = runMc(['deps', 'hydrate', '--json'], { cwd: worktree, env });
    assert.equal(hydrate.status, 0, hydrate.stderr);
    const hydrated = parseJsonOrNull(hydrate.stdout);
    assert.equal(hydrated.ok, true);
    assert.equal(hydrated.source, 'install');
    assert.equal(hydrated.status.worktree.state, 'ready');
    assert.equal(readFileSync(join(worktree, 'node_modules', 'fixture', 'result.txt'), 'utf8'), 'installed\n');
    assert.equal(existsSync(join(worktree, 'node_modules', '.mc-dependency-snapshot.json')), true);

    const after = runMc(['deps', 'status'], { cwd: worktree, env });
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /web\/agent/);
    assert.match(after.stdout, /worktree\s+ready/);
    assert.match(after.stdout, /snapshot\s+ready/);
  });
});
