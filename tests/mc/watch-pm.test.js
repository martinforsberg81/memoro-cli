/**
 * The round (designnote §3) — what it promises PM.
 *
 * The guarantees under test are the four the order calls conditions rather
 * than advice: it never costs a model turn; it wakes on change and then goes
 * quiet; it decides nothing about the content; and its auto-commit commits
 * without ever editing. Plus the one the daemon shape demands — a thirty
 * minute round proved in milliseconds, by injecting the clock and the
 * interval and running passes back to back rather than waiting for one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendNotice, pendingNotices, readLedger } from '../../src/mc/watch-notices.js';
import { pmWatchLoop } from '../../src/mc/watch-pm-loop.js';
import {
  REMINDER_PASS, decide, knockText, minute, pmRound, readInbox, readState,
} from '../../src/mc/watch-pm-round.js';
import { parseArgs } from '../../src/mc/commands/watch.js';

/**
 * A PM home that is what `role-home.js` guarantees: a git repository with an
 * inbox in it. Nothing here is mocked — the commit under test is a real one.
 */
function fixture() {
  const box = mkdtempSync(join(tmpdir(), 'mc-test-watch-pm-'));
  const root = join(box, 'mc-home');
  const workRoot = join(box, 'work');
  const area = join(workRoot, 'pm');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(area, 'inbox'), { recursive: true });
  writeFileSync(join(area, 'state.md'), '# PM — state\n');
  writeFileSync(join(area, 'inbox', 'README.md'), '# inbox\n');
  git(area, ['init', '-q']);
  git(area, ['-c', 'user.name=t', '-c', 'user.email=t@invalid', 'add', '-A']);
  git(area, ['-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '-q', '-m', 'first']);

  const sent = [];
  const outbox = { ok: true, file: '/inbox/message.md', woke: true, reason: null, guard: false };
  return {
    box,
    root,
    area,
    env: { MC_HOME: root, MC_WORK_ROOT: workRoot },
    sent,
    /** The channel, recorded rather than spoken. `outbox` is what it answers. */
    send: async (message) => { sent.push(message); return { ...outbox }; },
    reply(value) { Object.assign(outbox, value); },
    /** `mc doctor`, silenced: what it says is a separate test. */
    doctor: () => ({ ok: true, issues: [] }),
    item(name, body = 'a message nobody has read') {
      const path = join(area, 'inbox', name);
      writeFileSync(path, body);
      return path;
    },
    aged(name, at) {
      const path = join(area, 'inbox', name);
      const seconds = Date.parse(at) / 1000;
      utimesSync(path, seconds, seconds);
      return path;
    },
    cleanup() { rmSync(box, { recursive: true, force: true }); },
  };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** One pass, with the fixture's clock, channel and diagnosis. */
function pass(fx, { now = new Date(), doctor = fx.doctor } = {}) {
  return pmRound({ root: fx.root, env: fx.env, now, send: fx.send, doctor });
}

describe('the round', () => {
  it('costs nothing when nothing has happened', async () => {
    const fx = fixture();
    try {
      const outcome = await pass(fx);
      assert.equal(fx.sent.length, 0, 'an empty inbox and a quiet ledger say nothing');
      assert.equal(outcome.knock, null);
      assert.deepEqual(outcome.failed, []);
      assert.equal(outcome.inbox.count, 0);
    } finally { fx.cleanup(); }
  });

  it('commits what PM wrote, and edits nothing', async () => {
    const fx = fixture();
    try {
      writeFileSync(join(fx.area, 'state.md'), '# PM — state\n\nPM wrote this.\n');
      const before = readFileSync(join(fx.area, 'state.md'), 'utf8');

      const outcome = await pass(fx);

      assert.equal(outcome.commit.committed, true);
      assert.equal(outcome.commit.files, 1);
      assert.equal(readFileSync(join(fx.area, 'state.md'), 'utf8'), before, 'byte for byte');
      assert.equal(git(fx.area, ['status', '--porcelain']).trim(), '', 'nothing left uncommitted');
      // A fixed identity: the commit is mc's act, and a machine with no
      // user.email must not cost PM its versioning.
      assert.match(git(fx.area, ['log', '-1', '--format=%an <%ae>']), /^mc <mc@memoro\.local>/u);
      assert.match(git(fx.area, ['log', '-1', '--format=%s']), /^mc watch pm: round /u);
    } finally { fx.cleanup(); }
  });

  it('commits nothing when PM wrote nothing', async () => {
    const fx = fixture();
    try {
      const outcome = await pass(fx);
      assert.equal(outcome.commit.committed, false);
      assert.equal(outcome.commit.reason, 'nothing-changed');
      assert.equal(git(fx.area, ['rev-list', '--count', 'HEAD']).trim(), '1');
    } finally { fx.cleanup(); }
  });

  it('counts files at the top level, and neither README.md nor a directory', async () => {
    const fx = fixture();
    try {
      fx.item('one.md');
      fx.item('two.md');
      mkdirSync(join(fx.area, 'inbox', 'archive'));
      writeFileSync(join(fx.area, 'inbox', 'archive', 'old.md'), 'processed');

      const { items } = readInbox(fx.area);
      assert.deepEqual(items.map((i) => i.name), ['one.md', 'two.md']);
    } finally { fx.cleanup(); }
  });

  it('knocks on a new member, then goes quiet, then reminds once, then is silent for good', async () => {
    const fx = fixture();
    try {
      fx.item('2026-08-17T15-53-02.000Z-martin.md');
      fx.aged('2026-08-17T15-53-02.000Z-martin.md', '2026-08-17T15:53:02Z');

      // Six passes back to back. At the default interval that is three hours;
      // here it is a few milliseconds, because the rule is counted in passes
      // and the clock is an argument.
      const knocks = [];
      for (let index = 0; index < 6; index += 1) {
        const outcome = await pass(fx, { now: new Date(Date.parse('2026-08-21T10:00:00Z') + index * 1800_000) });
        knocks.push(Boolean(outcome.knock));
      }

      assert.deepEqual(knocks, [true, false, true, false, false, false], 'arrival, silence, one reminder, silence');
      assert.equal(fx.sent.length, 2);
      assert.match(fx.sent[0].message, /^1 unprocessed item in pm\/inbox\/, oldest 2026-08-17T15:53Z/u);
      assert.match(fx.sent[0].message, /new\s+2026-08-17T15-53-02\.000Z-martin\.md/u);
      assert.match(fx.sent[1].message, /reminder\s+2026-08-17T15-53-02\.000Z-martin\.md/u);
    } finally { fx.cleanup(); }
  });

  it('the reminder lands on the third pass whatever the interval is', () => {
    let state = {};
    const items = [{ name: 'a.md', at: '2026-08-17T15:53:02.000Z' }];
    const seen = [];
    for (let index = 0; index < REMINDER_PASS + 1; index += 1) {
      const outcome = decide(items, state);
      state = outcome.items;
      seen.push(outcome.fresh.length ? 'new' : outcome.reminders.length ? 'reminder' : 'quiet');
    }
    assert.deepEqual(seen, ['new', 'quiet', 'reminder', 'quiet']);
  });

  it('an item that comes back after PM archived it is a new arrival, not a lingering one', async () => {
    const fx = fixture();
    try {
      fx.item('a.md');
      await pass(fx);
      rmSync(join(fx.area, 'inbox', 'a.md'));
      await pass(fx);
      fx.item('a.md');
      const outcome = await pass(fx);

      assert.ok(outcome.knock, 'the second arrival knocks');
      assert.equal(outcome.knock.fresh, 1);
    } finally { fx.cleanup(); }
  });

  it('never knocks about its own knock', async () => {
    const fx = fixture();
    try {
      // The channel is PM's inbox, so the message lands there as a file like
      // any other. Left alone that file is a new member on the next pass, and
      // the round would wake PM about waking PM, every pass, for ever.
      let index = 0;
      const channel = async (message) => {
        fx.sent.push(message);
        index += 1;
        const name = `2026-08-21T10-0${index}-00.000Z-mc-watch-pm.md`;
        writeFileSync(join(fx.area, 'inbox', name), 'a knock');
        return { ok: true, file: join(fx.area, 'inbox', name), woke: true, reason: null, guard: false };
      };
      fx.item('a.md');

      const first = await pmRound({ root: fx.root, env: fx.env, send: channel, doctor: fx.doctor });
      assert.ok(first.knock, 'the arrival is worth saying');

      const second = await pmRound({ root: fx.root, env: fx.env, send: channel, doctor: fx.doctor });
      assert.equal(second.knock, null, 'and its own message is not');
      assert.equal(second.inbox.count, 2, 'while still being counted, because it is unprocessed');
      assert.equal(fx.sent.length, 1);
    } finally { fx.cleanup(); }
  });

  it('names the files and says nothing about what is in them', async () => {
    const fx = fixture();
    try {
      fx.item('a.md', 'PRODUCTION IS DOWN AND THE DATABASE IS ON FIRE');
      const outcome = await pass(fx);

      assert.ok(outcome.knock);
      assert.doesNotMatch(fx.sent[0].message, /DATABASE/u, 'the round never opened it');
      assert.match(fx.sent[0].message, /a\.md/u);
    } finally { fx.cleanup(); }
  });

  it('says how many it did not name rather than trimming in silence', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      name: `item-${String(index).padStart(2, '0')}.md`, at: '2026-08-17T15:53:02.000Z',
    }));
    const text = knockText({ items, fresh: [items[0].name] });
    assert.match(text, /^20 unprocessed items in pm\/inbox\//u);
    assert.match(text, /and 8 more, not named here/u);
  });

  it('delivered, but did not knock is a normal outcome', async () => {
    const fx = fixture();
    try {
      fx.reply({ ok: true, woke: false, reason: 'somebody is attached to it', guard: true });
      fx.item('a.md');
      const outcome = await pass(fx);

      assert.equal(outcome.knock.ok, true, 'the message is in the inbox');
      assert.equal(outcome.knock.woke, false);
      assert.deepEqual(outcome.failed, [], 'and it is not a failure');
      assert.match(readState(fx.root).last_round, /delivered, but did not knock: somebody is attached to it/u);

      // Delivered means seen: the next pass does not call it new again.
      const second = await pass(fx);
      assert.equal(second.knock, null);
    } finally { fx.cleanup(); }
  });

  it('a message that never reached the inbox leaves the item unannounced, so the next pass says it again', async () => {
    const fx = fixture();
    try {
      fx.reply({ ok: false, woke: false, reason: 'no-such-area', guard: false });
      fx.item('a.md');
      const first = await pass(fx);
      assert.equal(first.knock.ok, false);

      fx.reply({ ok: true, woke: true, reason: null, guard: false });
      const second = await pass(fx);
      assert.equal(second.knock.fresh, 1, 'still a new arrival, because PM never heard it');
    } finally { fx.cleanup(); }
  });

  it('a knock that threw is not a knock that happened', async () => {
    const fx = fixture();
    try {
      fx.item('a.md');
      const angry = async () => { throw new Error('the channel is gone'); };
      const first = await pmRound({ root: fx.root, env: fx.env, send: angry, doctor: fx.doctor });
      assert.deepEqual(first.failed.map((f) => f.step), ['knock']);
      assert.equal(first.knock, null);

      const second = await pass(fx);
      assert.equal(second.knock?.fresh, 1, 'the item is still an arrival nobody has heard about');
    } finally { fx.cleanup(); }
  });

  it('delivers the guard\'s notices once and never repeats one', async () => {
    const fx = fixture();
    try {
      appendNotice(
        { source: 'guard', session: 'msr-cleanup', pattern: 'silent', detail: 'no output for 4h12m', id: 'n1' },
        { root: fx.root },
      );

      const first = await pass(fx);
      assert.equal(first.knock.notices, 1);
      assert.match(fx.sent[0].message, /msr-cleanup {2}silent — no output for 4h12m/u);
      assert.deepEqual(pendingNotices({ root: fx.root }), [], 'and it is marked delivered');

      const second = await pass(fx);
      assert.equal(second.knock, null, 'a delivered notice is never said twice');
      // Nothing removed: the notice and its delivery are both still on file.
      assert.equal(readLedger({ root: fx.root }).notices.length, 1);
    } finally { fx.cleanup(); }
  });

  it('carries a doctor complaint into a knock, and never knocks because of one', async () => {
    const fx = fixture();
    const unwell = () => ({ ok: false, issues: [{ reason: 'stale runtime' }, { reason: 'orphan worktree' }] });
    try {
      const quiet = await pass(fx, { doctor: unwell });
      assert.equal(quiet.knock, null, 'a complaint is not a reason to wake anybody');
      assert.equal(quiet.doctor.ok, false);

      fx.item('a.md');
      const loud = await pass(fx, { doctor: unwell });
      assert.ok(loud.knock);
      assert.match(fx.sent[0].message, /mc doctor: 2 issues/u);
    } finally { fx.cleanup(); }
  });

  it('a failing step does not stop the others', async () => {
    const fx = fixture();
    try {
      // A PM home whose git is unusable: the commit fails and everything
      // after it still runs, which is the whole of the order's promise.
      rmSync(join(fx.area, '.git', 'HEAD'));
      fx.item('a.md');

      const outcome = await pass(fx, { doctor: () => { throw new Error('doctor exploded'); } });

      assert.deepEqual(outcome.failed.map((f) => f.step), ['commit', 'doctor']);
      assert.equal(outcome.inbox.count, 1, 'the inbox was still counted');
      assert.ok(outcome.knock, 'and PM was still told');
    } finally { fx.cleanup(); }
  });

  it('an inbox that cannot be read forgets nothing', async () => {
    const fx = fixture();
    try {
      fx.item('a.md');
      await pass(fx);
      const before = readState(fx.root).items;

      chmodSync(join(fx.area, 'inbox'), 0o000);
      try {
        const blind = await pass(fx);
        assert.equal(blind.inbox.count, 0);
        assert.deepEqual(readState(fx.root).items, before, 'the bookkeeping survives a blind pass');
      } finally { chmodSync(join(fx.area, 'inbox'), 0o700); }

      const outcome = await pass(fx);
      assert.equal(outcome.knock, null, 'and the item is not announced twice');
    } finally { fx.cleanup(); }
  });

  it('a thirty-minute loop runs three passes without waiting for one', async () => {
    const fx = fixture();
    try {
      const passes = [];
      await pmWatchLoop({
        intervalMs: 0,
        rounds: 3,
        root: fx.root,
        env: fx.env,
        round: async (options) => { passes.push(options.now.toISOString()); },
        now: (() => {
          let tick = 0;
          return () => new Date(Date.parse('2026-08-21T10:00:00Z') + (tick += 1800_000));
        })(),
      });
      assert.deepEqual(passes, [
        '2026-08-21T10:30:00.000Z', '2026-08-21T11:00:00.000Z', '2026-08-21T11:30:00.000Z',
      ]);
    } finally { fx.cleanup(); }
  });

  it('a pass that throws is logged and the loop goes on', async () => {
    const lines = [];
    let call = 0;
    await pmWatchLoop({
      intervalMs: 0,
      rounds: 3,
      log: (line) => lines.push(line),
      round: async () => { call += 1; if (call === 2) throw new Error('one bad pass'); },
    });
    assert.equal(call, 3);
    assert.deepEqual(lines, ['round failed: one bad pass']);
  });

  it('says the oldest to the minute, in the form the order names', () => {
    assert.equal(minute('2026-08-17T15:53:02.481Z'), '2026-08-17T15:53Z');
  });
});

