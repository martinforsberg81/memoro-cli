/**
 * `mc log` — the morning of 2026-08-30, answered by one command.
 *
 * Two merge rounds on memoro were killed from outside; the first had already
 * landed #11082 and had not reached #11085. Every fact was on disk and none of
 * it was joined: `leases.log` knew a pid was reaped, `gate-rounds.jsonl` knew
 * nothing at all (it is written when a round *ends*), and `mc.log` was not
 * written by the merge path. Understanding it took three files and a script
 * somebody threw away afterwards.
 *
 * The centre of this file is `the incident, replayed` at the bottom: the same
 * disk contents, and the verdict read off them by the machine.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { filterRuns, readLeaseLog, runsFrom, storyOf, abandoned } from '../../src/mc/log-read.js';
import { setLogPath } from '../../src/mc/logger.js';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-log-read-'));
  mkdirSync(join(root, 'repo-leases'), { recursive: true });
  mkdirSync(join(root, 'logs'), { recursive: true });
  return root;
}

function writeEvents(root, events) {
  writeFileSync(join(root, 'logs', 'mc.log'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  setLogPath(join(root, 'logs', 'mc.log'));
}

const DEAD = () => false;
const LIVE = () => true;

describe('an invocation is assembled from its two ends', () => {
  it('a start and an end become one run, with the verb from one and the outcome from the other', () => {
    const runs = runsFrom([
      { at: '2026-08-30T09:00:00Z', pid: 10, run: 'run_a', event: 'mc.start', verb: 'merge', sub: 'memoro', args: ['11082'], flags: ['--check'], holder: 'icon-assets' },
      { at: '2026-08-30T09:03:00Z', pid: 10, run: 'run_a', event: 'mc.end', exit_code: 0, duration_ms: 180_000, threw: false },
    ], { alive: DEAD });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].verb, 'merge');
    assert.deepEqual(runs[0].args, ['11082']);
    assert.equal(runs[0].holder, 'icon-assets');
    assert.equal(runs[0].outcome, 'ok');
    assert.equal(runs[0].duration_ms, 180_000);
  });

  it('a nonzero exit is failed; a throw is its own word', () => {
    const [failed] = runsFrom([
      { at: 'x', pid: 1, run: 'r1', event: 'mc.start', verb: 'repo' },
      { at: 'x', pid: 1, run: 'r1', event: 'mc.end', exit_code: 1, threw: false },
    ], { alive: DEAD });
    assert.equal(failed.outcome, 'failed');

    const [threw] = runsFrom([
      { at: 'x', pid: 2, run: 'r2', event: 'mc.start', verb: 'plan' },
      { at: 'x', pid: 2, run: 'r2', event: 'mc.end', exit_code: 1, threw: true, error: 'boom' },
    ], { alive: DEAD });
    assert.equal(threw.outcome, 'threw');
    assert.equal(threw.error, 'boom');
  });

  it('a start with no end is died or running — decided by the pid, never by a clock', () => {
    const events = [{ at: 'x', pid: 4321, run: 'r3', event: 'mc.start', verb: 'merge' }];
    assert.equal(runsFrom(events, { alive: DEAD })[0].outcome, 'died');
    // A gate round is *supposed* to take half an hour. Elapsed time can never
    // separate a slow round from a dead one, which is why nothing here reads
    // the clock.
    assert.equal(runsFrom(events, { alive: LIVE })[0].outcome, 'running');
  });

  it('keeps the round\'s narration, which on a dead round is the only account of it', () => {
    const [run] = runsFrom([
      { at: 'x', pid: 1, run: 'r', event: 'mc.start', verb: 'merge' },
      { at: 'x', pid: 1, run: 'r', event: 'merge.say', text: 'lease taken by icon-assets for the whole round' },
      { at: 'x', pid: 1, run: 'r', event: 'gate.say', text: 'candidate: 66 red, 0 of them new' },
    ], { alive: DEAD });
    assert.equal(run.outcome, 'died');
    assert.deepEqual(run.said.map((s) => s.text), [
      'lease taken by icon-assets for the whole round',
      'candidate: 66 red, 0 of them new',
    ]);
  });
});

describe('narrowing keeps the name of the thing that failed', () => {
  const runs = () => runsFrom([
    { at: '2026-08-30T09:00:00Z', pid: 1, run: 'a', event: 'mc.start', verb: 'merge', args: ['memoro', '11082'] },
    { at: '2026-08-30T09:01:00Z', pid: 1, run: 'a', event: 'mc.end', exit_code: 1 },
    { at: '2026-08-30T10:00:00Z', pid: 2, run: 'b', event: 'mc.start', verb: 'brief', args: [] },
    { at: '2026-08-30T10:01:00Z', pid: 2, run: 'b', event: 'mc.end', exit_code: 0 },
  ], { alive: DEAD });

  it('--failures keeps the verb, because it filters runs and not events', () => {
    const failed = filterRuns(runs(), { failures: true });
    assert.equal(failed.length, 1);
    // The bug this asserts against: an event-level filter keeps the `mc.end`
    // line, which carries the exit code and not the verb, and prints a column
    // of nameless failures.
    assert.equal(failed[0].verb, 'merge');
    assert.deepEqual(failed[0].args, ['memoro', '11082']);
  });

  it('--repo, --verb and --since each narrow without losing the assembly', () => {
    assert.equal(filterRuns(runs(), { repo: 'memoro' }).length, 1);
    assert.equal(filterRuns(runs(), { verb: 'brief' })[0].run, 'b');
    assert.equal(filterRuns(runs(), { since: '2026-08-30T09:30:00Z' }).length, 1);
  });

  it('excludes the reading invocation, which is always the one still running', () => {
    assert.deepEqual(filterRuns(runs(), { exclude: 'b' }).map((r) => r.run), ['a']);
  });
});

describe('the lease log is parsed leniently — it is a courtesy other eyes read', () => {
  it('reads claim, release and reap with their pids and errands', () => {
    const root = home();
    try {
      writeFileSync(join(root, 'repo-leases', 'leases.log'), [
        '2026-08-30T09:48:22.097Z  claim    /Users/m/memoro  holder=icon-assets  errand="merge round for #11082 #11085"  pid=175',
        '2026-08-30T10:01:45.193Z  reap     /Users/m/memoro  by=icon-assets  was=icon-assets  pid=175 gone  after=803s  errand="merge round for #11082 #11085"',
        'this line is not a lease record at all',
        '',
      ].join('\n'));
      const entries = readLeaseLog({ root });
      assert.equal(entries.length, 2, 'a line it does not recognise is skipped, not thrown on');
      assert.equal(entries[0].verb, 'claim');
      assert.equal(entries[0].pid, 175);
      assert.equal(entries[0].holder, 'icon-assets');
      assert.equal(entries[0].errand, 'merge round for #11082 #11085');
      assert.equal(entries[1].verb, 'reap');
      assert.equal(entries[1].gone, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an absent lease log is an empty answer, not a failure', () => {
    const root = home();
    try { assert.deepEqual(readLeaseLog({ root }), []); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/**
 * The morning itself.
 *
 * The disk contents are the real ones: the lease log lines are copied from
 * `~/.memoro/mc/repo-leases/leases.log`, and the round-start line is what step
 * 1 would have written at 09:48. The assertion is that the machine now reaches
 * the conclusion that cost a person three files and a script.
 */
