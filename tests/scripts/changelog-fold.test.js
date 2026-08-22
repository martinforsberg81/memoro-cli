/**
 * One file per change, so two pull requests never touch the same file; the
 * entries meet in CHANGELOG.md only when folded, in one commit.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { foldChangelog, foldInto, listFragments, readFragment } from '../../scripts/changelog-fold.js';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- an entry that was already here

### Fixed
- a fix that was already here

## [0.7.6] — 2026-06-06

### Added
- released
`;

function repo({ fragments = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-changelog-fold-'));
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  mkdirSync(join(root, 'changelog.d'));
  let tick = 1000;
  for (const [name, text] of Object.entries(fragments)) {
    const path = join(root, 'changelog.d', name);
    writeFileSync(path, text);
    tick += 1000;
    utimesSync(path, tick / 1000, tick / 1000);
  }
  return { root, changelog: () => readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('a fragment', () => {
  it('is a section line and a body that starts as an entry', () => {
    const fx = repo({ fragments: { 'suite-lease.md': 'section: added\n\n- **The suite right is a lease.** One at a time.\n  continued.\n' } });
    try {
      const [fragment] = listFragments(fx.root);
      assert.equal(fragment.section, 'Added');
      assert.equal(fragment.body, '- **The suite right is a lease.** One at a time.\n  continued.');
    } finally { fx.cleanup(); }
  });

  it('without a section, with an unknown one, or without an entry is malformed by name — never dropped', () => {
    const fx = repo({ fragments: {
      'a.md': '- no section line\n',
      'b.md': 'section: Broken\n\n- x\n',
      'c.md': 'section: Fixed\n\nprose, not an entry\n',
    } });
    try {
      const errors = listFragments(fx.root).map((item) => `${item.name}: ${item.error}`).sort();
      assert.match(errors[0], /^a\.md: no "section:/u);
      assert.match(errors[1], /^b\.md: unknown section "Broken"/u);
      assert.match(errors[2], /^c\.md: the body must start/u);
      const result = foldChangelog({ root: fx.root });
      assert.equal(result.folded.length, 0, 'a malformed fragment stops the fold');
      assert.equal(fx.changelog(), CHANGELOG, 'and nothing was written');
      assert.ok(existsSync(join(fx.root, 'changelog.d', 'a.md')));
    } finally { fx.cleanup(); }
  });
});

describe('folding', () => {
  it('puts each entry under its section, newest first, creating a section in canonical order', () => {
    const fx = repo({ fragments: {
      'older.md': 'section: Added\n\n- older added\n',
      'newer.md': 'section: Added\n\n- newer added\n  with a second line\n',
      'gone.md': 'section: Removed\n\n- something removed\n',
    } });
    try {
      const result = foldChangelog({ root: fx.root });
      assert.deepEqual(result.folded.sort(), ['gone.md', 'newer.md', 'older.md']);
      const text = fx.changelog();
      const added = text.indexOf('### Added');
      assert.ok(text.indexOf('- newer added\n  with a second line\n- older added\n- an entry that was already here') > added, text);
      // Removed sits between Added and Fixed, as Keep a Changelog orders them.
      assert.ok(text.indexOf('### Removed\n- something removed') > text.indexOf('### Added'));
      assert.ok(text.indexOf('### Removed') < text.indexOf('### Fixed'));
      assert.ok(text.includes('## [0.7.6] — 2026-06-06\n\n### Added\n- released'), 'released sections untouched');
      assert.deepEqual(listFragments(fx.root), [], 'folded fragments are gone');
    } finally { fx.cleanup(); }
  });

  it('--check lists what would fold and writes nothing', () => {
    const fx = repo({ fragments: { 'x.md': 'section: Fixed\n\n- a fix\n' } });
    try {
      const result = foldChangelog({ root: fx.root, check: true });
      assert.deepEqual(result.ready, ['x.md']);
      assert.equal(fx.changelog(), CHANGELOG);
    } finally { fx.cleanup(); }
  });

  it('nothing to fold is nothing written', () => {
    const fx = repo();
    try {
      assert.deepEqual(foldChangelog({ root: fx.root }), { folded: [], ready: [], malformed: [] });
      assert.equal(fx.changelog(), CHANGELOG);
    } finally { fx.cleanup(); }
  });

  it('a changelog with no Unreleased heading is refused, not guessed at', () => {
    assert.throws(() => foldInto('# Changelog\n\n## [1.0.0]\n', [{ section: 'Added', body: '- x' }]), /no "## \[Unreleased\]"/u);
  });

  it('reads the one fragment this repository ships with', () => {
    const fragment = readFragment(new URL('../../changelog.d/changelog-d.md', import.meta.url).pathname);
    assert.equal(fragment.error, undefined, fragment.error);
    assert.equal(fragment.section, 'Added');
  });
});