describe('mc watch, the words', () => {
  it('takes a target, a verb, and nothing else', () => {
    // `model` joined the shape when the session guard landed: it is the only
    // leg that has one, and the parser rejects it for any other rather than
    // accepting a flag it would then ignore.
    assert.deepEqual(
      parseArgs(['pm', 'start', '--interval', '60']),
      {
        target: 'pm', verb: 'start', json: false, intervalMs: 60_000, model: null,
      },
    );
    assert.equal(parseArgs(['pm']).verb, 'status');
    assert.equal(parseArgs(['pm', 'status', '--json']).json, true);
  });

  it('gives each leg its own default interval', () => {
    // The round is cheap and runs every half hour; the guard costs a model
    // turn per session that moved and runs every ten minutes. One default for
    // both would have been wrong for both.
    assert.equal(parseArgs(['pm', 'start']).intervalMs, 30 * 60_000);
    assert.equal(parseArgs(['sessions', 'start']).intervalMs, 10 * 60_000);
  });

  it('refuses what it cannot do rather than guessing', () => {
    assert.match(parseArgs([]).error, /mc watch what\?/u);
    assert.match(parseArgs(['guard']).error, /mc watch guard\? — pm, sessions/u);
    assert.match(parseArgs(['pm', 'restart']).error, /start, stop or status/u);
    assert.match(parseArgs(['pm', 'stop', '--interval', '60']).error, /--interval belongs to mc watch pm start/u);
    assert.match(parseArgs(['pm', 'start', '--json']).error, /--json belongs to mc watch pm status/u);
    assert.match(parseArgs(['pm', 'start', '--interval', 'soon']).error, /number of seconds/u);
    assert.match(parseArgs(['pm', 'start', '--model', 'haiku']).error, /mc watch pm has no model/u);
  });
});
