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
  MERGE_BATCH_MAX, dequeue, enqueue, heldLanding, markLanding, markQueued, markRed, mergesPath, nextBatch, nextJob,
  parseQueue, placeOf, queueEntries, queueOrder, queuedFor, stepsDone, waitingOn,
} from '../../src/mc/merge-queue.js';

const job = (over = {}) => ({
  repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, branch: 'merge-queue',
  since: '2026-09-06T18:00:00Z', holder: { name: 'martin@host', kind: 'shell' }, step: null, ...over,
});

test('with a lane, a batch is only that lane\'s jobs', () => {
  const laneOf = (entry) => (entry.repo === 'memoro-cli' ? 'light' : 'heavy');
  const entries = queueEntries([
    job({ repo: 'memoro', pr: 1, since: 'a' }), job({ pr: 2, since: 'b' }), job({ repo: 'memoro', pr: 3, since: 'c' }),
  ]);
  assert.deepEqual(nextBatch(entries, { lane: 'heavy', laneOf }).map((e) => e.pr), [1, 3]);
  assert.deepEqual(nextBatch(entries, { lane: 'light', laneOf }).map((e) => e.pr), [2]);
  assert.deepEqual(nextBatch(entries).map((e) => e.pr), [1, 3], 'no lane is every job');
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
  assert.deepEqual(waitingOn(alone, { landed: () => false }).map((w) => [w.entry.pr, w.parent, w.step]), [[10, 9, null]]);
  assert.deepEqual(waitingOn(alone, { landed: () => true }), []);
});

test('a batch is the next job and the ones after it for the same repository, up to MERGE_BATCH_MAX', () => {
  const at = (minute) => `2026-10-10T12:${String(minute).padStart(2, '0')}:00Z`;
  let entries = [];
  for (const pr of [1, 2, 3, 4, 5, 6]) entries = enqueue(entries, job({ repo: 'memoro', pr, since: at(pr * 2) }));
  entries = enqueue(entries, job({ pr: 7, since: at(3) }));
  assert.equal(MERGE_BATCH_MAX, 4);
  assert.deepEqual(nextBatch(entries).map((e) => e.pr), [1, 2, 3, 4], 'memoro-cli #7 is not in memoro\'s batch');
  assert.deepEqual(nextBatch(entries, { max: 2 }).map((e) => e.pr), [1, 2]);
  assert.deepEqual(nextBatch(dequeue(entries, { repo: 'memoro', pr: 1 })).map((e) => e.pr), [7], 'the oldest decides the repository');
  assert.deepEqual(nextBatch([]), []);
});

test('a batch leaves out a red entry and a job whose parent has not landed', () => {
  const parent = { project: 'mq', index: 0, pr: 20, sha: 'abc' };
  let entries = [];
  entries = enqueue(entries, job({ repo: 'memoro', pr: 1, since: '2026-10-10T12:01:00Z' }));
  entries = enqueue(entries, job({ repo: 'memoro', pr: 2, since: '2026-10-10T12:02:00Z' }));
  entries = enqueue(entries, job({ repo: 'memoro', pr: 3, since: '2026-10-10T12:03:00Z', parent }));
  entries = enqueue(entries, job({ repo: 'memoro', pr: 4, since: '2026-10-10T12:04:00Z' }));
  entries = markRed(entries, { repo: 'memoro', pr: 2 }, { reason: 'red: x', answered: 'z' });
  assert.deepEqual(nextBatch(entries, { landed: () => false }).map((e) => e.pr), [1, 4]);
  assert.deepEqual(nextBatch(entries, { landed: () => true }).map((e) => e.pr), [1, 3, 4]);
  const below = enqueue(entries, job({ repo: 'memoro', pr: 20, since: '2026-10-10T12:05:00Z' }));
  assert.deepEqual(nextBatch(below).map((e) => e.pr), [1, 4, 20], 'built on one still queued, even in the same batch, it waits');
});

test('a merger that died under a batch: every landing entry of that repository is taken again, and nothing more', () => {
  let entries = [];
  for (const pr of [1, 2, 3]) entries = enqueue(entries, job({ repo: 'memoro', pr, since: `2026-10-10T12:0${pr}:00Z` }));
  entries = enqueue(entries, job({ pr: 9, since: '2026-10-10T12:00:00Z' }));
  entries = markLanding(entries, { repo: 'memoro', pr: 1 }, 's');
  entries = markLanding(entries, { repo: 'memoro', pr: 3 }, 's');
  assert.deepEqual(nextBatch(entries).map((e) => [e.pr, e.state]), [[1, 'landing'], [3, 'landing']]);
});

