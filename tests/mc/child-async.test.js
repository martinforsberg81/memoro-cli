/**
 * A child process without holding the event loop (`child-async.js`): the
 * result shape the synchronous spawn gives, and the files on the merger's path
 * that must not use the synchronous one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runShell, runTool } from '../../src/mc/child-async.js';

describe('runTool and runShell resolve what spawnSync returns', () => {
  it('exit 0 and exit 1, with stdout and stderr as strings', async () => {
    const ok = await runTool(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    assert.deepEqual({ ...ok, error: ok.error }, { status: 0, signal: null, stdout: 'out', stderr: 'err', error: null });
    const red = await runShell('echo nope >&2; exit 1');
    assert.equal(red.status, 1);
    assert.equal(red.signal, null);
    assert.equal(red.stdout, '');
    assert.equal(red.stderr.trim(), 'nope');
    assert.equal(red.error, null);
  });

  it('runs in the cwd and env it is given', async () => {
    const ran = await runShell('pwd; echo "$MC_CHILD_ASYNC"', { cwd: '/', env: { ...process.env, MC_CHILD_ASYNC: 'here' } });
    assert.deepEqual(ran.stdout.trim().split('\n'), ['/', 'here']);
  });

  it('a binary that is not there resolves with status null and the error, and never rejects', async () => {
    const ran = await runTool('mc-no-such-binary-anywhere', ['x']);
    assert.equal(ran.status, null);
    assert.equal(ran.error?.code, 'ENOENT');
    assert.equal(ran.stdout, '');
  });

  it('output past maxBuffer kills the child and resolves ENOBUFS', async () => {
    const ran = await runTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 5000)'], { maxBuffer: 1024 });
    assert.equal(ran.status, null);
    assert.equal(ran.error?.code, 'ENOBUFS');
    assert.equal(ran.stdout.length, 1024, 'what fits is kept');
  });

  it('a timeout kills with SIGTERM', async () => {
    const from = Date.now();
    const ran = await runTool('sleep', ['5'], { timeoutMs: 100 });
    assert.ok(Date.now() - from < 2000, 'it did not wait for the child');
    assert.equal(ran.status, null);
    assert.equal(ran.signal, 'SIGTERM');
    assert.equal(ran.error?.code, 'ETIMEDOUT');
  });

  it('two children started together run side by side', async () => {
    const from = Date.now();
    const both = await Promise.all([runTool('sleep', ['0.2']), runShell('sleep 0.2')]);
    const took = Date.now() - from;
    assert.deepEqual(both.map((ran) => ran.status), [0, 0]);
    assert.ok(took < 350, `two 200 ms children took ${took} ms`);
  });
});

describe('the merger\'s path holds no synchronous child', () => {
  // The gate's round and what it calls (merger-hardening step 4), and the
  // merge round and the merger itself (step 5).
  const FILES = [
    'repo-gate.js', 'repo-derived.js', 'prepare-cache.js', 'selector-miss.js',
    'repo-merge.js', 'repo-freshen.js', 'merger.js', 'merger-run.js',
  ];

  it('none of these files names spawnSync, execFileSync or execSync', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of FILES) {
      const source = readFileSync(join(here, '..', '..', 'src', 'mc', file), 'utf8');
      assert.doesNotMatch(source, /\b(?:spawnSync|execFileSync|execSync)\b/u, `${file} holds the event loop`);
    }
  });
});
