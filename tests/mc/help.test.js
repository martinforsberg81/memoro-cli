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
    assert.match(r.stdout, /mc open <name> --codex\s+Use Codex only before first launch or for Codex sessions/);
    assert.match(r.stdout, /mc coding-profile read\|diff\|write/);
    assert.match(r.stdout, /mc setup --resource-profile <unlimited\|balanced\|conservative\|custom>/);
    assert.match(r.stdout, /--heavy-max-rss-mb/);
    assert.match(r.stdout, /mc storage prune-generated --dry-run\|--apply/);
    assert.match(r.stdout, /END IS PERMANENT/);
    assert.match(r.stdout, /asks y\/n once/);
    assert.match(r.stdout, /provider transcript \+ ID-bound auxiliary paths/);
    assert.match(r.stdout, /--force supplies automation consent/);
    assert.match(r.stdout, /--keep-branch is the explicit branch-retention exception/);
    assert.match(r.stdout, /Shared provider\s+databases, global history\/config\/memory/);
    assert.match(r.stdout, /It cannot be resumed/);
    assert.doesNotMatch(r.stdout, /deal with the branch/);
    assert.match(r.stdout, /mc dev plan \[service\] \[--profile <name>\]/);
    assert.match(r.stdout, /mc deps status\|hydrate \[service\]/);
    assert.match(r.stdout, /--dependency-mode <auto\|isolated\|off>/);
    assert.match(r.stdout, /Terminal commands manage machines and sessions/);
    assert.match(r.stdout, /Inside a launched LLM session/);
    assert.match(r.stdout, /mc coding-profile read/);
    assert.match(r.stdout, /mc coding-profile diff/);
    assert.match(r.stdout, /mc coding-profile write/);
    assert.match(r.stdout, /same across Codex, Claude Code/);
    assert.match(r.stdout, /compact User Profile and Coding Profile context/);
    assert.match(r.stdout, /does\s+not create or read a repo-local\s+MEMORO\.md/);
    assert.match(r.stdout, /vault is locked/);
    assert.match(r.stdout, /live broker-owned PTY/);
    assert.match(r.stdout, /without sending a new prompt/);
    assert.match(r.stdout, /relaunches the same provider-native\s+session by id/);
    assert.match(r.stdout, /refuses to\s+start a contextless replacement/);
    assert.match(r.stdout, /Idle tracked sessions that have never\s+launched start as fresh grounded sessions on first open/);
    assert.match(r.stdout, /cannot switch provider for an existing provider\s+session/);
    assert.doesNotMatch(r.stdout, /\/mc map/);
    assert.doesNotMatch(r.stdout, /MEMORO\.md is missing/);
    assert.doesNotMatch(r.stdout, /first user\s+message/);
    assert.doesNotMatch(r.stdout, /prompted to start anew/);
    assert.doesNotMatch(r.stdout, /asks before starting a new grounded/);
  });

  it('does not expose internal plan-section shorthand', () => {
    const r = runMc(['--help']);
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.doesNotMatch(r.stdout, /§\d/);
    assert.doesNotMatch(r.stdout, /\bMVP\b/);
  });
});
