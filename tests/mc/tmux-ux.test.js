/**
 * The tmux a person actually meets, and the prompt mc leaves behind.
 *
 * Two complaints from real use, both about mc's plumbing showing through.
 *
 * Attaching to a session mc made did not feel like a terminal: the wheel did
 * not scroll and a status bar sat across the bottom announcing a tmux nobody
 * asked for. So a session is born with those set — on the session, never
 * globally, because a user's own tmux is theirs.
 *
 * And a wake that failed left its notice sitting in the recipient's input box,
 * where it went in as the opening words of whatever that person typed next.
 * A failure mc knows about must not corrupt the turn it failed to start.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { startInBackground } from '../../src/mc/work-open.js';
import { wakeConversation } from '../../src/mc/work-send.js';

const OPTIONS = [
  ['set-option', '-t', 'mc-x', 'mouse', 'on'],
  ['set-option', '-t', 'mc-x', 'status', 'off'],
  ['set-option', '-t', 'mc-x', 'history-limit', '50000'],
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-tmux-ux-'));
  return {
    root,
    areaRoot: root,
    worktree: { repo: 'r', path: root, is_git: true },
    env: { MC_HOME: join(root, 'home'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** tmux, faked: no session exists, everything succeeds, every call recorded. */
function tmux({ refuse = null } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'has-session') return { status: 1 };
    if (refuse && args[0] === 'set-option' && args[3] === refuse) return { status: 1, stderr: 'no' };
    return { status: 0 };
  };
  return { calls, run };
}

describe('a session mc creates is born terminal-like', () => {
  it('sets exactly those three, on the session, straight after creating it', () => {
    const fx = fixture();
    try {
      const { calls, run } = tmux();
      const started = startInBackground({
        name: 'x', areaRoot: fx.areaRoot, worktree: fx.worktree, tool: 'claude',
        env: fx.env, run, loadProfile: () => null,
      });
      assert.equal(started.ok, true);

      const created = calls.findIndex((args) => args[0] === 'new-session');
      assert.ok(created !== -1, 'expected a tmux new-session call');
      // Straight after: the session must not be attachable in its default
      // clothes even briefly, and nothing else belongs between the two.
      assert.deepEqual(calls.slice(created + 1, created + 1 + OPTIONS.length), OPTIONS);
      // And exactly those: an option nobody agreed to is as wrong as a missing
      // one, since every one of them overrides something the user may have set.
      assert.deepEqual(calls.filter((args) => args[0] === 'set-option'), OPTIONS);
    } finally { fx.cleanup(); }
  });

  it('never reaches outside its own session — no global option, ever', () => {
    const fx = fixture();
    try {
      const { calls, run } = tmux();
      startInBackground({
        name: 'x', areaRoot: fx.areaRoot, worktree: fx.worktree, tool: 'claude',
        env: fx.env, run, loadProfile: () => null,
      });
      // `-g` is the whole danger: it would rewrite the tmux of every session on
      // the machine, including ones mc did not make and has no business in.
      const global = calls.filter((args) => args.includes('-g') || args.includes('-gu'));
      assert.deepEqual(global, [], 'mc must never set a global tmux option');
      // Every option names the session it belongs to.
      for (const args of calls.filter((item) => item[0] === 'set-option')) {
        assert.deepEqual(args.slice(1, 3), ['-t', 'mc-x']);
      }
    } finally { fx.cleanup(); }
  });

  it('a refused option is a look, not a failure — the conversation still starts', () => {
    const fx = fixture();
    try {
      const { calls, run } = tmux({ refuse: 'mouse' });
      const started = startInBackground({
        name: 'x', areaRoot: fx.areaRoot, worktree: fx.worktree, tool: 'claude',
        env: fx.env, run, loadProfile: () => null,
      });
      // An old tmux without one of these must not cost somebody their worker.
      assert.equal(started.ok, true);
      assert.equal(started.target, 'mc-x');
      // The rest are still attempted: one refusal is not a reason to stop.
      assert.deepEqual(calls.filter((args) => args[0] === 'set-option'), OPTIONS);
    } finally { fx.cleanup(); }
  });
});

/** A pane, drawn: a conversation, an optional busy line, then the input box. */
function pane({ typed = '', busy = false, sent = [] } = {}) {
  const lines = ['a conversation', ...sent.map((line) => `> ${line}`)];
  if (busy) lines.push('  * Thinking… (esc to interrupt)');
  lines.push('+--------------------------+', `| > ${typed}`, '+--------------------------+', '  ? for shortcuts');
  return { status: 0, stdout: `${lines.join('\n')}\n\n\n\n` };
}

