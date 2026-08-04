import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runMc } from './_helpers/cli.js';

describe('mc --help V1', () => {
  it('explains source ownership, stable identity, and workspace freedom', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.match(result.stdout, /source-owned coding sessions/iu);
    assert.match(result.stdout, /Create a local session in this directory/iu);
    assert.match(result.stdout, /Create no branch or worktree implicitly/iu);
    assert.match(result.stdout, /Local sessions are authoritative on this machine/iu);
    assert.match(result.stdout, /Cloud sessions are authoritative in Memoro\s+Cloud/iu);
    assert.match(result.stdout, /not synchronized copies/iu);
    assert.match(result.stdout, /several repositories, worktrees, checkouts, and ordinary\s+directories/iu);
    assert.match(result.stdout, /never the session identity/iu);
    assert.match(result.stdout, /one opaque mc-id and one owner/iu);
  });

  it('documents exact local runtime control and the single certified path', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.match(result.stdout, /mc attach <name>.*exact live local terminal/iu);
    assert.match(result.stdout, /mc sessions send <name> <text>/iu);
    assert.match(result.stdout, /bounded current screen/iu);
    assert.match(result.stdout, /one certified execution path/iu);
    assert.match(result.stdout, /fails\s+closed/iu);
    assert.match(result.stdout, /--replace is required/iu);
    assert.doesNotMatch(result.stdout, /registry\.json|global broker|broker-owned|provider-native/iu);
  });

  it('separates archival, owned-resource cleanup, and session deletion', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.match(result.stdout, /mc end <name>.*Stop and archive; keep every workspace/iu);
    assert.match(result.stdout, /mc cleanup <name> --dry-run\|--apply/iu);
    assert.match(result.stdout, /only exactly proven mc-owned resources/iu);
    assert.match(result.stdout, /mc delete <name> --force.*Delete an archived session home/iu);
    assert.match(result.stdout, /mc gc.*never Git resources/iu);
  });

  it('does not expose internal plan shorthand', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.doesNotMatch(result.stdout, /§\d/u);
    assert.doesNotMatch(result.stdout, /\bMVP\b/u);
  });
});
