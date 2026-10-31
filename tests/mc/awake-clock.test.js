/**
 * The awake clock (awake-clock.js): suspend is excluded, reboots keep the count
 * rising, wall-clock steps and short intervals never break session-control's
 * rules, and a clock that cannot be read refuses to exist.
 *
 * Every fake machine moves by hand — wall time, uptime (which does not run during
 * suspend), the boot session — so no test sleeps. Only the last test reads the
 * real clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAwakeClock, probeAwakeClock, readAwakeMs } from '../../src/mc/awake-clock.js';

/** A machine the test moves by hand. `stored` is what `load` returns: the state, or null. */
function machine({ wall = 1_000_000, uptime = 5_000, boot = 'boot-A', stored = null } = {}) {
  const m = { wall, uptime, boot, stored, saves: 0 };
  m.deps = {
    platform: 'darwin',
    read: () => m.uptime,
    bootSession: () => m.boot,
    now: () => m.wall,
    load: () => structuredClone(m.stored),
    save: (state) => { m.stored = structuredClone(state); m.saves++; },
  };
  return m;
}
const clockOn = (m, extra = {}) => createAwakeClock({ statePath: 'injected-not-used', ...m.deps, ...extra });

test('the first sample stores the boot session with base 0 and reports uptime as awake time', () => {
  const m = machine({ uptime: 5_000 });
  const sample = clockOn(m);
  assert.deepEqual(sample(), { at_ms: 1_000_000, awake_ms: 5_000 });
  assert.deepEqual(m.stored, { boot_session: 'boot-A', base_ms: 0, last_awake_ms: 5_000, last_at_ms: 1_000_000 });
});

test('suspend: an hour of wall time with no uptime is sleep, not awake time', () => {
  const m = machine({ uptime: 5_000 });
  const sample = clockOn(m);
  const before = sample();
  m.wall += 3_600_000; // the machine sleeps; uptime does not run
  const asleep = sample();
  assert.equal(asleep.awake_ms - before.awake_ms, 0);
  assert.equal(asleep.at_ms - before.at_ms - (asleep.awake_ms - before.awake_ms), 3_600_000, 'sleep equals the wall delta');

  m.wall += 60_000; m.uptime += 60_000; // a minute awake after waking
  const awake = sample();
  assert.equal(awake.awake_ms - asleep.awake_ms, 60_000);
  assert.equal(awake.at_ms - asleep.at_ms, awake.awake_ms - asleep.awake_ms, 'no sleep in the minute awake');
});

test('reboot: uptime starts again from zero, and awake time keeps rising', () => {
  const m = machine({ uptime: 5_000 });
  const sample = clockOn(m);
  const before = sample();
  m.boot = 'boot-B'; m.uptime = 2_000; m.wall += 60_000;
  const rebooted = sample();
  assert.equal(rebooted.awake_ms, 7_000, 'base is the last awake value, plus uptime since boot');
  assert.ok(rebooted.awake_ms > before.awake_ms);
  assert.equal(m.stored.base_ms, 5_000);

  m.uptime = 2_500; m.wall += 1_000;
  const later = sample();
  assert.equal(later.awake_ms, 7_500);
  assert.ok(later.awake_ms > rebooted.awake_ms);
});

test('a backward wall step holds at_ms and never moves awake_ms backwards or past wall time', () => {
  const m = machine({ uptime: 5_000 });
  const sample = clockOn(m);
  const before = sample();
  m.wall -= 10_000; m.uptime += 4_000;
  const stepped = sample();
  assert.equal(stepped.at_ms, before.at_ms, 'at_ms is held at the last value');
  assert.ok(stepped.awake_ms >= before.awake_ms, 'awake never moves backwards');
  assert.ok(stepped.awake_ms - before.awake_ms <= stepped.at_ms - before.at_ms, 'awake never exceeds wall');

  m.wall += 12_000; m.uptime += 1_000;
  const resumed = sample();
  assert.ok(resumed.at_ms > stepped.at_ms, 'wall time moves on once it passes the held value');
  assert.ok(resumed.awake_ms >= stepped.awake_ms);
  assert.ok(resumed.awake_ms - stepped.awake_ms <= resumed.at_ms - stepped.at_ms);
});

test('a short interval is capped at the wall time that passed', () => {
  const m = machine({ wall: 1_000, uptime: 5_000 });
  const sample = clockOn(m);
  sample();
  m.wall += 1; m.uptime += 3; // uptime advanced 3 ms while wall advanced 1 ms
  assert.deepEqual(sample(), { at_ms: 1_001, awake_ms: 5_001 });
});

