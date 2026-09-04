/**
 * `~/mc/runner/held.json` — the rules, over the entries and nothing else.
 *
 * The runner's own use of them is in `tests/mc/run.test.js`, where a round
 * writes the file; these are the edges a round would take an evening to show:
 * a file somebody hand-edited, two repositories numbering their pull requests
 * independently, and a repository GitHub could not be asked for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  heldEntries, holdPr, holdReason, holdsAfterSession, parseHeld, reconcileHeld, releasePr,
} from '../../src/mc/held.js';

const entry = (over = {}) => ({
  project: 'alpha', repo: 'memoro', pr: 11274, branch: 'alpha', reason: 'two tests red',
  note: 'open,gate-red', since: '2026-09-03T22:00:00Z', repairs: 0, ...over,
});

test('an unreadable or missing file is no entries, never a crash', () => {
  assert.deepEqual(parseHeld(null), []);
  assert.deepEqual(parseHeld('{'), []);
  assert.deepEqual(parseHeld('{"pr": 1}'), [], 'an object is not a list of entries');
  assert.deepEqual(heldEntries([{ project: 'a' }, null, 'x']), [], 'an entry with no pull request is not one');
});

test('an entry keeps the shape the page and the brief read, whatever the file says', () => {
  const [read] = heldEntries([{ pr: '9', project: 'alpha' }]);
  assert.deepEqual(read, {
    project: 'alpha', repo: null, pr: 9, branch: null, reason: 'no reason given',
    note: null, since: null, repairs: 0,
  });
});

test('holding the same pull request again keeps since and repairs', () => {
  const first = holdPr([], entry());
  assert.equal(first[0].repairs, 0);
  const repaired = first.map((item) => ({ ...item, repairs: 1 }));
  const again = holdPr(repaired, entry({ reason: 'still two tests red', since: '2026-09-04T09:00:00Z' }));
  assert.equal(again.length, 1);
  assert.equal(again[0].reason, 'still two tests red', 'the newest reason is the one to act on');
  assert.equal(again[0].since, '2026-09-03T22:00:00Z', 'how long it has stood still is the pull request\'s, not the round\'s');
  assert.equal(again[0].repairs, 1, 'a repair that has run has run');
});

test('a pull request is one number in one repository', () => {
  const both = holdPr(holdPr([], entry({ pr: 9 })), entry({ repo: 'memoro-cli', project: 'mc-run', pr: 9 }));
  assert.equal(both.length, 2, 'memoro #9 and memoro-cli #9 are different work');
  assert.deepEqual(releasePr(both, { repo: 'memoro', pr: 9 }).map((item) => item.repo), ['memoro-cli']);
});

test('reconcile drops what is not open, keeps what is, and touches no repository it could not ask', () => {
  const entries = [entry({ pr: 500 }), entry({ pr: 501 }), entry({ repo: 'memoro-cli', pr: 502 })];
  const { kept, dropped } = reconcileHeld(entries, {
    prs: [{ repo: 'memoro', number: 501 }],
    repos: ['memoro'],
  });
  assert.deepEqual(kept.map((item) => item.pr), [501, 502], 'memoro-cli was not asked, so nothing of its is dropped');
  assert.deepEqual(dropped.map((item) => item.pr), [500]);
  // A round that asked nobody anything changes nothing.
  assert.deepEqual(reconcileHeld(entries, { prs: [], repos: [] }).dropped, []);
});

test('the reasons a session leaves behind are the words the repair session reads', () => {
  assert.equal(holdsAfterSession('success'), false);
  assert.equal(holdsAfterSession('quota'), false, 'a refused session opened nothing');
  assert.equal(holdsAfterSession('timeout'), true);
  assert.match(holdReason({ note: 'timeout' }), /timed out with the pull request open/u);
  assert.equal(
    holdReason({ note: 'plan-trespass', problems: ['goal: a step session does not change it'] }),
    'the session changed more of the plan than its step: goal: a step session does not change it',
  );
  assert.match(holdReason({ note: 'failed' }), /the session ended `failed` with the pull request open/u);
});
