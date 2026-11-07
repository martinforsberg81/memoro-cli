/** Finish existing work first, then programme preference and age, within repository shares. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { laneShare, pickWork } from '../../src/mc/lane-pick.js';

const build = (name, repo, since = '2026-11-01T10:00Z', extra = {}) => ({ name, repo, kind: 'build', variant: 'project', since, ...extra });
const goal = (name, repo, since = '2026-11-01T10:00Z') => ({ name, repo, kind: 'build', variant: 'goal', since });
const review = (name, repo, variant = 'goal', since = '2026-11-02T10:00Z') => ({ name, repo, kind: 'review', variant, since });

test('pickWork: a review before a project build, and a project build before a goal build', () => {
  const items = [goal('g', 'memoro-cli', '2026-10-01T00:00Z'), build('p', 'memoro', '2026-11-01T00:00Z'), review('r', 'memoro-cli')];
  assert.equal(pickWork({ items, lanes: 4 }).name, 'r');
  assert.equal(pickWork({ items: items.slice(0, 2), lanes: 4 }).name, 'p', 'a younger project build still before an older goal');
  assert.equal(pickWork({ items: [goal('g', 'memoro'), review('pr', 'memoro', 'project')], lanes: 4 }).name, 'pr', "a project's review step is a review");
});

test('pickWork: among equals, the work that has waited longest first; no time is oldest of all', () => {
  const items = [build('new', 'memoro', '2026-11-02T09:00:00.000Z'), build('old', 'memoro-cli', '2026-11-01T09:00Z'), build('mid', 'memoro', '2026-11-01T12:00Z')];
  assert.equal(pickWork({ items, lanes: 4 }).name, 'old');
  assert.equal(pickWork({ items: [...items, build('never', 'memoro', '')], lanes: 4 }).name, 'never');
  assert.equal(pickWork({ items: [build('a', 'memoro', 'x'), build('b', 'memoro', 'x')], lanes: 4 }).name, 'a', 'a tie keeps the order given');
});

test('pickWork: a step the API cut off goes first among its kind', () => {
  const items = [build('old', 'memoro', '2026-10-01T00:00Z'), build('cut', 'memoro', '2026-11-02T00:00Z', { resumed: true })];
  assert.equal(pickWork({ items, lanes: 4 }).name, 'cut');
});

test('pickWork: carrying a build yields to a review and breaks ties within a rank', () => {
  const items = [review('r', 'memoro-cli'), build('p', 'memoro')];
  assert.equal(pickWork({ items, lanes: 4, carry: 'p' }).name, 'r');
  assert.equal(pickWork({ items: [build('old', 'memoro', ''), build('p', 'memoro')], carry: 'p' }).name, 'p');
  assert.equal(pickWork({ items, lanes: 4, carry: 'gone' }).name, 'r', 'a carry that cannot start is no carry');
});

test('pickWork: repository fairness reserves lanes within the same scheduling rank', () => {
  const memoro = Array.from({ length: 6 }, (_, i) => goal(`m${i}`, 'memoro', `2026-10-0${i + 1}T00:00Z`));
  const cli = [goal('g', 'memoro-cli', '2026-11-02T00:00Z')];
  // Four lanes, filled one at a time as a runner fills them.
  const held = [];
  const taken = [];
  let items = [...memoro, ...cli];
  for (let lane = 0; lane < 4; lane += 1) {
    const pick = pickWork({ items, held, lanes: 4 });
    taken.push(pick.name);
    held.push(pick.repo);
    items = items.filter((item) => item !== pick);
  }
  assert.ok(taken.includes('g'), 'the goal build got a lane though every memoro item has waited longer');
  assert.ok(held.filter((repo) => repo === 'memoro').length < 4, 'memoro did not take every lane');

  // memoro holds three lanes while memoro-cli was idle; its work appears and the next free lane is its.
  assert.equal(pickWork({ items: [...memoro, ...cli], held: ['memoro', 'memoro', 'memoro'], lanes: 4 }).name, 'g');
  // With nothing waiting elsewhere, one repository may have every lane.
  assert.equal(pickWork({ items: memoro, held: ['memoro', 'memoro', 'memoro'], lanes: 4 }).repo, 'memoro');
  // A carried project on a repository at its share yields too.
  assert.equal(pickWork({ items: [goal('p', 'memoro'), ...cli], held: ['memoro', 'memoro'], lanes: 4, carry: 'p' }).name, 'g');
});

test('pickWork: with one lane, the repositories take turns by their wait', () => {
  const items = [build('m', 'memoro', '2026-11-02T00:00Z'), build('c', 'memoro-cli', '2026-11-01T00:00Z')];
  assert.equal(pickWork({ items, lanes: 1 }).name, 'c');
  assert.equal(laneShare(1, 2), 1);
  assert.equal(laneShare(4, 2), 2);
  assert.equal(laneShare(5, 2), 3);
  assert.equal(pickWork({ items: [], lanes: 4 }), null);
});

test('pickWork: the mend of a blocked goal, then finish and the mend of a red merge, review, build, before programme preference or carry', () => {
  const items = [
    { ...goal('build', 'memoro'), priority: 98 },
    { ...review('review', 'memoro'), priority: 97 },
    { ...build('finish', 'memoro'), kind: 'finish', variant: null, priority: 1, goal: { stage: 'finish' } },
    { ...build('blocked', 'memoro'), kind: 'mend', variant: null, goal: { status: 'blocked' } },
  ];
  assert.equal(pickWork({ items, held: ['memoro'], lanes: 2 }).name, 'blocked', 'existing sessions do not demote recovery');
  const taken = [];
  while (items.length) {
    const next = pickWork({ items, carry: 'build' });
    taken.push(next.name);
    items.splice(items.indexOf(next), 1);
  }
  assert.deepEqual(taken, ['blocked', 'finish', 'review', 'build']);
  assert.equal(pickWork({ items: [review('r', 'memoro'), { ...build('merge', 'memoro'), kind: 'mend', variant: null, goal: { stage: 'merge', status: 'ready' } }] }).name, 'merge', 'a red merge ranks with finish, before review');
});

test('pickWork: higher programme priority wins within a rank, with fairness and old tie rules intact', () => {
  const low = { ...goal('low', 'memoro', ''), priority: 1, resumed: true };
  const high = { ...goal('high', 'memoro'), priority: 2 };
  assert.equal(pickWork({ items: [low, high], carry: 'low' }).name, 'high');
  assert.equal(pickWork({ items: [low, { ...high, priority: 1 }] }).name, 'low');
  const other = goal('other-repository', 'memoro-cli');
  assert.equal(pickWork({ items: [high, other], held: ['memoro'], lanes: 2 }).name, 'other-repository');
  assert.equal(pickWork({ items: [{ ...low, priority: undefined }, { ...high, priority: 0 }] }).name, 'low');
});

test('pickWork: stage order precedes repository shares when another repository has only new builds', () => {
  const items = [goal('new-build', 'memoro-cli'), { ...review('stuck-review', 'memoro'), goal: { status: 'blocked' }, kind: 'mend', variant: null }];
  assert.equal(pickWork({ items, held: ['memoro'], lanes: 2 }).name, 'stuck-review');
});
