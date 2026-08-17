/**
 * Waking types into somebody else's input box — so it looks first, and asks.
 *
 * Two things seen in real use, and both of them are here as tests:
 *
 *  1. a notice an earlier wake had abandoned in a prompt, and a new one typed
 *     after it, went in as one pasted-together sentence;
 *  2. the pane a person was attached to took a wake while a half-written
 *     question of theirs sat in the box — where the cleanup keystroke, which
 *     clears the whole line, would have deleted it.
 *
 * Hence the four rules asserted below. A pane with a client attached is never
 * woken. A pane whose box is not visibly empty is never woken, whoever put the
 * text there. `C-u` is pressed only on text mc has just read back and can
 * prove is its own notice. And waking happens because a sender asked for it,
 * not as a free extra on every send — with every refusal printed, because a
 * knock that quietly did not happen is a sender waiting for an answer.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { wakeConversation } from '../../src/mc/work-send.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const NOTICE = 'mc: new in inbox/ from alpha - read it now';

/** A pane, drawn: a conversation, an optional busy line, then the input box. */
function pane({ typed = '', busy = false, sent = [], rows = null } = {}) {
  const lines = ['a conversation', ...sent.map((line) => `> ${line}`)];
  if (busy) lines.push('  * Thinking… (esc to interrupt)');
  lines.push('+--------------------------+');
  // Only the first row of the box carries the prompt mark; what a long line
  // wrapped onto is drawn plain, which is how a real one looks.
  const [head, ...tail] = rows || [typed];
  lines.push(`| > ${head}`, ...tail.map((row) => `| ${row}`));
  lines.push('+--------------------------+', '  ? for shortcuts');
  return { status: 0, stdout: `${lines.join('\n')}\n\n\n\n` };
}

/**
 * A tmux that keeps a prompt, so "what is in the box?" is a question about
 * state rather than about which calls went by. `paint` decides what a capture
 * shows; `clients` is who is sitting at the pane.
 */
function conversation({ paint, clients = '', typedAlready = '' }) {
  const calls = [];
  let typed = typedAlready;
  let captures = 0;
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-clients') return { status: 0, stdout: clients };
    if (args[0] === 'send-keys' && args[3] === '-l') { typed += args[4]; return { status: 0 }; }
    if (args[0] === 'send-keys' && args[3] === 'C-u') { typed = ''; return { status: 0 }; }
    if (args[0] === 'capture-pane') { captures += 1; return paint({ typed, captures }); }
    return { status: 0 };
  };
  return {
    calls,
    run,
    prompt: () => typed,
    captures: () => captures,
    keys: () => calls.filter((args) => args[0] === 'send-keys'),
  };
}

const wake = (run) => wakeConversation({ target: 'mc-pm', sender: 'alpha', sleep: () => {}, run });

describe('a pane somebody is sitting at is not mc\'s to type into', () => {
  it('never wakes a pane with a client attached, and touches nothing', () => {
    // The observed near-miss: a wake arrived at the pane its user was attached
    // to, with a half-written question of theirs in the box. Everything after
    // the first keystroke is too late — so the answer is not to type at all.
    const talk = conversation({ paint: () => pane(), clients: '/dev/ttys004\n' });
    const result = wake(talk.run);

    assert.equal(result.ok, false);
    assert.equal(result.guard, true);
    assert.equal(result.reason, 'somebody is attached to it');
    // Not a keystroke, and not even a look at the pane: the question was
    // answered before mc had any reason to read it.
    assert.deepEqual(talk.keys(), []);
    assert.equal(talk.captures(), 0);
  });

  it('a pane nobody is attached to is woken as before', () => {
    const talk = conversation({
      paint: ({ typed, captures }) => (captures <= 2 ? pane({ typed }) : pane({ sent: [NOTICE] })),
      clients: '',
    });
    assert.deepEqual(wake(talk.run), { ok: true, attempts: 1 });
  });

  it('a tmux that will not answer the question is a refusal, not a guess', () => {
    const talk = conversation({ paint: () => pane() });
    const run = (args) => (args[0] === 'list-clients' ? { status: 1, stderr: 'no server' } : talk.run(args));
    const result = wake(run);
    assert.equal(result.guard, true);
    assert.match(result.reason, /whether anybody is attached/u);
    assert.deepEqual(talk.keys(), []);
  });
});

