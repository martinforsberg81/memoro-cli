/**
 * The guard — what it flags, what it refuses to flag, and what it refuses to
 * spend.
 *
 * The guarantees under test are KP-05's design laws and §4, §5 and §7 of the
 * autonomy-loop note, in the order they matter:
 *
 *   - a cheap model amplifies attention and never filters it, so the model's
 *     silence never suppresses a script pattern, and a model call that fails
 *     costs the round nothing it had already worked out;
 *   - everything with a deterministic answer is script — waiting, silent, dead
 *     and unreachable are computed without asking anybody;
 *   - a turn is spent only on change, and that is a lock rather than an
 *     intention: a session whose transcript has not moved is never read;
 *   - the guard flags, and does not decide or rank;
 *   - exactly two classes knock, and everything else waits for the round.
 *
 * Nothing here starts a daemon and nothing here calls a model. The clock, the
 * status board, the model and the channel are all injected — a test that
 * spawned the real thing would be measuring this machine's load, which is the
 * one number that has nothing to do with whether the code is right.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readingOrder, watchLoop, watchRound } from '../../src/mc/watch-sessions-loop.js';
import {
  MODEL_PATTERNS, SCRIPT_PATTERNS, arrivedSince, countInbox, describeSpan, scanSessions,
} from '../../src/mc/watch-sessions-scan.js';
import { parseFlags, quoteFrom, readOutput } from '../../src/mc/watch-sessions-read.js';
import { readMemory } from '../../src/mc/watch-sessions-store.js';
import { URGENT_PATTERNS, pendingNotices, readLedger } from '../../src/mc/watch-notices.js';
import { knockText } from '../../src/mc/watch-sessions-knock.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-08-21T20:00:00.000Z');

function root() {
  return mkdtempSync(join(tmpdir(), 'mc-watch-sessions-'));
}

/** One conversation as the status board describes it. */
function conversation(overrides = {}) {
  return {
    id: 'c1',
    tool: 'claude-code',
    path: '/nowhere/c1.jsonl',
    bytes: 1000,
    updated_ms: NOW - MINUTE,
    live: true,
    state: 'working',
    turn: 'working',
    ...overrides,
  };
}

/** A status report with one area per entry. */
function board(areas) {
  return {
    at: new Date(NOW).toISOString(),
    areas: areas.map(([name, conversations, path = `/work/${name}`]) => ({
      name, path, conversations,
    })),
  };
}

/** The round, with everything expensive replaced. */
function round(options = {}) {
  return watchRound({
    now: NOW,
    status: async () => options.report,
    read: options.read || (async () => ({ patterns: [], failed: null })),
    send: options.send || (() => ({ ok: true, woke: true })),
    reachable: options.reachable || (() => null),
    ...options,
  });
}

