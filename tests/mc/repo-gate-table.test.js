/**
 * What a repository needs before its suite means anything — declared, never
 * guessed.
 *
 * A gate worktree carries no `node_modules` of its own. For a repository whose
 * suite cannot then resolve anything the suite dies, and the unfinished-run
 * guard catches that. The case it cannot catch is the one this file is about:
 * a suite that runs a *subset* and summarises anyway. Two such runs produce two
 * small red sets that match, and the gate calls that green.
 *
 * So the rule asserted here is a refusal. A repository mc cannot prove is safe
 * to run unprepared, and has not been told about, stops the round — with a
 * reason that says what to write and where.
 *
 * The tempting heuristic still cannot be inferred from a manifest, but the
 * example this file used to give for that — "memoro-cli declares three
 * dependencies and runs fine without them" — was false for as long as it was
 * written down, and no test here could see it: the evidence was a sentence
 * inside the entry. It is read against `package.json` now.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  SHIPPED, UNKNOWN, declarationFor, gateLaneOf, gateLanes, repoDeclarationPath, tablePath,
} from '../../src/mc/repo-gate-table.js';
import { gateRoot } from '../../src/mc/repo-gate.js';
import { sharedDepsPath } from '../../src/mc/paths.js';
import { SHARED_TREE_REPOS } from '../../src/mc/shared-deps.js';

describe('an operator override changes the fields it states and keeps the rest (D-0135)', () => {
  it('a partial override drops nothing it did not name', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-override-'));
    try {
      // The measured hole, twice on one repository: the operator's memoro
      // override replaced the whole shipped entry — extra_gates fell out
      // 2026-08-22, pr_tests_flags fell out 2026-08-24, both in silence. The
      // same override now changes what it says and nothing else.
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({
        memoro: {
          prepare: 'npm ci --prefer-offline',
          prepare_why: 'machine-local',
          extra_gates: [{ name: 'msr contract', command: 'npm run test:msr:contract' }],
        },
      }));
      const answer = declarationFor('/x/memoro', { root });
      assert.equal(answer.ok, true, answer.reason);
      assert.equal(answer.declaration.prepare, 'npm ci --prefer-offline');
      assert.deepEqual(answer.declaration.extra_gates.map((gate) => gate.name), ['msr contract']);
      // Every field the old override lost is still the shipped one.
      const plainRoot = mkdtempSync(join(tmpdir(), 'mc-plain-'));
      const plain = declarationFor('/x/memoro', { root: plainRoot });
      rmSync(plainRoot, { recursive: true, force: true });
      for (const field of ['select', 'suite', 'round_timeout_ms', 'pr_tests_flags', 'retry_once']) {
        assert.ok(plain.declaration[field] != null, `shipped memoro declares ${field}`);
        assert.deepEqual(answer.declaration[field], plain.declaration[field], field);
      }
      assert.equal(answer.sources.prepare, 'override');
      assert.equal(answer.sources.select, 'shipped');
      assert.equal('shadowed' in answer, false, 'there is nothing left to warn about');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('null is how an override says a field is not wanted', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-override-'));
    try {
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({ memoro: { select: null } }));
      const answer = declarationFor('/x/memoro', { root });
      assert.equal(answer.ok, true, answer.reason);
      assert.equal(answer.declaration.select, null);
      assert.equal(answer.sources.select, 'override');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the repository ceiling can be tuned by an override but not dropped', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-override-'));
    try {
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({ memoro: { round_timeout_ms: 600_000, round_timeout_why: 'tuned' } }));
      assert.equal(declarationFor('/x/memoro', { root }).declaration.round_timeout_ms, 600_000);
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({ memoro: { round_timeout_ms: null } }));
      const dropped = declarationFor('/x/memoro', { root });
      assert.equal(dropped.ok, false);
      assert.match(dropped.reason, /round_timeout_ms/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('memoro derived list has one governing layer: the repository (mc/derived-list-one-layer)', () => {
  it('the shipped memoro entry declares no derived list, so there is no second copy to go stale', () => {
    assert.equal('derived' in SHIPPED.memoro, false);
  });

  it('a repository derived list wins over an operator override that does not state it', () => {
    const fx = repo('memoro', { name: 'memoro', scripts: { test: 'node scripts/testing/ci.mjs' } });
    try {
      const derived = [
        { command: 'npm run db:local-schema', paths: ['scripts/dev/local-schema.sql'] },
        { command: 'node scripts/scan-ocr-languages-mirror.mjs', paths: ['public/js/msr/cards/document-scan/generated/locales.js'] },
      ];
      fx.declare({ derived, derived_why: 'fixture: the repository declares its own derived list' });
      fx.override({ memoro: { prepare: 'npm ci --prefer-offline', prepare_why: 'machine-local fixture' } });
      const answer = fx.ask();
      assert.equal(answer.ok, true, answer.reason);
      assert.deepEqual(answer.declaration.derived.map(({ command, paths }) => ({ command, paths })), derived);
      assert.equal(answer.sources.derived, 'repository');
      assert.equal(answer.sources.prepare, 'override');
    } finally { fx.cleanup(); }
  });
});

describe('a lane per repository', () => {
  it('the lane is the name of the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-lane-'));
    try {
      assert.equal(gateLaneOf('memoro-cli'), 'memoro-cli');
      assert.equal(gateLaneOf('/repos/memoro'), 'memoro');
      assert.equal(gateLaneOf('/repos/memoro.git'), 'memoro', 'a bare clone is the same repository');
      assert.equal(gateLaneOf('nobody-knows'), 'nobody-knows');
      assert.ok(gateLanes({ root }).includes('memoro-cli'));
      assert.equal('gate_lane' in SHIPPED['memoro-cli'], false);
      assert.equal('gate_lane' in declarationFor('/x/memoro-cli', { root }).declaration, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});

/** A repository directory with the manifest a test wants it to have. */
function repo(name, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'mc-gate-table-'));
  const path = join(root, name);
  const home = join(root, 'home');
  mkdirSync(path, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (manifest !== undefined) writeFileSync(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const writeOwn = (body) => {
    mkdirSync(join(path, '.mc'), { recursive: true });
    writeFileSync(repoDeclarationPath(path), body);
  };
  return {
    path,
    home,
    root,
    /** What the repository says about itself, in its own tree. */
    declare: (entry) => writeOwn(JSON.stringify(entry, null, 2)),
    declareRaw: (body) => writeOwn(body),
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
  it('the shipped entry for this repository is held against its own package.json', () => {
    // What `prepare: null` claims is that the round has nothing to install.
    // This entry claimed it for months while nothing installed anything —
    // `src/runtime/session-host/` imports `@xterm/addon-serialize`, and five
    // test files went unrun and uncounted every round — and nothing here could
    // catch it, because the only evidence was a sentence in the entry itself.
    // So the manifest is the assertion, whatever names it happens to hold.
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const declares = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
    ];
    const { prepare } = SHIPPED['memoro-cli'];
    if (!declares.length) {
      assert.equal(prepare, null, 'nothing to install, so nothing to prepare');
      return;
    }
    if (prepare === null) {
      // A null beside declared dependencies is allowed exactly once: when the
      // tree is mc's own rather than the round's. That is a claim about two
      // pieces of machinery, and it is asserted against them rather than
      // against the sentence in `prepare_why` — this repository's tree is one
      // mc keeps, and the gate builds its candidate under the directory that
      // tree sits in, so node's parent walk finds it. Move either and this
      // goes red, which is what the old null could never do.
      const env = { MC_WORK_ROOT: '/work' };
      assert.ok(
        SHARED_TREE_REPOS.includes('memoro-cli'),
        `package.json declares ${declares.join(', ')} and nothing installs them: the entry says the `
        + 'round needs no preparation, but mc keeps no tree for this repository',
      );
      assert.equal(sharedDepsPath(env), '/work/node_modules');
      assert.ok(
        gateRoot(env).startsWith('/work/'),
        `the gate builds its candidate at ${gateRoot(env)}, which is not under the work root — `
        + 'the tree mc keeps is not above it, and the suite would run five files short',
      );
    } else {
      // A command, or UNKNOWN — anything but a forgotten claim. `undefined`
      // and a missing field are the same one, so the shape is asserted.
      assert.ok(
        typeof prepare === 'string' && prepare.length > 0,
        `package.json declares ${declares.join(', ')}, and the shipped entry says nothing `
        + `about preparing them (prepare: ${JSON.stringify(prepare)})`,
      );
    }
  });

  it('every shipped declaration explains its preparation, whatever it says', () => {
    // An unexplained `null` is indistinguishable from a forgotten one — and an
    // unexplained command is the guess this file refuses, wearing a uniform.
    for (const [name, entry] of Object.entries(SHIPPED)) {
      assert.ok(entry.prepare_why, `${name} says nothing about why its prepare step is what it is`);
    }
  });

  it('no shipped entry claims a provenance mc cannot stand behind', () => {
    // The failure this cannot test is content: "declared by the PM" reads the
    // same whether or not anybody declared it, which is why the rule is written
    // in the file header. What *can* be checked is that nothing ships a command
    // attributed to somebody — if mc does not know, it says UNKNOWN.
    for (const [name, entry] of Object.entries(SHIPPED)) {
      if (typeof entry.prepare === 'string' && entry.prepare !== UNKNOWN) {
        assert.doesNotMatch(
          entry.prepare_why,
          /declared by|per the|as agreed/iu,
          `${name} ships a command resting on an attribution rather than on evidence`,
        );
      }
    }
  });
});

