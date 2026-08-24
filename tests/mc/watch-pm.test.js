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

import { renderWatchLines } from '../../src/mc/commands/watch.js';

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
    /** A knock as the channel would write it: the round's own sender line first. */
    ownKnock(name = '2026-08-23T19-00-00.000Z-mc-watch-pm.md') {
      const path = join(area, 'inbox', name);
      writeFileSync(path, '---\nfrom: mc watch pm\nat: 2026-08-23T19:00:00.000Z\n---\n\n1 unprocessed item\n');
      return { name, path };
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
      assert.equal(fx.sent.length, 0, 'an empty inbox, a quiet ledger and no helper home say nothing');
      assert.equal(outcome.knock, null);
      assert.deepEqual(outcome.failed, []);
      assert.equal(outcome.inbox.count, 0);
    } finally { fx.cleanup(); }
  });

  it('a quiet heartbeat pulses the helper\'s improve round — once it exists, and never when something is urgent', async () => {
    const fx = fixture();
    try {
      // The improve rhythm hangs on this heartbeat (design note §4): a
      // quiet pass is the helper's cue to take the next project in rotation.
      mkdirSync(join(fx.area, '..', 'pm-helper'), { recursive: true });
      const quiet = await pass(fx);
      assert.equal(quiet.knock, null);
      assert.equal(fx.sent.length, 1);
      assert.equal(fx.sent[0].name, 'pm-helper');
      assert.match(fx.sent[0].message, /improve round: nothing urgent this heartbeat — take the next project in rotation/u);
      assert.deepEqual(quiet.helper_pulse, { sent: true, woke: true });
      // Urgency outranks the rotation: an unread item is PM's turn, not an
      // improve round.
      fx.item('a.md');
      const urgent = await pass(fx);
      assert.equal(urgent.knock?.ok, true);
      assert.equal(urgent.helper_pulse, null);
      assert.ok(!fx.sent.slice(1).some((sent) => sent.name === 'pm-helper'));
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
    // All twenty new: twelve named, the cap said out loud.
    const text = knockText({ items, fresh: items.map((item) => item.name) });
    assert.match(text, /^20 unprocessed items in pm\/inbox\//u);
    assert.match(text, /and 8 more new, not named here/u);
  });

  it('names what is new, and counts what it has already announced (B3)', () => {
    // Five knocks in ninety seconds, each listing the four before it: a
    // knock names the fresh and the reminded, and says how many older
    // items are still there without naming them again.
    const items = Array.from({ length: 6 }, (_, index) => ({
      name: `item-${index}.md`, at: '2026-08-17T15:53:02.000Z',
    }));
    const text = knockText({ items, fresh: ['item-5.md'], reminders: ['item-1.md'] });
    assert.match(text, /^6 unprocessed items/u);
    assert.match(text, /new\s+item-5\.md/u);
    assert.match(text, /reminder\s+item-1\.md/u);
    assert.match(text, /waiting\s+4 older, already announced/u);
    assert.doesNotMatch(text, /item-0\.md|item-2\.md/u);
  });

  it('the last knock is remembered apart from the last round (B5)', async () => {
    const fx = fixture();
    try {
      fx.reply({ ok: true, woke: false, reason: 'somebody is attached to it', guard: true });
      fx.item('a.md');
      await pass(fx);
      // Three quiet passes later, the last knock still says what became of it.
      await pass(fx); await pass(fx);
      const state = readState(fx.root);
      assert.equal(state.last_knock.woke, false);
      assert.equal(state.last_knock.delivered, true);
      assert.equal(state.last_knock.reason, 'somebody is attached to it');
      // And the page says it: "nothing to say" and "refused every time" were
      // the same silence for a day — 188 knocks, none landed.
      const lines = renderWatchLines({ running: true, pid: 1, interval_ms: 1800000, last_write_at: state.at, last_round: 'x', last_knock: state.last_knock, log: '/x' }, { target: 'pm', now: Date.parse(state.at) });
      assert.ok(lines.some((line) => /last knock .*delivered, did not knock: somebody is attached to it/u.test(line)), lines.join('|'));
    } finally { fx.cleanup(); }
  });

  it('its own knocks are not items: not counted, not named, never a reason to knock (B3)', async () => {
    const fx = fixture();
    try {
      fx.item('a.md');
      const first = await pass(fx);
      assert.equal(first.knock.ok, true);
      // The channel's file for that knock is in the inbox now, signed by the
      // round. The next pass must not count it, and must have nothing to say.
      const { name } = fx.ownKnock();
      const second = await pass(fx);
      assert.equal(second.inbox.count, 1, `the round's own ${name} was counted`);
      assert.equal(second.knock, null, 'the round knocked about its own knock');
    } finally { fx.cleanup(); }
  });

  it('a mechanism out of force knocks, earns one reminder, then rests — and is named in full (D-0180)', async () => {
    const fx = fixture();
    try {
      const broken = 'push-guard is not in force on memoro — no pre-push hook; mc repo guard memoro';
      const out = (list) => () => ({ ok: true, issues: [], not_in_force: list });
      const first = await pass(fx, { doctor: out([broken]) });
      assert.equal(first.knock?.ok, true, 'newly out of force is worth a turn');
      const said = fx.sent[fx.sent.length - 1].message;
      assert.match(said, /1 mechanism NOT IN FORCE:/u);
      assert.ok(said.includes(broken), 'named in full, never counted');
      // Still broken: quiet, then one reminder on the third pass, then rest.
      const second = await pass(fx, { doctor: out([broken]) });
      assert.equal(second.knock, null, 'still broken is not news yet');
      const third = await pass(fx, { doctor: out([broken]) });
      assert.equal(third.knock?.ok, true, 'one reminder');
      const fourth = await pass(fx, { doctor: out([broken]) });
      assert.equal(fourth.knock, null, 'then rest');
      // Repaired: forgotten — and a NEW break knocks at once.
      await pass(fx, { doctor: out([]) });
      const again = await pass(fx, { doctor: out([broken]) });
      assert.equal(again.knock?.ok, true, 'a repaired-then-rebroken mechanism is news again');
    } finally { fx.cleanup(); }
  });

  it("does not count the guard's knock either — a watcher's file is never an item (KP-10)", async () => {
    const fx = fixture();
    try {
      fx.item('a.md');
      await pass(fx);
      // The guard flagged something into PM's inbox, signed with its own fixed
      // name. Measured 2026-08-24: the round counted it, knocked, and the
      // guard then flagged PM for the round's knock — 104 of 163 archived
      // files were the two watchers announcing each other.
      const guard = join(fx.area, 'inbox', '2026-08-24T03-00-00.000Z-mc-watch-sessions.md');
      writeFileSync(guard, '---\nfrom: mc watch sessions\nat: 2026-08-24T03:00:00.000Z\n---\n\nmc watch sessions flagged 1 thing\n');
      const second = await pass(fx);
      assert.equal(second.inbox.count, 1, "the guard's knock was counted as an item");
      assert.equal(second.knock, null, "the round knocked about the guard's knock");
      assert.deepEqual(readInbox(fx.area).items.map((i) => i.name), ['a.md']);
    } finally { fx.cleanup(); }
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

  it('a new file in the inbox ends the wait, and the clock is the floor (D-0013)', async () => {
    // Four reports landed one evening and PM sat on them until somebody asked
    // "status?": the half hour had not come round. The file is the event the
    // round exists for, so the file is what wakes the round.
    const fx = fixture();
    try {
      const passes = [];
      const started = Date.now();
      let done = false;
      const loop = pmWatchLoop({
        intervalMs: 60 * 60 * 1000,
        settleMs: 50,
        rounds: 2,
        root: fx.root,
        env: fx.env,
        round: async () => {
          passes.push(Date.now() - started);
          if (passes.length === 1) setTimeout(() => fx.item('2026-08-22T19-00-30.885Z-alpha.md'), 150);
        },
      }).then(() => { done = true; });
      await Promise.race([loop, new Promise((resolve) => { setTimeout(resolve, 5000); })]);
      assert.equal(done, true, 'the second pass waited for the hour instead of the file');
      assert.equal(passes.length, 2);
      assert.ok(passes[1] < 3000, `woke ${passes[1]}ms after start — should be the file, not the clock`);
    } finally { fx.cleanup(); }
  });

  it('an inbox that cannot be watched is said once, and the clock still runs', async () => {
    const lines = [];
    let call = 0;
    await pmWatchLoop({
      intervalMs: 0,
      rounds: 2,
      log: (line) => lines.push(line),
      watchInbox: () => null,
      round: async () => { call += 1; },
    });
    assert.equal(call, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not watching .*inbox for new files — the clock is the only wake/u);
  });

  it('a pass that throws is logged and the loop goes on', async () => {
    const lines = [];
    let call = 0;
    await pmWatchLoop({
      intervalMs: 0,
      rounds: 3,
      log: (line) => lines.push(line),
      watchInbox: () => null,
      round: async () => { call += 1; if (call === 2) throw new Error('one bad pass'); },
    });
    assert.equal(call, 3);
    assert.deepEqual(lines.filter((line) => !line.startsWith('not watching')), ['round failed: one bad pass']);
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
        target: 'pm', verb: 'start', json: false, intervalMs: 60_000, model: null, idleMs: null, groups: [],
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
