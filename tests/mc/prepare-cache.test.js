/**
 * The candidate's `npm ci`, cloned from a tree installed from the same
 * lockfile. The clone (`cp -cR`) and the install are stubbed; the cache
 * directory and its `meta.json` are real files in a temporary root.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PREPARE_CACHE_KEEP, prepareCacheKey, prepareCandidate } from '../../src/mc/prepare-cache.js';

function fixture({ lock = '{"lockfileVersion":3}', manifest = '{"name":"memoro"}' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-prepare-cache-'));
  const headDir = join(root, 'candidate');
  const cacheDir = join(root, 'gate-cache', 'memoro-12345678');
  mkdirSync(headDir, { recursive: true });
  const fx = {
    headDir,
    cacheDir,
    installs: [],
    clones: [],
    cloneFails: false,
    clock: 1000,
    lockfile(text) { writeFileSync(join(headDir, 'package-lock.json'), text); },
    manifest(text) { writeFileSync(join(headDir, 'package.json'), text); },
    // npm ci: writes node_modules in the candidate.
    shell: async (command, { cwd }) => {
      fx.installs.push(command);
      mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    },
    // cp -cR: copies a directory's existence, which is all the module reads.
    run: (command, args) => {
      fx.clones.push([command, ...args]);
      if (fx.cloneFails) {
        mkdirSync(args[2], { recursive: true });
        return { status: 1, stderr: 'clonefile: Operation not supported' };
      }
      mkdirSync(args[2], { recursive: true });
      return { status: 0, stderr: '' };
    },
    said: [],
    go(prepare = 'npm ci', extra = {}) {
      return prepareCandidate({
        prepare, headDir, cacheDir, shell: fx.shell, run: fx.run,
        say: (line) => fx.said.push(line), now: () => fx.clock, platform: 'darwin', ...extra,
      });
    },
    fresh() {
      fx.installs = [];
      fx.clones = [];
      fx.said = [];
      // A new candidate: the round's worktree is thrown away after every round.
      rmSync(join(headDir, 'node_modules'), { recursive: true, force: true });
    },
  };
  fx.lockfile(lock);
  fx.manifest(manifest);
  return fx;
}

const entries = (fx) => readdirSync(fx.cacheDir).filter((name) => !name.includes('.tmp-')).sort();

describe('the prepare cache', () => {
  it('a miss runs npm ci and stores the tree under the key', async () => {
    const fx = fixture();
    const result = await fx.go();
    assert.equal(result.status, 0);
    assert.equal(result.cached, false);
    assert.deepEqual(fx.installs, ['npm ci']);
    assert.equal(fx.clones.length, 1);
    assert.deepEqual(fx.clones[0].slice(0, 3), ['cp', '-cR', join(fx.headDir, 'node_modules')]);
    const key = prepareCacheKey({ lock: readFileSync(join(fx.headDir, 'package-lock.json')), manifest: readFileSync(join(fx.headDir, 'package.json')) });
    assert.deepEqual(entries(fx), [key]);
    const meta = JSON.parse(readFileSync(join(fx.cacheDir, key, 'meta.json'), 'utf8'));
    assert.equal(meta.key, key);
    assert.equal(meta.at, 1000);
    assert.equal(meta.node, process.version);
    assert.match(meta.lock_sha, /^[0-9a-f]{64}$/u);
  });

  it('a hit clones once and makes no npm ci call', async () => {
    const fx = fixture();
    await fx.go();
    fx.fresh();
    const result = await fx.go();
    assert.equal(result.status, 0);
    assert.equal(result.cached, true);
    assert.deepEqual(fx.installs, []);
    assert.equal(fx.clones.length, 1);
    assert.deepEqual(fx.clones[0], ['cp', '-cR', join(fx.cacheDir, result.key, 'node_modules'), join(fx.headDir, 'node_modules')]);
    assert.ok(fx.said.includes(`prepare: cloned node_modules from the cache (${result.key})`));
  });

  it('a changed lockfile is a miss, and a third key evicts the oldest', async () => {
    const fx = fixture();
    const first = await fx.go();
    for (const [i, lock] of ['{"v":2}', '{"v":3}'].entries()) {
      fx.fresh();
      fx.clock = 2000 + i;
      fx.lockfile(lock);
      const result = await fx.go();
      assert.equal(result.cached, false);
      assert.deepEqual(fx.installs, ['npm ci']);
    }
    assert.equal(entries(fx).length, PREPARE_CACHE_KEEP);
    assert.ok(!entries(fx).includes(first.key), 'the oldest entry is the one evicted');
  });

  it('a different node version is a miss', () => {
    const a = prepareCacheKey({ lock: 'l', manifest: 'm', node: 'v22.0.0' });
    const b = prepareCacheKey({ lock: 'l', manifest: 'm', node: 'v22.1.0' });
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{16}$/u);
  });

  it('a clone that fails removes what it left and runs npm ci', async () => {
    const fx = fixture();
    await fx.go();
    fx.fresh();
    fx.cloneFails = true;
    const result = await fx.go();
    assert.equal(result.status, 0);
    assert.equal(result.cached, false);
    assert.deepEqual(fx.installs, ['npm ci']);
    assert.ok(fx.said.some((line) => /clone from the cache .* failed/u.test(line)));
    assert.ok(fx.said.some((line) => /could not store node_modules/u.test(line)), 'the store after it fails too and is said');
    assert.ok(existsSync(join(fx.headDir, 'node_modules', 'pkg')), 'npm ci wrote the tree');
  });

  it('a package.json with a postinstall never uses the cache', async () => {
    const fx = fixture({ manifest: '{"name":"memoro","scripts":{"postinstall":"node setup.js"}}' });
    await fx.go();
    fx.fresh();
    await fx.go();
    assert.deepEqual(fx.installs, ['npm ci']);
    assert.deepEqual(fx.clones, []);
    assert.ok(!existsSync(fx.cacheDir));
  });

  it('a prepare other than npm ci, or another platform, runs as it is', async () => {
    const fx = fixture();
    await fx.go('npm install && npm run build');
    assert.deepEqual(fx.installs, ['npm install && npm run build']);
    await fx.go('npm ci', { platform: 'linux' });
    assert.deepEqual(fx.installs, ['npm install && npm run build', 'npm ci']);
    assert.deepEqual(fx.clones, []);
    assert.ok(!existsSync(fx.cacheDir));
  });

  it('a failed npm ci stores nothing', async () => {
    const fx = fixture();
    const result = await prepareCandidate({
      prepare: 'npm ci', headDir: fx.headDir, cacheDir: fx.cacheDir, run: fx.run, platform: 'darwin',
      shell: async () => ({ status: 1, stderr: 'ERESOLVE' }),
    });
    assert.equal(result.status, 1);
    assert.deepEqual(fx.clones, []);
    assert.ok(!existsSync(fx.cacheDir));
  });
});
