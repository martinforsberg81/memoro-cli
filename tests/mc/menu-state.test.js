/**
 * A pane in a menu is a session waiting on a person (2026-08-23). It has no
 * prompt; "could not find its prompt" was true and named the wrong thing.
 *
 * It was recognised for two readers: the work model, which carries it as a
 * field for whoever reads it next, and the wake, which refused to type into a
 * menu. The wake went with the inbox channel it knocked for; `readMenu` stays,
 * because `work-status.js` still asks it what a pane is doing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { menuReason, readMenu } from '../../src/mc/menu-read.js';

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

describe('the live capture', () => {
  const lines = readFileSync(new URL('../fixtures/menu-capture-live.txt', import.meta.url), 'utf8').replace(/\s+$/u, '').split('\n');

  it('is read as a menu, with the question and not the sentence under it', () => {
    assert.deepEqual(readMenu(lines), {
      question: 'Teach auto mode about your environment?',
      options: ['Yes', 'Not now', "Don't show again"],
    });
  });

  it('the footer family: Enter plus a way out, in either order; a footer without options is not a menu', () => {
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel']));
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Esc to cancel · Enter to select']));
    assert.ok(readMenu(['❯ 1. Yes', '  2. No', 'Press Enter to accept or cancel with q']));
    assert.equal(readMenu(['❯ 1. Yes', '  2. No', 'Enter a value']), null, 'Enter alone is not a menu');
    assert.equal(readMenu(['Enter to confirm · Esc to cancel']), null, 'no options, no menu');
  });
});
