/**
 * The runner holds the machine awake, and says exactly what it held.
 *
 * `pmset -g custom` on this laptop: `sleep 1` on battery, `sleep 0` on AC. A
 * runner that waits ten minutes between rounds — its normal behaviour — is the
 * precise case that one-minute idle sleep exists to end, so an unattended run
 * on battery stops without anyone deciding it should.
 *
 * Two things are asserted, and the second matters as much as the first.
 *
 * The assertion is tied to a PROCESS, not a clock: `caffeinate -w <pid>` exits
 * when the runner does, including when the runner is killed by a signal no
 * handler can see. A timed assertion is wrong at both ends — too short and the
 * run sleeps, too long and a laptop is held awake in somebody's bag.
 *
 * And it never overstates itself. `-s` is documented as valid only on AC
 * power, and no assertion at all suppresses a closed lid; a message that let
 * somebody believe otherwise would be discovered as an empty log the next
 * morning, which is the expensive way to learn it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AWAKE_FLAGS, awakeNote, keepAwake, onACPower } from '../../src/mc/stay-awake.js';

function fakeSpawn(calls, { pid = 4242 } = {}) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { pid, unref() { calls.push({ unref: true }); } };
  };
}

describe('mc run stays awake for as long as it runs', () => {
  it('asks caffeinate to watch the runner\'s pid, not a number of seconds', () => {
    const calls = [];
    const held = keepAwake({ pid: 777, platform: 'darwin', spawner: fakeSpawn(calls) });

    assert.equal(held.ok, true);
    assert.equal(held.pid, 4242);
    assert.equal(held.watching, 777);
    const [spawned] = calls;
    assert.equal(spawned.cmd, 'caffeinate');
    assert.deepEqual(spawned.args, ['-i', '-m', '-s', '-w', '777']);
    // No timeout anywhere in the argument list: `-t` is the shape this is
    // deliberately not.
    assert.ok(!spawned.args.includes('-t'), 'the assertion is tied to a pid, never to a clock');
  });

  it('does not keep the display lit — that costs battery and holds nothing', () => {
    const calls = [];
    keepAwake({ pid: 1, platform: 'darwin', spawner: fakeSpawn(calls) });
    assert.ok(!calls[0].args.includes('-d'), 'display sleep does not stop a process');
    assert.deepEqual(AWAKE_FLAGS, ['-i', '-m', '-s']);
  });

  it('is detached and unreferenced, so it outlives the round and holds nothing open', () => {
    const calls = [];
    keepAwake({ pid: 1, platform: 'darwin', spawner: fakeSpawn(calls) });
    assert.equal(calls[0].options.detached, true);
    assert.ok(calls.some((c) => c.unref), 'the child must not hold the runner open');
  });

  it('is a reported no-op off macOS rather than a crash', () => {
    const calls = [];
    const held = keepAwake({ pid: 1, platform: 'linux', spawner: fakeSpawn(calls) });
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'not-darwin');
    assert.equal(calls.length, 0);
  });

  it('a missing caffeinate is reported, never thrown — a run must still start', () => {
    const held = keepAwake({
      pid: 1,
      platform: 'darwin',
      spawner: () => { throw new Error('spawn caffeinate ENOENT'); },
    });
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'caffeinate-missing');
  });
});

describe('what it says is what it actually held', () => {
  it('always names the lid, because no assertion suppresses it', () => {
    for (const onAC of [true, false, null]) {
      assert.match(awakeNote({ onAC }), /closed lid still sleeps the machine/u);
    }
  });

  it('on battery it says that -s does nothing, instead of implying it worked', () => {
    assert.match(awakeNote({ onAC: false }), /-s does nothing/u);
    assert.match(awakeNote({ onAC: false }), /idle sleep is still held/u);
  });

  it('on AC it says system sleep is held too', () => {
    assert.match(awakeNote({ onAC: true }), /system sleep held too/u);
  });

  it('reads the power source, and says null rather than guessing', () => {
    assert.equal(onACPower({ runner: () => "Now drawing from 'AC Power'\n" }), true);
    assert.equal(onACPower({ runner: () => "Now drawing from 'Battery Power'\n" }), false);
    assert.equal(onACPower({ runner: () => 'something else entirely' }), null);
    assert.equal(onACPower({ runner: () => { throw new Error('no pmset'); } }), null);
  });
});
