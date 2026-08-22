/**
 * The alarm clock a session set for itself, read from its transcript (D-0155).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dueIn, scheduledWakeup } from '../../src/mc/wakeup.js';

const at = (minutes) => new Date(Date.parse('2026-08-22T12:00:00Z') + minutes * 60000).toISOString();
const schedule = (input, minutes) => ({
  type: 'assistant', timestamp: at(minutes),
  message: { content: [{ type: 'text', text: 'waiting' }, { type: 'tool_use', name: 'ScheduleWakeup', input }] },
});
const user = (text, minutes) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: text } });
const other = (minutes) => ({ type: 'assistant', timestamp: at(minutes), message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

describe('scheduledWakeup', () => {
  it('reads the last clock set: prompt, delay, and when it is due', () => {
    const entries = [schedule({ prompt: 'npm run test:msr:contract', delaySeconds: 600, reason: 'waiting for the suite' }, 0), other(1)];
    assert.deepEqual(scheduledWakeup(entries), {
      prompt: 'npm run test:msr:contract', delay_s: 600, set_at: at(0), due_at: at(10), reason: 'waiting for the suite',
    });
  });

  it('a stop clears it', () => {
    assert.equal(scheduledWakeup([schedule({ prompt: 'x', delaySeconds: 60 }, 0), schedule({ stop: true }, 1)]), null);
  });

  it('a clock that rang and was not set again is no clock', () => {
    const entries = [schedule({ prompt: 'npm run test:msr:contract', delaySeconds: 120 }, 0), user('npm run test:msr:contract', 2)];
    assert.equal(scheduledWakeup(entries), null);
  });

  it('a clock that rang and was set again is the new one — eleven times, in the measured case', () => {
    const entries = [];
    for (let round = 0; round < 11; round += 1) {
      entries.push(schedule({ prompt: 'npm run test:msr:contract', delaySeconds: 600 }, round * 10));
      if (round < 10) entries.push(user('npm run test:msr:contract', round * 10 + 10));
    }
    assert.equal(scheduledWakeup(entries)?.set_at, at(100));
  });

  it('a user turn saying something else does not ring it', () => {
    const entries = [schedule({ prompt: 'poll CI', delaySeconds: 300 }, 0), user('läs din inbox nu', 1)];
    assert.equal(scheduledWakeup(entries)?.prompt, 'poll CI');
  });

  it('no clock, no claim', () => {
    assert.equal(scheduledWakeup([other(0), user('hello', 1)]), null);
    assert.equal(scheduledWakeup([]), null);
  });

  it('says how far off it is, in either direction', () => {
    const clock = { due_at: at(10) };
    assert.equal(dueIn(clock, Date.parse(at(1))), 'in 9m');
    assert.equal(dueIn(clock, Date.parse(at(13))), 'overdue 3m');
    assert.equal(dueIn(clock, Date.parse(at(10))), 'due now');
    assert.equal(dueIn({ due_at: null }, 0), null);
    assert.equal(dueIn(null, 0), null);
  });
});
