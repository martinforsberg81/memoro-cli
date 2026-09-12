/**
 * `streamSession` is the real `deps.session`: claude on stream-json, the
 * prompt as the first message on stdin, a check-in written every interval,
 * stdin closed on the `result` line, and a kill only after the stall interval
 * went by without a byte on stdout (ruling 18 — nothing is killed for how long
 * it has run). Driven here by a fake child and fake timers, so three hours
 * take no time at all.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { streamSession } from '../../src/mc/run.js';

const MINUTE = 60_000;

/** A child with the three streams spawn hands back, and a kill that closes it. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = [];
  child.written = [];
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    ended: false,
    write(text) { child.written.push(JSON.parse(text)); return true; },
    end() { this.writable = false; this.ended = true; },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.say = (line) => child.stdout.emit('data', Buffer.from(`${line}\n`));
  child.kill = (signal) => { child.killed.push(signal); child.emit('close', null, signal); };
  return child;
}

function start(options = {}) {
  const child = fakeChild();
  const spawned = [];
  const checkIns = [];
  const session = streamSession({
    bin: '/bin/claude', args: ['-p'], cwd: '/w', env: {},
    prompt: 'do the step', checkInMs: 60 * MINUTE, stallMs: 20 * MINUTE,
    checkIn: (minutes, count) => { checkIns.push([minutes, count]); return `check-in ${count} at ${minutes}`; },
    spawn: (...call) => { spawned.push(call); return child; },
    ...options,
  });
  return { child, session, spawned, checkIns, texts: () => child.written.map((m) => m.message.content) };
}

/** Minutes of fake time, with the child saying something every `every` of them. */
function run(child, minutes, every = null) {
  for (let m = 1; m <= minutes; m += 1) {
    mock.timers.tick(MINUTE);
    if (every && m % every === 0) child.say(JSON.stringify({ type: 'assistant', message: { content: [] } }));
  }
}

const RESULT = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, session_id: 'sid' });

describe('streamSession', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 }));
  afterEach(() => mock.timers.reset());

  it('writes the prompt first, as a user message, on a piped stdin', () => {
    const { spawned, child, texts } = start();
    assert.deepEqual(spawned[0][2].stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(child.written[0], { type: 'user', message: { role: 'user', content: 'do the step' } });
    assert.deepEqual(texts(), ['do the step']);
  });

  it('checks in at the interval with the elapsed minutes and the count, and again at twice it', () => {
    const { child, checkIns, texts } = start();
    run(child, 59, 5);
    assert.deepEqual(checkIns, []);
    run(child, 1);
    assert.deepEqual(checkIns, [[60, 1]]);
    assert.deepEqual(texts(), ['do the step', 'check-in 1 at 60']);
    run(child, 60, 5);
    assert.deepEqual(checkIns, [[60, 1], [120, 2]]);
    assert.equal(texts().at(-1), 'check-in 2 at 120');
  });

  it('ends stdin on the result line, and writes no check-in due after it', async () => {
    const { child, session, checkIns, texts } = start();
    run(child, 30, 5);
    child.stdout.emit('data', Buffer.from(RESULT.slice(0, 20)));
    assert.equal(child.stdin.ended, false, 'half a line is not a result yet');
    child.stdout.emit('data', Buffer.from(`${RESULT.slice(20)}\n`));
    assert.equal(child.stdin.ended, true);
    run(child, 45, 5);
    assert.deepEqual(checkIns, [], 'the check-in due at 60 minutes was not written');
    assert.deepEqual(texts(), ['do the step']);
    child.emit('close', 0, null);
    const result = await session;
    assert.equal(result.status, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stalled, false);
    assert.match(result.stdout, /"type":"result"/u);
  });

  it('kills a child silent for the stall interval and reports it timed out', async () => {
    const { child, session } = start();
    run(child, 10, 1);
    run(child, 19);
    assert.deepEqual(child.killed, [], 'nineteen silent minutes are not a stall');
    run(child, 1);
    assert.deepEqual(child.killed, ['SIGTERM']);
    const result = await session;
    assert.equal(result.status, 142);
    assert.equal(result.timedOut, true);
    assert.equal(result.stalled, true);
  });

  it('still kills a child that hangs silent after its result', async () => {
    const { child, session } = start();
    child.say(RESULT);
    run(child, 20);
    assert.deepEqual(child.killed, ['SIGTERM'], 'the stall guard outlives the result');
    assert.equal((await session).stalled, true);
  });

  it('never kills a child that says something every minute, three hours long', async () => {
    const { child, session, checkIns } = start();
    run(child, 180, 1);
    assert.deepEqual(child.killed, []);
    assert.deepEqual(checkIns.map(([, count]) => count), [1, 2, 3]);
    child.say(RESULT);
    child.emit('close', 0, null);
    const result = await session;
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 0);
  });

  it('leaves no timer behind once the child has closed', async () => {
    const { child, session, checkIns } = start();
    child.emit('close', 1, null);
    await session;
    run(child, 120);
    assert.deepEqual(child.killed, []);
    assert.deepEqual(checkIns, []);
  });

  it('with no prompt, stdin is not piped and nothing is written', async () => {
    const { spawned, child, session } = start({ prompt: null, checkInMs: 0, stallMs: 0 });
    assert.equal(spawned[0][2].stdio[0], 'ignore');
    assert.deepEqual(child.written, []);
    run(child, 300);
    assert.deepEqual(child.killed, [], 'no stall guard asked for, none armed');
    child.emit('close', 0, null);
    assert.equal((await session).status, 0);
  });
});
