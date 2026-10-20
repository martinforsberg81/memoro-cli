/**
 * The page's reads: the plans under `~/mc/programs/`, and the pull-request
 * cache. Fixtures only: the plans and the cache files are functions and an
 * object, so nothing spawns and nothing is written to disk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ageWords, cachePath, dropPr, loadPlans, loadPrs, mergePrs, savePrs,
} from '../../src/mc/page-cache.js';

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

describe('loadPlans', () => {
  /**
   * The plans live under `~/mc/programs/` (ruling 48), which no sha keys, so
   * they are read on every call and nothing is cached for them.
   */
  it('reads ~/mc/programs/ on every call, asks no git and writes nothing', () => {
    const PROGRAM = JSON.stringify({
      schema: 'mc-plan', version: 1, repo: 'memoro', goal: ['g'], contract: ['c'], out_of_scope: ['o'],
      success_criteria: [{ met: false, criterion: 'x', check: 'y' }], documents: [],
      steps: [{ title: 'S1 — one', status: 'ready', done_when: 'one', instruction: ['Do it.'], pr: null, blocked_by: null }],
    });
    let text = PROGRAM;
    const programs = () => [{ path: '/w/programs/mc/memoro/PLAN.json', programme: 'mc', project: 'memoro', file: 'PLAN.json', text, repo: 'memoro' }];
    const git = () => { throw new Error('loadPlans asked git'); };
    const fs = files();
    const first = loadPlans({ root: ROOT, repos: REPOS, now: NOW, git, programs, ...fs });
    assert.deepEqual(first.plans.map((p) => [p.repo, p.path, p.status]), [['memoro', '/w/programs/mc/memoro/PLAN.json', 'ready']]);
    assert.deepEqual(first.sources, [
      { repo: 'memoro', sha: null, cached: false }, { repo: 'memoro-cli', sha: null, cached: false },
    ]);

    text = '{'; // the same file, edited in place
    const second = loadPlans({ root: ROOT, repos: REPOS, now: NOW, git, programs, ...fs });
    assert.deepEqual(second.plans.map((p) => [p.path, p.status]), [['/w/programs/mc/memoro/PLAN.json', 'invalid']]);
    assert.deepEqual(fs.held, {});
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

describe('mergePrs', () => {
  /**
   * A runner round asks GitHub anyway, sometimes one repository only; what it
   * heard replaces that repository's entries and leaves the other's alone.
   */
  it('replaces the repositories that were asked and keeps the rest', () => {
    const files = {
      [`${ROOT}/runner/prs.json`]: JSON.stringify({
        fetched: '2026-10-09T17:00:00.000Z',
        prs: [{ repo: 'memoro', number: 1 }, { repo: 'memoro-cli', number: 2 }],
      }),
    };
    const read = (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; };
    const write = (path, value) => { files[path] = JSON.stringify(value); };
    const now = new Date('2026-10-09T19:00:00Z');
    mergePrs({ root: ROOT, repos: ['memoro'], prs: [{ repo: 'memoro', number: 3 }], now, read, write });
    const saved = JSON.parse(files[`${ROOT}/runner/prs.json`]);
    assert.equal(saved.fetched, now.toISOString());
    assert.deepEqual(saved.prs.map((pr) => pr.number), [2, 3]);
  });

  it('writes nothing when no repository answered', () => {
    let wrote = false;
    assert.equal(mergePrs({ root: ROOT, repos: [], prs: [], write: () => { wrote = true; } }), null);
    assert.equal(wrote, false);
  });
});

describe('dropPr', () => {
  // The merger has just landed it: off the list now, and the list's age is
  // what it was — the rest of it is no fresher.
  it('takes one landed pull request off the list and keeps fetched', () => {
    const fs = files({
      [`${ROOT}/runner/prs.json`]: JSON.stringify({
        fetched: '2026-10-10T07:00:00.000Z',
        prs: [{ repo: 'memoro', number: 12900 }, { repo: 'memoro-cli', number: 12900 }, { repo: 'memoro-cli', number: 821 }],
      }),
    });
    assert.equal(dropPr({ root: ROOT, repo: 'memoro-cli', number: 12900, ...fs }), true);
    const saved = JSON.parse(fs.held[`${ROOT}/runner/prs.json`]);
    assert.equal(saved.fetched, '2026-10-10T07:00:00.000Z');
    assert.deepEqual(saved.prs, [{ repo: 'memoro', number: 12900 }, { repo: 'memoro-cli', number: 821 }]);
  });

  it('writes nothing for a pull request it does not hold, or no cache', () => {
    const fs = files({ [`${ROOT}/runner/prs.json`]: JSON.stringify({ fetched: 'T', prs: [] }) });
    let wrote = false;
    assert.equal(dropPr({ root: ROOT, repo: 'memoro', number: 1, read: fs.read, write: () => { wrote = true; } }), false);
    assert.equal(dropPr({ root: ROOT, repo: 'memoro', number: 1, read: files().read }), false);
    assert.equal(wrote, false);
  });
});