describe('the guard flags, and only flags', () => {
  it('has eleven patterns, eight of them script, and exactly four that knock', () => {
    assert.deepEqual([...SCRIPT_PATTERNS], ['waiting', 'silent', 'dead', 'unreachable', 'unattended', 'quiet-group', 'stalled', 'holding']);
    assert.deepEqual([...MODEL_PATTERNS], ['blocked', 'quota-exhausted', 'error']);
    // The bound in §5 is the point of the exception. The two added for B2
    // (2026-08-23) are the work itself standing still — a session stopped
    // with mail it has not read, a group in which nobody works — and the
    // round's half hour is the latency they exist to remove. Everything else
    // still waits for the round.
    assert.deepEqual([...URGENT_PATTERNS], ['dead', 'quota-exhausted', 'unattended', 'quiet-group']);
  });

  it('a session stopped with mail that arrived since it last moved is unattended, knocked, and urgent', async () => {
    // Measured 2026-08-23: a track idle 9m36s with its answer lying in its
    // own inbox, and nothing said so. Unread is not "files in inbox/" — a
    // work area does not archive — it is a file newer than the session's
    // last move.
    const at = root();
    const sent = [];
    const stopped = NOW - 12 * MINUTE;
    const outcome = await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: stopped })]]]),
      arrivals: (path, since) => (since === stopped ? { count: 2, oldest: '2026-08-23T18-50-00.000Z-pm.md' } : { count: 0, oldest: null }),
      send: (message) => { sent.push(message); return { ok: true, woke: true }; },
    });
    const notice = readLedger({ root: at }).notices.find((item) => item.pattern === 'unattended');
    assert.ok(notice, 'no unattended notice');
    assert.equal(notice.session, 'alpha');
    assert.match(notice.detail, /stopped for 12m with 2 inbox files that arrived since it last moved, oldest 2026-08-23T18-50-00\.000Z-pm\.md/u);
    // Knocked twice: the session itself, and PM — at once, not at the round.
    assert.deepEqual(sent.map((item) => item.name), ['alpha', 'pm']);
    assert.match(sent[0].message, /read your inbox now/u);
    assert.equal(outcome.urgent, 1);
    assert.equal(outcome.knocked, 1);
  });

  it('unattended needs the stop to be long enough, and the mail to be newer than the stop', async () => {
    const at = root();
    const stopped = NOW - 12 * MINUTE;
    // Mail older than the stop: it was read, or will be, on the session's
    // own turn. Nothing flagged.
    const first = await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: stopped })]]]),
      arrivals: () => ({ count: 0, oldest: null }),
    });
    assert.equal(first.urgent, 0);
    // Stopped four minutes with new mail: not yet — ten is the line.
    const second = await round({
      root: at,
      report: board([['alpha', [conversation({ id: 'c2', state: 'waiting', turn: 'waiting', updated_ms: NOW - 4 * MINUTE })]]]),
      arrivals: () => ({ count: 1, oldest: 'x.md' }),
    });
    assert.equal(second.urgent, 0);
    // Working with new mail: it reads it when its turn ends.
    const third = await round({
      root: at,
      report: board([['alpha', [conversation({ id: 'c3', state: 'working', turn: 'working', updated_ms: NOW - 30 * MINUTE })]]]),
      arrivals: () => ({ count: 1, oldest: 'x.md' }),
    });
    assert.equal(third.urgent, 0);
  });

  it('a named group in which nobody works is quiet-group, once, with how long', async () => {
    const at = root();
    const sent = [];
    const report = board([
      ['msr-track-1', [conversation({ id: 't1', state: 'waiting', turn: 'waiting', updated_ms: NOW - 25 * MINUTE })]],
      ['msr-track-2', [conversation({ id: 't2', state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]],
      ['msr-design', [conversation({ id: 'd1', state: 'working', turn: 'working' })]],
    ]);
    const first = await round({
      root: at, report, groups: ['msr-track-'], arrivals: () => ({ count: 0, oldest: null }),
      send: (message) => { sent.push(message); return { ok: true, woke: true }; },
    });
    const notice = readLedger({ root: at }).notices.find((item) => item.pattern === 'quiet-group');
    assert.ok(notice, 'no quiet-group notice');
    assert.equal(notice.session, 'msr-track-*');
    // The last one stopped 25 minutes ago: that is how long the group has been quiet.
    assert.match(notice.detail, /none of 2 live under msr-track-\* is working — the last stopped 25m ago \(msr-track-1, msr-track-2\)/u);
    assert.equal(first.urgent, 1);
    assert.deepEqual(sent.map((item) => item.name), ['pm']);
    // Still quiet next round: still true, not newly true. One notice.
    const second = await round({ root: at, report, groups: ['msr-track-'], arrivals: () => ({ count: 0, oldest: null }) });
    assert.equal(second.urgent, 0);
    assert.equal(readLedger({ root: at }).notices.filter((item) => item.pattern === 'quiet-group').length, 1);
    // One of them starts working: the flag ends, and memory follows.
    const working = board([
      ['msr-track-1', [conversation({ id: 't1', state: 'working', turn: 'working' })]],
      ['msr-track-2', [conversation({ id: 't2', state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]],
    ]);
    await round({ root: at, report: working, groups: ['msr-track-'], arrivals: () => ({ count: 0, oldest: null }) });
    assert.deepEqual(readMemory({ root: at }).sessions['group:msr-track-'].active, []);
  });

  it('writes a notice that says where to look and nothing else', async () => {
    const at = root();
    await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]]]),
    });
    const [notice] = readLedger({ root: at }).notices;
    assert.equal(notice.session, 'alpha');
    assert.equal(notice.pattern, 'waiting');
    assert.equal(notice.source, 'guard');
    // No severity, no rank, no advice, no summary of the work.
    assert.deepEqual(
      Object.keys(notice).sort(),
      ['at', 'detail', 'id', 'pattern', 'session', 'source'],
    );
  });

  it('says so in the knock, so nobody reads the list as an order of importance', () => {
    const text = knockText([
      { session: 'alpha', pattern: 'dead', detail: 'it was running last round' },
      { session: 'beta', pattern: 'quota-exhausted' },
    ]);
    assert.match(text, /alpha: dead/u);
    assert.match(text, /beta: quota-exhausted/u);
    assert.match(text, /does not decide/u);
    assert.match(text, /not in any order of importance/u);
  });
});