describe('a prompt that is not empty is not mc\'s to type into', () => {
  it('refuses on somebody\'s draft, and leaves it exactly as it was', () => {
    const draft = 'why is the build red on';
    const talk = conversation({ paint: ({ typed }) => pane({ typed }), typedAlready: draft });
    const result = wake(talk.run);

    assert.equal(result.guard, true);
    assert.equal(result.reason, 'there is already something in its prompt');
    assert.deepEqual(talk.keys(), []);
    assert.equal(talk.prompt(), draft, 'the draft was touched');
  });

  it('refuses on a notice an earlier wake left behind — not pastes onto it', () => {
    // Observation (1), pinned: two notices in one box submitted as a single
    // sentence. It cannot happen if the second one is never typed.
    const talk = conversation({ paint: ({ typed }) => pane({ typed }), typedAlready: NOTICE });
    const result = wake(talk.run);

    assert.equal(result.guard, true);
    assert.equal(result.reason, 'there is already something in its prompt');
    assert.deepEqual(talk.keys(), []);
    assert.equal(talk.prompt(), NOTICE, 'the old notice was disturbed');
  });

  it('a pane with no prompt to read counts as occupied, not as clear', () => {
    // A shell, or a tool that has exited. Not seeing an empty box is not the
    // same as seeing one, and only one of those is a licence to type.
    const shell = { status: 0, stdout: 'npm ERR! code ELIFECYCLE\n$\n' };
    const talk = conversation({ paint: () => shell });
    const result = wake(talk.run);

    assert.equal(result.guard, true);
    assert.match(result.reason, /could not find its prompt/u);
    assert.deepEqual(talk.keys(), []);
  });

  it('looks at the box last of all, immediately before typing', () => {
    // The window between "I looked" and "I typed" is where a person can start
    // a sentence. It cannot be closed, only kept as narrow as this.
    const talk = conversation({
      paint: ({ typed, captures }) => (captures <= 2 ? pane({ typed }) : pane({ sent: [NOTICE] })),
    });
    wake(talk.run);
    assert.deepEqual(talk.calls.slice(0, 3).map((args) => args.slice(0, 2).join(' ')), [
      'list-clients -t',
      'capture-pane -t',
      'send-keys -t',
    ]);
  });
});

describe('C-u is for mc\'s own text and nothing else', () => {
  it('leaves the notice where it is when the box never showed it', () => {
    // The box was empty when mc looked and empty every time after, so what is
    // in there now is not something mc has read. Clearing on that reasoning is
    // how a person's sentence gets deleted; the litter is the cheaper mistake,
    // and the guard above means the next wake refuses on it rather than
    // pasting onto it.
    const talk = conversation({ paint: () => pane({ typed: '' }) });
    const result = wake(talk.run);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'the text never reached the prompt');
    assert.equal(result.left, true, 'it should say the notice is still there');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
    assert.equal(talk.prompt(), NOTICE);
  });

  it('clears when the last thing it read was its own notice, alone', () => {
    // The pane never submits: the notice stays in the box however often Enter
    // is pressed — and it is provably mc's, so mc takes it back out.
    const talk = conversation({ paint: ({ typed }) => pane({ typed }) });
    const result = wake(talk.run);

    assert.equal(result.reason, 'it stayed in the prompt');
    assert.equal(result.left, false);
    assert.equal(talk.keys().filter((args) => args[3] === 'C-u').length, 1);
    assert.equal(talk.prompt(), '');
  });

  it('will not clear a line it can no longer see', () => {
    const talk = conversation({
      paint: ({ typed, captures }) => (captures > 2 ? { status: 1 } : pane({ typed })),
    });
    const result = wake(talk.run);
    assert.equal(result.reason, 'could not read the conversation back');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
    assert.equal(result.left, true);
    assert.equal(talk.prompt(), NOTICE);
  });
});

