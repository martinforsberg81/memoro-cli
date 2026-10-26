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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { canonRoot } from '../../src/mc/canon.js';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../src/mc/plan-schema.js';

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

describe('canon/roles/_plan-writing.md names the step models and their tool', () => {
  const role = readFileSync(new URL('../../canon/roles/_plan-writing.md', import.meta.url), 'utf8').replace(/\s+/gu, ' ');
  // The pairing as the role writes it, e.g. "`haiku` and `opus` on claude".
  const onTool = (models, tool) => `${models.map((model) => `\`${model}\``).join(' and ')} on ${tool}`;

  it('pairs the claude models with claude and the codex models with codex', () => {
    assert.ok(role.includes(onTool(CLAUDE_MODELS, 'claude')), 'the role no longer pairs haiku and opus with claude');
    assert.ok(role.includes(onTool(CODEX_MODELS, 'codex')), 'the role no longer pairs the Codex names with codex');
  });

  it('states the flag the Codex name goes to and the effort override codex gets', () => {
    assert.ok(role.includes('`codex exec -m`'), 'the role no longer says the Codex name goes to codex exec -m');
    assert.ok(role.includes('`-c model_reasoning_effort=<level>`'), 'the role no longer says effort reaches codex as model_reasoning_effort');
  });

  it('does not call the Codex names replacements, nor say only haiku and opus are valid', () => {
    assert.doesNotMatch(role, /\breplac\w* (?:for )?`?(?:haiku|opus)/iu);
    assert.doesNotMatch(role, /\bonly `?haiku`? (?:or|and) `?opus/iu);
  });
});