describe('the incident, replayed', () => {
  const setUp = (root) => {
    writeFileSync(join(root, 'repo-leases', 'leases.log'), [
      '2026-08-30T09:48:22.097Z  claim    /Users/m/memoro  holder=icon-assets  errand="merge round for #11082 #11085"  pid=175',
      '2026-08-30T10:01:45.193Z  reap     /Users/m/memoro  by=icon-assets  was=icon-assets  pid=175 gone  after=803s  errand="merge round for #11082 #11085"',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'gate-rounds.jsonl'), `${JSON.stringify({
      schema: 'mc-gate-round', version: 1, phase: 'start', at: '2026-08-30T09:48:22.097Z',
      repo: 'memoro', mode: 'merge', prs: [11082, 11085], holder: 'icon-assets', pid: 175, run: 'run_incident',
    })}\n`);
  };

  it('names the round that died, the pull requests it was carrying, and its reaped lease', () => {
    const root = home();
    try {
      setUp(root);
      const [round] = abandoned({ root, alive: DEAD });
      assert.equal(round.verdict, 'died');
      assert.equal(round.repo, 'memoro');
      assert.deepEqual(round.prs, [11082, 11085]);
      assert.equal(round.pid, 175);
      assert.equal(round.reaped, true, 'its lease was taken back, so nothing is still held');
      assert.deepEqual(round.lease.map((l) => l.verb), ['claim', 'reap']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a died round whose lease was never reaped says so — that one is still held', () => {
    const root = home();
    try {
      setUp(root);
      // The same round, with the reap line removed: the state between the kill
      // and the next round noticing. This is the case where somebody has to
      // decide, and the difference must be visible.
      writeFileSync(join(root, 'repo-leases', 'leases.log'),
        '2026-08-30T09:48:22.097Z  claim    /Users/m/memoro  holder=icon-assets  errand="merge round for #11082 #11085"  pid=175\n');
      const [round] = abandoned({ root, alive: DEAD });
      assert.equal(round.verdict, 'died');
      assert.equal(round.reaped, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the same round, still running, is never called dead', () => {
    const root = home();
    try {
      setUp(root);
      assert.equal(abandoned({ root, alive: LIVE })[0].verdict, 'running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('one run id gathers the invocation, its rounds and the leases it touched', () => {
    const root = home();
    try {
      setUp(root);
      writeEvents(root, [
        { at: '2026-08-30T09:48:22.000Z', pid: 175, run: 'run_incident', event: 'mc.start', verb: 'merge', sub: 'memoro', args: ['11082', '11085'], holder: 'icon-assets' },
        { at: '2026-08-30T09:48:30.000Z', pid: 175, run: 'run_incident', event: 'merge.say', text: 'lease taken by icon-assets for the whole round' },
        { at: '2026-08-30T09:59:00.000Z', pid: 175, run: 'run_incident', event: 'merge.say', text: 'merged #11082' },
      ]);
      const story = storyOf('run_incident', { root, alive: DEAD });
      assert.equal(story.invocation.outcome, 'died');
      assert.equal(story.rounds.length, 1);
      assert.equal(story.leases.length, 2, 'joined on the pid — the lease log has no run id');
      // The sentence that mattered: it had already merged one of them.
      assert.ok(story.invocation.said.some((s) => s.text === 'merged #11082'));
    } finally { setLogPath(null); rmSync(root, { recursive: true, force: true }); }
  });
});
