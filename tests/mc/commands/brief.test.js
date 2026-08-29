/**
 * `mc brief` — the session half: the brief role ships with mc, the bare
 * verb collects and then opens a fresh foreground conversation in the work
 * root with the overlay and the brief as its first words; `--collect`
 * stops after the file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANSWER_LINE, parseDecision } from '../../../src/mc/brief-collect.js';
import { briefLaunch, run } from '../../../src/mc/commands/brief.js';
import { readCanonRole } from '../../../src/mc/roles.js';

const COLLECTED = {
  path: '/work/brief/2026-08-25T20-00-00Z.md',
  text: '# Brief — 2026-08-25T20:00:00Z\n\n## Waiting on Martin\n\n| a | b |\n',
  data: { decisions: [{ answered: false }, { answered: true }], merged: [1, 2], opened: [3], notes: ['memoro: no checkout'] },
};

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
}

describe('the brief role', () => {
  it('ships with mc and fixes the answer line', () => {
    const role = readCanonRole('brief');
    assert.equal(role.model, 'opus');
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.match(role.overlay, /`\*\*Beslut:\*\* <option> \(Martin, <YYYY-MM-DD>\)\. <one sentence why>`/u);
    assert.match(role.overlay, /one at a time/u);
    assert.match(role.overlay, /never edit PLAN\.md/u);
  });

  /**
   * Step 3 of the plan: the answer lands. The line the overlay dictates is
   * the only thing that moves a `waiting-decision` project, and the same
   * test for it is written three times — `ANSWER_LINE` here, `grep -l
   * '^\*\*Beslut'` in `~/mc/bin/runner.sh`, `isAnswered()` in `mc run`.
   * So take the template out of the overlay itself, fill it the way a
   * session would, and hold it against all three shapes; then close the
   * loop, that the next brief stops asking the question.
   */
  it('dictates an answer line that the runner already greps for, and that closes the question', () => {
    const template = /`(\*\*Beslut:\*\* <option>[^`]*)`/u.exec(readCanonRole('brief').overlay)?.[1];
    assert.equal(template, '**Beslut:** <option> (Martin, <YYYY-MM-DD>). <one sentence why>');
    const line = template
      .replace('<option>', 'A — vilande')
      .replace('<YYYY-MM-DD>', '2026-08-26')
      .replace('<one sentence why>', 'It costs one Sonnet turn a day and asks for no new daemon.');

    assert.match(line, ANSWER_LINE);                 // the brief's own answered test
    assert.ok(/^\*\*Beslut/mu.test(line));           // mc run's isAnswered()
    assert.ok(new RegExp('^\\*\\*Beslut', 'm').test(line)); // runner.sh's grep -l '^\*\*Beslut'

    const open = '# 2. Hur bevakar vi memoro.me?\n\n## Alternativ\n\n**A.** En helper.\n\n## Rekommendation\n\n**A**, med C som senare steg.\n';
    assert.equal(parseDecision(open).answered, false);
    assert.equal(parseDecision(`${open}\n${line}\n`).answered, true);
    assert.equal(parseDecision(`${open}\n${line}\n`).recommendation, '**A**, med C som senare steg.');
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
    assert.match(out.stdout, /2026-08-25T20-00-00Z\.md \(\d+\.\ds\) — 2 merged, 1 open, 1 waiting on you/u);
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
