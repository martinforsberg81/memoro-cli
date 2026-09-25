/**
 * `streamSession` is the real `deps.session`: claude on stream-json, the
 * prompt as the first message on stdin, a check-in written every interval,
 * stdin closed on the `result` line, and a kill only after the stall interval
 * went by without a byte on stdout (ruling 18 — nothing is killed for how long
 * it has run), or the result grace after the `result` line. Driven here by a fake child and fake timers, so three hours
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
    onQuiet: (minutes, tasks) => `quiet ${minutes} ${tasks.map((t) => t.task_id).join(',')}`,
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
/** The result as claude 2.1 writes it: `type` after the usage, far past the line's head. */
const RESULT_LATE = JSON.stringify({ duration_api_ms: 1, stop_reason: 'end_turn', usage: { padding: 'x'.repeat(2000) }, type: 'result', subtype: 'success' });
const tasksChanged = (...ids) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: `run ${task_id}` })) });

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

  it('kills a child that hangs after its result once the grace is up, and the result stands', async () => {
    const { child, session } = start({ resultGraceMs: 10 });
    child.say(RESULT);
    mock.timers.tick(9);
    assert.deepEqual(child.killed, [], 'the grace is not up yet');
    mock.timers.tick(1);
    assert.deepEqual(child.killed, ['SIGTERM']);
    const result = await session;
    assert.equal(result.status, 0);
    assert.equal(result.stalled, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.lingered, true);
    assert.match(result.stdout, /"type":"result"/u);
  });

  it('arms the grace with no stall guard set, and chunks after the result do not extend it', async () => {
    const { child, session } = start({ resultGraceMs: 10, stallMs: 0 });
    child.say(RESULT);
    mock.timers.tick(6);
    child.say(JSON.stringify({ type: 'assistant', message: { content: [] } }));
    mock.timers.tick(4);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal((await session).lingered, true);
  });

  it('does not kill a child that exits inside the grace, and leaves no timer behind', async () => {
    const { child, session } = start({ resultGraceMs: 10 });
    child.say(RESULT);
    child.emit('close', 0, null);
    const result = await session;
    assert.equal(result.lingered, false);
    mock.timers.tick(1000);
    assert.deepEqual(child.killed, []);
  });

  it('still stalls a child that never writes a result, with 142', async () => {
    const { child, session } = start({ resultGraceMs: 10 });
    run(child, 20);
    assert.deepEqual(child.killed, ['SIGTERM']);
    const result = await session;
    assert.equal(result.status, 142);
    assert.equal(result.stalled, true);
    assert.equal(result.lingered, false);
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

  it('finds a result whose type comes after two thousand characters of usage', () => {
    const { child } = start();
    child.say(RESULT_LATE);
    assert.equal(child.stdin.ended, true);
  });

  it('keeps stdin open on a result while a background task runs, and ends it on the next', () => {
    const { child, texts } = start();
    child.say(tasksChanged('b1'));
    child.say(RESULT_LATE);
    assert.equal(child.stdin.ended, false, 'claude starts the next turn itself when the task finishes');
    child.say(tasksChanged());
    child.say(RESULT_LATE);
    assert.equal(child.stdin.ended, true);
    assert.deepEqual(texts(), ['do the step']);
  });

  it('asks a session silent over a background task instead of killing it, and kills it if no answer comes', async () => {
    const { child, session, texts } = start();
    child.say(tasksChanged('b4swqbpox'));
    child.say(RESULT_LATE);
    run(child, 20);
    assert.deepEqual(child.killed, []);
    assert.equal(texts().at(-1), 'quiet 20 b4swqbpox');
    child.say(JSON.stringify({ type: 'assistant', message: { content: [] } }));
    run(child, 20);
    assert.deepEqual(child.killed, [], 'an answer earns the next silence its own question');
    assert.equal(texts().filter((t) => t.startsWith('quiet')).length, 2);
    run(child, 20);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal((await session).stalled, true);
  });

  it('still kills a silent session with no background task', () => {
    const { child, texts } = start();
    child.say(tasksChanged('b1'));
    child.say(tasksChanged());
    run(child, 20);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal(texts().some((t) => t.startsWith('quiet')), false);
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
