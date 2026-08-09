/**
 * The reserved role names, refused at every door.
 *
 * `pm`, `pm-helper`, and `helper` are identities: everything that trusts a
 * session name — attach, status, send — would be talking to an impostor if
 * an ordinary session could wear one. Each refusal points at the role's own
 * command. This is the single sanctioned behaviour change to `mc new` and
 * `mc rename`; everything else about them is untouched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runNew } from '../../../src/cli/new.js';
import { run as runRename } from '../../../src/cli/rename.js';
import { runMcCli } from '../_helpers/mc-cli.js';

function sink() {
  const chunks = [];
  return { write: (text) => { chunks.push(text); return true; }, text: () => chunks.join('') };
}

function workEnv() {
  const root = mkdtempSync(join(tmpdir(), 'mc-reserved-'));
  return {
    MC_HOME: join(root, 'home'),
    MC_WORK_ROOT: join(root, 'work'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
  };
}

describe('reserved names at every door', () => {
  it('mc new refuses each, pointing at the role command', async () => {
    for (const name of ['pm', 'pm-helper', 'helper']) {
      const stderr = sink();
      const code = await runNew([name], { stderr, stdout: sink() });
      assert.equal(code, 1, name);
      assert.match(stderr.text(), /reserved for a role/u);
    }
  });

  it('mc rename refuses a role name as the destination', async () => {
    const stderr = sink();
    const code = await runRename(['something', 'pm'], { stderr, stdout: sink() });
    assert.equal(code, 1);
    assert.match(stderr.text(), /reserved for a role/u);
    assert.match(stderr.text(), /mc pm\)/u);
  });

  it('mc work refuses to open one', () => {
    const result = runMcCli(['work', 'pm'], workEnv());
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /reserved for a role/u);
  });

  it('mc work add refuses to conjure one up', () => {
    const result = runMcCli(['work', 'add', 'helper', 'memoro-cli'], workEnv());
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /reserved for a role/u);
    assert.match(result.stderr, /mc pm-helper/u);
  });

  it('mc worker refuses them too — a worker is not a singleton role', () => {
    const result = runMcCli(['worker', 'pm'], workEnv());
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /reserved for a role/u);
  });
});
