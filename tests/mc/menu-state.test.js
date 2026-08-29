/**
 * A pane in a menu is a session waiting on a person (2026-08-23). It has no
 * prompt; "could not find its prompt" was true and named the wrong thing, and
 * a probe would have typed into the menu. Recognised, said with the question,
 * by the wake and the guard alike; the work model carries it as a field, for
 * whoever reads it next.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { menuReason, readMenu } from '../../src/mc/menu-read.js';
import { paneWillTakeText } from '../../src/mc/work-send.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const MENU = [
  'a conversation',
  '⏺ Which card migration order should the plan take?',
  '',
  '❯ 1. Concepts first, then cards',
  '  2. Cards first, then concepts',
  '  3. Cancel',
  '',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
];

describe('readMenu', () => {
  it('reads the options and the question above them', () => {
    assert.deepEqual(readMenu(MENU), {
      question: 'Which card migration order should the plan take?',
      options: ['Concepts first, then cards', 'Cards first, then concepts', 'Cancel'],
    });
    assert.equal(menuReason(readMenu(MENU)), 'waiting on a menu — it needs an answer, not a knock: "Which card migration order should the plan take?"');
  });

  it('a menu at the top of the capture has options and no question', () => {
    const menu = readMenu(['❯ 1. Yes', '  2. No', '  Enter to select · ↑/↓ to navigate · Esc to cancel']);
    assert.equal(menu.question, null);
    assert.deepEqual(menu.options, ['Yes', 'No']);
    assert.equal(menuReason(menu), 'waiting on a menu — it needs an answer, not a knock');
  });

  it('a prompt is not a menu, and neither is a footer with no options', () => {
    assert.equal(readMenu(['a conversation', '+---+', '| ❯ ', '+---+', '  ? for shortcuts']), null);
    assert.equal(readMenu(['  Enter to select · ↑/↓ to navigate']), null);
    assert.equal(readMenu(['1. a numbered line in prose', '2. another']), null, 'no footer, no menu');
  });
});

describe('the wake guard on a menu', () => {
  const pane = (lines) => (args) => (args[0] === 'list-clients' ? { status: 0, stdout: '' }
    : args[0] === 'capture-pane' ? { status: 0, stdout: `${lines.join('\n')}\n\n` } : { status: 0 });

  it('says waiting on a menu, with the question, and types nothing — not "could not find its prompt"', () => {
    const keys = [];
    const run = (args) => { if (args[0] === 'send-keys') keys.push(args); return pane(MENU)(args); };
    const verdict = paneWillTakeText({ target: 'mc-alpha', run, probe: () => { throw new Error('a probe would type into the menu'); } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /^waiting on a menu — it needs an answer, not a knock: "Which card migration/u);
    assert.deepEqual(verdict.menu.options.length, 3);
    assert.deepEqual(keys, []);
  });

  it('a pane with neither box nor menu still says it could not find the prompt', () => {
    const verdict = paneWillTakeText({ target: 'mc-alpha', run: pane(['$ ', 'npm ERR!']) });
    assert.match(verdict.reason, /could not find its prompt/u);
  });
});

describe('mc work send --wake against a menu', () => {
  it('delivers, does not knock, and names the state', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-menu-state-'));
    const workRoot = join(root, 'work');
    mkdirSync(join(workRoot, 'alpha'), { recursive: true });
    mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 });
    const tmux = installTmuxStub(root, { alive: ['alpha'], menu: { question: 'Proceed with the migration?', options: ['Yes', 'No'] } });
    try {
      const sent = runMcCli(['work', 'send', 'alpha', '--wake', 'read me'], {
        MC_HOME: join(root, 'home'), MC_WORK_ROOT: workRoot, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'),
        PATH: `${tmux.bin}:${SAFE_PATH}`,
      }, { cwd: join(workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /delivered, but did not knock: waiting on a menu — it needs an answer, not a knock: "Proceed with the migration\?"/u);
      assert.deepEqual(tmux.keys(), [], 'nothing typed into a menu');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the live capture', () => {
  const lines = readFileSync(new URL('../fixtures/menu-capture-live.txt', import.meta.url), 'utf8').replace(/\s+$/u, '').split('\n');

  it('is read as a menu, with the question and not the sentence under it', () => {
    assert.deepEqual(readMenu(lines), {
      question: 'Teach auto mode about your environment?',
      options: ['Yes', 'Not now', "Don't show again"],
    });
  });

  it('is a menu even though a prompt box is still drawn above it, and nothing is typed', () => {
    const keys = [];
    const run = (args) => {
      if (args[0] === 'send-keys') keys.push(args);
      if (args[0] === 'list-clients') return { status: 0, stdout: '' };
      if (args[0] === 'capture-pane') return { status: 0, stdout: `${lines.join('\n')}\n\n` };
      return { status: 0 };
    };
    const verdict = paneWillTakeText({ target: 'mc-alpha', run, probe: () => { throw new Error('a probe would type into the menu'); } });
    assert.match(verdict.reason, /^waiting on a menu — it needs an answer, not a knock: "Teach auto mode about your environment\?"/u);
    assert.deepEqual(keys, []);
  });

  it('the footer family: Enter plus a way out, in either order; a footer without options is not a menu', () => {
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel']));
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Esc to cancel · Enter to select']));
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Press Enter to accept or cancel with q']));
    assert.equal(readMenu(['❯ 1. Yes', '  2. No', 'Enter a value']), null, 'Enter alone is not a menu');
    assert.equal(readMenu(['Enter to confirm · Esc to cancel']), null, 'no options, no menu');
  });
});
