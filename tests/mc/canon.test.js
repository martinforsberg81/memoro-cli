/**
 * TDD spec for package-shipped canon (Grounding Phase 5 — Universal).
 *
 * The orchestrator role + the coordination canon ship INSIDE the mc package
 * (a checked-in `canon/` dir included in `package.json` `files`), so any repo
 * — even one that carries none of the `.claude` / `docs` files — grounds with
 * the full role. This spec covers the pure + injectable seams:
 *
 *   - CANON_MANIFEST       — logical name → packaged filename (single source).
 *   - canonRoot({ here })  — resolve the package canon dir from mc's OWN
 *     install root (not cwd); injectable + soft-degrade.
 *   - readPackageCanon(..) — read the packaged canon files; per-file
 *     soft-degrade, never throws.
 *
 * Runtime-root resolution against a REAL global install / npx is not
 * verifiable in-process; this asserts the injectable seam + the default
 * pointing at the real shipped files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CANON_MANIFEST,
  canonRoot,
  readPackageCanon,
} from '../../src/mc/canon.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('CANON_MANIFEST', () => {
  it('maps the three universal-canon assets to packaged filenames', () => {
    assert.equal(CANON_MANIFEST.protocol, 'coding-agent-protocol.md');
    assert.equal(CANON_MANIFEST.coordination, 'agent-coordination.md');
    assert.equal(CANON_MANIFEST.beCoordinator, 'be-coordinator.md');
  });
});

describe('canonRoot', () => {
  it('resolves a canon/ dir from an injected install root (Pattern 2)', () => {
    // `here` is the dir of src/mc/canon.js; canon/ sits at the package root,
    // two levels up. We assert the resolver climbs to <root>/canon.
    const root = canonRoot({ here: '/opt/lib/node_modules/memoro-cli/src/mc' });
    assert.equal(root, '/opt/lib/node_modules/memoro-cli/canon');
  });

  it('defaults to the real shipped canon dir (module-relative, not cwd)', () => {
    // No injection → resolves from import.meta.url of the real module. Must
    // point at <repo>/canon regardless of the test runner's cwd.
    const root = canonRoot();
    assert.equal(root, join(repoRoot, 'canon'));
  });
});

describe('readPackageCanon', () => {
  it('reads all three packaged canon files from the real package', () => {
    const canon = readPackageCanon();
    assert.match(canon.protocol, /Coding-agent protocol/);
    assert.match(canon.coordination, /Coordinator . Agent coordination/);
    assert.match(canon.beCoordinator, /Be coordinator/i);
  });

  it('soft-degrades a single unreadable file to null (never throws)', () => {
    const canon = readPackageCanon({
      root: '/canon',
      readFileImpl: (p) => {
        if (p.endsWith('coding-agent-protocol.md')) throw new Error('boom');
        return 'ok';
      },
      exists: () => true,
    });
    assert.equal(canon.protocol, null);
    assert.equal(canon.coordination, 'ok');
    assert.equal(canon.beCoordinator, 'ok');
  });

  it('soft-degrades a missing canon dir to all-null (broken install)', () => {
    const canon = readPackageCanon({ root: '/no/such/dir', exists: () => false });
    assert.equal(canon.protocol, null);
    assert.equal(canon.coordination, null);
    assert.equal(canon.beCoordinator, null);
  });

  it('never throws even when the reader itself throws for every file', () => {
    assert.doesNotThrow(() =>
      readPackageCanon({
        root: '/x',
        exists: () => true,
        readFileImpl: () => { throw new Error('total failure'); },
      }),
    );
  });
});
