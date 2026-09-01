/**
 * Spec for `canonRoot` — where mc's own packaged `canon/` dir is.
 *
 * `canon/` ships inside the package, so the dir must be resolved from this
 * module's own install root rather than from cwd: a session grounded in an
 * unrelated, empty repo still finds the roles mc shipped. Resolution against
 * a real global install / npx is not verifiable in-process, so this asserts
 * the injectable seam and that the default points at the real shipped dir.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { canonRoot } from '../../src/mc/canon.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
