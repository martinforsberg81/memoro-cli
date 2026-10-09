/**
 * `~/mc/runner/merges.json` — the merger's jobs, over the entries and nothing
 * else (ruling 30).
 *
 * The verb's use of them is `tests/mc/merge-command.test.js` and the merger's
 * is `tests/mc/merger.test.js`; these are the edges that would otherwise be
 * found by the merger at three in the morning: a file somebody hand-edited or
 * an older mc left, two repositories numbering their pull requests
 * independently, the same pull request queued twice, and a job a dead merger
 * was landing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dequeue, enqueue, markLanding, mergesPath, nextJob, parseQueue, placeOf, queueEntries, queueOrder, queuedFor,
  waitingOnParent,
} from '../../src/mc/merge-queue.js';

const job = (over = {}) => ({
  repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, branch: 'merge-queue',
  since: '2026-09-06T18:00:00Z', holder: { name: 'martin@host', kind: 'shell' }, step: null, ...over,
});

test('the file sits beside the runner\'s other state', () => {
  assert.equal(mergesPath('/Users/x/mc'), '/Users/x/mc/runner/merges.json');
});

test('an unreadable or missing file is no entries, never a crash', () => {
  assert.deepEqual(parseQueue(null), []);
  assert.deepEqual(parseQueue('{'), []);
  assert.deepEqual(parseQueue('{"pr": 1}'), [], 'an object is not a list of entries');
  assert.deepEqual(queueEntries([null, { pr: 'x' }]), []);
});

test('an entry an older mc left — a waiter with a pid and a reason — reads as a queued job', () => {
  const [old] = parseQueue(JSON.stringify([{ repo: 'memoro', pr: 12, branch: 'b', reason: 'busy', stopped_at: 'busy', since: 's', holder: 'martin@host', pid: 99 }]));
  assert.equal(old.state, 'queued');
  assert.deepEqual(old.holder, { name: 'martin@host' });
  assert.equal(old.step, null);
  assert.equal(old.pid, undefined, 'no process is part of a job');
});

test('a step that is not { project, index } is no step', () => {
  assert.equal(queueEntries([job({ step: { project: 'x' } })])[0].step, null);
  assert.deepEqual(queueEntries([job({ step: { project: 'x', index: 2 } })])[0].step, { project: 'x', index: 2 });
});

test('the identity is repository and number: memoro #9 and memoro-cli #9 are two jobs', () => {
  let entries = enqueue([], job({ pr: 9 }));
  entries = enqueue(entries, job({ repo: 'memoro', pr: 9 }));
  assert.equal(entries.length, 2);
  assert.equal(queuedFor(entries, 'memoro', 9).repo, 'memoro');
  assert.deepEqual(dequeue(entries, { repo: 'memoro', pr: 9 }).map((e) => e.repo), ['memoro-cli']);
});

test('queued again keeps its place in line', () => {
  let entries = enqueue([], job({ since: '2026-09-06T17:00:00Z' }));
  entries = enqueue(entries, job({ since: '2026-09-06T18:30:00Z', branch: 'merge-queue-2' }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].since, '2026-09-06T17:00:00Z');
  assert.equal(entries[0].branch, 'merge-queue-2');
});

test('a job being landed is not touched by a second ask', () => {
  const landing = markLanding(enqueue([], job()), job(), '2026-09-06T18:01:00Z');
  assert.equal(enqueue(landing, job({ branch: 'other' })), landing);
});

test('oldest first; a job a dead merger was landing goes before everything', () => {
  let entries = [];
  entries = enqueue(entries, job({ pr: 3, since: '2026-09-06T18:03:00Z' }));
  entries = enqueue(entries, job({ pr: 1, since: '2026-09-06T18:01:00Z' }));
  entries = enqueue(entries, job({ pr: 2, since: '2026-09-06T18:02:00Z' }));
  assert.deepEqual(queueOrder(entries).map((e) => e.pr), [1, 2, 3]);
  assert.equal(nextJob(entries).pr, 1);
  assert.equal(placeOf(entries, 'memoro-cli', 3), 2);
  assert.equal(placeOf(entries, 'memoro-cli', 99), null);
  const landing = markLanding(entries, { repo: 'memoro-cli', pr: 3 }, '2026-09-06T18:05:00Z');
  assert.equal(nextJob(landing).pr, 3);
  assert.equal(nextJob([]), null);
});

test('a job built on another waits until that one has landed (ruling 30, A)', () => {
  const parent = { project: 'mq', index: 0, pr: 9, sha: 'abc' };
  let entries = enqueue([], job({ pr: 9, since: '2026-09-06T18:00:00Z' }));
  entries = enqueue(entries, job({ pr: 10, since: '2026-09-06T17:00:00Z', parent }));
  assert.deepEqual(entries[1].parent, parent);
  assert.equal(nextJob(entries).pr, 9, 'older, but built on #9, which is still queued');
  const alone = dequeue(entries, { repo: 'memoro-cli', pr: 9 });
  assert.equal(nextJob(alone, { landed: () => true }).pr, 10, '#9 landed: #10 may go');
  assert.equal(nextJob(alone, { landed: () => false }), null, '#9 came back red: #10 waits for it');
  assert.deepEqual(waitingOnParent(alone, { landed: () => false }).map((e) => e.pr), [10]);
  assert.deepEqual(waitingOnParent(alone, { landed: () => true }), []);
});
