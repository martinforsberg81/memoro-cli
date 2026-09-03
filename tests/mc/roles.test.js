/**
 * Roles: the file format, the catalogue, the mark on an area, and what a
 * conversation is told.
 *
 * The parallel-operation guarantees live here as much as anywhere: an
 * ordinary area has no mark and gets no overlay, codex conversations get
 * exactly today's delivery even inside a role's area, and the reserved names
 * are a fixed, small set.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  RESERVED_ROLE_NAMES,
  areaRole,
  areaRoleName,
  instructionsFor,
  listRoles,
  markAreaRole,
  parseRole,
  readRole,
  reservedRoleHint,
  reservedRoleName,
} from '../../src/mc/roles.js';
import { discardWorkArea, releaseWorkArea } from '../../src/mc/work-area.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker. Escalate to the PM.`;

function catalogue(files = { 'worker.md': WORKER_MD }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-roles-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, env: { MC_ROLES_DIR: dir } };
}

describe('role files', () => {
  it('frontmatter for mc, overlay text for the conversation', () => {
    const role = parseRole(WORKER_MD);
    assert.equal(role.name, 'worker');
    assert.equal(role.model, 'fable');
    assert.equal(role.singleton, false);
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.equal(role.overlay, 'You are a worker. Escalate to the PM.');
  });

  it('the filename names a role that does not name itself', () => {
    const role = parseRole('---\nmodel: opus\nsingleton: true\n---\nBody.', 'pm-helper');
    assert.equal(role.name, 'pm-helper');
    assert.equal(role.singleton, true);
    assert.deepEqual(role.tools, []);
  });

  it('no frontmatter is no role, not a role with defaults', () => {
    assert.equal(parseRole('just some markdown'), null);
    assert.equal(parseRole(''), null);
    assert.equal(parseRole(null), null);
  });

  it('a CRLF checkout is still a role', () => {
    const role = parseRole(WORKER_MD.replace(/\n/gu, '\r\n'));
    assert.equal(role.name, 'worker');
    assert.equal(role.model, 'fable');
    assert.equal(role.overlay, 'You are a worker. Escalate to the PM.');
  });

  it('the catalogue lists what is defined and reads one whole', () => {
    const { dir, env } = catalogue();
    const roles = listRoles(env);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].name, 'worker');
    assert.equal(roles[0].path, join(dir, 'worker.md'));
    const worker = readRole('worker', env);
    assert.equal(worker.overlay, 'You are a worker. Escalate to the PM.');
    assert.equal(readRole('pm', env), null);
  });

  it('a catalogue that does not exist is empty, not an error', () => {
    assert.deepEqual(listRoles({ MC_ROLES_DIR: '/nowhere/at/all' }), []);
  });
});

describe('the mark on an area', () => {
  it('is written once and read back, and a missing definition says so', () => {
    const { env } = catalogue();
    const area = mkdtempSync(join(tmpdir(), 'mc-area-'));
    assert.equal(areaRoleName(area), null);
    assert.equal(areaRole(area, env), null);
    markAreaRole(area, 'worker');
    assert.equal(areaRoleName(area), 'worker');
    assert.equal(areaRole(area, env).overlay, 'You are a worker. Escalate to the PM.');
    markAreaRole(area, 'vanished');
    const missing = areaRole(area, env);
    assert.equal(missing.missing, true);
    assert.equal(missing.name, 'vanished');
  });

  it('survives a release that keeps the area', () => {
    // Releasing an area with a stray user file keeps the area — and must
    // keep its role: an area silently demoted runs every future
    // conversation without the overlay and cannot even warn about it.
    const workRoot = mkdtempSync(join(tmpdir(), 'mc-workroot-'));
    const env = {
      ...process.env,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(workRoot, 'claude'),
      CODEX_HOME: join(workRoot, 'codex'),
    };
    const area = join(workRoot, 'w');
    mkdirSync(area);
    markAreaRole(area, 'worker');
    writeFileSync(join(area, 'notes.txt'), 'still mine');
    const survived = releaseWorkArea('w', { env, dryRun: false });
    assert.equal(survived.removed.length, 0);
    assert.equal(areaRoleName(area), 'worker');
    // And an area holding nothing but its own mark is releasable: the mark
    // must not keep an otherwise-empty area alive.
    const area2 = join(workRoot, 'w2');
    mkdirSync(area2);
    markAreaRole(area2, 'worker');
    releaseWorkArea('w2', { env, dryRun: false });
    assert.equal(areaRoleName(area2), null);
  });

  it('goes out with the area when the area is discarded', () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'mc-workroot-'));
    const env = { ...process.env, MC_WORK_ROOT: workRoot };
    const area = join(workRoot, 'w');
    mkdirSync(area);
    markAreaRole(area, 'worker');
    const result = discardWorkArea('w', { env, dryRun: false });
    assert.equal(result.removes_area, true);
    assert.equal(areaRoleName(area), null);
  });
});

describe('what a conversation is told', () => {
  it('claude gets the overlay behind the profile', () => {
    assert.equal(instructionsFor('claude-code', 'PROFILE', 'OVERLAY'), 'PROFILE\n\n---\n\nOVERLAY');
    assert.equal(instructionsFor('claude-code', null, 'OVERLAY'), 'OVERLAY');
  });

  it('codex gets the same body, on its own instruction channel', () => {
    assert.equal(instructionsFor('codex', 'PROFILE', 'OVERLAY'), 'PROFILE\n\n---\n\nOVERLAY');
    assert.equal(instructionsFor('codex', null, 'OVERLAY'), 'OVERLAY');
  });

  it('is one body of text, whichever tool is asked', () => {
    assert.equal(
      instructionsFor('codex', 'PROFILE', 'OVERLAY'),
      instructionsFor('claude-code', 'PROFILE', 'OVERLAY'),
    );
  });

  it('nothing to say is nothing, for both', () => {
    assert.equal(instructionsFor('claude-code', null, null), null);
    assert.equal(instructionsFor('codex', null, null), null);
  });
});

describe('reserved names', () => {
  // One name, and it points at its own door. `pm` and `pm-helper` were
  // reserved beside it for a pair of roles that no longer exist; they are
  // ordinary names again, and `mc work pm` makes an ordinary workarea.
  it('is the fixed set, each pointing at its own door', () => {
    assert.deepEqual([...RESERVED_ROLE_NAMES], ['helper']);
    for (const name of RESERVED_ROLE_NAMES) assert.equal(reservedRoleName(name), true);
    assert.equal(reservedRoleName('worker-1'), false);
    assert.equal(reservedRoleName('pm'), false);
    assert.equal(reservedRoleName('pm-helper'), false);
    // The bare verb owns `~/mc/helper/`, so that is the command to name.
    assert.match(reservedRoleHint('helper'), /mc helper\)/u);
  });

  it('guards case-insensitively — the filesystems mostly are', () => {
    for (const name of ['Helper', 'HELPER']) {
      assert.equal(reservedRoleName(name), true, name);
    }
    assert.match(reservedRoleHint('HELPER'), /mc helper\)/u);
  });
});
