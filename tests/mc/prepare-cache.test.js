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

import { PREPARE_CACHE_KEEP, evict, prepareCacheKey, prepareCandidate } from '../../src/mc/prepare-cache.js';

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
    const key = prepareCacheKey({ lock: readFileSync(join(fx.headDir, 'package-lock.json')), manifest: readFileSync(join(fx.headDir, 'package.json')), platform: 'darwin' });
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

  it('a hit renews meta.at to now and counts the hit', async () => {
    const fx = fixture();
    const first = await fx.go();
    const metaPath = join(fx.cacheDir, first.key, 'meta.json');
    fx.fresh();
    fx.clock = 5000;
    assert.equal((await fx.go()).cached, true);
    let meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(meta.at, 5000);
    assert.equal(meta.hits, 1);
    assert.equal(meta.key, first.key);
    fx.fresh();
    fx.clock = 6000;
    await fx.go();
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(meta.at, 6000);
    assert.equal(meta.hits, 2);
  });

  it('a hit whose meta cannot be renewed is still a cached round', async () => {
    const fx = fixture();
    await fx.go();
    fx.fresh();
    const result = await fx.go('npm ci', { write: () => { throw new Error('EACCES: permission denied'); } });
    assert.equal(result.status, 0);
    assert.equal(result.cached, true);
    assert.deepEqual(fx.installs, []);
  });

  it('eviction removes the least recently used entry, not the oldest stored one', async () => {
    const fx = fixture();
    const a = await fx.go();
    fx.fresh();
    fx.clock = 2;
    fx.lockfile('{"v":"b"}');
    const b = await fx.go();
    fx.fresh();
    fx.clock = 3;
    fx.lockfile('{"v":"c"}');
    const c = await fx.go();
    // A hit on the first entry renews it: it is now the most recently used.
    fx.fresh();
    fx.clock = 10;
    fx.lockfile('{"lockfileVersion":3}');
    const hit = await fx.go();
    assert.equal(hit.key, a.key);
    assert.equal(hit.cached, true);
    evict({ cacheDir: fx.cacheDir, keep: 2 });
    assert.deepEqual(entries(fx), [a.key, c.key].sort());
    assert.ok(!entries(fx).includes(b.key));
    assert.equal(JSON.parse(readFileSync(join(fx.cacheDir, a.key, 'meta.json'), 'utf8')).at, 10);
  });

  it('a changed lockfile is a miss, and a key past PREPARE_CACHE_KEEP evicts the oldest', async () => {
    const fx = fixture();
    const first = await fx.go();
    const locks = Array.from({ length: PREPARE_CACHE_KEEP }, (_, i) => `{"v":${i + 2}}`);
    for (const [i, lock] of locks.entries()) {
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

  it('keeps four entries', () => {
    assert.equal(PREPARE_CACHE_KEEP, 4);
  });

  it('another node major, ABI, platform or architecture is a miss; a node minor or patch is not', () => {
    const key = (extra) => prepareCacheKey({ lock: 'l', manifest: '{}', node: 'v22.0.0', abi: '127', platform: 'darwin', arch: 'arm64', ...extra });
    assert.match(key(), /^[0-9a-f]{16}$/u);
    assert.equal(key({ node: 'v22.11.3' }), key());
    assert.notEqual(key({ node: 'v24.0.0' }), key());
    assert.notEqual(key({ abi: '131' }), key());
    assert.notEqual(key({ platform: 'linux' }), key());
    assert.notEqual(key({ arch: 'x64' }), key());
  });

  it('hashes only what changes an install: not the name, version, scripts or description', () => {
    const base = { name: 'memoro', version: '1.0.0', dependencies: { a: '^1' }, devDependencies: { b: '^2' }, scripts: { test: 'x' } };
    const key = (manifest, lock = 'l') => prepareCacheKey({ lock, manifest: JSON.stringify(manifest), node: 'v22.0.0', abi: '127', platform: 'darwin', arch: 'arm64' });
    assert.equal(key({ ...base, version: '1.0.1', description: 'new', scripts: { test: 'y', lint: 'z' } }), key(base));
    // Key order in the file is not a change either.
    assert.equal(key({ scripts: base.scripts, devDependencies: base.devDependencies, dependencies: base.dependencies, name: 'memoro' }), key(base));
    for (const [field, value] of [
      ['dependencies', { a: '^2' }], ['devDependencies', { b: '^3' }], ['optionalDependencies', { c: '1' }], ['peerDependencies', { d: '1' }],
      ['overrides', { a: '1.2.3' }], ['engines', { node: '>=22' }], ['workspaces', ['pkg/*']], ['packageManager', 'npm@10.0.0'],
      ['bundleDependencies', ['a']],
    ]) {
      assert.notEqual(key({ ...base, [field]: value }), key(base), field);
    }
    assert.notEqual(key(base, 'other lock'), key(base));
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

  it('a package.json with a lifecycle script npm ci runs never uses the cache', async () => {
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
      const fx = fixture({ manifest: JSON.stringify({ name: 'memoro', scripts: { [script]: 'node setup.js' } }) });
      await fx.go();
      fx.fresh();
      await fx.go();
      assert.deepEqual(fx.installs, ['npm ci']);
      assert.deepEqual(fx.clones, []);
      assert.ok(!existsSync(fx.cacheDir));
      assert.ok(fx.said.includes(`prepare: the package.json has a ${script} script, so the cache is not used`));
    }
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
