/**
 * `mc manager` — the session: the manager role ships with mc, the verb opens the
 * foreground conversation in the ~/mc/manager desk with the overlay and no opening
 * words — Martin types the first message; nothing is gathered for it.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { managerLaunch, run } from '../../../src/mc/commands/manager.js';
import { readCanonRole } from '../../../src/mc/roles.js';

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
}

describe('the manager launch', () => {
  it('opens with the role and no words of its own', () => {
    const launch = managerLaunch({ role: readCanonRole('manager') });
    assert.equal(launch.prompt, null);
    assert.equal(launch.model, 'opus');
  });
});

describe('mc manager', () => {
  it('opens the conversation in the ~/mc/manager desk, foreground, with the overlay and no gathered document', async () => {
    const { stdout, stderr } = io();
    let seen = null;
    const code = await run(['--model', 'fable'], {
      stdout, stderr, open: async (o) => { seen = o; return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    // Its own room, not the work root every other session is launched below.
    assert.equal(seen.areaRoot, join(process.env.MC_WORK_ROOT, 'manager'));
    assert.equal(seen.worktree.path, join(process.env.MC_WORK_ROOT, 'manager'));
    assert.deepEqual(seen.conversationRoots, [join(process.env.MC_WORK_ROOT, 'manager'), join(process.env.MC_WORK_ROOT, 'brief')]);
    assert.equal(seen.verb, 'manager');
    assert.equal(seen.roleName, 'manager');
    // The manager session there is resumed; `--new` is the only fresh start.
    assert.equal(seen.pick, null);
    assert.equal(seen.tool, 'claude');
    assert.equal(seen.model, 'fable');
    assert.equal(seen.defaultModel, 'opus');
    assert.match(seen.overlay, /^You are the manager session/u);
    assert.equal(seen.prompt, null);
  });

  it('resumes with no prompt of its own — it is where it was', async () => {
    const { stdout, stderr } = io();
    let seen = null;
    await run([], { stdout, stderr, open: async (o) => { seen = o; return { ok: true, code: 0 }; } });
    assert.equal(seen.resumePrompt, undefined);
  });

  it('prints nothing of its own before the session opens', async () => {
    const { out, stdout, stderr } = io();
    await run([], { stdout, stderr, open: async () => ({ ok: true, code: 0 }) });
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, '');
  });

  it('--new starts a fresh conversation', async () => {
    const { stdout, stderr } = io();
    let seen = null;
    await run(['--new'], { stdout, stderr, open: async (o) => { seen = o; return { ok: true, code: 0 }; } });
    assert.equal(seen.pick, 'new');
  });

  it('--collect and --offline are unknown flags', async () => {
    for (const flag of ['--collect', '--offline']) {
      const { out, stdout, stderr } = io();
      let opened = 0;
      assert.equal(await run([flag], { stdout, stderr, open: async () => { opened += 1; return { ok: true }; } }), 2);
      assert.equal(opened, 0);
      assert.match(out.stderr, new RegExp(`unknown flag ${flag}|${flag}`, 'u'));
    }
  });

  it('refuses a stray word', async () => {
    const { out, stdout, stderr } = io();
    assert.equal(await run(['now'], { stdout, stderr }), 2);
    assert.match(out.stderr, /unknown argument now/u);
  });
});

describe('manual headless manager', () => {
  it('dispatches an explicit task without opening an interactive conversation, including through brief', async () => {
    const { run: brief } = await import('../../../src/mc/commands/brief.js');
    for (const command of [run, brief]) {
      const { out, stdout, stderr } = io();
      let seen;
      assert.equal(await command(['--headless', '--new', '--prompt', 'Resolve the blocked merge', '--codex', '--model', 'gpt-6.1-sol', '--minutes', '12'], {
        stdout, stderr, open: () => assert.fail('interactive launch'),
        turn: async options => { seen = options; return { ok: true, answer: 'Merge resolved', note: 'success', log: '/receipt.json' }; },
      }), 0);
      assert.deepEqual(seen, { prompt: 'Resolve the blocked merge', tool: 'codex', model: 'gpt-6.1-sol', minutes: 12 });
      assert.match(out.stdout, /Merge resolved/u);
      assert.match(out.stdout, /receipt.json/u);
    }
  });

  it('rejects missing work and invalid limits before starting a model, and preserves failure status', async () => {
    for (const argv of [['--headless'], ['--headless', '--prompt', ' '], ['--prompt', 'task'], ['--minutes', '2'], ...['0', '-2', 'NaN', 'Infinity', '1441'].map(n => ['--headless', '--prompt', 'task', '--minutes', n])]) {
      const { stdout, stderr } = io();
      assert.equal(await run(argv, { stdout, stderr, turn: () => assert.fail('invalid launch'), open: () => assert.fail('invalid launch') }), 2);
    }
    const { stdout, stderr } = io();
    assert.equal(await run(['--headless', '--prompt', 'task'], { stdout, stderr, turn: async o => {
      assert.equal(o.minutes, 30);
      return { ok: false, status: 142, note: 'timeout' };
    } }), 142);
  });
});
