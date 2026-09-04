/**
 * `mc roles list` / `mc roles show` — a window onto the catalogue.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from '../_helpers/mc-cli.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker. Escalate to the PM.`;

function fixture({ withWorker = true, withShared = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-roles-cli-'));
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir);
  if (withWorker) writeFileSync(join(rolesDir, 'worker.md'), WORKER_MD);
  if (withShared) writeFileSync(join(rolesDir, '_common.md'), 'A turn is the unit of cost.\n');
  return { env: { MC_HOME: join(root, 'home'), MC_ROLES_DIR: rolesDir } };
}

describe('mc roles', () => {
  it('lists what is defined, with model and source', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'list', '--json'], env);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.roles.length, 1);
    assert.equal(payload.roles[0].name, 'worker');
    assert.equal(payload.roles[0].model, 'fable');
  });

  it('shows one role whole — facts, then overlay', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'show', 'worker'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /model:\s+fable/u);
    assert.match(result.stdout, /You are a worker\. Escalate to the PM\./u);
  });

  // `_common.md` is the text every role session is told, not a role. A
  // catalogue that has a copy of it must not list `_common` as one.
  it('does not name the shared text as a role', () => {
    const { env } = fixture({ withShared: true });
    const result = runMcCli(['roles', 'list'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /worker/u);
    assert.doesNotMatch(result.stdout, /_common/u);
  });

  it('an empty catalogue says where it looked', () => {
    const { env } = fixture({ withWorker: false });
    const result = runMcCli(['roles'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no roles defined in/u);
  });

  it('a role that is not there is a miss with a path, not a crash', () => {
    const { env } = fixture();
    const result = runMcCli(['roles', 'show', 'pm'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no role "pm"/u);
  });
});
