/**
 * `mc brief` — the session half: the brief role ships with mc, the bare
 * verb collects and then opens a fresh foreground conversation in the work
 * root with the overlay and the brief as its first words; `--collect`
 * stops after the file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { briefLaunch, run } from '../../../src/mc/commands/brief.js';
import { readCanonRole } from '../../../src/mc/roles.js';

const COLLECTED = {
  path: '/work/brief/2026-08-25T20-00-00Z.md',
  text: '# Brief — 2026-08-25T20:00:00Z\n\n## Waiting on Martin\n\n| a | b |\n',
  data: { merged: [1, 2], opened: [3], proposals: [], notes: ['memoro: no checkout'] },
};

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
}

describe('the brief role', () => {
  /**
   * A decision is put to Martin as one proposal he says GO to. The overlay
   * that told the session to lay out "the options in one line each" is the
   * reason a brief could open with six unrelated menus; it says the opposite
   * now, and forbids a question the session has not read the code behind.
   */
  it('forbids the menu, and demands the code was read', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /says\s+GO\s+to/u);
    assert.match(overlay, /Never\s+lay\s+out\s+options\s+for\s+him\s+to\s+choose\s+between/u);
    assert.match(overlay, /Present\s+a\s+decision\s+as\s+a\s+menu\s+of\s+options/u);
    assert.match(overlay, /the\s+code\s+it\s+stands\s+on/u);
    assert.doesNotMatch(overlay, /the\s+options\s+in\s+one\s+line\s+each/u);
  });

  /**
   * The two lists the tidying leaves — `mc run` writes both intake files and
   * reads neither, so the brief is where they are raised. The overlay has to
   * name them, and has to say the one thing that is not obvious from a row:
   * the session removes nothing itself.
   */
  it('walks what the tidying left, and removes nothing itself', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /\*Archived without a note\*/u);
    assert.match(overlay, /\*Workareas with no project on main\*/u);
    assert.match(overlay, /`branch: landed`/u);
    assert.match(overlay, /You remove nothing\./u);
  });

  it('opens with the brief as the first words', () => {
    const launch = briefLaunch({ ...COLLECTED, role: readCanonRole('brief') });
    assert.match(launch.prompt, /^This is the brief, from \/work\/brief\/2026-08-25T20-00-00Z\.md\. Start the meeting\.\n\n# Brief/u);
    assert.equal(launch.model, 'opus');
  });
});

describe('mc brief', () => {
  it('--collect writes and reports, and opens nothing', async () => {
    const { out, stdout, stderr } = io();
    let opened = 0;
    const code = await run(['--collect', '--offline'], { stdout, stderr, collect: async ({ offline }) => { assert.equal(offline, true); return COLLECTED; }, open: async () => { opened += 1; return { ok: true }; } });
    assert.equal(code, 0);
    assert.equal(opened, 0);
    assert.match(out.stdout, /2026-08-25T20-00-00Z\.md \(\d+\.\ds\) — 2 merged, 1 open/u);
    assert.match(out.stderr, /memoro: no checkout/u);
  });

  it('bare: collects, then a fresh conversation in the work root, foreground, with overlay and prompt', async () => {
    const { stdout, stderr } = io();
    let seen = null;
    const code = await run(['--model', 'fable'], {
      stdout, stderr, collect: async () => COLLECTED, open: async (o) => { seen = o; return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    assert.equal(seen.areaRoot, process.env.MC_WORK_ROOT);
    assert.equal(seen.worktree.path, process.env.MC_WORK_ROOT);
    assert.equal(seen.pick, 'new');
    assert.equal(seen.tool, 'claude');
    assert.equal(seen.model, 'fable');
    assert.equal(seen.defaultModel, 'opus');
    assert.match(seen.overlay, /^You are the brief session/u);
    assert.match(seen.prompt, /Start the meeting/u);
  });

  it('refuses a stray word', async () => {
    const { out, stdout, stderr } = io();
    assert.equal(await run(['now'], { stdout, stderr }), 2);
    assert.match(out.stderr, /unknown argument now/u);
  });
});
