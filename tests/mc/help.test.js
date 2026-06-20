import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMc } from './_helpers/cli.js';

describe('mc --help', () => {
  it('is workflow-oriented and explains startup behaviour', () => {
    const r = runMc(['--help']);
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /COMMON/);
    assert.match(r.stdout, /SETUP/);
    assert.match(r.stdout, /SECRETS/);
    assert.match(r.stdout, /FLEET \/ ADVANCED/);
    assert.match(r.stdout, /COMMAND SURFACES/);
    assert.match(r.stdout, /NEW USER FLOW/);
    assert.match(r.stdout, /WHAT HAPPENS ON START/);
    assert.match(r.stdout, /TOOL SELECTION/);
    assert.match(r.stdout, /mc resume <name> --codex\s+Use Codex only if prompted to start anew/);
    assert.match(r.stdout, /Terminal commands manage machines and sessions/);
    assert.match(r.stdout, /Inside a launched LLM session/);
    assert.match(r.stdout, /same across Codex, Claude Code/);
    assert.match(r.stdout, /MEMORO\.md is missing/);
    assert.match(r.stdout, /first user\s+message/);
    assert.match(r.stdout, /vault is locked/);
    assert.match(r.stdout, /live broker-owned PTY/);
    assert.match(r.stdout, /without sending a new prompt/);
    assert.match(r.stdout, /asks before starting a new grounded\s+tool session in the same worktree/);
    assert.match(r.stdout, /tool-flag\s+variants attach to that running session as-is/);
  });

  it('does not expose internal plan-section shorthand', () => {
    const r = runMc(['--help']);
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.doesNotMatch(r.stdout, /§\d/);
    assert.doesNotMatch(r.stdout, /\bMVP\b/);
  });
});
