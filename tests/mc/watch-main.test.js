/**
 * The main-watch (D-0190/D-0199, built 2026-08-24): is the base branch
 * green, and when did it go red? What matters is the transition, measured
 * per base-SHA. Everything the round touches is injected, so the whole of
 * its judgement is tested without a real suite, worktree or network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { mainRound, mainKnockText } from '../../src/mc/watch-main-round.js';
import { readMainState, writeMainState } from '../../src/mc/watch-main-store.js';
import { saveBaseline, lockfileHashAt } from '../../src/mc/repo-baseline-cache.js';

const HOME = () => mkdtempSync(join(tmpdir(), 'mc-watch-main-'));

/**
 * A git stub that answers the round's questions: a base commit that can be
 * moved, a lockfile hash, and a first-parent log for the interval. `red`
 * decides what a real suite would report if the round runs one.
 */
function gitStub({ commit = 'aaaaaaa', log = [] } = {}) {
  const calls = [];
  return {
    calls,
    move(next) { commit = next; },
    git(args) {
      calls.push(args.join(' '));
      const a = args.filter((x) => x !== '-C' && x !== repoPathToken(args));
      if (args.includes('fetch')) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('rev-parse') && args.includes('origin/main')) return { status: 0, stdout: `${commit}\n` };
      if (args.includes('show')) return { status: 1, stdout: '', stderr: '' }; // no lockfile
      if (args.includes('log')) return { status: 0, stdout: `${log.join('\n')}\n` };
      if (args[args.indexOf('worktree') + 1] === 'add') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
  };
}
function repoPathToken() { return null; }

/** A suite runner that reports a chosen red set as TAP. */
function suiteWith(red, { finished = true } = {}) {
  return async () => {
    const lines = ['TAP version 13'];
    red.forEach((name, index) => { lines.push(`# Subtest: ${name}`, `not ok ${index + 1} - ${name}`); });
    lines.push(`1..${red.length}`);
    if (finished) lines.push(`# tests ${Math.max(1, red.length)}`, `# pass 0`, `# fail ${red.length}`);
    return { code: red.length ? 1 : 0, tap: lines.join('\n') };
  };
}

