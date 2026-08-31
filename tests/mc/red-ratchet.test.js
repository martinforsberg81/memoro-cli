/**
 * The standing red set: what it binds, and the way a ratchet invites getting
 * it wrong.
 *
 * No round reads this any more — the 2026-08-31 ruling took main's own red out
 * of the verdict, and `red-ratchet.js` says so in its header. What is asserted
 * here is the file's reading and writing, which survives the ruling, and the
 * property that made it a name set rather than a count.
 *
 * The measurement that motivated it: two rounds hours apart on this repository
 * gave 55 and 56 red names, and the extra one was green again on the next run
 * — a wall-clock assertion on a machine with three other builders on it. A
 * ratchet on the *number* fails the next pull request when that happens,
 * having been given no reason to. So the tests below assert the property that
 * makes a name-set ratchet survivable and a count ratchet not: the same set
 * breathing does not move the floor, and a name that is genuinely new does.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { compareRatchet, parseRatchet, ratchetAtRef, readRatchet, ratchetPath, renderRatchet } from '../../src/mc/red-ratchet.js';

function checkout(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ratchet-'));
  if (contents !== undefined) {
    const path = ratchetPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === 'string' ? contents : renderRatchet(contents));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the recorded floor', () => {
  it('a name nobody wrote down is a rise', () => {
    const moved = compareRatchet(['one', 'two'], ['one', 'two', 'three']);
    assert.deepEqual(moved.risen, ['three']);
    assert.deepEqual(moved.fallen, []);
  });

  it('a name that came good is a fall, and decides nothing on its own', () => {
    const moved = compareRatchet(['one', 'two'], ['one']);
    assert.deepEqual(moved.risen, []);
    assert.deepEqual(moved.fallen, ['two']);
  });

  /**
   * The measurement from the brief, as a test. `standing` is the set as it was
   * recorded; `busy` is the same repository with the load-sensitive test red on
   * top of it, and `quiet` is the next run with it green again.
   *
   * A count ratchet sees 2 → 3 → 2 and fails the middle round. The set sees a
   * name it already knows and a name it already knows going quiet, and moves
   * the floor neither time.
   */
  it('the baseline breathing on a known name does not move the floor', () => {
    const standing = ['already red › one', 'already red', 'flaky under load'];
    const busy = ['already red › one', 'already red', 'flaky under load'];
    const quiet = ['already red › one', 'already red'];

    assert.deepEqual(compareRatchet(standing, busy).risen, [], 'the flake reappearing is not a rise');
    assert.deepEqual(compareRatchet(standing, quiet).risen, [], 'the flake going quiet is not a rise either');
    // And the quiet round offers the name up rather than taking it: nothing
    // here writes the file, because evicting a name on a lucky round is what
    // lays the trap for the next author.
    assert.deepEqual(compareRatchet(standing, quiet).fallen, ['flaky under load']);
  });

  it('a count would have failed the round the names let through', () => {
    const standing = ['already red › one', 'already red'];
    const busy = [...standing, 'flaky under load'];
    // The count ratchet the brief warned about, spelled out so the difference
    // is a test rather than a claim in a comment.
    assert.equal(busy.length > standing.length, true, 'the count rose');
    assert.deepEqual(compareRatchet([...busy], busy).risen, [], 'the set, holding that name, did not');
  });
});

