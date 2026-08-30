/**
 * memoro-cli's production is this machine, and until now nothing read it.
 *
 * The memoro half of the helper reads five remote sources. memoro-cli has no
 * server, and for a week that was taken to mean it had nothing to collect —
 * so every failure in mc itself was found by a person noticing it. On
 * 2026-08-30 sixteen gate rounds stopped on a held lease in one day and that
 * was a feeling rather than a number.
 *
 * What is asserted here is the thing that makes the count trustworthy: a
 * fingerprint is a *signature*, not a line. Two rounds that both stopped on
 * `lease` must be one fingerprint seen twice, or the digest can never say
 * "sixteen" and the delta against yesterday means nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cliFailing, cliRows, fingerprintOf, signature, RUNNER_SILENT_HOURS } from '../../src/mc/helper-cli-collect.js';
import { setLogPath } from '../../src/mc/logger.js';

const NOW = new Date('2026-08-30T12:00:00Z');
const SINCE = new Date('2026-08-29T12:00:00Z');

function ground() {
  const root = mkdtempSync(join(tmpdir(), 'mc-cli-collect-'));
  mkdirSync(join(root, 'repo-leases'), { recursive: true });
  mkdirSync(join(root, 'logs'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'mc-cli-work-'));
  mkdirSync(join(work, 'runner', 'log'), { recursive: true });
  setLogPath(join(root, 'logs', 'mc.log'));
  return { root, work, cleanup: () => { setLogPath(null); rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); } };
}

const events = (g, lines) => writeFileSync(join(g.root, 'logs', 'mc.log'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
const rounds = (g, lines) => writeFileSync(join(g.root, 'gate-rounds.jsonl'), `${lines.map((l) => JSON.stringify({ schema: 'mc-gate-round', version: 1, ...l })).join('\n')}\n`);
const leases = (g, lines) => writeFileSync(join(g.root, 'repo-leases', 'leases.log'), `${lines.join('\n')}\n`);
const runs = (g, rows) => writeFileSync(join(g.work, 'runner', 'log', 'runs.tsv'),
  `ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n${rows.join('\n')}\n`);

const collect = (g) => cliRows({ root: g.root, work: g.work, since: SINCE, now: NOW });

describe('a fingerprint is a signature, not a line', () => {
  it('two rounds that stopped the same way are one fingerprint seen twice', () => {
    const g = ground();
    try {
      rounds(g, [
        { phase: 'end', at: '2026-08-30T09:00:00Z', repo: 'memoro', prs: [11082], stopped_at: 'lease', reason: 'held by icon-assets' },
        { phase: 'end', at: '2026-08-30T10:00:00Z', repo: 'memoro', prs: [11137], stopped_at: 'lease', reason: 'held by week-focus' },
      ]);
      const out = collect(g);
      assert.equal(out.rows.length, 1, 'the pull request numbers and the holder are not part of the signature');
      assert.equal(out.rows[0].count, 2);
      assert.equal(out.rows[0].lastSeen, '2026-08-30T10:00:00Z');
    } finally { g.cleanup(); }
  });

  it('numbers and hashes are stripped, so a defect does not look like N defects', () => {
    assert.equal(signature('x', 'merged #11082 as 7dcbf96'), signature('x', 'merged #11137 as a1b2c3d'));
    assert.notEqual(signature('x', 'stopped at lease'), signature('x', 'stopped at drift'));
    // Stable across days: the delta against yesterday depends on it.
    assert.equal(fingerprintOf(signature('round stopped', 'memoro at lease')),
      fingerprintOf(signature('round stopped', 'memoro at lease')));
  });

  it('a different stop is a different fingerprint', () => {
    const g = ground();
    try {
      rounds(g, [
        { phase: 'end', at: '2026-08-30T09:00:00Z', repo: 'memoro', stopped_at: 'lease' },
        { phase: 'end', at: '2026-08-30T09:30:00Z', repo: 'memoro', stopped_at: 'drift' },
      ]);
      assert.equal(collect(g).rows.length, 2);
    } finally { g.cleanup(); }
  });
});

describe('the four sources', () => {
  it('counts invocations that threw, invocations that exited nonzero, and rounds killed by a signal', () => {
    const g = ground();
    try {
      events(g, [
        { at: '2026-08-30T09:00:00Z', run: 'a', event: 'mc.end', verb: 'merge', exit_code: 1, threw: false },
        { at: '2026-08-30T09:05:00Z', run: 'b', event: 'mc.end', verb: 'merge', exit_code: 1, threw: false },
        { at: '2026-08-30T09:10:00Z', run: 'c', event: 'mc.end', verb: 'plan', exit_code: 1, threw: true, error: 'boom' },
        { at: '2026-08-30T09:20:00Z', run: 'd', event: 'gate.killed', repo: 'memoro', signal: 'SIGTERM' },
        { at: '2026-08-30T09:30:00Z', run: 'e', event: 'mc.end', verb: 'brief', exit_code: 0, threw: false },
      ]);
      const out = collect(g);
      const by = Object.fromEntries(out.rows.map((r) => [r.message, r.count]));
      assert.equal(by['mc failed: merge exited N'], 2);
      assert.ok('mc threw: plan — boom' in by);
      assert.ok('round killed: memoro by SIGTERM' in by);
      assert.equal(out.rows.some((r) => /brief/u.test(r.message)), false, 'a clean exit is not a finding');
    } finally { g.cleanup(); }
  });

  it('counts reaped leases — a holder that went away without giving it back', () => {
    const g = ground();
    try {
      leases(g, [
        '2026-08-30T09:00:00Z  claim    /Users/m/memoro  holder=icon-assets  errand="merge round"  pid=175',
        '2026-08-30T10:01:45.193Z  reap     /Users/m/memoro  by=icon-assets  was=icon-assets  pid=175 gone  after=803s  errand="merge round"',
      ]);
      const out = collect(g);
      assert.equal(out.reaps.length, 1);
      assert.ok(out.rows.some((r) => /lease reaped/u.test(r.message)));
      assert.equal(out.rows.some((r) => /claim/u.test(r.message)), false, 'an ordinary claim is not a finding');
    } finally { g.cleanup(); }
  });

  it('counts runner steps that did not succeed, and always names the exit code', () => {
    const g = ground();
    try {
      runs(g, [
        '2026-08-30T09:00:00Z\talpha\tstep\t0\t100\t7\t3\t-\t-\t-\t-\t-\tsuccess,merged',
        '2026-08-30T09:30:00Z\tbeta\tstep\t1\t100\t-\t3\t-\t-\t-\t-\t-\tno-json',
        // The row that made this rule: the session said success and the
        // process exited 1. Rendering only the note hides it completely.
        '2026-08-30T10:00:00Z\tgamma\tstep\t1\t100\t-\t3\t-\t-\t-\t-\t-\tsuccess',
      ]);
      const out = collect(g);
      const messages = out.rows.map((r) => r.message);
      assert.equal(messages.some((m) => /alpha/u.test(m)), false, 'a merged step is not a finding');
      assert.ok(messages.some((m) => /beta.*no-json.*exit N/u.test(m)));
      assert.ok(messages.some((m) => /gamma.*success.*exit N/u.test(m)), 'success with a nonzero exit must be visible');
    } finally { g.cleanup(); }
  });

  it('a source that will not read is a note, never an empty digest', () => {
    const g = ground();
    try {
      // No runs.tsv at all; the other three still answer.
      rounds(g, [{ phase: 'end', at: '2026-08-30T09:00:00Z', repo: 'memoro', stopped_at: 'lease' }]);
      const out = collect(g);
      assert.equal(out.rows.length, 1, 'the readable sources still counted');
      assert.equal(out.notes.length, 1);
      assert.match(out.notes[0], /^runs\.tsv:/u);
    } finally { g.cleanup(); }
  });

  it('nothing outside the window is counted', () => {
    const g = ground();
    try {
      rounds(g, [
        { phase: 'end', at: '2026-08-27T09:00:00Z', repo: 'memoro', stopped_at: 'lease' },
        { phase: 'end', at: '2026-08-30T09:00:00Z', repo: 'memoro', stopped_at: 'drift' },
      ]);
      const out = collect(g);
      assert.deepEqual(out.rows.map((r) => r.message), ['round stopped: memoro at drift']);
    } finally { g.cleanup(); }
  });
});

describe('conditions failing now, not counts of things that went wrong', () => {
  it('a round that died with its lease never reaped is the one that blocks the next round', () => {
    const g = ground();
    try {
      rounds(g, [{ phase: 'start', at: '2026-08-30T09:48:22Z', repo: 'memoro', prs: [11082, 11085], pid: 999_999, run: 'r' }]);
      const out = cliRows({ root: g.root, work: g.work, since: SINCE, now: NOW });
      assert.equal(out.open.length, 1);
      assert.equal(out.open[0].verdict, 'died');
      const failing = cliFailing({ open: out.open.map((r) => ({ ...r, reaped: false })), lastRun: '2026-08-30T11:00:00Z', now: NOW });
      assert.ok(failing.includes('gate-round-lease-held (1)'));
      assert.ok(failing.includes('gate-round-died (1)'));
    } finally { g.cleanup(); }
  });

  it('a died round whose lease was taken back is reported, but not as still held', () => {
    const failing = cliFailing({
      open: [{ verdict: 'died', reaped: true }], lastRun: '2026-08-30T11:00:00Z', now: NOW,
    });
    assert.ok(failing.includes('gate-round-died (1)'));
    assert.equal(failing.some((f) => f.startsWith('gate-round-lease-held')), false);
  });

  it('a runner that has been silent too long is itself a failing condition', () => {
    const quiet = new Date(NOW.getTime() - (RUNNER_SILENT_HOURS + 1) * 3_600_000).toISOString();
    assert.ok(cliFailing({ lastRun: quiet, now: NOW }).some((f) => /^runner-silent-/u.test(f)));
    assert.equal(cliFailing({ lastRun: '2026-08-30T11:30:00Z', now: NOW }).length, 0);
  });

  it('an unreadable runner log is said, not treated as a quiet day', () => {
    assert.deepEqual(cliFailing({ lastRun: null, now: NOW }), ['runner-log-unreadable']);
  });
});
