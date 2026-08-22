/**
 * `mc watch sessions` — the surface, and the two things it must never do.
 *
 * It must not start anything by itself: asking after a guard on a machine
 * with none running is a question, not a launch. And it must not type into
 * anybody's pane to answer a question about it — `unreachable` is decided by
 * the same predicate a wake uses before it touches a keyboard, asked without
 * touching one.
 *
 * No daemon is spawned here and no model is called. `start` is exercised only
 * through its argument parsing; the process control it wraps is the same shape
 * `mc repo watch` already has, and spawning a real detached node process to
 * prove a flag was parsed would test this machine's load, not this code.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendNotice, markDelivered, pendingNotices } from '../../src/mc/watch-notices.js';

import { paneWillTakeText } from '../../src/mc/work-send.js';
import { renderWatchLines, run } from '../../src/mc/commands/watch.js';

function capture() {
  const out = [];
  const err = [];
  return {
    out, err, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
  };
}

const said = (lines) => lines.join('');

describe('mc watch sessions', () => {
  it('answers for itself without starting anything', async () => {
    const io = capture();
    assert.equal(await run(['sessions', 'status'], io), 0);
    assert.match(said(io.out), /not running/u);
    assert.match(said(io.out), /mc watch sessions start/u);
  });

  it('is the same page for a session as for a person', async () => {
    const io = capture();
    assert.equal(await run(['sessions', 'status', '--json'], io), 0);
    const state = JSON.parse(said(io.out));
    assert.equal(state.running, false);
    assert.equal(typeof state.interval_ms, 'number');
    assert.deepEqual(state.flags_standing, {});
  });

  it('stands beside the round under one verb, not beside it as a second one', async () => {
    const io = capture();
    assert.equal(await run(['sessions', 'status'], io), 0);
    const other = capture();
    assert.equal(await run(['bogus'], other), 2);
    assert.match(said(other.err), /mc watch bogus\? — pm, sessions/u);
  });

  it('keeps --model to the leg that has one', async () => {
    const io = capture();
    assert.equal(await run(['pm', 'start', '--model', 'haiku'], io), 2);
    assert.match(said(io.err), /mc watch pm has no model — it is a script/u);
  });

  it('refuses a verb it does not have, and says which it does', async () => {
    const io = capture();
    assert.equal(await run(['sessions', 'peek'], io), 2);
    assert.match(said(io.err), /start, stop or status/u);
  });

  it('keeps start\'s flags on start', async () => {
    const interval = capture();
    assert.equal(await run(['sessions', 'status', '--interval', '30'], interval), 2);
    assert.match(said(interval.err), /--interval belongs to mc watch sessions start/u);

    const model = capture();
    assert.equal(await run(['sessions', 'stop', '--model', 'haiku'], model), 2);
    assert.match(said(model.err), /--model belongs to mc watch sessions start/u);

    const bad = capture();
    assert.equal(await run(['sessions', 'start', '--interval', 'soon'], bad), 2);
    assert.match(said(bad.err), /--interval needs a number of seconds/u);
  });

  it('lists what is standing without putting it in an order of importance', () => {
    const lines = renderWatchLines({
      running: true,
      pid: 1234,
      interval_ms: 600_000,
      last_write_at: new Date().toISOString(),
      stale: false,
      sessions_seen: 12,
      flags_standing: { waiting: 3, error: 1, unreachable: 2 },
      notices_pending: 2,
      detail: ['standing  error 1   unreachable 2   waiting 3'],
      log: '/tmp/sessions.log',
    }, { target: 'sessions' });
    const standing = lines.find((line) => line.includes('standing'));
    // Alphabetical, so nobody can read the order as a ranking.
    assert.match(standing, /error 1\s+unreachable 2\s+waiting 3/u);
    assert.match(said(lines), /watching/u);
  });

  it('shows the flags themselves, in the order they were written', () => {
    const lines = renderWatchLines({
      running: true,
      pid: 1,
      interval_ms: 600_000,
      last_write_at: new Date().toISOString(),
      stale: false,
      sessions_seen: 2,
      flags_standing: { waiting: 1, dead: 1 },
      last_round: '2 conversations, 2 live, 1 read, 2 flagged in 4.1s',
      notices_pending: 2,
      log: '/tmp/x.log',
      detail: ['alpha  dead  it was running last round', 'beta  waiting  stopped and waiting for 40m'],
    });
    const text = said(lines);
    assert.ok(text.indexOf('alpha  dead') < text.indexOf('beta  waiting'), 'arrival order, not severity');
  });

  it('says when a pid file outlived its process', () => {
    const lines = renderWatchLines({
      running: false, abandoned: true, interval_ms: 600_000, last_write_at: null,
      sessions_seen: 0, flags_standing: {}, notices_pending: 0, log: '/tmp/x.log',
    }, { target: 'sessions' });
    assert.match(said(lines), /a pid file was left behind/u);
    assert.match(said(lines), /never/u);
  });
});

describe('the ledger, read back', () => {
  it('lists only what has not been delivered, and adds no order of its own', () => {
    const at = mkdtempSync(join(tmpdir(), 'mc-watch-command-'));
    const first = appendNotice({
      source: 'guard', session: 'beta', pattern: 'waiting', detail: 'for 40m',
    }, { root: at });
    appendNotice({
      source: 'guard', session: 'alpha', pattern: 'error', detail: '"EACCES"',
    }, { root: at });
    markDelivered(first.id, { root: at });
    assert.deepEqual(
      pendingNotices({ root: at }).map((n) => `${n.session}  ${n.pattern}  ${n.detail}`),
      ['alpha  error  "EACCES"'],
    );
  });
});

describe('unreachable is decided without typing', () => {
  /** A tmux that records every call, so "did it type?" is answerable. */
  function tmux({ clients = '', box = '' } = {}) {
    const calls = [];
    const run0 = (args) => {
      calls.push(args);
      if (args[0] === 'list-clients') return { status: 0, stdout: clients };
      if (args[0] === 'capture-pane') {
        return {
          status: 0,
          stdout: `a conversation\n+------------+\n| > ${box}\n+------------+\n  ? for shortcuts\n\n\n\n`,
        };
      }
      return { status: 0 };
    };
    return { calls, run: run0, typed: () => calls.filter((args) => args[0] === 'send-keys') };
  }

  it('refuses a pane somebody is attached to, and presses no key', () => {
    const talk = tmux({ clients: '/dev/ttys004\n' });
    const verdict = paneWillTakeText({ target: 'mc-alpha', run: talk.run });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /somebody is attached to it/u);
    assert.deepEqual(talk.typed(), []);
  });

  it('refuses a pane with unsent text in its prompt, and presses no key', () => {
    // The failure measured 2026-08-21: a worker sat with its own half-written
    // line in the box while an order it had never read lay in its inbox. The
    // wake was right to refuse; nobody was told it had.
    const talk = tmux({ box: 'half a question of mine' });
    const verdict = paneWillTakeText({ target: 'mc-alpha', run: talk.run });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /something is drawn in its prompt — a draft, or a ghost/u);
    assert.deepEqual(talk.typed(), []);
  });

  it('allows an empty pane nobody is sitting at, and still presses no key', () => {
    const talk = tmux();
    const verdict = paneWillTakeText({ target: 'mc-alpha', run: talk.run });
    assert.equal(verdict.ok, true);
    assert.deepEqual(talk.typed(), []);
  });
});

