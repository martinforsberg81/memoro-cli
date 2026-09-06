/**
 * `~/mc/runner/merges.json` — the rules, over the entries and nothing else.
 *
 * The verb's own use of them is in `tests/mc/merge-command.test.js`, where a
 * refused round writes the file; these are the edges that would otherwise be
 * found by a runner at three in the morning: a file somebody hand-edited, two
 * repositories numbering their pull requests independently, and the same pull
 * request queued twice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QUEUEABLE_STOPS, dequeue, enqueue, mergesPath, parseQueue, queueEntries, queueOrder, queuedFor, queueable,
} from '../../src/mc/merge-queue.js';

const entry = (over = {}) => ({
  repo: 'memoro-cli', pr: 671, branch: 'merge-queue', reason: 'the gate is busy',
  stopped_at: 'busy', since: '2026-09-06T18:00:00Z', holder: 'martin@host', ...over,
});

test('the file sits beside the runner\'s other state', () => {
  assert.equal(mergesPath('/Users/x/mc'), '/Users/x/mc/runner/merges.json');
});

test('an unreadable or missing file is no entries, never a crash', () => {
  assert.deepEqual(parseQueue(null), []);
  assert.deepEqual(parseQueue('{'), []);
  assert.deepEqual(parseQueue('{"pr": 1}'), [], 'an object is not a list of entries');
  assert.deepEqual(queueEntries([{ repo: 'memoro' }, null, 'x']), [], 'an entry with no pull request is not one');
});

test('an entry keeps the shape the lane and the page read, whatever the file says', () => {
  const [read] = queueEntries([{ pr: '9', repo: 'memoro' }]);
  assert.deepEqual(read, {
    repo: 'memoro', pr: 9, branch: null, reason: 'no reason given', stopped_at: null, since: null, holder: null,
  });
});

test('queueing the same pull request again keeps how long it has waited', () => {
  const first = enqueue([], entry());
  const again = enqueue(first, entry({ reason: 'the lease is held by mc-run', stopped_at: 'lease', since: '2026-09-06T18:20:00Z' }));
  assert.equal(again.length, 1, 'one entry per pull request');
  assert.equal(again[0].reason, 'the lease is held by mc-run', 'the newest reason is the one the lane acts on');
  assert.equal(again[0].since, '2026-09-06T18:00:00Z', 'how long it has waited is the pull request\'s, not the round\'s');
});

test('a pull request is one number in one repository', () => {
  const both = enqueue(enqueue([], entry({ repo: 'memoro', pr: 9 })), entry({ repo: 'memoro-cli', pr: 9 }));
  assert.equal(both.length, 2, 'memoro #9 and memoro-cli #9 are different work');
  assert.equal(queuedFor(both, 'memoro-cli', 9).repo, 'memoro-cli');
  assert.equal(queuedFor(both, 'memoro', 671), null);
  assert.deepEqual(dequeue(both, { repo: 'memoro', pr: 9 }).map((item) => item.repo), ['memoro-cli']);
});

test('the lane takes them oldest first', () => {
  const entries = [entry({ pr: 3, since: '2026-09-06T19:00:00Z' }), entry({ pr: 2, since: '2026-09-06T17:00:00Z' })];
  assert.deepEqual(queueOrder(entries).map((item) => item.pr), [2, 3]);
});

test('only the stops the lane can do something about are queued', () => {
  for (const stop of ['busy', 'lease', 'red', 'pr-tests', 'extra-gate', 'merge']) {
    assert.equal(queueable(stop), true, `${stop} is one the lane can try again`);
  }
  // A pull request nothing on this machine can name, and the stops that mean
  // something else has to happen first.
  for (const stop of ['pr', 'drift', 'merge-unknown', 'batch', null, undefined]) {
    assert.equal(queueable(stop), false, `${stop} is not the lane's`);
  }
  assert.equal(QUEUEABLE_STOPS.length, 6, 'a seventh stop needs a sentence beside the list');
});
