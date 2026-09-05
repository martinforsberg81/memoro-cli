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

  /**
   * A pull request the runner would not land, whose one repair session has
   * run, is the brief's — and the overlay has to say what an answer to one
   * looks like, because the three of them are all the session may do.
   */
  it('takes the held pull requests, one proposal each', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /\*Held before merge\*/u);
    assert.match(overlay, /`mc merge <repo> <pr>`/u);
    assert.match(overlay, /`gh pr close`/u);
    assert.match(overlay, /`blocked_by`/u);
    assert.match(overlay, /One proposal per pull request, never a menu/u);
  });

  /**
   * The other half of the same waiting: a plan that says `ready` and a machine
   * that will not start it. A held pull request there takes the three answers
   * above; a workarea somebody killed takes a person opening it — and the one
   * thing the session must be told is that the person is not it.
   */
  it('proposes what is waiting on hands, and touches no workarea itself', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /\*Ready, and the runner cannot start it\*/u);
    assert.match(overlay, /you touch none of them/u);
    assert.match(overlay, /`git\n?restore`/u);
  });

  /**
   * The third section of that family, and the largest: 45 blocked steps on
   * `origin/main` when this was written. Three kinds, three answers, and a
   * session that had only ever read the role has to take the same three — a
   * project blocker it leaves alone, a `plan-review` it hands to the
   * programme's planning session, a named decision it works itself.
   */
  it('takes the blocked steps, and knows which of the three it settles', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /\*Blocked\*/u);
    assert.match(overlay, /project\s+blocker\*{2}\s+is\s+sequencing/u);
    assert.match(overlay, /`mc\s+plan\s+<programme>`/u);
    assert.match(overlay, /named\s+decision\*{2}\s+is\s+the\s+list\s+you\s+actually\s+work/u);
    assert.match(overlay, /write\n?into\s+that\s+step's\s+`comments`/u);
  });

  /**
   * The route, which is the part no other section needs: the brief has no
   * workarea, so where its own edit goes and how it lands has to be in the
   * role or it will not be taken. One pull request per repository per brief,
   * landed by the session with `--docs`, and the two names that keep the
   * runner from mistaking it for a project's own work.
   */
  it('says how its own unblocking reaches main', () => {
    const { overlay } = readCanonRole('brief');
    assert.match(overlay, /~\/mc\/brief\/unblock\/<repo>/u);
    assert.match(overlay, /`brief\/unblock-<date>`/u);
    assert.match(overlay, /`mc\s+merge\s+<repo>\s+<pr>\s+--docs`/u);
    assert.match(overlay, /one\s+per\s+repository\s+per\s+brief/u);
    assert.match(overlay, /Land\s+it\s+before\s+the\s+brief\n?ends/u);
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