describe('somebody who starts typing wins the box', () => {
  it('stops before Enter when words appeared next to the notice', () => {
    // The window this exists for: the box was empty, mc typed, and while it
    // waited for the pane to paint, a person began a sentence. Pressing Enter
    // now submits mc's notice and their half-thought as one turn.
    const talk = conversation({
      paint: ({ typed, captures }) => (
        captures === 1 ? pane({ typed }) : pane({ typed: `${typed} and my own question` })
      ),
    });
    const result = wake(talk.run);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'somebody started typing');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'Enter'), [], 'it submitted their sentence');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), [], 'it deleted their sentence');
    assert.equal(result.left, true);
  });

  it('stops after a swallowed Enter too, rather than trying again over them', () => {
    const talk = conversation({
      paint: ({ typed, captures }) => {
        if (captures <= 2) return pane({ typed });
        return pane({ typed: `${typed} wait, one more thing` });
      },
    });
    const result = wake(talk.run);

    assert.equal(result.reason, 'somebody started typing');
    // One Enter — the one pressed on a box that held only the notice. The
    // retry is for a swallowed keystroke, not for a box somebody else is in.
    assert.equal(talk.keys().filter((args) => args[3] === 'Enter').length, 1);
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
  });

  it('a notice the box wrapped is still the notice, not a stranger', () => {
    // A pane narrower than the notice breaks it over two rows. That is a line
    // break mc did not type, and reading it as somebody else's words would
    // make every wake in a narrow pane refuse.
    const wrapped = ['mc: new in inbox/ from', 'alpha - read it now'];
    const talk = conversation({
      paint: ({ typed, captures }) => {
        if (captures === 1) return pane({ typed });
        if (captures === 2) return pane({ rows: wrapped });
        return pane({ sent: [NOTICE] });
      },
    });
    assert.deepEqual(wake(talk.run), { ok: true, attempts: 1 });
  });
});