describe('everything with a deterministic answer is script', () => {
  it('flags a session that has been waiting longer than the threshold, and not one that has not', () => {
    const { sessions } = scanSessions({
      now: NOW,
      waitingMs: 20 * MINUTE,
      report: board([
        ['old', [conversation({ id: 'a', state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]],
        ['fresh', [conversation({ id: 'b', state: 'waiting', turn: 'waiting', updated_ms: NOW - 5 * MINUTE })]],
      ]),
    });
    assert.deepEqual(sessions[0].patterns.map((p) => p.pattern), ['waiting']);
    assert.match(sessions[0].patterns[0].detail, /40m/u);
    assert.deepEqual(sessions[1].patterns, []);
  });

  it('flags a session that is meant to be working and has produced nothing', () => {
    const { sessions } = scanSessions({
      now: NOW,
      silentMs: 20 * MINUTE,
      report: board([['alpha', [conversation({ updated_ms: NOW - 4 * 60 * MINUTE - 12 * MINUTE })]]]),
    });
    assert.deepEqual(sessions[0].patterns.map((p) => p.pattern), ['silent']);
    assert.match(sessions[0].patterns[0].detail, /4h12m/u);
  });

  it('calls a conversation dead only when it saw it alive, and never on first sight', () => {
    const gone = conversation({ live: false, state: 'idle', turn: 'working' });
    const first = scanSessions({ now: NOW, report: board([['alpha', [gone]]]) });
    assert.deepEqual(first.sessions[0].patterns, [], 'the guard did not see it die');

    const second = scanSessions({
      now: NOW,
      report: board([['alpha', [gone]]]),
      previous: { c1: { live: true, bytes: 1000, updated_ms: gone.updated_ms, active: [] } },
    });
    assert.deepEqual(second.sessions[0].patterns.map((p) => p.pattern), ['dead']);
  });

  it('flags mail that arrived in a pane no wake can reach — and asks the channel, not a model', () => {
    const at = root();
    const area = join(at, 'alpha');
    mkdirSync(join(area, 'inbox'), { recursive: true });
    writeFileSync(join(area, 'inbox', 'README.md'), 'not an item\n');
    mkdirSync(join(area, 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(area, 'inbox', '2026-08-21T10-00-00Z-pm.md'), 'an order\n');

    const { sessions } = scanSessions({
      now: NOW,
      report: board([['alpha', [conversation()], area]]),
      reachable: () => ({ ok: false, target: 'mc-alpha', reason: 'there is already something in its prompt' }),
    });
    const [flag] = sessions[0].patterns.filter((p) => p.pattern === 'unreachable');
    assert.ok(flag, 'unread mail in a pane that refuses the knock is the flag');
    assert.match(flag.detail, /1 unread in inbox\//u);
    assert.match(flag.detail, /already something in its prompt/u);
  });

  it('flags a running session mc cannot address — the quietest of the three', () => {
    // Measured by PM 2026-08-22 on nine of mc's own sessions: waking looks up
    // the tmux session `mc-<area>`, those nine ran under names of their own,
    // and every send delivered the file and never tried to knock. mc said
    // "nothing is running", which reads as "never started". Nothing anywhere
    // said the knock had not happened.
    const at = root();
    const area = join(at, 'alpha');
    mkdirSync(join(area, 'inbox'), { recursive: true });
    writeFileSync(join(area, 'inbox', 'order.md'), 'an order\n');
    const { sessions } = scanSessions({
      now: NOW,
      report: board([['alpha', [conversation()], area]]),
      reachable: () => ({
        ok: false,
        target: null,
        reason: 'mc cannot address it: something is running in it, but no tmux pane stands in it (neither mc-alpha nor one found by its path) — started outside tmux',
      }),
    });
    const [flag] = sessions[0].patterns.filter((p) => p.pattern === 'unreachable');
    assert.ok(flag, 'a live session with no address is unreachable, not absent');
    assert.match(flag.detail, /1 unread in inbox\//u);
    assert.match(flag.detail, /mc cannot address it/u);
    // Distinct from the prompt case, so nobody reads one as the other.
    assert.doesNotMatch(flag.detail, /already something in its prompt/u);
  });

  it('does not call a session unreachable when nothing is running in it at all', () => {
    const at = root();
    const area = join(at, 'alpha');
    mkdirSync(join(area, 'inbox'), { recursive: true });
    writeFileSync(join(area, 'inbox', 'order.md'), 'an order\n');
    let asked = 0;
    const { sessions } = scanSessions({
      now: NOW,
      // Idle: mail waiting for a session that is not running is read when it
      // boots, which is the designed path and not a failure. Flagging it would
      // make every finished session a standing flag.
      report: board([['alpha', [conversation({ live: false, state: 'idle', turn: 'waiting' })], area]]),
      reachable: () => { asked += 1; return { ok: false, target: null, reason: 'no' }; },
    });
    assert.deepEqual(sessions[0].patterns, []);
    assert.equal(asked, 0, 'and the channel is not even asked');
  });

  it('counts an inbox the way the round does: top-level files, not README, not directories', () => {
    const at = root();
    mkdirSync(join(at, 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(at, 'inbox', 'README.md'), 'x');
    writeFileSync(join(at, 'inbox', 'archive', 'done.md'), 'x');
    writeFileSync(join(at, 'inbox', 'b.md'), 'x');
    writeFileSync(join(at, 'inbox', 'a.md'), 'x');
    assert.deepEqual(countInbox(at), { count: 2, oldest: 'a.md' });
  });

  it("never counts a watcher's knock as mail — neither the round's nor its own (KP-10)", () => {
    const at = root();
    mkdirSync(join(at, 'inbox'), { recursive: true });
    // The round's knock into PM's inbox was, to this guard, "a file that
    // arrived since PM last moved": PM went `unattended`, the guard knocked,
    // and the round counted that knock as the next item. Six wakes in a row
    // after the fleet went quiet, none carrying a report (2026-08-24).
    writeFileSync(join(at, 'inbox', '2026-08-24T03-00-00.000Z-mc-watch-pm.md'), '---\nfrom: mc watch pm\nat: 2026-08-24T03:00:00.000Z\n---\n\n1 unprocessed item\n');
    writeFileSync(join(at, 'inbox', '2026-08-24T03-01-00.000Z-mc-watch-sessions.md'), '---\nfrom: mc watch sessions\nat: 2026-08-24T03:01:00.000Z\n---\n\nmc watch sessions flagged 1 thing\n');
    writeFileSync(join(at, 'inbox', '2026-08-24T03-02-00.000Z-alpha.md'), '---\nfrom: alpha\nat: 2026-08-24T03:02:00.000Z\n---\n\nSLUTRAPPORT\n');
    assert.deepEqual(countInbox(at), { count: 1, oldest: '2026-08-24T03-02-00.000Z-alpha.md' });
    assert.deepEqual(arrivedSince(at, 0), { count: 1, oldest: '2026-08-24T03-02-00.000Z-alpha.md' });
  });

  it('flags an order that was given and has not moved, without saying what it was', () => {
    const twelveHours = 12 * 60 * 60_000;
    const { sessions } = scanSessions({
      now: NOW,
      report: board([['alpha', [conversation()]], ['beta', [conversation({ id: 'b' })]]]),
      tasks: () => [
        { id: 'a1b2c3d4-ffff', session: 'alpha', state: 'open', text: 'do step 3 of plan Z', updated_at: new Date(NOW - 14 * 60 * MINUTE - twelveHours).toISOString() },
        { id: 'e5f6a7b8-ffff', session: 'alpha', state: 'open', text: 'and step 4', updated_at: new Date(NOW - twelveHours - MINUTE).toISOString() },
        { id: 'c9d0e1f2-ffff', session: 'beta', state: 'open', text: 'something recent', updated_at: new Date(NOW - MINUTE).toISOString() },
      ],
    });
    const [flag] = sessions[0].patterns.filter((p) => p.pattern === 'stalled');
    assert.ok(flag);
    assert.match(flag.detail, /2 open tasks not moved in over 12h00m/u);
    assert.match(flag.detail, /\(a1b2c3d\)|\(a1b2c3d4\)/u, 'the id points; it does not describe');
    // The round's rule for the inbox, applied to the same kind of thing: it
    // never says what the order was about.
    assert.doesNotMatch(flag.detail, /step 3|plan Z/u);
    assert.deepEqual(sessions[1].patterns, [], 'a task that moved an hour ago is a task in progress');
  });

  it('ignores a task addressed to a session that is not on this machine', () => {
    const { sessions } = scanSessions({
      now: NOW,
      report: board([['alpha', [conversation()]]]),
      tasks: () => [
        { id: 'x', session: 'somewhere-else', state: 'open', updated_at: new Date(0).toISOString() },
      ],
    });
    assert.deepEqual(sessions[0].patterns, []);
  });

  it('flags the suite right held with nothing running, on the holder, and says which kind of hold', () => {
    const suite = (lease, running = []) => ({ ...board([['pm', [conversation()]], ['alpha', [conversation({ id: 'a' })]]]), suite: { lease, running } });
    const held = { held: true, holder: 'pm', holder_kind: 'work-area', errand: 'gate round for #10861', age_ms: 145 * MINUTE, owner_pid: null, orphaned: false };
    const flags = (report) => scanSessions({ now: NOW, report, tasks: () => [] }).sessions
      .flatMap((session) => session.patterns.filter((p) => p.pattern === 'holding').map((p) => ({ area: session.area, ...p })));

    // Held by hand for 2h25m, nothing running: the holder's session is flagged.
    const [byHand] = flags(suite(held));
    assert.equal(byHand.area, 'pm');
    assert.match(byHand.detail, /holds the suite right for 2h25m with no suite running \(“gate round for #10861”\) — mc suite release if the run is over/u);

    // Its process gone: said as that, with the pid and the way back.
    const [orphan] = flags(suite({ ...held, owner_pid: 4242, orphaned: true }));
    assert.match(orphan.detail, /pid 4242\) is gone — nothing is running; the next claim takes it/u);

    // A suite actually running under it is a lease doing its job.
    assert.deepEqual(flags(suite(held, [{ pid: 9, command: 'npm test', area: 'alpha', elapsed: '03:00' }])), []);
    // Fifteen minutes is the line: a gate round's git work between two suites is minutes, not fifteen.
    assert.deepEqual(flags(suite({ ...held, age_ms: 14 * MINUTE })), []);
    assert.equal(flags(suite({ ...held, age_ms: 16 * MINUTE })).length, 1);
    // Free, or held by a shell nobody can flag: nothing — the board row is what there is.
    assert.deepEqual(flags(suite({ held: false })), []);
    assert.deepEqual(flags(suite({ ...held, holder: 'me@host', holder_kind: 'shell' })), []);
    assert.deepEqual(flags(board([['pm', [conversation()]]])), [], 'a board with no suite row flags nothing');
  });

  it('reads a span the way a person does', () => {
    assert.equal(describeSpan(12 * MINUTE), '12m');
    assert.equal(describeSpan(4 * 60 * MINUTE + 12 * MINUTE), '4h12m');
  });
});

describe('a turn is spent only on change', () => {
  it('never reads a conversation whose transcript has not moved', async () => {
    const at = root();
    const still = conversation({ bytes: 4096, updated_ms: NOW - 3 * MINUTE });
    const read = [];
    await round({
      root: at,
      report: board([['alpha', [still]]]),
      read: async (session) => { read.push(session.id); return { patterns: [], failed: null }; },
    });
    assert.deepEqual(read, ['c1'], 'a conversation it has never seen is read once');

    // Second round, same size, same mtime: a stat, and no turn.
    const again = [];
    await round({
      root: at,
      report: board([['alpha', [still]]]),
      read: async (session) => { again.push(session.id); return { patterns: [], failed: null }; },
    });
    assert.deepEqual(again, [], 'unchanged output costs a stat, never a model turn');
  });

  it('never reads a conversation nobody is running, however much it changed', () => {
    const { sessions } = scanSessions({
      now: NOW,
      report: board([['alpha', [conversation({ live: false, state: 'idle', turn: 'waiting' })]]]),
    });
    assert.equal(sessions[0].changed, true);
    assert.equal(sessions[0].readable, false);
  });

  it('bounds what one round reads, rotates the queue, and never drops it silently', async () => {
    const at = root();
    const many = Array.from({ length: 5 }, (_, index) => conversation({ id: `c${index}` }));
    const said = [];
    const read = [];
    await round({
      root: at,
      maxReads: 2,
      concurrency: 1,
      report: board([['alpha', many]]),
      log: (message) => said.push(message),
      read: async (session) => { read.push(session.id); return { patterns: [], failed: null }; },
    });
    assert.equal(read.length, 2);
    assert.ok(said.some((line) => /3 changed sessions not read this round/u.test(line)),
      'a ceiling that bites is logged, never silent');

    // The two that were read carry a read_at; the queue is ordered by it, so
    // the next round starts with the three that were not.
    const memory = readMemory({ root: at }).sessions;
    const order = readingOrder(
      many.map((item) => ({ id: item.id, readable: true })), memory, 2,
    );
    assert.deepEqual(order.queue.map((item) => item.id).sort(), ['c2', 'c3']);
  });
});

describe('the model amplifies attention; it never filters it', () => {
  it('keeps every script pattern when the model finds nothing', async () => {
    const at = root();
    await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]]]),
      read: async () => ({ patterns: [], failed: null }),
    });
    assert.deepEqual(readLedger({ root: at }).notices.map((n) => n.pattern), ['waiting']);
  });

  it('keeps every script pattern when the model call fails outright', async () => {
    const at = root();
    const said = [];
    const outcome = await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]]]),
      read: async () => ({ patterns: [], failed: 'the model did not answer within 240s' }),
      log: (message) => said.push(message),
    });
    assert.equal(outcome.flagged, 1);
    assert.deepEqual(readLedger({ root: at }).notices.map((n) => n.pattern), ['waiting']);
    assert.ok(said.some((line) => /could not read alpha/u.test(line)));
  });

  it('drops a word the model invented outside its vocabulary', async () => {
    const answer = '{"flags":[{"pattern":"needs-review","quote":"anything"},{"pattern":"error","quote":"EACCES"}]}';
    const outcome = await readOutput('tool failed: EACCES denied', { ask: async () => answer });
    assert.deepEqual(outcome.patterns.map((p) => p.pattern), ['error']);
  });

  it('checks the quote against the output rather than believing it', async () => {
    const text = 'tool failed: Error: EACCES: permission denied';
    const copied = await readOutput(text, {
      ask: async () => '{"flags":[{"pattern":"error","quote":"EACCES: permission denied"}]}',
    });
    assert.equal(copied.patterns[0].detail, '"EACCES: permission denied"');

    // Paraphrased rather than copied: the flag stands — withholding it would be
    // filtering — and the invention is thrown away and named as one.
    const invented = await readOutput(text, {
      ask: async () => '{"flags":[{"pattern":"error","quote":"the build broke because of permissions"}]}',
    });
    assert.equal(invented.patterns[0].pattern, 'error');
    assert.match(invented.patterns[0].detail, /not in the output/u);
  });

  it('reads an answer the model wrapped in prose or a fence', () => {
    assert.deepEqual(parseFlags('Here you go:\n```json\n{"flags":[]}\n```'), []);
    assert.equal(parseFlags('no json here'), null);
    assert.equal(quoteFrom('  a   spaced\nquote ', 'and a spaced quote in here'), '"a spaced quote"');
  });

  it('spends nothing at all on an empty excerpt', async () => {
    let asked = 0;
    const outcome = await readOutput('   ', { ask: async () => { asked += 1; return '{"flags":[]}'; } });
    assert.equal(asked, 0);
    assert.deepEqual(outcome.patterns, []);
  });
});