describe('reading the file', () => {
  it('a repository with no ratchet is not an error and has no floor', () => {
    const fx = checkout();
    try {
      const read = readRatchet(fx.dir);
      assert.equal(read.present, false);
      assert.equal(read.ok, true);
      assert.deepEqual(read.names, []);
    } finally { fx.cleanup(); }
  });

  it('a file that will not parse is a stop, never an empty set', () => {
    const fx = checkout('{ not json');
    try {
      const read = readRatchet(fx.dir);
      assert.equal(read.present, true);
      assert.equal(read.ok, false);
      // The failure mode being refused: an empty floor makes every standing
      // red name look like a rise, so a typo would fail everything.
      assert.deepEqual(read.names, []);
      assert.match(read.reason, /readable JSON/u);
    } finally { fx.cleanup(); }
  });

  it('a file with no names array is a stop', () => {
    const fx = checkout(JSON.stringify({ schema: 'mc-red-ratchet', standing_red: 55 }));
    try {
      const read = readRatchet(fx.dir);
      assert.equal(read.ok, false);
      assert.match(read.reason, /"names" array/u);
    } finally { fx.cleanup(); }
  });

  it('a name written twice cannot inflate the floor', () => {
    const fx = checkout(JSON.stringify({ names: ['one', 'one', 'two'] }));
    try {
      assert.deepEqual(readRatchet(fx.dir).names, ['one', 'two']);
    } finally { fx.cleanup(); }
  });

  it('what is written is sorted, so a diff shows the name that changed', () => {
    const rendered = JSON.parse(renderRatchet(['b', 'a', 'a', 'c']));
    assert.deepEqual(rendered.names, ['a', 'b', 'c']);
    assert.equal(rendered.standing_red, 3, 'the count beside the names is the count of them');
  });
});

describe("this repository's own recorded floor", () => {
  it('is present, parses, and matches the count written beside it', () => {
    const repo = join(dirname(new URL(import.meta.url).pathname), '..', '..');
    const read = readRatchet(repo);
    assert.equal(read.present, true, 'memoro-cli records its own standing red set');
    assert.equal(read.ok, true, read.reason || '');
    assert.ok(read.names.length > 0);
  });
});

/**
 * The floor as it stands on the base branch, read without a worktree.
 *
 * It is what says whether a change *lowered* the floor, and it has to be
 * available on every round: a carried baseline (A1) never builds the baseline
 * worktree, so a check that read the file off disk would quietly stop
 * happening on exactly the rounds that are cheapest to run.
 */
describe('the floor on a ref', () => {
  const gitSaying = (out) => () => out;

  it('parses the file git shows at the ref', () => {
    const floor = ratchetAtRef({
      git: gitSaying({ status: 0, stdout: renderRatchet(['one', 'two']) }),
      ref: 'origin/main',
      cwd: '/repo',
    });
    assert.equal(floor.ok, true);
    assert.equal(floor.present, true);
    assert.deepEqual(floor.names, ['one', 'two']);
  });

  it('a base branch with no floor is absent, not malformed', () => {
    for (const out of [{ status: 1, stdout: '' }, { status: 0, stdout: '' }, { status: 0, stdout: '  \n' }]) {
      const floor = ratchetAtRef({ git: gitSaying(out), ref: 'origin/main', cwd: '/repo' });
      assert.equal(floor.present, false, JSON.stringify(out));
      assert.equal(floor.ok, true, 'absent is not an error');
      assert.deepEqual(floor.names, []);
    }
  });

  it('a floor that will not parse says so rather than reading as empty', () => {
    const floor = ratchetAtRef({ git: gitSaying({ status: 0, stdout: '{ not json' }), ref: 'origin/main', cwd: '/repo' });
    assert.equal(floor.present, true);
    assert.equal(floor.ok, false);
    assert.match(floor.reason, /not readable JSON/u);
  });

  it('a git that throws is absent, never an exception into the round', () => {
    const floor = ratchetAtRef({
      git: () => { throw new Error('git is not on PATH'); }, ref: 'origin/main', cwd: '/repo',
    });
    assert.equal(floor.present, false);
    assert.equal(floor.ok, true);
  });

  it('one parser, so a floor read from a checkout and one read from a ref agree', () => {
    const text = renderRatchet(['a', 'b', 'a']);
    assert.deepEqual(parseRatchet(text, 'x').names, ['a', 'b']);
    assert.deepEqual(ratchetAtRef({ git: gitSaying({ status: 0, stdout: text }), ref: 'r', cwd: '/' }).names, ['a', 'b']);
  });
});
