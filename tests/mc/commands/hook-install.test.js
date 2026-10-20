/**
 * `mc hook install [--check]` — mc's two entries in a settings file, through the
 * command, against a temp home. Nothing here touches the machine's own file.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../../src/mc/commands/hook.js';
import { hookRegistration } from '../../../src/mc/hooks.js';

const FOREIGN = { matcher: 'Bash|Read', hooks: [{ type: 'command', command: '/x/block-secret-reads.sh' }] };
const OLD = {
  permissions: { allow: ['Bash'] },
  hooks: {
    PreToolUse: [FOREIGN, { matcher: 'Bash|Write', hooks: [{ type: 'command', command: 'mc hook pre-tool 2>/dev/null || true' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'mc hook session-start 2>/dev/null || true' }] }],
  },
};

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

/** A temp home with `.claude/`, and its settings file holding `text` when one is given. */
function setup(text) {
  const home = mkdtempSync(join(tmpdir(), 'mc-hook-install-'));
  mkdirSync(join(home, '.claude'));
  const path = join(home, '.claude', 'settings.json');
  if (text !== undefined) writeFileSync(path, text);
  return { home, path };
}

describe('mc hook install — the command', () => {
  it('installs into a file with old lines and keeps the rest', async () => {
    const { home, path } = setup(JSON.stringify(OLD, null, 2));
    const check = sink();
    assert.equal(await run(['install', '--check'], { home, stdout: check, stderr: sink() }), 1);
    assert.match(check.text, /pre-tool on Bash\|Write, want Bash\|Write\|Read\|Edit\|MultiEdit — mc hook install writes them/u);

    const out = sink();
    assert.equal(await run(['install'], { home, stdout: out, stderr: sink() }), 0);
    assert.match(out.text, /hooks registered in .*settings\.json \(pre-tool on Bash\|Write, want Bash\|Write\|Read\|Edit\|MultiEdit before\)/u);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(written.permissions, OLD.permissions);
    assert.deepEqual(written.hooks.PreToolUse[0], FOREIGN);
    assert.equal(hookRegistration(written).ok, true);

    const text = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const again = sink();
    assert.equal(await run(['install'], { home, stdout: again, stderr: sink() }), 0);
    assert.match(again.text, /already registered/u);
    assert.equal(readFileSync(path, 'utf8'), text, 'a second run writes nothing');
    assert.equal(statSync(path).mtimeMs, mtime, 'a second run does not touch the file');
    assert.equal(await run(['install', '--check'], { home, stdout: sink(), stderr: sink() }), 0);
  });

  it('a missing file is created', async () => {
    const { home, path } = setup();
    assert.equal(await run(['install'], { home, stdout: sink(), stderr: sink() }), 0);
    assert.equal(existsSync(path), true);
    assert.equal(hookRegistration(JSON.parse(readFileSync(path, 'utf8'))).ok, true);
  });

  it('a file that is not JSON is refused and left alone', async () => {
    const text = '{"apiKey": "sk-secret", oops';
    const { home, path } = setup(text);
    const stdout = sink();
    const stderr = sink();
    assert.equal(await run(['install'], { home, stdout, stderr }), 1);
    assert.match(stderr.text, /could not be read as JSON — nothing written/u);
    assert.doesNotMatch(stderr.text, /sk-secret/u, 'the refusal never quotes the file');
    assert.doesNotMatch(stdout.text, /sk-secret/u);
    assert.equal(readFileSync(path, 'utf8'), text);
  });

  it('anything but --check is refused', async () => {
    const { home } = setup();
    const stderr = sink();
    assert.equal(await run(['install', '--force'], { home, stdout: sink(), stderr }), 2);
    assert.match(stderr.text, /mc hook install takes only --check/u);
  });
});