/**
 * A plan's steps land in order (merger-hardening 3): step 3's job, parent or
 * none, waits until steps 1 and 2 are `done` in the register.
 */
test('a step-3 job with no parent waits until step 2 is done; a step-1 job and a job with no step do not', () => {
  const register = { mq: [{ status: 'done' }, { status: 'ready' }, { status: 'landing' }] };
  const ordered = stepsDone((project) => register[project] ?? null);
  let entries = [];
  entries = enqueue(entries, job({ pr: 3, since: '2026-10-10T12:01:00Z', step: { project: 'mq', index: 2 } }));
  entries = enqueue(entries, job({ pr: 1, since: '2026-10-10T12:02:00Z', step: { project: 'other', index: 0 } }));
  entries = enqueue(entries, job({ pr: 9, since: '2026-10-10T12:03:00Z', step: null }));
  for (const status of ['ready', 'landing', 'failed']) {
    register.mq[1] = { status };
    assert.deepEqual(nextBatch(entries, { ordered }).map((e) => e.pr), [1, 9], `step 2 ${status}: #3 waits`);
    assert.equal(nextJob(entries, { ordered }).pr, 1);
    assert.deepEqual(waitingOn(entries, { ordered }).map((w) => [w.entry.pr, w.parent, w.step]), [[3, null, { project: 'mq', number: 2 }]]);
  }
  register.mq[1] = { status: 'done' };
  assert.deepEqual(nextBatch(entries, { ordered }).map((e) => e.pr), [3, 1, 9], 'step 2 done: #3 goes, first in line');
  assert.deepEqual(waitingOn(entries, { ordered }), []);
  register.mq[0] = { status: 'failed' };
  assert.deepEqual(nextBatch(entries, { ordered }).map((e) => e.pr), [1, 9], 'every earlier step, not only the one before');
  assert.equal(stepsDone(() => null)(entries[0]), true, 'a register that cannot be read is no reason to wait');
});

test('a stacked job whose parent has landed still waits for its earlier steps', () => {
  const parent = { project: 'mq', index: 1, pr: 20, sha: 'abc' };
  const entries = enqueue([], job({ pr: 21, step: { project: 'mq', index: 2 }, parent }));
  const ordered = stepsDone(() => [{ status: 'failed' }, { status: 'done' }]);
  assert.equal(nextJob(entries, { landed: () => true, ordered }), null);
  assert.equal(nextJob(entries, { landed: () => true, ordered: stepsDone(() => [{ status: 'done' }, { status: 'done' }]) }).pr, 21);
});

test('a resumed landing batch drops a member whose earlier step is no longer done, and it goes back in line', () => {
  const register = { mq: [{ status: 'done' }, { status: 'ready' }] };
  const ordered = stepsDone((project) => register[project] ?? null);
  let entries = [];
  entries = enqueue(entries, job({ repo: 'memoro', pr: 1, since: '2026-10-10T12:01:00Z' }));
  entries = enqueue(entries, job({ repo: 'memoro', pr: 2, since: '2026-10-10T12:02:00Z', step: { project: 'mq', index: 2 } }));
  entries = markLanding(entries, { repo: 'memoro', pr: 1 }, 's');
  entries = markLanding(entries, { repo: 'memoro', pr: 2 }, 's');
  assert.deepEqual(nextBatch(entries, { ordered }).map((e) => e.pr), [1]);
  assert.deepEqual(heldLanding(entries, { ordered }).map((e) => e.pr), [2]);
  const back = markQueued(entries, { repo: 'memoro', pr: 2 });
  assert.deepEqual(queuedFor(back, 'memoro', 2).state, 'queued');
  assert.equal(queuedFor(back, 'memoro', 2).since, '2026-10-10T12:02:00Z', 'its place is kept');
  const alone = markLanding(enqueue([], job({ repo: 'memoro', pr: 2, step: { project: 'mq', index: 2 } })), { repo: 'memoro', pr: 2 }, 's');
  assert.deepEqual(nextBatch(alone, { ordered }), [], 'a landing job alone and out of order is not landed');
  assert.equal(nextJob(alone, { ordered }), null);
});
