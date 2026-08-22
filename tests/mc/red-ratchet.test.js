/**
 * The standing red set: what it binds, and the two ways of getting it wrong.
 *
 * The first is the one this repository has already lived through — a gate that
 * reports "green" over fifty-five red names, because the rule it enforces is
 * differential and the word it printed was not. That half is a wording test and
 * lives beside the verdict.
 *
 * The second is the one a ratchet invites. The measurement that motivated this
 * file: two rounds hours apart on this repository gave 55 and 56 red names, and
 * the extra one was green again on the next run — a wall-clock assertion on a
 * machine with three other builders on it. A ratchet on the *number* fails the
 * next pull request when that happens, having been given no reason to. So the
 * tests below assert the property that makes a name-set ratchet survivable and
 * a count ratchet not: the same set breathing does not move the floor, and a
 * name that is genuinely new does.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { compareRatchet, readRatchet, ratchetPath, renderRatchet } from '../../src/mc/red-ratchet.js';
import { compareRed, redNames } from '../../src/mc/tap-red.js';

function checkout(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ratchet-'));
  if (contents !== undefined) {
    const path = ratchetPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === 'string' ? contents : renderRatchet(contents));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the question the ratchet was commissioned to answer', () => {
  /**
   * The brief's premise, checked against the real comparison rather than
   * argued: a brand new test that is born red is red on the candidate and
   * absent from the baseline — does it fall out of `broke`?
   *
   * It does not, and it cannot, because `broke` is a set difference taken on
   * the candidate side. Absent from the baseline is the strongest possible way
   * of not being in it. So that is not the hole the ratchet fills.
   */
  it('a test that is born red is caught by the differential check, not missed by it', () => {
    const tap = (rows) => [
      'TAP version 13',
      ...rows.flatMap(([name, ok]) => [`# Subtest: ${name}`, `${ok ? 'ok' : 'not ok'} 1 - ${name}`]),
      '# tests 4', '# pass 2', '# fail 2',
    ].join('\n');

    const baseline = redNames(tap([['standing red', false], ['a green one', true]]));
    const candidate = redNames(tap([['standing red', false], ['a green one', true], ['born red', false]]));
    const { broke } = compareRed(baseline, candidate);

    assert.deepEqual(broke, ['born red'], 'a name absent from the baseline cannot be filtered out of broke');
  });

  /**
   * And the general form, because one example is not a property. Within a
   * single round the count cannot rise while `broke` stays empty: if the
   * candidate has more names than the baseline then at least one is not in it.
   *
   * This is what makes the ratchet's real job the one it has. The hole is not
   * inside a round — it is between rounds, where every round measures main
   * afresh and inherits whatever it finds as the new floor.
   */
  it('inside one round a rise is always visible to the differential check', () => {
    const universe = ['a', 'b', 'c', 'd', 'e'];
    const subsets = [];
    for (let mask = 0; mask < (1 << universe.length); mask += 1) {
      subsets.push(universe.filter((_, index) => mask & (1 << index)));
    }
    let missed = 0;
    for (const baseline of subsets) {
      for (const candidate of subsets) {
        const { broke } = compareRed(baseline, candidate);
        if (!broke.length && candidate.length > baseline.length) missed += 1;
      }
    }
    assert.equal(missed, 0, 'no pair where the count rose and broke was empty');
  });
});

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