describe('declarations, shipped and overridden', () => {
  it('memoro-cli is declared, and its round runs whatever the entry says it must', () => {
    const fx = repo('memoro-cli', { name: 'memoro-cli', dependencies: { 'node-pty': '1.0.0' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.source, 'declared');
      assert.equal(answer.declaration.prepare, SHIPPED['memoro-cli'].prepare);
      assert.deepEqual(answer.declaration.extra_gates, [], 'an extra gate appeared where there was none');
      assert.match(answer.declaration.merge_log, /runner\/log\/merge-memoro-cli\.md$/u);
    } finally { fx.cleanup(); }
  });

  it('memoro ships the measured declaration, not UNKNOWN (D-0089)', () => {
    // This entry said UNKNOWN for a day while the operator table beside it
    // carried the measurement — and mc's own reading of itself quoted the
    // stale half (2026-08-22). One question about one repository, one answer.
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true, answer.reason);
      assert.equal(answer.source, 'declared');
      assert.equal(answer.declaration.prepare, 'npm ci');
      assert.match(answer.declaration.prepare_why, /D-0089/u);
      // `msr contract` was an extra gate until 2026-08-30. It ran the same 326
      // files the suite already ran — `test:msr:contract` globs exactly the
      // `msr-contract` profile — so a round paid for that suite four times
      // over: both sides of `npm test`, then both sides of the gate.
      assert.deepEqual(answer.declaration.extra_gates, []);
      // How memoro says what a change reaches. Its presence is what turns the
      // round from two full suites into the reached files, measured on both.
      assert.match(answer.declaration.select, /ci\.mjs --list --json/u);
      assert.match(answer.declaration.merge_log, /runner\/log\/merge-memoro\.md$/u);
    } finally { fx.cleanup(); }
  });

  it('a partly declared repository stops exactly as hard as an undeclared one', () => {
    // The rule that makes the third state safe: "partly declared" must never
    // become a way to run anyway.
    const known = repo('stranger', { name: 'stranger', dependencies: { next: '15.0.0' } });
    const unknown = repo('nobody', { name: 'nobody', dependencies: { next: '15.0.0' } });
    try {
      known.override({ stranger: { prepare: 'unknown', extra_gates: [], merge_log: null } });
      assert.equal(known.ask().ok, false);
      assert.match(known.ask().reason, /preparation step is not/u);
      assert.equal(unknown.ask().ok, false);
      // And neither hands back a declaration the round could act on.
      assert.equal(known.ask().declaration, undefined);
      assert.equal(unknown.ask().declaration, undefined);
    } finally { known.cleanup(); unknown.cleanup(); }
  });

  it('declaring the missing half is enough to let it run', () => {
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      fx.override({
        memoro: {
          prepare: 'npm ci',
          prepare_why: 'written by whoever actually knows, in the operator table',
          extra_gates: [{ name: 'msr contract', command: 'npm run test:msr:contract' }],
          merge_log: null,
        },
      });
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.equal(answer.declaration.prepare, 'npm ci');
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

describe('pr_tests_flags', () => {
  it('memoro and memoro-cli ship theirs, an entry without any gets an empty list', () => {
    const memoro = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    const cli = repo('memoro-cli', { name: 'memoro-cli', dependencies: { a: '1' } });
    const other = repo('stranger', { name: 'stranger' });
    try {
      assert.deepEqual(memoro.ask().declaration.pr_tests_flags, ['--import', './tests/_helpers/browser-paths.mjs']);
      assert.deepEqual(cli.ask().declaration.pr_tests_flags, ['--import', './tests/_isolate-home.mjs', '--test-timeout=30000']);
      other.override({ stranger: { prepare: null, extra_gates: [], merge_log: null } });
      assert.deepEqual(other.ask().declaration.pr_tests_flags, []);
    } finally { memoro.cleanup(); cli.cleanup(); other.cleanup(); }
  });
});

/**
 * The measured tree's timeout is the floor the layers above it are held to
 * (timeout-enforcement-plan.md contract A). Memoro declares 1000 ms in its
 * own `.mc/test.json`; read from the bare common directory, or replaced by a
 * loader-only override, it became the 600000 ms default in silence.
 */
describe('the timeout policy of the measured tree', () => {
  const LOADER = ['--import', './tests/_helpers/browser-paths.mjs'];
  /** A bare common directory, a primary checkout and a worktree, each declaring differently. */
  function layout({ worktree = { pr_tests_flags: [...LOADER, '--test-timeout=1000'] }, script = 'node scripts/testing/ci.mjs' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mc-timeout-policy-'));
    const bare = join(root, 'repos', 'memoro.git');
    const primary = join(root, 'memoro');
    const tree = join(root, 'gate', 'memoro', 'candidate');
    const home = join(root, 'home');
    for (const dir of [bare, primary, tree, home]) mkdirSync(dir, { recursive: true });
    const declare = (dir, entry) => {
      mkdirSync(join(dir, '.mc'), { recursive: true });
      writeFileSync(repoDeclarationPath(dir), typeof entry === 'string' ? entry : JSON.stringify(entry));
    };
    declare(primary, { pr_tests_flags: [...LOADER, '--test-timeout=5000'] });
    if (worktree !== null) declare(tree, worktree);
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'memoro', scripts: { test: script } }));
    return {
      root, bare, primary, tree, home,
      override: (entry) => writeFileSync(tablePath(home), JSON.stringify({ memoro: entry })),
      ask: (repoPath, contentDir) => declarationFor(repoPath, { root: home, env: { MC_WORK_ROOT: join(root, 'work') }, ...(contentDir ? { contentDir } : {}) }),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('timeout policy: the repository is named by its identity, the declaration read from the measured tree — bare and ordinary alike', () => {
    const fx = layout();
    try {
      const fromBare = fx.ask(fx.bare, fx.tree);
      const fromPrimary = fx.ask(fx.primary, fx.tree);
      for (const answer of [fromBare, fromPrimary]) {
        assert.equal(answer.ok, true, answer.reason);
        assert.equal(answer.name, 'memoro', 'identity, not the directory called candidate');
        assert.deepEqual(answer.declaration.pr_tests_flags, [...LOADER, '--test-timeout=1000']);
        assert.deepEqual(answer.timeout, { ms: 1000, source: repoDeclarationPath(fx.tree) });
        assert.equal(answer.sources.pr_tests_flags, 'repository');
        assert.equal(answer.declaration.select, SHIPPED.memoro.select, 'the shipped layer is memoro\'s');
        assert.equal(answer.notice, null);
      }
      // Read where the repository is, a bare one says nothing and a primary checkout its own 5000.
      assert.deepEqual(fx.ask(fx.bare).declaration.pr_tests_flags, LOADER);
      assert.equal(fx.ask(fx.bare).timeout, null);
      assert.deepEqual(fx.ask(fx.primary).declaration.pr_tests_flags, [...LOADER, '--test-timeout=5000']);
    } finally { fx.cleanup(); }
  });

  it('timeout policy: an override array without a timeout inherits the reference with a notice, and every other field is the override\'s precedence', () => {
    const fx = layout();
    const plain = layout({ worktree: { pr_tests_flags: LOADER } });
    try {
      const entry = { pr_tests_flags: ['--import', './op-loader.mjs'], prepare: 'npm ci --offline', prepare_why: 'operator' };
      fx.override(entry);
      plain.override(entry);
      const answer = fx.ask(fx.bare, fx.tree);
      assert.equal(answer.ok, true, answer.reason);
      assert.deepEqual(answer.declaration.pr_tests_flags, ['--import', './op-loader.mjs', '--test-timeout=1000']);
      assert.equal(answer.notice, `timeout policy: --test-timeout=1000 from ${repoDeclarationPath(fx.tree)} — `
        + `pr_tests_flags from the operator override ${tablePath(fx.home)} states no --test-timeout`);
      assert.equal(answer.sources.pr_tests_flags, 'override');
      // The same layers with no timeout in the tree: only pr_tests_flags differs.
      const without = plain.ask(plain.bare, plain.tree);
      assert.deepEqual(without.declaration.pr_tests_flags, ['--import', './op-loader.mjs']);
      assert.equal(without.notice, null);
      const rest = (declaration) => ({ ...declaration, pr_tests_flags: null, merge_log: null });
      assert.deepEqual(rest(answer.declaration), rest(without.declaration));
      assert.equal(answer.declaration.prepare, 'npm ci --offline');
      assert.deepEqual(answer.sources, without.sources);
    } finally { fx.cleanup(); plain.cleanup(); }
  });

  it('timeout policy: a looser, zero, Infinity, wordy or duplicated override timeout refuses, naming both sources and values', () => {
    const fx = layout();
    try {
      for (const [flags, stated, why] of [
        [[...LOADER, '--test-timeout=600000'], '--test-timeout=600000', 'looser than the measured tree'],
        [['--test-timeout=0'], '--test-timeout=0', 'not a positive number of milliseconds'],
        [['--test-timeout=Infinity'], '--test-timeout=Infinity', 'not a positive number of milliseconds'],
        [['--test-timeout', 'soon'], '--test-timeout=soon', 'not a positive number of milliseconds'],
        [['--test-timeout=1000', '--test-timeout=500'], '--test-timeout=1000 --test-timeout=500', 'more than one --test-timeout'],
      ]) {
        fx.override({ pr_tests_flags: flags });
        const answer = fx.ask(fx.bare, fx.tree);
        assert.deepEqual({ ok: answer.ok, kind: answer.kind, declaration: answer.declaration }, { ok: false, kind: 'timeout', declaration: undefined }, stated);
        assert.equal(answer.reason, `timeout policy: pr_tests_flags from the operator override ${tablePath(fx.home)} states ${stated} (${why}), `
          + `but ${repoDeclarationPath(fx.tree)} declares --test-timeout=1000 — nothing was run. A layer may tighten the repository's `
          + 'timeout, never loosen or drop it: state at most --test-timeout=1000 there, or none and the repository\'s applies.');
      }
    } finally { fx.cleanup(); }
  });

  it('timeout policy: an equal or tighter override timeout stands exactly as written', () => {
    const fx = layout();
    try {
      for (const flags of [[...LOADER, '--test-timeout=1000'], ['--test-timeout', '500', ...LOADER]]) {
        fx.override({ pr_tests_flags: flags });
        const answer = fx.ask(fx.bare, fx.tree);
        assert.equal(answer.ok, true, answer.reason);
        assert.deepEqual(answer.declaration.pr_tests_flags, flags);
        assert.equal(answer.notice, null);
      }
    } finally { fx.cleanup(); }
  });

  it('timeout policy: a script timeout is the reference when .mc/test.json states none; with neither, the array is as declared', () => {
    const scripted = layout({ worktree: null, script: 'node --test --test-timeout=1000 tests/' });
    const neither = layout({ worktree: null });
    try {
      const shipped = scripted.ask(scripted.bare, scripted.tree);
      assert.equal(shipped.ok, true, shipped.reason);
      assert.deepEqual(shipped.declaration.pr_tests_flags, [...LOADER, '--test-timeout=1000']);
      assert.equal(shipped.notice, `timeout policy: --test-timeout=1000 from ${join(scripted.tree, 'package.json')} scripts.test — `
        + 'pr_tests_flags from mc\'s shipped gate table entry for memoro (src/mc/repo-gate-table.js) states no --test-timeout');
      scripted.override({ pr_tests_flags: ['--test-timeout=2000'] });
      assert.equal(scripted.ask(scripted.bare, scripted.tree).kind, 'timeout');
      // No reference anywhere: today's behaviour, a looser array included.
      neither.override({ pr_tests_flags: [...LOADER, '--test-timeout=600000'] });
      const unchanged = neither.ask(neither.bare, neither.tree);
      assert.equal(unchanged.ok, true, unchanged.reason);
      assert.deepEqual(unchanged.declaration.pr_tests_flags, [...LOADER, '--test-timeout=600000']);
      assert.deepEqual([unchanged.notice, unchanged.timeout], [null, null]);
    } finally { scripted.cleanup(); neither.cleanup(); }
  });

  it('timeout policy: a malformed declaration in the measured tree, or one stating two timeouts, is a stop with its kind', () => {
    const broken = layout({ worktree: '{"pr_tests_flags": [' });
    const twice = layout({ worktree: { pr_tests_flags: ['--test-timeout=1000', '--test-timeout=2000'] } });
    try {
      const malformed = broken.ask(broken.bare, broken.tree);
      assert.deepEqual([malformed.ok, malformed.kind], [false, 'malformed']);
      assert.ok(malformed.reason.startsWith(`memoro declares itself in ${repoDeclarationPath(broken.tree)}, but it could not be read as JSON`), malformed.reason);
      const ambiguous = twice.ask(twice.bare, twice.tree);
      assert.deepEqual([ambiguous.ok, ambiguous.kind], [false, 'timeout']);
      assert.equal(ambiguous.reason, `timeout policy: ${repoDeclarationPath(twice.tree)} declares --test-timeout=1000 --test-timeout=2000 `
        + '— exactly one positive --test-timeout or none; nothing was run. Fix that file.');
    } finally { broken.cleanup(); twice.cleanup(); }
  });
});

/**
 * The layer the repository owns.
 *
 * How memoro tests itself is a fact about memoro, and it lived in mc's source
 * — so every change to it was a memoro-cli release. The rule is unchanged
 * here: written down or the round stops. Only the address is new, and with
 * three addresses the two things a reader needs are which one won and which
 * one to edit.
 */
describe('a repository that declares itself in .mc/test.json', () => {
  const cli = () => repo('memoro-cli', { name: 'memoro-cli', dependencies: { 'node-pty': '1.0.0' } });

  it('a repository with no file of its own is exactly what mc ships, field for field', () => {
    // The case that must not move. Everything below it is new behaviour; this
    // is the assertion that the new behaviour costs nothing when the file is
    // absent — the shipped values verbatim, and the two fields this step adds
    // reading null, which is what "this repository has not said" looks like.
    const fx = cli();
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      assert.deepEqual(answer.declaration, {
        prepare: SHIPPED['memoro-cli'].prepare,
        prepare_why: SHIPPED['memoro-cli'].prepare_why,
        select: SHIPPED['memoro-cli'].select,
        select_why: SHIPPED['memoro-cli'].select_why,
        select_changed_path: SHIPPED['memoro-cli'].select_changed_path,
        select_changed_path_why: SHIPPED['memoro-cli'].select_changed_path_why,
        suite: SHIPPED['memoro-cli'].suite,
        suite_why: SHIPPED['memoro-cli'].suite_why,
        extra_gates: [],
        derived: [],
        merge_log: join(fx.root, 'work', 'runner/log/merge-memoro-cli.md'),
        pr_tests_flags: ['--import', './tests/_isolate-home.mjs', '--test-timeout=30000'],
        session_whole: true,
        main_only: [],
        affected: null,
        serial_paths: null,
        deps_notes: [],
        retry_once: { files: [], gates: [] },
        retry_once_why: null,
        round_timeout_ms: 900_000,
        round_timeout_why: SHIPPED['memoro-cli'].round_timeout_why,
      });
      // And every field is attributed to the file it came from.
      assert.equal(answer.sources.select, 'shipped');
      assert.equal(answer.sources.prepare, 'shipped');
    } finally { fx.cleanup(); }
  });

  it('the repository beats what mc ships, and the operator beats the repository', () => {
    const fx = cli();
    try {
      fx.declare({ select: 'node scripts/affected-tests.js --base-ref origin/main --v2' });
      assert.equal(fx.ask().declaration.select, 'node scripts/affected-tests.js --base-ref origin/main --v2');
      assert.equal(fx.ask().sources.select, 'repository');

      // The operator's file stays the last word: it is how a fact about this
      // machine gets in without a release in either repository.
      fx.override({ 'memoro-cli': { prepare: null, prepare_why: 'local', select: 'node one-off.js', extra_gates: [], merge_log: null } });
      assert.equal(fx.ask().declaration.select, 'node one-off.js');
      assert.equal(fx.ask().sources.select, 'override');
    } finally { fx.cleanup(); }
  });

  it('the archive worktree is named after its repository, so memoro\'s own file is read as memoro\'s', () => {
    // The archive pass opens its worktree at runner/archive/programs/<repo>.
    // declarationFor names the repository by the last segment of the path, so
    // only that path finds memoro's shipped entry. Under the old name the same
    // file is a partial declaration, and it is refused.
    const fx = repo('memoro');
    try {
      const own = {
        schema_version: 1,
        environments: { dev: { service: 'memoro-worker', profile: 'agent' }, prod: { base_url: 'https://meetmemoro.app' } },
        base_url_env: 'MEMORO_BASE_URL',
        skip_exit_code: 78,
        suites: [{ name: 'write-smoke', argv: ['npm', 'run', 'test:environment-smoke'], server: 'app', needs_account: true }],
      };
      const at = (...parts) => join(fx.root, 'runner', 'archive', ...parts);
      for (const dir of [at('programs', 'memoro'), at('memoro-programs')]) {
        mkdirSync(join(dir, '.mc'), { recursive: true });
        writeFileSync(repoDeclarationPath(dir), JSON.stringify(own, null, 2));
      }
      const opts = { root: fx.home, env: { MC_WORK_ROOT: join(fx.root, 'work') } };

      const named = declarationFor(at('programs', 'memoro'), opts);
      assert.equal(named.ok, true, named.reason);
      assert.equal(named.name, 'memoro');

      const oldName = declarationFor(at('memoro-programs'), opts);
      assert.equal(oldName.ok, false);
      assert.equal(oldName.name, 'memoro-programs');
      assert.match(oldName.reason, /says nothing about its preparation/u);
    } finally { fx.cleanup(); }
  });

  /**
   * The one field this table did not have until 2026-09-02, layered like the
   * rest.
   *
   * What a repository calls its *whole* suite used to be read off
   * `package.json` — `npm test`, verbatim — and the assumption under that is
   * false for memoro, whose `npm test` is a diff-selector. A `--full` round
   * had no diff, so it ran 6 files of 2,018 and summarised them as
   * everything. So it is declared, and declared means all three files: a
   * repository can correct mc without a release, and an operator can correct
   * both without either.
   */
  it('the whole-suite command reads through the same three layers as the rest', () => {
    const fx = cli();
    try {
      assert.equal(fx.ask().declaration.suite, SHIPPED['memoro-cli'].suite);
      assert.equal(fx.ask().sources.suite, 'shipped');

      fx.declare({ suite: 'npm run test:all', suite_why: 'the repository measured it' });
      assert.equal(fx.ask().declaration.suite, 'npm run test:all');
      assert.equal(fx.ask().sources.suite, 'repository');
      assert.equal(fx.ask().declaration.select, SHIPPED['memoro-cli'].select, 'a partial file dropped the shipped select');

      fx.override({ 'memoro-cli': { prepare: null, prepare_why: 'local', suite: 'npm run test:here', extra_gates: [], merge_log: null } });
      assert.equal(fx.ask().declaration.suite, 'npm run test:here');
      assert.equal(fx.ask().sources.suite, 'override');
    } finally { fx.cleanup(); }
  });

  /**
   * The absence that must stay expressible. `suite: null` is not a defect in
   * a repository that never claimed to narrow anything — it is what "nothing
   * here selects, so `npm test` is the whole thing" looks like, and the round
   * is what decides whether that is enough (`repo-gate.js`, `suiteCommand`).
   * This table's job is to report the fields, not to grade them.
   */
  it('a repository that has said nothing about its whole suite reads null, not a guess', () => {
    const fx = repo('stranger', { name: 'stranger' });
    try {
      const answer = fx.ask();
      assert.equal(answer.ok, true, answer.reason);
      assert.equal(answer.declaration.suite, null);
      assert.equal(answer.declaration.select, null);
    } finally { fx.cleanup(); }
  });

  it('the repository states one field and keeps the rest of what mc ships', () => {
    // Field by field, unlike the operator's file. A repository writes about
    // itself and cannot know where its merges are logged — a whole-entry
    // replacement would drop merge_log in silence, which is D-0135 again.
    const fx = cli();
    try {
      fx.declare({ pr_tests_flags: ['--import', './tests/_isolate-home.mjs', '--no-warnings'] });
      const answer = fx.ask();
      assert.deepEqual(answer.declaration.pr_tests_flags, ['--import', './tests/_isolate-home.mjs', '--no-warnings']);
      assert.equal(answer.declaration.select, SHIPPED['memoro-cli'].select, 'the shipped select fell out of a partial file');
      assert.match(answer.declaration.merge_log, /runner\/log\/merge-memoro-cli\.md$/u);
      assert.equal(answer.sources.pr_tests_flags, 'repository');
      assert.equal(answer.sources.merge_log, 'shipped');
    } finally { fx.cleanup(); }
  });

  it('an override on top of the repository keeps what the repository declared', () => {
    const fx = cli();
    try {
      fx.declare({ select: 'node scripts/affected-tests.js --v2', select_why: 'measured here' });
      fx.override({ 'memoro-cli': { prepare: null, prepare_why: 'local', extra_gates: [], merge_log: null } });
      const answer = fx.ask();
      assert.equal(answer.ok, true, answer.reason);
      // The repository's own fields are a layer an override used to drop just
      // as it dropped the shipped one twice; field by field, it cannot.
      assert.equal(answer.declaration.select, 'node scripts/affected-tests.js --v2');
      assert.equal(answer.sources.select, 'repository');
      assert.equal(answer.sources.prepare, 'override');
      assert.equal(answer.sources.round_timeout_ms, 'shipped');
    } finally { fx.cleanup(); }
  });

  it('a file that will not parse is a stop, never a fall-through to what mc ships', () => {
    // The important half. Falling back here would run the round on an
    // instruction somebody believes they replaced — the same failure as a
    // partial declaration, and it stops exactly as hard. The operator's file
    // keeps the opposite behaviour, asserted above: it is additions on top of
    // a declaration, not the declaration.
    const fx = cli();
    try {
      fx.declareRaw('{ "select": ');
      const answer = fx.ask();
      assert.equal(answer.ok, false, 'a broken .mc/test.json was ignored and the shipped entry ran');
      assert.match(answer.reason, /\.mc\/test\.json/u);
      assert.match(answer.reason, /could not be read as JSON/u);
      assert.equal(answer.declaration, undefined);
    } finally { fx.cleanup(); }
  });

  it('a file that is JSON but not an object of fields stops the same way', () => {
    const fx = cli();
    try {
      fx.declareRaw('["npm ci"]');
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /JSON object of declaration fields/u);
    } finally { fx.cleanup(); }
  });

  it('a repository mc ships nothing for must still state its preparation', () => {
    // A file saying `select` and nothing else, for a repository no other layer
    // knows, would quietly mean "prepare: null" — the guess this whole table
    // exists to refuse, arriving by the new door.
    const fx = repo('stranger', { name: 'stranger', dependencies: { left_pad: '1.0.0' } });
    try {
      fx.declare({ select: 'node select.js' });
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /says nothing about[\s\S]*its preparation/u);
      assert.equal(answer.declaration, undefined);
      // And it says what it did hear, so whoever completes the file can see it.
      assert.equal(answer.known.select, 'node select.js');

      // Stating it is enough — no release in mc, no operator file.
      fx.declare({ select: 'node select.js', prepare: 'npm ci', prepare_why: 'measured in the repository' });
      const ok = fx.ask();
      assert.equal(ok.ok, true, ok.reason);
      assert.equal(ok.declaration.prepare, 'npm ci');
      assert.equal(ok.sources.prepare, 'repository');
    } finally { fx.cleanup(); }
  });

  it('a repository can declare its preparation unknown, and that stops the round', () => {
    const fx = repo('stranger', { name: 'stranger', dependencies: { left_pad: '1.0.0' } });
    try {
      fx.declare({ prepare: UNKNOWN, prepare_why: 'nobody has measured it', select: 'node select.js' });
      const answer = fx.ask();
      assert.equal(answer.ok, false);
      assert.match(answer.reason, /preparation step is not/u);
      // A refusal with three possible addresses has to name the one that is
      // the repository's own.
      assert.match(answer.reason, /\.mc\/test\.json/u);
    } finally { fx.cleanup(); }
  });
});

