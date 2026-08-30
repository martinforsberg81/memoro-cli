/**
 * The two files that make the page instant. Fixtures only: the git here is a
 * function, and the cache files are an object, so nothing spawns and nothing
 * is written to disk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ageWords, cachePath, loadPlans, loadPrs, savePrs } from '../../src/mc/page-cache.js';

const ROOT = '/w';
const REPOS = [{ name: 'memoro', path: '/r/memoro' }, { name: 'memoro-cli', path: '/r/memoro-cli' }];
const NOW = new Date('2026-08-29T12:00:00Z');

/** A fake filesystem: `read` throws on a name it does not hold, as fs does. */
function files(initial = {}) {
  const held = { ...initial };
  return {
    held,
    read: (path) => {
      if (!(path in held)) throw new Error(`ENOENT ${path}`);
      return held[path];
    },
    write: (path, value) => { held[path] = JSON.stringify(value); },
  };
}

const PLAN = '---\nstatus: ready\nnext: "Step 2 — instant"\n---\n';

/** ls-tree names one plan per repository; cat-file answers with PLAN. */
function fakeGit(shas, calls) {
  return (cwd, args) => {
    calls.push([cwd, args[0]]);
    if (args[0] === 'rev-parse') return shas[cwd] ?? null;
    if (args[0] === 'ls-tree') return `docs/project/mc/${cwd.split('/').at(-1)}/PLAN.md`;
    return null;
  };
}

const batchOf = (calls) => (cwd, refs) => {
  calls.push([cwd, 'cat-file']);
  return new Map(refs.map((ref) => [ref, PLAN]));
};

describe('plans.json', () => {
  it('reads git on a miss, writes the entry under the sha, and reads nothing but rev-parse on a hit', () => {
    const fs = files();
    const shas = { '/r/memoro': 'aaa', '/r/memoro-cli': 'bbb' };
    const first = [];
    const miss = loadPlans({ root: ROOT, repos: REPOS, now: NOW, git: fakeGit(shas, first), batch: batchOf(first), ...fs });
    assert.deepEqual(miss.plans.map((p) => [p.repo, p.project, p.status]), [
      ['memoro', 'memoro', 'ready'], ['memoro-cli', 'memoro-cli', 'ready'],
    ]);
    assert.deepEqual(miss.sources, [
      { repo: 'memoro', sha: 'aaa', cached: false }, { repo: 'memoro-cli', sha: 'bbb', cached: false },
    ]);
    assert.deepEqual(first.map((c) => c[1]), ['rev-parse', 'ls-tree', 'cat-file', 'rev-parse', 'ls-tree', 'cat-file']);
    assert.equal(JSON.parse(fs.held[cachePath(ROOT, 'plans.json')]).memoro.sha, 'aaa');

    const second = [];
    const hit = loadPlans({ root: ROOT, repos: REPOS, now: NOW, git: fakeGit(shas, second), batch: batchOf(second), ...fs });
    assert.deepEqual(second.map((c) => c[1]), ['rev-parse', 'rev-parse'], 'a hit costs one rev-parse per repository');
    assert.deepEqual(hit.plans, miss.plans);
    assert.equal(hit.sources.every((s) => s.cached), true);
  });

  it('re-reads the repository whose sha moved, and leaves the other alone', () => {
    const fs = files();
    const shas = { '/r/memoro': 'aaa', '/r/memoro-cli': 'bbb' };
    loadPlans({ root: ROOT, repos: REPOS, now: NOW, git: fakeGit(shas, []), batch: batchOf([]), ...fs });
    shas['/r/memoro-cli'] = 'ccc';
    const calls = [];
    const after = loadPlans({ root: ROOT, repos: REPOS, now: NOW, git: fakeGit(shas, calls), batch: batchOf(calls), ...fs });
    assert.deepEqual(after.sources, [
      { repo: 'memoro', sha: 'aaa', cached: true }, { repo: 'memoro-cli', sha: 'ccc', cached: false },
    ]);
    assert.deepEqual(calls.map((c) => c[1]), ['rev-parse', 'rev-parse', 'ls-tree', 'cat-file']);
  });

  it('reads a repository without a sha straight through and files nothing under it', () => {
    const fs = files();
    const calls = [];
    const out = loadPlans({
      root: ROOT, repos: [REPOS[0]], now: NOW, git: fakeGit({}, calls), batch: batchOf(calls), ...fs,
    });
    assert.equal(out.plans.length, 1);
    assert.deepEqual(out.sources, [{ repo: 'memoro', sha: null, cached: false }]);
    assert.equal(cachePath(ROOT, 'plans.json') in fs.held, false, 'nothing to key it by, so nothing written');
  });
});

describe('prs.json', () => {
  it('is empty and ageless until --fresh writes it, then carries its age', () => {
    const fs = files();
    assert.deepEqual(loadPrs({ root: ROOT, now: NOW, ...fs }), { prs: [], fetched: null, age_seconds: null });

    const prs = [{ repo: 'memoro-cli', number: 433, headRefName: 'mc-decisions' }];
    savePrs({ root: ROOT, prs, now: NOW, ...fs });
    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const read = loadPrs({ root: ROOT, now: later, ...fs });
    assert.deepEqual(read.prs, prs);
    assert.equal(read.fetched, '2026-08-29T12:00:00.000Z');
    assert.equal(read.age_seconds, 7200);
    assert.equal(ageWords(read.age_seconds), '2 h');
  });

  it('treats an unreadable cache as no cache', () => {
    const fs = files({ [cachePath(ROOT, 'prs.json')]: '{ half a fil' });
    assert.deepEqual(loadPrs({ root: ROOT, now: NOW, ...fs }), { prs: [], fetched: null, age_seconds: null });
  });
});

describe('ageWords', () => {
  it('says seconds, minutes, hours and days', () => {
    assert.equal(ageWords(null), 'unknown age');
    assert.equal(ageWords(12), '12s');
    assert.equal(ageWords(600), '10 min');
    assert.equal(ageWords(6 * 3600), '6 h');
    assert.equal(ageWords(5 * 24 * 3600), '5 d');
  });
});