describe('measured per base-SHA', () => {
  it('does nothing when main has not moved since the last pass', async () => {
    const root = HOME();
    try {
      writeMainState({ commit: 'aaaaaaa', red: [], base: 'origin/main' }, { root });
      const git = gitStub({ commit: 'aaaaaaa' });
      let ran = 0;
      const out = await mainRound({ repoPath: '/r', root, git: git.git, suite: () => { ran += 1; return suiteWith([])(); }, knock: null, log: () => {} });
      assert.equal(out.moved, false);
      assert.equal(ran, 0, 'an unmoved main runs no suite');
      assert.ok(!git.calls.some((c) => c.includes('worktree add')), 'and builds no worktree');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a moved main already measured green by the gate is green for free — no suite', async () => {
    const root = HOME();
    const repo = mkdtempSync(join(tmpdir(), 'mc-watch-main-repo-'));
    try {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node --test' } }));
      writeMainState({ commit: 'aaaaaaa', red: [], base: 'origin/main' }, { root });
      const git = gitStub({ commit: 'bbbbbbb' });
      const { suiteCommand } = await import('../../src/mc/repo-gate.js');
      const command = suiteCommand({ repoPath: repo }).command;
      const lockfileHash = lockfileHashAt({ git: (args) => git.git(['-C', repo, ...args]), repoPath: repo, commit: 'bbbbbbb' });
      saveBaseline({ repoPath: repo, commit: 'bbbbbbb', lockfileHash, command, red: [], totals: null, root });
      let ran = 0;
      const out = await mainRound({ repoPath: repo, root, git: git.git, suite: () => { ran += 1; return suiteWith([])(); }, knock: null, log: () => {} });
      assert.equal(out.moved, true);
      assert.equal(out.source, 'gate-baseline');
      assert.equal(ran, 0, 'the gate already measured this commit');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('the transition, not the state', () => {
  const run = async (root, { from, to, prevRed, red, log = [] }) => {
    // A repo the declaration table knows (prepare: null), so measureAt runs
    // the injected suite rather than stopping for a missing declaration.
    const repo = mkdtempSync(join(tmpdir(), 'mc-watch-main-repo-'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({ r: { prepare: null, prepare_why: 'a test', extra_gates: [], merge_log: null } }));
    writeMainState({ commit: from, red: prevRed, base: 'origin/main' }, { root });
    const git = gitStub({ commit: to, log });
    const knocks = [];
    const out = await mainRound({
      repoPath: repo, root, git: git.git, suite: suiteWith(red),
      knock: async (message) => { knocks.push(message); return { ok: true, woke: true }; },
      log: () => {},
    });
    rmSync(repo, { recursive: true, force: true });
    return { out, knocks };
  };

  it('knocks the moment main goes red, names the new red, and lists the landings', async () => {
    const root = HOME();
    try {
      const { out, knocks } = await run(root, {
        from: 'aaaaaaa', to: 'ccccccc', prevRed: [], red: ['suite › a', 'suite › b'],
        log: ['ccccccc a bad merge', 'ddddddd something else'],
      });
      assert.equal(out.wentRed, true);
      assert.equal(knocks.length, 1);
      assert.match(knocks[0], /origin\/main WENT RED at ccccccc — 2 red names, and it was green before this/u);
      assert.match(knocks[0], /suite › a/u);
      assert.match(knocks[0], /ccccccc a bad merge/u);
      assert.equal(readMainState({ root }).red.length, 2, 'the new measurement is remembered');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is silent when main was red and stays red with nothing new', async () => {
    const root = HOME();
    try {
      const { out, knocks } = await run(root, {
        from: 'aaaaaaa', to: 'ccccccc', prevRed: ['old'], red: ['old'],
      });
      assert.equal(out.wentRed, false);
      assert.equal(knocks.length, 0, 'a standing red is not news');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('knocks again when a red main gains a NEW red name', async () => {
    const root = HOME();
    try {
      const { out, knocks } = await run(root, {
        from: 'aaaaaaa', to: 'ccccccc', prevRed: ['old'], red: ['old', 'fresh'],
      });
      assert.equal(out.wentRed, true);
      assert.deepEqual(out.broke, ['fresh']);
      assert.match(knocks[0], /1 NEW red name at ccccccc/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a green move after red is remembered, and knocks nobody', async () => {
    const root = HOME();
    try {
      const { out, knocks } = await run(root, {
        from: 'aaaaaaa', to: 'ccccccc', prevRed: ['old'], red: [],
      });
      assert.equal(out.wentRed, false);
      assert.equal(knocks.length, 0);
      assert.deepEqual(readMainState({ root }).red, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a measurement it could not take advances nothing', () => {
  it('an unfinished suite leaves the state untouched, so the next pass retries', async () => {
    const root = HOME();
    try {
      const repo = mkdtempSync(join(tmpdir(), 'mc-watch-main-repo-'));
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'node --test' } }));
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({ r: { prepare: null, prepare_why: 'a test', extra_gates: [], merge_log: null } }));
      writeMainState({ commit: 'aaaaaaa', red: [], base: 'origin/main' }, { root });
      const git = gitStub({ commit: 'ccccccc' });
      const out = await mainRound({
        repoPath: repo, root, git: git.git, suite: suiteWith(['x'], { finished: false }),
        knock: async () => ({ ok: true }), log: () => {},
      });
      assert.equal(out.measured, false);
      assert.match(out.reason, /never reached its own summary/u);
      assert.equal(readMainState({ root }).commit, 'aaaaaaa', 'the unmeasured commit was not recorded');
      rmSync(repo, { recursive: true, force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the knock text', () => {
  it('names one landing in the singular and says the review is somebody-s', () => {
    const text = mainKnockText({ base: 'origin/main', commit: 'ccccccc1', red: ['a'], broke: ['a'], wasGreen: true, landings: ['ccccccc1 the one merge'] });
    assert.match(text, /WENT RED/u);
    assert.match(text, /The landing since the last green measurement:/u);
    assert.match(text, /which of these landings caused it is the review/u);
  });
});

