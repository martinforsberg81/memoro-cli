/**
 * What a repository needs before its suite means anything — declared, never
 * guessed.
 *
 * A gate worktree has no `node_modules`. For a repository whose suite cannot
 * run without them the suite dies, and the unfinished-run guard catches that.
 * The case it cannot catch is the one this file is about: a suite that runs a
 * *subset* and summarises anyway. Two such runs produce two small red sets that
 * match, and the gate calls that green.
 *
 * So the rule asserted here is a refusal. A repository mc cannot prove is safe
 * to run unprepared, and has not been told about, stops the round — with a
 * reason that says what to write and where. The tempting heuristic is wrong in
 * both directions and there is a test for that too: this repository declares
 * three dependencies, one of them native, and its suite runs perfectly from a
 * clean worktree.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SHIPPED, declarationFor, tablePath } from '../../src/mc/repo-gate-table.js';

/** A repository directory with the manifest a test wants it to have. */
function repo(name, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'mc-gate-table-'));
  const path = join(root, name);
  const home = join(root, 'home');
  mkdirSync(path, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (manifest !== undefined) writeFileSync(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    path,
    home,
    root,
    override: (table) => writeFileSync(tablePath(home), JSON.stringify(table)),
    ask: () => declarationFor(path, { root: home, env: { MC_WORK_ROOT: join(root, 'work') } }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('a repository mc has not been told about', () => {
  it('stops the round when it has dependencies, and says what to write', () => {
    // The whole point. mc cannot tell from a manifest whether this suite needs
    // its dependencies installed, so it does not decide — it asks to be told.
    const fx = repo('stranger', { name: 'stranger', dependencies: { left_pad: '1.0.0' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /no gate declaration/u);
      assert.match(answer.reason, /declares 1 dependency/u);
      // A stop that does not say how to fix it is a stop somebody works around.
      assert.match(answer.reason, /repo-gates\.json/u);
      assert.match(answer.reason, /"prepare"/u);
    } finally { fx.cleanup(); }
  });

  it('stops when there is no manifest to reason about at all', () => {
    const fx = repo('bare', undefined);
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /no package.json for mc to reason about/u);
    } finally { fx.cleanup(); }
  });

  it('stops when the manifest cannot be read, rather than assuming the best', () => {
    const fx = repo('broken', { name: 'x' });
    try {
      writeFileSync(join(fx.path, 'package.json'), '{ this is not json');
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /could not be read/u);
    } finally { fx.cleanup(); }
  });

  it('proceeds only when there is provably nothing to install', () => {
    // The one carve-out, and it is narrow: a manifest asking for nothing has
    // nothing that could be missing.
    const fx = repo('selfcontained', { name: 'selfcontained', scripts: { test: 'node --test' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.source, 'nothing-to-install');
      assert.equal(answer.declaration.prepare, null);
      assert.match(answer.declaration.prepare_why, /no dependencies at all/u);
    } finally { fx.cleanup(); }
  });

  it('an empty dependency block still counts as nothing to install', () => {
    const fx = repo('empty', { name: 'empty', dependencies: {}, devDependencies: {} });
    try {
      assert.equal(fx.ask().ok, true);
    } finally { fx.cleanup(); }
  });

  it('devDependencies alone are enough to require a declaration', () => {
    const fx = repo('devonly', { name: 'devonly', devDependencies: { eslint: '9.0.0' } });
    try {
      assert.equal(fx.ask().ok, false);
    } finally { fx.cleanup(); }
  });
});

describe('the heuristic mc deliberately does not use', () => {
  it('this repository has dependencies and needs no preparation', () => {
    // "It has dependencies, so install them" would add an install to every
    // round here for nothing — three dependencies, one native, and a suite that
    // runs from a clean worktree. The claim is declared, with its evidence,
    // rather than inferred.
    assert.equal(SHIPPED['memoro-cli'].prepare, null);
    assert.match(SHIPPED['memoro-cli'].prepare_why, /no node_modules/u);
  });

  it('every shipped declaration says why it needs nothing, if it needs nothing', () => {
    // An unexplained `null` is indistinguishable from a forgotten one.
    for (const [name, entry] of Object.entries(SHIPPED)) {
      if (entry.prepare === null) {
        assert.ok(entry.prepare_why, `${name} claims no preparation without saying why`);
      }
    }
  });
});

describe('declarations, shipped and overridden', () => {
  it('memoro-cli keeps behaving exactly as it did', () => {
    const fx = repo('memoro-cli', { name: 'memoro-cli', dependencies: { 'node-pty': '1.0.0' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.source, 'declared');
      assert.equal(answer.declaration.prepare, null, 'a prepare step appeared where there was none');
      assert.deepEqual(answer.declaration.extra_gates, [], 'an extra gate appeared where there was none');
      assert.match(answer.declaration.merge_log, /large-scale-llm-project\/merge-log\.md$/u);
    } finally { fx.cleanup(); }
  });

  it('memoro carries its contract gate and its install step', () => {
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.declaration.prepare, 'npm ci');
      assert.deepEqual(answer.declaration.extra_gates.map((gate) => gate.command), ['npm run test:msr:contract']);
      // The open question, answered honestly: no log rather than an invented one.
      assert.equal(answer.declaration.merge_log, null);
    } finally { fx.cleanup(); }
  });

  it('an operator can declare a repository without a release', () => {
    const fx = repo('someone-elses', { name: 'someone-elses', dependencies: { react: '19.0.0' } });
    try {
      assert.equal(fx.ask().ok, false, 'it should start out undeclared');
      fx.override({ 'someone-elses': { prepare: 'pnpm install --frozen-lockfile', extra_gates: [], merge_log: null } });
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.declaration.prepare, 'pnpm install --frozen-lockfile');
    } finally { fx.cleanup(); }
  });

  it('an override wins over what mc ships', () => {
    const fx = repo('memoro-cli', { name: 'memoro-cli', dependencies: { 'node-pty': '1.0.0' } });
    try {
      fx.override({ 'memoro-cli': { prepare: 'npm ci', extra_gates: [], merge_log: null } });
      assert.equal(fx.ask().declaration.prepare, 'npm ci');
    } finally { fx.cleanup(); }
  });

  it('an unreadable override file does not take the repository down with it', () => {
    const fx = repo('memoro-cli', { name: 'memoro-cli', dependencies: { 'node-pty': '1.0.0' } });
    try {
      writeFileSync(tablePath(fx.home), 'not json at all');
      assert.equal(fx.ask().ok, true, 'a broken override file hid a shipped declaration');
    } finally { fx.cleanup(); }
  });

  it('the merge log path carries no machine’s home directory in it', () => {
    // Written relative to the work root, so a declaration shipped in source
    // does not hard-code where one person keeps their files.
    const raw = JSON.stringify(SHIPPED);
    assert.doesNotMatch(raw, /\/Users\//u);
    assert.doesNotMatch(raw, /\/home\//u);
  });
});
