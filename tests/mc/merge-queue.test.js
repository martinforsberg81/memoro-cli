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
  dequeue, dropDeadEntries, enqueue, mergesPath, nextWaiter, parseQueue, queueEntries, queueOrder,
  queuedFor,
} from '../../src/mc/merge-queue.js';

const entry = (over = {}) => ({
  repo: 'memoro-cli', pr: 671, branch: 'merge-queue', reason: 'the gate is red',
  stopped_at: 'red', since: '2026-09-06T18:00:00Z', holder: 'martin@host', ...over,
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
    pid: null,
  });
});

test('a no-pid entry round-trips through the file as no-pid, not pid 0', () => {
  // `Number(null)` is `0`, a finite number — the trap this guards against.
  const [written] = queueEntries([entry({ pid: null })]);
  const [reread] = queueEntries(JSON.parse(JSON.stringify([written])));
  assert.equal(reread.pid, null, 'a refusal entry read back from disk is still not a waiter');
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


test('a dead pid is litter, dropped by whoever polls next', () => {
  const entries = [entry({ pid: 111 }), entry({ pr: 9, pid: 222 }), entry({ pr: 5 })];
  const dropped = dropDeadEntries(entries, { alive: (pid) => pid === 111 });
  assert.deepEqual(dropped.map((item) => item.pr), [671, 5], 'the dead waiter is gone, the refusal entry with no pid is untouched');
});

test('the oldest live waiter takes the lock; a waiter behind a held lease keeps its place', () => {
  const entries = [
    entry({ pr: 1, pid: 1, since: '2026-09-06T17:00:00Z' }),
    entry({ repo: 'memoro', pr: 2, pid: 2, since: '2026-09-06T17:05:00Z' }),
  ];
  const heldByLease = nextWaiter(entries, { leaseHeld: (repo) => repo === 'memoro-cli' });
  assert.equal(heldByLease.pr, 2, 'memoro-cli\'s lease is held, so the later memoro waiter goes instead');
  const bothFree = nextWaiter(entries, { leaseHeld: () => false });
  assert.equal(bothFree.pr, 1, 'both free: the oldest entry, whichever repository');
  assert.equal(nextWaiter([entry({ pid: null })]), null, 'a refusal entry with no pid is not a waiter');
});
