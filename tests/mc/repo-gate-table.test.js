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

import {
  SHIPPED, UNKNOWN, declarationFor, repoDeclarationPath, tablePath,
} from '../../src/mc/repo-gate-table.js';

describe('an override that shadows shipped fields is said, not silent (D-0135)', () => {
  it('names the fields the override dropped, and nothing when there is no override', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-shadow-'));
    try {
      // The measured hole, twice on one repository: the operator's memoro
      // override replaced the whole shipped entry — extra_gates fell out
      // 2026-08-22, pr_tests_flags fell out 2026-08-24, both in silence.
      writeFileSync(join(root, 'repo-gates.json'), JSON.stringify({
        memoro: {
          prepare: 'npm ci',
          prepare_why: 'measured',
          extra_gates: [{ name: 'msr contract', command: 'npm run test:msr:contract' }],
          merge_log: null,
        },
      }));
      const shadowedResult = declarationFor('/x/memoro', { root });
      assert.equal(shadowedResult.ok, true);
      // `select` joined the shipped entry on 2026-08-30 and is the field that
      // decides whether the round measures the change's reach or the whole
      // suite — so an override that omits it silently would cost the whole
      // saving, which is exactly the shape of the two earlier losses.
      assert.deepEqual(shadowedResult.shadowed, ['select', 'select_why', 'pr_tests_flags']);
      // The shipped entry alone shadows nothing.
      const plain = declarationFor('/x/memoro-cli', { root });
      assert.deepEqual(plain.shadowed, []);
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
  it('this repository has dependencies and needs no preparation', () => {
    // "It has dependencies, so install them" would add an install to every
    // round here for nothing — three dependencies, one native, and a suite that
    // runs from a clean worktree. The claim is declared, with its evidence,
    // rather than inferred.
    assert.equal(SHIPPED['memoro-cli'].prepare, null);
    assert.match(SHIPPED['memoro-cli'].prepare_why, /no node_modules/u);
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
      assert.match(answer.declaration.merge_log, /pm\/decisions\/merge-log\.md$/u);
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
      assert.deepEqual(cli.ask().declaration.pr_tests_flags, ['--import', './tests/_isolate-home.mjs']);
      other.override({ stranger: { prepare: null, extra_gates: [], merge_log: null } });
      assert.deepEqual(other.ask().declaration.pr_tests_flags, []);
    } finally { memoro.cleanup(); cli.cleanup(); other.cleanup(); }
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
        prepare: null,
        prepare_why: SHIPPED['memoro-cli'].prepare_why,
        select: SHIPPED['memoro-cli'].select,
        select_why: SHIPPED['memoro-cli'].select_why,
        extra_gates: [],
        merge_log: join(fx.root, 'work', 'large-scale-llm-project/merge-log.md'),
        pr_tests_flags: ['--import', './tests/_isolate-home.mjs'],
        affected: null,
        serial_paths: null,
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
      assert.match(answer.declaration.merge_log, /large-scale-llm-project\/merge-log\.md$/u);
      assert.deepEqual(answer.shadowed, []);
      assert.equal(answer.sources.pr_tests_flags, 'repository');
      assert.equal(answer.sources.merge_log, 'shipped');
    } finally { fx.cleanup(); }
  });

  it('an override that drops what the repository declared is named, not silent', () => {
    const fx = cli();
    try {
      fx.declare({ select: 'node scripts/affected-tests.js --v2', select_why: 'measured here' });
      fx.override({ 'memoro-cli': { prepare: null, prepare_why: 'local', extra_gates: [], merge_log: null } });
      const answer = fx.ask();
      assert.equal(answer.ok, true);
      // The repository's own fields are a layer an override can shadow just as
      // it shadowed the shipped one twice.
      assert.ok(answer.shadowed.includes('select'), answer.shadowed.join(', '));
      assert.ok(answer.shadowed.includes('select_why'), answer.shadowed.join(', '));
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