describe('one knocker', () => {
  it('knocks for dead and quota-exhausted, and marks them delivered itself', async () => {
    const at = root();
    const sent = [];
    const working = conversation({ live: true, state: 'working', turn: 'working' });
    const gone = conversation({ live: false, state: 'idle', turn: 'working' });

    // First round: it is running, and nothing is flagged. A conversation the
    // guard has never seen alive can never be reported as having died.
    const first = await round({
      root: at,
      report: board([['alpha', [working]]]),
      send: (message) => { sent.push(message); return { ok: true, woke: true }; },
    });
    assert.equal(first.urgent, 0);
    assert.deepEqual(sent, []);

    // Second round: the process is gone and its last turn never finished.
    const after = await round({
      root: at,
      report: board([['alpha', [gone]]]),
      send: (message) => { sent.push(message); return { ok: true, woke: true }; },
    });
    assert.equal(after.urgent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'pm');
    assert.equal(sent[0].wake, true);
    assert.match(sent[0].message, /alpha: dead/u);
    // Written by the guard, so the round never carries it a second time.
    assert.deepEqual(pendingNotices({ root: at }), []);
  });

  it('leaves every other flag for the round to carry, and never knocks for it', async () => {
    const at = root();
    const sent = [];
    await round({
      root: at,
      report: board([['alpha', [conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE })]]]),
      send: (message) => { sent.push(message); return { ok: true, woke: true }; },
    });
    assert.deepEqual(sent, [], 'the guard does not knock; the round delivers');
    assert.deepEqual(pendingNotices({ root: at }).map((n) => n.pattern), ['waiting']);
  });

  it('counts a delivery that could not wake anybody as delivered, because the file arrived', async () => {
    const at = root();
    const gone = conversation({ live: false, state: 'idle', turn: 'working' });
    await round({ root: at, report: board([['alpha', [conversation()]]]) });
    const said = [];
    await round({
      root: at,
      report: board([['alpha', [gone]]]),
      send: () => ({ ok: true, woke: false, reason: 'somebody is attached to it' }),
      log: (message) => said.push(message),
    });
    assert.deepEqual(pendingNotices({ root: at }), [], 'the file is the delivery; the knock is latency');
    assert.ok(said.some((line) => /delivered without waking/u.test(line)));
  });

  it('says one thing once: a flag that is still true is not a new notice', async () => {
    const at = root();
    const stuck = conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE });
    for (let pass = 0; pass < 3; pass += 1) {
      await round({ root: at, report: board([['alpha', [stuck]]]) });
    }
    assert.deepEqual(readLedger({ root: at }).notices.map((n) => n.pattern), ['waiting']);
  });

  it('says it again when it stops being true and becomes true a second time', async () => {
    const at = root();
    const stuck = conversation({ state: 'waiting', turn: 'waiting', updated_ms: NOW - 40 * MINUTE });
    const busy = conversation({ bytes: 2000, updated_ms: NOW });
    await round({ root: at, report: board([['alpha', [stuck]]]) });
    await round({ root: at, report: board([['alpha', [busy]]]) });
    await round({ root: at, report: board([['alpha', [stuck]]]) });
    assert.deepEqual(readLedger({ root: at }).notices.map((n) => n.pattern), ['waiting', 'waiting']);
  });

  it('never removes a line: delivery is a new one', async () => {
    const at = root();
    const gone = conversation({ live: false, state: 'idle', turn: 'working' });
    await round({ root: at, report: board([['alpha', [conversation()]]]) });
    await round({ root: at, report: board([['alpha', [gone]]]) });
    const { notices, delivered } = readLedger({ root: at });
    assert.equal(notices.length, 1);
    assert.equal(delivered.size, 1);
    assert.ok(delivered.has(notices[0].id));
  });
});

