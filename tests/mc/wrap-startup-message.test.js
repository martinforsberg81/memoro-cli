import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createStartupMessageController } from '../../src/mc/wrap-startup-message.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const cleared = [];

  return {
    cleared,
    ids: () => [...pending.keys()],
    delayFor: (id) => pending.get(id)?.delay,
    fire: (id) => {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.fn();
      return true;
    },
    setTimeoutFn: (fn, delay) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeoutFn: (id) => {
      cleared.push(id);
      pending.delete(id);
    },
  };
}

describe('createStartupMessageController', () => {
  test('no-ops when message is null or empty', () => {
    for (const message of [null, '']) {
      const timers = fakeTimers();
      const delivered = [];
      const controller = createStartupMessageController({
        message,
        delayMs: 10,
        deliver: (msg) => delivered.push(msg),
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      });

      assert.equal(controller.schedule(), false);
      assert.equal(controller.sendNow(), false);
      controller.cancel();
      assert.deepEqual(delivered, []);
      assert.deepEqual(timers.ids(), []);
      assert.deepEqual(timers.cleared, []);
    }
  });

  test('scheduling after output eventually delivers exactly once', () => {
    const timers = fakeTimers();
    const delivered = [];
    const controller = createStartupMessageController({
      message: 'create MEMORO',
      delayMs: 25,
      deliver: (msg) => delivered.push(msg),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    assert.equal(controller.schedule(), true);
    const [timerId] = timers.ids();
    assert.equal(timers.delayFor(timerId), 25);

    assert.equal(timers.fire(timerId), true);
    assert.deepEqual(delivered, ['create MEMORO']);
    assert.equal(timers.fire(timerId), false);
    assert.equal(controller.sendNow(), false);
    assert.deepEqual(delivered, ['create MEMORO']);
  });

  test('repeated schedules reset the pending timer', () => {
    const timers = fakeTimers();
    const delivered = [];
    const controller = createStartupMessageController({
      message: 'create MEMORO',
      delayMs: 25,
      deliver: (msg) => delivered.push(msg),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    assert.equal(controller.schedule(), true);
    const firstId = timers.ids()[0];
    assert.equal(controller.schedule(), true);
    const secondId = timers.ids()[0];

    assert.deepEqual(timers.cleared, [firstId]);
    assert.notEqual(secondId, firstId);
    assert.equal(timers.fire(firstId), false);
    assert.deepEqual(delivered, []);

    assert.equal(timers.fire(secondId), true);
    assert.deepEqual(delivered, ['create MEMORO']);
  });

  test('pause clears a pending timer without cancelling later delivery', () => {
    const timers = fakeTimers();
    const delivered = [];
    const controller = createStartupMessageController({
      message: 'create MEMORO',
      delayMs: 25,
      deliver: (msg) => delivered.push(msg),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    assert.equal(controller.schedule(), true);
    const [firstId] = timers.ids();
    assert.equal(controller.pause(), true);
    assert.equal(timers.fire(firstId), false);
    assert.deepEqual(delivered, []);

    assert.equal(controller.schedule(), true);
    const [secondId] = timers.ids();
    assert.equal(timers.fire(secondId), true);
    assert.deepEqual(delivered, ['create MEMORO']);
  });

  test('explicit immediate send cancels pending timer and delivers once', () => {
    const timers = fakeTimers();
    const delivered = [];
    const controller = createStartupMessageController({
      message: 'create MEMORO',
      delayMs: 25,
      deliver: (msg) => delivered.push(msg),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.schedule();
    const [timerId] = timers.ids();

    assert.equal(controller.sendNow(), true);
    assert.deepEqual(timers.cleared, [timerId]);
    assert.deepEqual(delivered, ['create MEMORO']);
    assert.equal(timers.fire(timerId), false);
    assert.equal(controller.sendNow(), false);
    assert.deepEqual(delivered, ['create MEMORO']);
  });

  test('cancel prevents later delivery', () => {
    const timers = fakeTimers();
    const delivered = [];
    const controller = createStartupMessageController({
      message: 'create MEMORO',
      delayMs: 25,
      deliver: (msg) => delivered.push(msg),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    controller.schedule();
    const [timerId] = timers.ids();
    controller.cancel();

    assert.deepEqual(timers.cleared, [timerId]);
    assert.equal(timers.fire(timerId), false);
    assert.equal(controller.schedule(), false);
    assert.equal(controller.sendNow(), false);
    assert.deepEqual(delivered, []);
  });
});