test('clock readings are integers, each rounded once', () => {
  const m = machine({ wall: 1_000.4, uptime: 5_000.6 });
  assert.deepEqual(clockOn(m)(), { at_ms: 1_000, awake_ms: 5_001 });
});

test('two clock instances sharing one state file agree, including across a reboot', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'mc-awake-clock-')), 'awake-clock.json');
  const m = machine({ uptime: 5_000 });
  const a = clockOn(m, { statePath, load: undefined, save: undefined });
  const b = clockOn(m, { statePath, load: undefined, save: undefined });
  assert.deepEqual(a(), { at_ms: 1_000_000, awake_ms: 5_000 });

  m.uptime = 9_000; m.wall = 1_004_000;
  assert.deepEqual(b(), { at_ms: 1_004_000, awake_ms: 9_000 });

  m.boot = 'boot-B'; m.uptime = 1_000; m.wall = 1_010_000;
  assert.deepEqual(b(), { at_ms: 1_010_000, awake_ms: 10_000 });

  // a has taken no sample since the reboot and holds only its first state: it must read B's file.
  m.uptime = 2_000; m.wall = 1_011_000;
  assert.deepEqual(a(), { at_ms: 1_011_000, awake_ms: 11_000 });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).boot_session, 'boot-B');
});

test('the probe refuses off Darwin and when perl, sysctl or the output fail', () => {
  const good = { platform: 'darwin', read: () => 5_000, bootSession: () => 'boot-A' };
  assert.deepEqual(probeAwakeClock(good), { ok: true });
  assert.equal(probeAwakeClock({ ...good, platform: 'linux' }).ok, false);
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(probeAwakeClock({ ...good, read: () => bad }).ok, false, String(bad));
  }
  const noPerl = probeAwakeClock({ ...good, read: () => { throw new Error('perl: not found'); } });
  assert.equal(noPerl.ok, false);
  assert.match(noPerl.reason, /perl: not found/);
  const noSysctl = probeAwakeClock({ ...good, bootSession: () => { throw new Error('sysctl failed'); } });
  assert.equal(noSysctl.ok, false);
  assert.match(noSysctl.reason, /sysctl failed/);
  assert.equal(probeAwakeClock({ ...good, bootSession: () => '' }).ok, false);
});

test('createAwakeClock throws when the probe fails: there is no degraded mode', () => {
  const good = { platform: 'darwin', read: () => 5_000, bootSession: () => 'boot-A' };
  assert.throws(() => createAwakeClock({ statePath: 'x', ...good, platform: 'linux' }), /awake clock unavailable.*Darwin/);
  assert.throws(() => createAwakeClock({ statePath: 'x', ...good, read: () => NaN }), /awake clock unavailable/);
  assert.throws(() => createAwakeClock({ statePath: 'x', ...good, read: () => { throw new Error('perl gone'); } }), /perl gone/);
  assert.throws(() => createAwakeClock({ ...good }), /needs a statePath/);
});

test('unreadable or malformed stored state throws and is never reset', () => {
  const cases = [
    ['a string', 'stored'],
    ['an array', []],
    ['no last_at_ms', { boot_session: 'boot-A', base_ms: 0, last_awake_ms: 5_000 }],
    ['an empty boot session', { boot_session: '', base_ms: 0, last_awake_ms: 0, last_at_ms: 0 }],
    ['a negative base', { boot_session: 'boot-A', base_ms: -1, last_awake_ms: 0, last_at_ms: 0 }],
    ['awake below its base', { boot_session: 'boot-A', base_ms: 9_000, last_awake_ms: 5_000, last_at_ms: 0 }],
  ];
  for (const [label, stored] of cases) {
    const m = machine({ stored });
    assert.throws(() => clockOn(m)(), /corrupt/, label);
    assert.equal(m.saves, 0, `${label}: nothing written`);
    assert.deepEqual(m.stored, structuredClone(stored), `${label}: state untouched`);
  }
});

test('a state file that is not JSON throws and is left as it is', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'mc-awake-clock-')), 'awake-clock.json');
  writeFileSync(statePath, '{ not json');
  const sample = createAwakeClock({ statePath, platform: 'darwin', read: () => 5_000, bootSession: () => 'boot-A', now: () => 1_000_000 });
  assert.throws(() => sample(), /corrupt/);
  assert.equal(readFileSync(statePath, 'utf8'), '{ not json');
});

test('the real uptime read advances over a 50 ms wait', { skip: process.platform !== 'darwin' && 'the awake clock is Darwin only' }, async () => {
  const before = readAwakeMs();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const elapsed = readAwakeMs() - before;
  assert.ok(elapsed >= 45 && elapsed < 2_000, `elapsed ${elapsed} ms`);
});
