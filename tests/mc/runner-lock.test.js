import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { holderPath, lockPath, realLock } from '../../src/mc/runner-lock.js';

function layout2Root() {
  const root = mkdtempSync(join(tmpdir(), 'mc-runner-lock-'));
  mkdirSync(join(root, 'runner'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A clock that only moves when the test says so: no real waits, no real time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

/** The logger, injected: every event the lock writes is kept here. */
function recorder() {
  const lines = [];
  return { lines, log: (event, fields) => lines.push({ event, fields }) };
}

test('realLock holds runner/register.lock in layout 2 and runner/projects/.lock in layout 1, and removes it after', () => {
  const { root, cleanup } = layout2Root();
  try {
    const two = join(root, 'runner', 'register.lock');
    assert.equal(lockPath(root), two);
    assert.equal(realLock(root, () => existsSync(two)), true, 'held while fn runs');
    assert.equal(existsSync(two), false, 'removed after');
    assert.equal(existsSync(join(root, 'runner', 'projects')), false, 'layout 2 makes no directory of its own');
    rmSync(join(root, 'runner'), { recursive: true });
    const one = join(root, 'runner', 'projects', '.lock');
    assert.equal(realLock(root, () => existsSync(one)), true, 'layout 1: the old file, so old and new code exclude each other');
    assert.equal(existsSync(one), false);
  } finally { cleanup(); }
});

test('realLock takes over a lock a dead pid left, and strict refuses one a live pid holds past the wait', () => {
  const { root, cleanup } = layout2Root();
  try {
    const path = lockPath(root);
    writeFileSync(path, '999999');
    assert.equal(realLock(root, () => 'ran', { alive: () => false }), 'ran');
    writeFileSync(path, String(process.pid + 1));
    assert.throws(() => realLock(root, () => 'ran', { alive: () => true, waitMs: 0, strict: true }), /held by pid/u);
    assert.equal(realLock(root, () => 'ran anyway', { alive: () => true, waitMs: 0, log: () => {} }), 'ran anyway', 'not strict: the write goes ahead');
  } finally { cleanup(); }
});

test('a hold over 1 s logs one held line with the caller and its ms; a short hold logs nothing', () => {
  const { root, cleanup } = layout2Root();
  try {
    const clock = fakeClock();
    const rec = recorder();
    realLock(root, () => clock.tick(1500), { name: 'merges', now: clock.now, log: rec.log });
    assert.deepEqual(rec.lines, [{ event: 'runner-lock-held', fields: { name: 'merges', pid: process.pid, held_ms: 1500 } }]);
    rec.lines.length = 0;
    realLock(root, () => clock.tick(200), { name: 'merges', now: clock.now, log: rec.log });
    assert.deepEqual(rec.lines, [], 'a short hold is not logged');
    assert.equal(existsSync(holderPath(lockPath(root))), false, 'the holder record is removed with the lock');
  } finally { cleanup(); }
});

test('the lock file stays the bare pid while held, so an older reader that Number()s it still reads the holder', () => {
  const { root, cleanup } = layout2Root();
  try {
    const path = lockPath(root);
    realLock(root, () => {
      const text = readFileSync(path, 'utf8');
      assert.equal(text, String(process.pid), 'one line, the pid, exactly as before');
      assert.equal(Number(text), process.pid);
      assert.equal(Number(text.split('\n')[0]), process.pid);
    }, { name: 'tidy-pressure', log: () => {} });
  } finally { cleanup(); }
});

test('a non-strict caller that proceeds past a live holder logs one unlocked line naming both pids and the holder', () => {
  const { root, cleanup } = layout2Root();
  try {
    const path = lockPath(root);
    const clock = fakeClock();
    const rec = recorder();
    const holder = process.pid + 1;
    writeFileSync(path, String(holder));
    writeFileSync(holderPath(path), JSON.stringify({ pid: holder, name: 'tidy-pressure' }));
    const ran = realLock(root, () => 'ran anyway', {
      alive: () => { clock.tick(10); return true; }, waitMs: 0, name: 'merges', now: clock.now, log: rec.log,
    });
    assert.equal(ran, 'ran anyway', 'fn runs without the lock');
    assert.deepEqual(rec.lines, [{
      event: 'runner-lock-unlocked',
      fields: { name: 'merges', pid: process.pid, holder_pid: holder, holder_name: 'tidy-pressure', waited_ms: 10 },
    }]);
    assert.equal(readFileSync(path, 'utf8'), String(holder), 'the holder\'s lock is left as it was');
  } finally { cleanup(); }
});

test('a holder record that names another pid is not the holder: the unlocked line says the name is unknown', () => {
  const { root, cleanup } = layout2Root();
  try {
    const path = lockPath(root);
    const clock = fakeClock();
    const rec = recorder();
    writeFileSync(path, String(process.pid + 1));
    writeFileSync(holderPath(path), JSON.stringify({ pid: process.pid + 7, name: 'stale' }));
    realLock(root, () => 'ran anyway', { alive: () => { clock.tick(10); return true; }, waitMs: 0, now: clock.now, log: rec.log });
    assert.equal(rec.lines[0].fields.holder_name, null);
    assert.equal(rec.lines[0].fields.holder_pid, process.pid + 1);
  } finally { cleanup(); }
});

test('strict refuses past a live holder with no unlocked line: nothing runs and nothing is logged as written without the lock', () => {
  const { root, cleanup } = layout2Root();
  try {
    const clock = fakeClock();
    const rec = recorder();
    writeFileSync(lockPath(root), String(process.pid + 1));
    let ran = false;
    assert.throws(() => realLock(root, () => { ran = true; }, {
      alive: () => { clock.tick(10); return true; }, waitMs: 0, strict: true, name: 'goal-allocate', now: clock.now, log: rec.log,
    }), /held by pid/u);
    assert.equal(ran, false);
    assert.deepEqual(rec.lines, []);
  } finally { cleanup(); }
});