describe('the holder of an idle suite right is told, by the guard, once', () => {
  it('sends one file with a wake to the holder when the flag is fresh, and not again while it stands', async () => {
    const at = root();
    const sent = [];
    const report = {
      ...board([['pm', [conversation()]]]),
      suite: { lease: { held: true, holder: 'pm', holder_kind: 'work-area', errand: 'x', age_ms: 30 * MINUTE, owner_pid: null, orphaned: false }, running: [] },
    };
    const send = (message) => { sent.push(message); return { ok: true, woke: true }; };
    const first = await round({ root: at, report, send });
    assert.equal(first.flagged, 1);
    assert.equal(first.urgent, 0, 'holding is not a knock on PM — it is a word to the holder');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'pm');
    assert.equal(sent[0].wake, true);
    assert.match(sent[0].message, /^mc watch sessions: you holds the suite right for 30m with no suite running/u);
    // Still held next round: the flag stands in memory, nothing is sent twice.
    const second = await round({ root: at, report, send, now: NOW + 5 * MINUTE });
    assert.equal(second.flagged, 0);
    assert.equal(sent.length, 1);
  });

  it('a send that fails is logged, and the round goes on', async () => {
    const at = root();
    const lines = [];
    const report = {
      ...board([['pm', [conversation()]]]),
      suite: { lease: { held: true, holder: 'pm', holder_kind: 'work-area', errand: 'x', age_ms: 30 * MINUTE }, running: [] },
    };
    const outcome = await round({ root: at, report, send: () => { throw new Error('tmux is not on this machine'); }, log: (line) => lines.push(line) });
    assert.equal(outcome.flagged, 1);
    assert.ok(lines.some((line) => /could not tell pm about the suite right: tmux is not on this machine/u.test(line)), lines.join('\n'));
  });
});

