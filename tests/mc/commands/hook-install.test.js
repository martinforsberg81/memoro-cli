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
    Stop: [{ hooks: [{ type: 'command', command: 'mc hook stop 2>/dev/null || true' }] }],
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
    assert.match(check.text, /pre-tool on Bash\|Write, want Bash\|Write\|Read\|Edit\|MultiEdit\|mcp__claude-in-chrome__\.\* — mc hook install writes them/u);

    const out = sink();
    assert.equal(await run(['install'], { home, stdout: out, stderr: sink() }), 0);
    assert.match(out.text, /hooks registered in .*settings\.json \(pre-tool on Bash\|Write, want Bash\|Write\|Read\|Edit\|MultiEdit\|mcp__claude-in-chrome__\.\* before\)/u);
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

describe('mc hook install — a tool with its own hooks file (agy)', () => {
  const FOREIGN_ENTRY = { SessionStart: [{ type: 'command', command: '/x/their-hook.sh' }] };
  const hooksPath = (home) => join(home, '.gemini', 'config', 'hooks.json');
  const only = (tools) => (tool) => tools.includes(tool);
  const withAgy = { installed: () => true };

  it('writes mc\'s one entry, keeps a foreign entry and every other key, and syncs the skills there', async () => {
    const { home } = setup();
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(hooksPath(home), JSON.stringify({ theirs: FOREIGN_ENTRY, setting: 7 }));
    const out = sink();
    assert.equal(await run(['install'], { home, stdout: out, stderr: sink(), ...withAgy }), 0);
    assert.match(out.text, /hooks registered in .*\.gemini\/config\/hooks\.json/u);
    const written = JSON.parse(readFileSync(hooksPath(home), 'utf8'));
    assert.deepEqual(written.theirs, FOREIGN_ENTRY, 'a foreign entry is left exactly as it was');
    assert.equal(written.setting, 7);
    const commands = JSON.stringify(written.mc);
    for (const word of ['session-start', 'pre-tool', 'stop']) assert.ok(commands.includes(`mc hook ${word} --tool agy 2>/dev/null || true`), word);
    assert.equal(written.mc.PreToolUse[0].matcher, 'run_command|read_file|view_file|edit_file|write_to_file');
    assert.equal(existsSync(join(home, '.gemini', 'antigravity-cli', 'skills', 'mc', 'SKILL.md')), true);
    assert.equal(existsSync(join(home, '.claude', 'settings.json')), true, 'the Claude file is still written');
  });

  it('--check is 1 until the entry is there, then 0, and a second install writes nothing', async () => {
    const { home } = setup();
    const before = sink();
    assert.equal(await run(['install', '--check'], { home, stdout: sink(), stderr: before, ...withAgy }), 1);
    assert.equal(existsSync(hooksPath(home)), false, '--check writes nothing');
    assert.equal(await run(['install'], { home, stdout: sink(), stderr: sink(), ...withAgy }), 0);
    assert.equal(await run(['install', '--check'], { home, stdout: sink(), stderr: sink(), ...withAgy }), 0);
    const text = readFileSync(hooksPath(home), 'utf8');
    const again = sink();
    assert.equal(await run(['install'], { home, stdout: again, stderr: sink(), ...withAgy }), 0);
    assert.match(again.text, /hooks\.json/u);
    assert.equal(readFileSync(hooksPath(home), 'utf8'), text);
  });

  it('a tool that is not installed has no file made for it', async () => {
    const { home } = setup();
    assert.equal(await run(['install'], { home, stdout: sink(), stderr: sink(), installed: () => false }), 0);
    assert.equal(existsSync(hooksPath(home)), false);
  });

  it('a hooks file that is not JSON is refused and left alone', async () => {
    const { home } = setup();
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const text = '{"token": "sk-agy-secret", nope';
    writeFileSync(hooksPath(home), text);
    const stderr = sink();
    assert.equal(await run(['install'], { home, stdout: sink(), stderr, ...withAgy }), 1);
    assert.doesNotMatch(stderr.text, /sk-agy-secret/u);
    assert.equal(readFileSync(hooksPath(home), 'utf8'), text);
  });
});