/**
 * A tmux that keeps a prompt, so "did it clean up?" is a question about state
 * rather than about which calls went by. `paint` decides what a capture shows.
 */
function conversation({ paint }) {
  const calls = [];
  let typed = '';
  let captures = 0;
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'send-keys' && args[3] === '-l') { typed += args[4]; return { status: 0 }; }
    if (args[0] === 'send-keys' && args[3] === 'C-u') { typed = ''; return { status: 0 }; }
    if (args[0] === 'capture-pane') { captures += 1; return paint({ typed, captures }); }
    return { status: 0 };
  };
  return { calls, run, prompt: () => typed, captures: () => captures };
}

const NOTICE = 'mc: nytt i inbox/ från alpha — läs nu';
const wake = (run) => wakeConversation({ target: 'mc-pm', sender: 'alpha', sleep: () => {}, run });

describe('a wake that failed takes its notice back', () => {
  it('gives up with exactly one C-u, last, and an empty prompt', () => {
    // The pane never submits: the notice stays in the box however often Enter
    // is pressed, which is the failure this whole path exists to report.
    const talk = conversation({ paint: ({ typed }) => pane({ typed }) });
    const result = wake(talk.run);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'it stayed in the prompt');

    const clears = talk.calls.filter((args) => args[0] === 'send-keys' && args[3] === 'C-u');
    assert.equal(clears.length, 1, 'exactly one C-u');
    assert.deepEqual(clears[0], ['send-keys', '-t', 'mc-pm', 'C-u']);
    // Last thing it did, so nothing it types afterwards could land in the box.
    assert.deepEqual(talk.calls.at(-1), ['send-keys', '-t', 'mc-pm', 'C-u']);
    // The point of all of it: the recipient's prompt is empty.
    assert.equal(talk.prompt(), '');
  });

  it('cleans up when the pane never showed the text either', () => {
    const talk = conversation({ paint: () => pane({ typed: '' }) });
    const result = wake(talk.run);
    assert.equal(result.reason, 'the text never reached the prompt');
    assert.equal(talk.calls.filter((args) => args[3] === 'C-u').length, 1);
    assert.equal(talk.prompt(), '');
  });

  it('cleans up when the pane stopped answering mid-wake', () => {
    const talk = conversation({ paint: ({ captures }) => (captures > 1 ? { status: 1 } : pane({ typed: NOTICE })) });
    const result = wake(talk.run);
    assert.equal(result.reason, 'could not read the conversation back');
    assert.equal(talk.calls.filter((args) => args[3] === 'C-u').length, 1);
    assert.equal(talk.prompt(), '');
  });

  it('a wake that worked clears nothing — the turn is the recipient\'s now', () => {
    const talk = conversation({
      paint: ({ typed, captures }) => (captures === 1 ? pane({ typed }) : pane({ sent: [NOTICE] })),
    });
    const result = wake(talk.run);
    assert.deepEqual(result, { ok: true, attempts: 1 });
    assert.deepEqual(talk.calls.filter((args) => args[3] === 'C-u'), []);
  });
});

describe('a busy conversation is waited for, not abandoned', () => {
  it('keeps waiting while the pane says it is working', () => {
    // Streaming for twenty looks — far past the quiet budget of five — then it
    // pauses, paints the notice, and takes it. Without the busy rule this is a
    // wake that fails against a recipient whose only fault was being at work.
    const talk = conversation({
      paint: ({ typed, captures }) => {
        if (captures <= 20) return pane({ busy: true });
        if (captures === 21) return pane({ typed });
        return pane({ sent: [NOTICE] });
      },
    });
    const result = wake(talk.run);
    assert.deepEqual(result, { ok: true, attempts: 1 });
    assert.ok(talk.captures() > 5, `expected more than the quiet budget, got ${talk.captures()}`);
  });

  it('but a quiet pane still gets five looks and no more', () => {
    // The bound matters as much as the wait: a pane that is simply not a prompt
    // must not hold the sender's terminal for the busy budget.
    const talk = conversation({ paint: () => pane({ typed: '' }) });
    const result = wake(talk.run);
    assert.equal(result.reason, 'the text never reached the prompt');
    assert.equal(talk.captures(), 5);
  });

  it('and a pane busy forever is given up on, with the prompt left clean', () => {
    const talk = conversation({ paint: () => pane({ busy: true }) });
    const result = wake(talk.run);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'the text never reached the prompt');
    assert.equal(talk.captures(), 40);
    assert.equal(talk.prompt(), '');
  });
});