/** A work root with two pieces of work in it, and a tmux told how to behave. */
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-wake-guards-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'pm'), { recursive: true });
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, options);

  return {
    root,
    workRoot,
    tmux,
    messages: (name) => {
      const path = join(workRoot, name, 'inbox');
      return existsSync(path) ? readdirSync(path) : [];
    },
    send: (args) => runMcCli(['work', 'send', ...args], {
      MC_HOME: mcHome,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: `${tmux.bin}:${SAFE_PATH}`,
    }, { cwd: join(workRoot, 'alpha') }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('waking is asked for, and every refusal is printed', () => {
  it('without --wake the file is delivered and nobody is touched', () => {
    const fx = fixture({ alive: ['pm'] });
    try {
      const sent = fx.send(['pm', 'SLUTRAPPORT — klar']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.equal(fx.messages('pm').length, 1);
      assert.match(sent.stdout, /nobody was woken — pm reads it at its next turn \(--wake knocks\)/u);
      // A live conversation was right there and it was still left alone.
      assert.deepEqual(fx.tmux.keys(), []);
    } finally { fx.cleanup(); }
  });

  it('with --wake it knocks', () => {
    const fx = fixture({ alive: ['pm'] });
    try {
      const sent = fx.send(['pm', '--wake', 'wake up']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke pm/u);
      assert.equal(fx.tmux.submitted().length, 1);
    } finally { fx.cleanup(); }
  });

  it('a guard that fired says which one and why', () => {
    const fx = fixture({ alive: ['pm'], clients: ['/dev/ttys004'] });
    try {
      const sent = fx.send(['pm', '--wake', 'wake up']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.equal(fx.messages('pm').length, 1, 'the message must survive a refusal');
      assert.match(sent.stdout, /delivered, but did not knock: somebody is attached to it/u);
      assert.deepEqual(fx.tmux.keys(), []);
    } finally { fx.cleanup(); }
  });

  it('a notice left in somebody\'s prompt is reported, not hidden', () => {
    const fx = fixture({ alive: ['pm'], drawAfter: 99 });
    try {
      const sent = fx.send(['pm', '--wake', 'wake up']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /could not wake it \(the text never reached the prompt\)/u);
      assert.match(sent.stdout, /the notice is still in pm's prompt/u);
    } finally { fx.cleanup(); }
  });

  it('--json carries the same verdict for anything reading it', () => {
    const fx = fixture({ alive: ['pm'], clients: ['/dev/ttys004'] });
    try {
      const sent = fx.send(['pm', '--wake', '--json', 'wake up']);
      const result = JSON.parse(sent.stdout);
      assert.equal(result.woke, false);
      assert.equal(result.guard, true);
      assert.equal(result.reason, 'somebody is attached to it');
    } finally { fx.cleanup(); }
  });
});

/**
 * A busy pane queues the turn, and a queued turn is a turn.
 *
 * Found in real use and reproduced against a live pane while fixing it: mc
 * reported `could not wake it (somebody started typing)` and `the notice is
 * still in the prompt`, and both were false — nobody was there, the prompt was
 * empty, and the message had arrived.
 *
 * What the capture showed, 140ms after Enter: a pane that is mid-answer does
 * not send a turn typed into it, it queues it, and the input box then shows a
 * placeholder of the TUI's own — `Press up to edit queued messages` — with the
 * notice sitting above the box as the queued turn. Neither empty nor the
 * notice, so the old rule read it as a stranger typing.
 *
 * The rows below are that capture, trimmed to the box.
 */
describe('a wake into a busy pane is not a failed wake', () => {
  /** The real thing: queued turn above, TUI placeholder in the box. */
  const queued = (notice) => ({
    status: 0,
    stdout: [
      '  ⎿  Allowed by auto mode classifier',
      `  ❯ ${notice}`,
      '────────────────────────────────────────',
      '❯ Press up to edit queued messages',
      '────────────────────────────────────────',
      '  ⏵⏵ auto mode on · 1 shell · esc to interrupt · ← for agents · ↓ to manage',
      '',
    ].join('\n'),
  });

  it('a queued turn is reported as woken, not as somebody typing', () => {
    const talk = conversation({
      paint: ({ typed, captures }) => {
        if (captures === 1) return pane({ typed });        // the guard: box empty
        if (captures === 2) return pane({ typed });        // the notice, landed
        return queued(NOTICE);                             // Enter → queued
      },
    });
    const result = wake(talk.run);

    assert.deepEqual(result, { ok: true, attempts: 1 });
    // And it left the queued turn alone: no second Enter, no C-u on a box that
    // holds the TUI's placeholder rather than anything of mc's.
    assert.equal(talk.keys().filter((args) => args[3] === 'Enter').length, 1);
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
  });

  it('the placeholder alone is not enough — the turn has to be visible', () => {
    // Same box, but the notice is nowhere above it. Then the notice left the
    // prompt without becoming anything, which is not a wake and is not claimed
    // as one: reporting a wake that never happened is the one outcome this
    // whole function exists to prevent.
    const vanished = {
      status: 0,
      stdout: [
        '  a conversation',
        '────────────────────────────────────────',
        '❯ Press up to edit queued messages',
        '────────────────────────────────────────',
        '  ⏵⏵ auto mode on',
        '',
      ].join('\n'),
    };
    const talk = conversation({
      paint: ({ typed, captures }) => (captures <= 2 ? pane({ typed }) : vanished),
    });
    const result = wake(talk.run);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'the notice left the prompt without becoming a turn');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
  });

  it('somebody typing after the notice still stops it', () => {
    // The fix must not swallow the case it was built around. The notice is
    // still in the box with words after it, so the line is not mc's to submit
    // and not mc's to clear — placeholder reasoning does not apply.
    const talk = conversation({
      paint: ({ typed, captures }) => (
        captures <= 2 ? pane({ typed }) : pane({ typed: `${typed} and my own question` })
      ),
    });
    const result = wake(talk.run);
    assert.equal(result.reason, 'somebody started typing');
    assert.deepEqual(talk.keys().filter((args) => args[3] === 'C-u'), []);
  });

  it('a swallowed Enter is still retried, and the box still ends empty', () => {
    // The notice is unchanged in the box, which is the old sticky-Enter case
    // and must keep behaving as it did: press again, then clean up.
    const talk = conversation({ paint: ({ typed }) => pane({ typed }) });
    const result = wake(talk.run);
    assert.equal(result.reason, 'it stayed in the prompt');
    assert.equal(talk.keys().filter((args) => args[3] === 'Enter').length, 2);
    assert.equal(talk.prompt(), '');
  });
});