describe('paneWillTakeText, reconciled with the probe and the role pane', () => {
  function pane({ clients = '', box = '' } = {}) {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[0] === 'list-clients') return { status: 0, stdout: clients };
      if (args[0] === 'capture-pane') {
        return { status: 0, stdout: `a conversation\n+------------+\n| > ${box}\n+------------+\n  ? for shortcuts\n\n\n\n` };
      }
      return { status: 0 };
    };
    return { run, typed: () => calls.filter((args) => args[0] === 'send-keys') };
  }

  it('a reader gets "drawn" and types nothing; a wake hands in a probe and gets the input\'s answer', () => {
    const drawn = pane({ box: 'merga #10799 och #10802 till main' });
    const read = paneWillTakeText({ target: 'mc-alpha', run: drawn.run });
    assert.equal(read.ok, false);
    assert.equal(read.drawn, true);
    assert.deepEqual(drawn.typed(), [], 'reading never types');

    let asked = 0;
    const ghost = paneWillTakeText({ target: 'mc-alpha', run: pane({ box: 'an old order' }).run, probe: () => { asked += 1; return 'empty'; } });
    assert.equal(asked, 1);
    assert.equal(ghost.ok, true, 'the probe said the input was empty');
    const draft = paneWillTakeText({ target: 'mc-alpha', run: pane({ box: 'a draft' }).run, probe: () => 'text' });
    assert.match(draft.reason, /already something in its prompt/u);
  });

  it('attachedOk skips the client question and nothing else', () => {
    assert.match(paneWillTakeText({ target: 'mc-pm', run: pane({ clients: '/dev/ttys009\n' }).run }).reason, /somebody is attached/u);
    assert.equal(paneWillTakeText({ target: 'mc-pm', run: pane({ clients: '/dev/ttys009\n' }).run, attachedOk: true }).ok, true);
  });
});
