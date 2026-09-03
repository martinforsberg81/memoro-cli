/**
 * A blocker nobody re-reads.
 *
 * The fixture is not invented: `tests/fixtures/stale-blockers-main-2026-09-03.json`
 * is three plan records taken verbatim from memoro's `origin/main` at
 * `6c04e604` — the commit that archived `inbox-finish` — where two steps were
 * blocked on `inbox-finish` and `inbox-finish` had no file left under
 * `docs/project/`. That is the real pair: a blocked step, and a blocker that
 * has finished. The third record is the control that must stay quiet.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { queueSection, runnerSection, sessionsSection } from '../../src/mc/page-collect.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { describeStale, staleBlockers } from '../../src/mc/stale-blockers.js';

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'stale-blockers-main-2026-09-03.json'), 'utf8'));
const PLANS = FIXTURE.plans;

/** The page as `mc` prints it, from a queue section and nothing else. */
function pageText(queue) {
  return renderPageLines({
    runner: runnerSection({ now: new Date('2026-09-03T12:00:00Z'), alive: () => false }),
    sessions: sessionsSection({ now: new Date('2026-09-03T12:00:00Z'), alive: () => false }),
    queue,
    intake: { digest: null, proposals: 0, loud: [], fresh: 0 },
    programmes: { repos: [], unplanned: [] },
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
  }, { columns: 120, colour: false }).join('\n');
}

describe('stale blockers', () => {
  it('names the two real steps whose blocker had left main, and no others', () => {
    const found = staleBlockers(PLANS);
    assert.deepEqual(found.map(describeStale), [
      'home-on-msr step 2 waits on inbox-finish, which is not on main',
      'time-axis step 1 waits on inbox-finish, which is not on main',
    ]);
  });

  it('leaves a step alone whose blocker is on main and unfinished', () => {
    // web-renderer-close waits on time-axis, which is right there in the same
    // fixture with nine steps to go. A blocker that is merely slow is not stale.
    const control = PLANS.find((p) => p.project === 'web-renderer-close');
    assert.equal(control.plan.steps[0].blocked_by.name, 'time-axis');
    assert.equal(staleBlockers(PLANS).some((item) => item.project === 'web-renderer-close'), false);
  });

  it('reports a blocker whose plan is still on main and says done', () => {
    // The `done` arm has no specimen on main and cannot have one: `mc run`
    // archives a plan the round it says done, which is how the two above lost
    // theirs. So it is built by finishing a real plan's steps rather than by
    // writing a plan, and it is the same fault either way.
    const blocker = PLANS.find((p) => p.project === 'time-axis');
    const finished = {
      ...blocker,
      status: 'done',
      plan: { ...blocker.plan, steps: blocker.plan.steps.map((step) => ({ ...step, status: 'done', blocked_by: null })) },
    };
    const found = staleBlockers([PLANS.find((p) => p.project === 'web-renderer-close'), finished]);
    assert.deepEqual(found.map(describeStale), ['web-renderer-close step 1 waits on time-axis, which is done']);
  });

  it('never reports a decision blocker — there is no artefact to read it against', () => {
    const [record] = PLANS;
    const decided = {
      ...record,
      plan: {
        ...record.plan,
        steps: record.plan.steps.map((step) => (step.status === 'blocked'
          ? { ...step, blocked_by: { kind: 'decision', name: 'plan-review' } }
          : step)),
      },
    };
    assert.deepEqual(staleBlockers([decided]), []);
  });

  it('flips nothing — the plans it read are the plans it leaves', () => {
    const before = JSON.stringify(PLANS);
    staleBlockers(PLANS);
    assert.equal(JSON.stringify(PLANS), before);
  });

  it('puts the count and the first names on the page, under QUEUE', () => {
    const text = pageText(queueSection({ queue: [], plans: PLANS }));
    assert.match(text, /blocker finished 2/u);
    assert.match(text, /home-on-msr step 2 on inbox-finish, which is not on main/u);
    assert.match(text, /time-axis step 1 on inbox-finish, which is not on main/u);
  });

  it('counts the rest rather than listing them', () => {
    const section = queueSection({ queue: [], plans: PLANS, staleNamed: 1 });
    assert.equal(section.stale.count, 2);
    assert.equal(section.stale.more, 1);
    assert.match(pageText(section), /… 1 more/u);
  });

  it('says nothing at all when no blocker is stale', () => {
    const text = pageText(queueSection({ queue: [], plans: [] }));
    assert.equal(/blocker finished/u.test(text), false);
  });
});
