import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gitLine } from '../_fake-git-default.mjs';
import { REAL_GIT_FILES } from '../_real-git-files.mjs';

const isolate = fileURLToPath(new URL('../_isolate-home.mjs', import.meta.url));

describe('a test file\'s git is the model', () => {
  it('reads one git command from a shell line, and nothing else', () => {
    assert.deepEqual(gitLine('git config user.name "a b"'), ['config', 'user.name', 'a b']);
    assert.deepEqual(gitLine(" git clone --bare -q '/x y' \"/z\""), ['clone', '--bare', '-q', '/x y', '/z']);
    assert.equal(gitLine('git add . && git commit -qm x'), null);
    assert.equal(gitLine('git log | head'), null);
    assert.equal(gitLine('gitk'), null);
  });

  it('answers each spelling of a spawn and leaves a repository only the model and the disk know', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mc-model-'));
    execSync('git init -q -b main', { cwd });
    writeFileSync(join(cwd, 'a'), 'a\n');
    execFileSync('git', ['add', 'a'], { cwd });
    assert.equal(spawnSync('git', ['commit', '-qm', 'x'], { cwd }).status, 0);
    assert.match(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout, /^[0-9a-f]{40}\n$/u);
    assert.equal(existsSync(join(cwd, '.git', 'objects')), false, 'no real git made this repository');
  });

  it('a child shares the model, through a shell too', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mc-model-'));
    execSync('git init -q -b main', { cwd });
    assert.equal(execSync('git rev-parse --abbrev-ref HEAD | cat', { cwd, encoding: 'utf8' }).trim(), 'main');
  });

  it('a file off the list that reaches real git ends red, whatever its tests said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-stop-'));
    writeFileSync(join(dir, 'reaches.test.js'), `
      import { execSync } from 'node:child_process';
      import { it } from 'node:test';
      it('passes', () => { execSync('unset MC_FAKE_GIT_STATE; git --version'); });
    `);
    const env = { ...process.env };
    for (const name of ['MC_GIT_CALLS', 'MC_FAKE_GIT_STATE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[name];
    const result = spawnSync(process.execPath, ['--import', isolate, '--test', 'reaches.test.js'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /started git \d+ time/u);
  });

  it('names files that exist', () => {
    for (const file of REAL_GIT_FILES) assert.equal(existsSync(fileURLToPath(new URL(`../../${file}`, import.meta.url))), true, file);
  });
});