describe('the fields a declaration can carry', () => {
  it('affected is read, and is null for every repository mc ships', () => {
    // `repo-freshen.js` has described a step that runs the repository's
    // declared `affected` since it was written, and normalise() did not
    // return the field — so it was undefined everywhere and the path never
    // ran. It is readable now; what it should hold for memoro is a live
    // question (ruling 4 said `npm run ci`, which is 554.7 s and was ruled
    // out on 2026-08-31), so no shipped entry answers it.
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      assert.equal(fx.ask().declaration.affected, null);
      fx.declare({ affected: 'node scripts/affected-tests.js --base-ref origin/main' });
      assert.equal(fx.ask().declaration.affected, 'node scripts/affected-tests.js --base-ref origin/main');
      assert.equal(fx.ask().sources.affected, 'repository');
    } finally { fx.cleanup(); }
  });

  /**
   * Ruling 44 § 5: the test files and command gates known to flip under load,
   * run once more alone before they are red. Declared, like everything here,
   * and a repository can say it for itself.
   */
  it('retry_once ships for memoro with its evidence, reads through the repository\'s file, and is empty elsewhere', () => {
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    const cli = repo('memoro-cli', { name: 'memoro-cli', dependencies: { a: '1' } });
    try {
      const shipped = fx.ask().declaration;
      assert.deepEqual(shipped.retry_once.gates, ['sql:pr-ci', 'core:startup:jsc:check']);
      assert.deepEqual(shipped.retry_once.files, ['tests/architecture/css-dead-rules.test.js', 'tests/scripts/build-bundle.test.js']);
      assert.match(shipped.retry_once_why, /sql:pr-ci` command gate 15/u);
      assert.equal(fx.ask().sources.retry_once, 'shipped');

      fx.declare({ retry_once: { files: ['tests/slow.test.js'] }, retry_once_why: 'measured here' });
      assert.deepEqual(fx.ask().declaration.retry_once, { files: ['tests/slow.test.js'], gates: [] });
      assert.equal(fx.ask().sources.retry_once, 'repository');

      assert.deepEqual(cli.ask().declaration.retry_once, { files: [], gates: [] });
    } finally { fx.cleanup(); cli.cleanup(); }
  });

  it('select_changed_path ships on for memoro and memoro-cli, and a non-boolean is a declaration error (ruling 47)', () => {
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    const cli = repo('memoro-cli', { name: 'memoro-cli', dependencies: { a: '1' } });
    try {
      assert.equal(fx.ask().declaration.select_changed_path, true);
      assert.match(fx.ask().declaration.select_changed_path_why, /--changed-path/u);
      assert.equal(cli.ask().declaration.select_changed_path, true, 'memoro-cli head greens survive main moving');
      assert.match(cli.ask().declaration.select_changed_path_why, /--changed-path.*--base-ref/u);
      fx.declare({ select_changed_path: false });
      assert.equal(fx.ask().declaration.select_changed_path, false);
      fx.declare({ select_changed_path: 'yes' });
      assert.equal(fx.ask().ok, false);
      assert.match(fx.ask().reason, /declares select_changed_path "yes"/u);
    } finally { fx.cleanup(); cli.cleanup(); }
  });

  it('a retry_once the round cannot read is a declaration error, not a quiet nothing', () => {
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      for (const bad of [['tests/a.test.js'], { files: 'tests/a.test.js' }, { gates: [''] }, { tests: [] }]) {
        fx.declare({ retry_once: bad });
        const answer = fx.ask();
        assert.equal(answer.ok, false, JSON.stringify(bad));
        assert.match(answer.reason, /declares retry_once/u);
      }
    } finally { fx.cleanup(); }
  });

  it('serial_paths tells "has not said" apart from "said nothing is serial"', () => {
    // mc runs a repository's selected files itself, so it does not see the
    // resource class the repository's own runner knows. Until a selection
    // carries that per file, the honest answer "this repository has not said"
    // has to be expressible — which is why null and [] are different answers.
    const fx = repo('memoro', { name: 'memoro', dependencies: { next: '15.0.0' } });
    try {
      assert.equal(fx.ask().declaration.serial_paths, null, 'a silence read as a promise');
      fx.declare({ serial_paths: [] });
      assert.deepEqual(fx.ask().declaration.serial_paths, []);
      fx.declare({ serial_paths: ['tests/sqlite/', 'tests/heavy/'] });
      assert.deepEqual(fx.ask().declaration.serial_paths, ['tests/sqlite/', 'tests/heavy/']);
    } finally { fx.cleanup(); }
  });
});
