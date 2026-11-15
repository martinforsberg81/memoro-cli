/**
 * `mc manager` — only the manual headless task is left: the interactive manager is
 * gone, so every other form is refused with exit 2 and one `mc:` line, and `mc brief`
 * is refused whatever it is given. The manual headless run is unchanged (V1).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MANAGER_GONE, run } from '../../../src/mc/commands/manager.js';
import { run as brief } from '../../../src/mc/commands/brief.js';
import { runModule, VERB_MODULES } from '../../../src/mc-verbs.js';
import { commandUsage } from '../../../src/mc/command-help.js';

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
}

describe('the interactive manager is gone', () => {
  it('refuses every form of mc manager without --headless: exit 2, one mc: line naming mc martin and the headless form, nothing opened', async () => {
    for (const argv of [[], ['--new'], ['--model', 'fable'], ['--resume', 'x'], ['--codex'], ['--collect'], ['--offline'], ['now'], ['--prompt', 'task'], ['--minutes', '2']]) {
      const { out, stdout, stderr } = io();
      assert.equal(await run(argv, { stdout, stderr, open: () => assert.fail('interactive launch'), turn: () => assert.fail('model started') }), 2, argv.join(' '));
      assert.equal(out.stdout, '');
      assert.equal(out.stderr, `${MANAGER_GONE}\n`);
      assert.equal(out.stderr.trim().split('\n').length, 1);
      assert.match(out.stderr, /^mc: the interactive manager is gone/u);
      assert.match(out.stderr, /mc martin/u);
      assert.match(out.stderr, /mc manager --headless --prompt/u);
    }
  });

  it('refuses mc brief whatever it is given, with the same line', async () => {
    for (const argv of [[], ['--new'], ['--headless', '--prompt', 'task'], ['--json']]) {
      const { out, stdout, stderr } = io();
      assert.equal(await brief(argv, { stdout, stderr, open: () => assert.fail('interactive launch'), turn: () => assert.fail('model started') }), 2, argv.join(' '));
      assert.equal(out.stderr, `${MANAGER_GONE}\n`);
      assert.equal(out.stdout, '');
    }
  });

  it('is refused in runModule before the module runs, and help still prints the usage', async () => {
    for (const verb of ['manager', 'brief']) {
      const { out, stderr } = io();
      let ran = 0;
      assert.equal(await runModule(VERB_MODULES[verb], [], { stderr, load: async () => ({ run: () => { ran += 1; return 0; }, usage: () => 'usage' }) }), 2);
      assert.equal(ran, 0);
      assert.equal(out.stderr, `${MANAGER_GONE}\n`);
      const help = io();
      assert.equal(await runModule(VERB_MODULES[verb], ['--help'], { stdout: help.stdout, stderr: help.stderr }), 0);
      assert.match(help.out.stdout, new RegExp(`mc ${verb}`, 'u'));
      assert.equal(help.out.stdout.includes(commandUsage(verb).split('\n')[0]), true);
    }
  });
});

describe('manual headless manager', () => {
  it('dispatches an explicit task without opening an interactive conversation', async () => {
    for (const command of [run]) {
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