describe('a round that goes wrong does not stop the watch', () => {
  it('logs a round that threw and keeps going', async () => {
    const at = root();
    const said = [];
    let calls = 0;
    await watchLoop({
      root: at,
      rounds: 2,
      intervalMs: 1,
      log: (message) => said.push(message),
      now: () => NOW,
      status: async () => {
        calls += 1;
        if (calls === 1) throw new Error('the board would not answer');
        return board([['alpha', [conversation()]]]);
      },
      read: async () => ({ patterns: [], failed: null }),
      reachable: () => null,
      send: () => ({ ok: true, woke: true }),
    });
    assert.equal(calls, 2);
    assert.ok(said.some((line) => /round failed: .*the board would not answer/su.test(line)));
    assert.ok(said.some((line) => /1 conversations, 1 live/u.test(line)));
  });

  it('stops when asked, without starting another round', async () => {
    const at = root();
    let calls = 0;
    await watchLoop({
      root: at,
      rounds: 5,
      intervalMs: 1,
      shouldStop: () => calls >= 1,
      now: () => NOW,
      status: async () => { calls += 1; return board([]); },
      read: async () => ({ patterns: [], failed: null }),
      reachable: () => null,
      send: () => ({ ok: true, woke: true }),
    });
    assert.equal(calls, 1);
  });
});

describe('a knock that could not happen is not a flag that was lost', () => {
  it('leaves the notice undelivered when the channel throws, so the round carries it', async () => {
    const at = root();
    const said = [];
    await round({ root: at, report: board([['alpha', [conversation()]]]) });
    await round({
      root: at,
      report: board([['alpha', [conversation({ live: false, state: 'idle', turn: 'working' })]]]),
      send: () => { throw new Error('tmux is not on this machine'); },
      log: (message) => said.push(message),
    });
    assert.deepEqual(pendingNotices({ root: at }).map((n) => n.pattern), ['dead']);
    assert.ok(said.some((line) => /could not deliver .*tmux is not on this machine/u.test(line)));
  });
});

describe('a round says what it actually spent', () => {
  it('counts a read that failed as unread, not as read', async () => {
    const at = root();
    const outcome = await round({
      root: at,
      concurrency: 1,
      report: board([['alpha', [conversation({ id: 'a' })]], ['beta', [conversation({ id: 'b' })]]]),
      read: async (session) => (session.id === 'a'
        ? { patterns: [], failed: 'the model did not answer within 240s' }
        : { patterns: [], failed: null }),
    });
    assert.equal(outcome.read, 1);
    assert.equal(outcome.unreadable, 1);
  });
});
