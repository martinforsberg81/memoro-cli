/**
 * `retireDecisions()` — which answered decision files have done their job.
 *
 * The rule Martin set: the plan changes for the decision, and the file goes.
 * So the test is never "has a `**Beslut:**` line" on its own — it is whether
 * the plans that own the file have left `waiting-decision`. The cases below
 * are the ones measured against `~/mc` on 2026-08-29, which is also why the
 * held and orphan cases exist at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { retireDecisions } from '../../src/mc/brief-collect.js';

const decision = (area, base, answered = true) => ({ area, base, path: `/work/${area}/decisions/${base}.md`, answered });
/** The same, with the ownership its frontmatter declares — what every real file carries. */
const owned = (area, base, owner, answered = true) => ({ ...decision(area, base, answered), owner });
const plan = (programme, project, status, path = `docs/project/${programme}/${project}/PLAN.md`) => ({ programme, project, status, path });

describe('retireDecisions', () => {
  it('retires an answered decision whose owning plan has moved on', () => {
    const { remove, held, orphans } = retireDecisions({
      decisions: [decision('canonical-response', 'chat-response-1')],
      plans: [plan('chat-response', 'canonical-response', 'ready')],
    });
    assert.equal(remove.length, 1);
    assert.equal(remove[0].base, 'chat-response-1');
    assert.deepEqual(remove[0].appliedBy, ['canonical-response']);
    assert.deepEqual([held, orphans], [[], []]);
  });

  it('never touches an open question', () => {
    const { remove, held, orphans } = retireDecisions({
      decisions: [decision('revise-test-architecture', 'test-architecture-1', false)],
      plans: [plan('test-architecture', 'revise-test-architecture', 'ready')],
    });
    assert.deepEqual([remove, held, orphans], [[], [], []]);
  });

  /**
   * `avatar-image-animation` on 2026-08-29: seven answered decisions, and a
   * plan still saying `waiting-decision` whose `next:` still names one of
   * them. Deleting on the answer alone takes the answer away before the
   * session that has to apply it ever runs.
   */
  it('holds an answered decision while its plan is still waiting on it', () => {
    const { remove, held } = retireDecisions({
      decisions: [decision('avatar-image-animation', 'assistant-avatar-6')],
      plans: [plan('assistant-avatar', 'avatar-image-animation', 'waiting-decision')],
    });
    assert.equal(remove.length, 0);
    assert.equal(held.length, 1);
    assert.match(held[0].why, /avatar-image-animation still waiting-decision/u);
  });

  /**
   * The cross-area case the runner's own ownership rule creates:
   * `mc-utredning/decisions/mc-2.md` is answered, and `mc/mc-helper` — a
   * different workarea — is the plan waiting on it. One waiting owner is
   * enough to hold the file.
   */
  it('holds when any owning plan is still waiting, even from another area', () => {
    const { remove, held } = retireDecisions({
      decisions: [decision('mc-utredning', 'mc-2')],
      plans: [plan('mc', 'mc-utredning', 'done'), plan('mc', 'mc-helper', 'waiting-decision')],
    });
    assert.equal(remove.length, 0);
    assert.match(held[0].why, /mc-helper still waiting-decision/u);
  });

  /**
   * `network-review-1` (its project `org-update` was closed and removed from
   * main by #11036) and `test-architecture-2` (referenced by no plan). A
   * machine never deletes these: an unanswered question nobody owns is the
   * one thing worse to lose than to keep. Here the file is answered and
   * still only reported.
   */
  it('reports an orphan and never deletes it', () => {
    const { remove, orphans } = retireDecisions({
      decisions: [decision('org-update', 'network-review-1')],
      plans: [plan('language-content', 'swedish-grammar', 'ready')],
    });
    assert.equal(remove.length, 0);
    assert.equal(orphans.length, 1);
    assert.match(orphans[0].why, /no plan on main owns it/u);
  });

  it('retires only when every owner has moved on', () => {
    const { remove, held } = retireDecisions({
      decisions: [decision('network-review-rollout', 'network-review-2'), decision('network-review-rollout', 'network-review-3')],
      plans: [plan('network-review', 'network-review-rollout', 'ready'), plan('network-review', 'network-review-entity-entry', 'ready')],
    });
    assert.equal(remove.length, 2);
    assert.equal(held.length, 0);
  });

  it('a blocked or done owner is an owner that has moved on', () => {
    const { remove } = retireDecisions({
      decisions: [decision('test-value-cleanup', 'test-architecture-9')],
      plans: [plan('test-architecture', 'test-value-cleanup', 'blocked')],
    });
    assert.equal(remove.length, 1);
  });

  it('matches an owner by area as well as by name prefix', () => {
    const { remove } = retireDecisions({
      decisions: [decision('legal-work', '2026-08-25-something-else')],
      plans: [plan('legal-readiness', 'legal-work', 'ready')],
    });
    assert.equal(remove.length, 1, 'a file in the plan’s own area belongs to it whatever it is called');
  });

  it('is empty in, empty out', () => {
    assert.deepEqual(retireDecisions(), { remove: [], orphans: [], held: [] });
  });

  /**
   * The declared owner, which every file under `~/mc` carries and the code
   * used to throw away. Measured 2026-08-29.
   */
  describe('reads the owner the file declares', () => {
    /**
     * `mc-test-1` says `project: mc-test`, and there is no `mc-test` plan.
     * The name heuristic made all eleven `mc` projects its owners — none
     * waiting — so an answered ruling that no plan applies and no document
     * carries came out as `remove`. It is an orphan.
     */
    it('a declared project with no plan is an orphan, not a deletion', () => {
      const plans = ['mc-brief', 'mc-helper', 'mc-ui', 'mc-run', 'mc-tidy'].map((p) => plan('mc', p, 'ready'));
      const { remove, orphans } = retireDecisions({
        decisions: [owned('mc-test', 'mc-test-1', { programme: 'mc', project: 'mc-test', plan: null })],
        plans,
      });
      assert.equal(remove.length, 0, 'eleven unrelated `mc-` plans are not owners');
      assert.equal(orphans.length, 1);
      assert.match(orphans[0].why, /no plan on main owns it/u);
    });

    it('a declared project beats the programme it sits in', () => {
      const { remove, held } = retireDecisions({
        decisions: [owned('avatar-image-animation', 'assistant-avatar-4',
          { programme: 'assistant-avatar', project: 'avatar-self-serve', plan: null })],
        plans: [
          plan('assistant-avatar', 'avatar-self-serve', 'ready'),
          plan('assistant-avatar', 'avatar-image-animation', 'waiting-decision'),
        ],
      });
      assert.deepEqual(remove.map((d) => d.appliedBy), [['avatar-self-serve']]);
      assert.equal(held.length, 0, 'a sibling still waiting does not own another project’s decision');
    });

    it('a declared plan path names exactly one owner', () => {
      const { held } = retireDecisions({
        decisions: [owned('avatar-image-animation', 'avatar-image-animation-2026-08-26',
          { programme: null, project: null, plan: 'docs/project/assistant-avatar/avatar-image-animation/PLAN.md' })],
        plans: [
          plan('assistant-avatar', 'avatar-image-animation', 'waiting-decision'),
          plan('assistant-avatar', 'avatar-self-serve', 'ready'),
        ],
      });
      assert.equal(held.length, 1);
      assert.match(held[0].why, /avatar-image-animation still waiting-decision/u);
    });

    it('a programme-level decision is owned by every plan in the programme', () => {
      const { remove, held } = retireDecisions({
        decisions: [owned('org-update', 'network-review-2', { programme: 'network-review', project: null, plan: null })],
        plans: [
          plan('network-review', 'network-review-rollout', 'waiting-decision'),
          plan('network-review', 'network-review-entity-entry', 'ready'),
          plan('language-content', 'swedish-grammar', 'ready'),
        ],
      });
      assert.equal(remove.length, 0);
      assert.match(held[0].why, /network-review-rollout still waiting-decision/u);
    });

    it('falls back to the heuristic when the file declares nothing', () => {
      const { remove } = retireDecisions({
        decisions: [decision('legal-work', '2026-08-25-something-else')],
        plans: [plan('legal-readiness', 'legal-work', 'ready')],
      });
      assert.equal(remove.length, 1, 'files written before the frontmatter existed still resolve');
    });

    it('a declared plan path that matches nothing is an orphan', () => {
      const { remove, orphans } = retireDecisions({
        decisions: [owned('gone', 'gone-1', { programme: null, project: null, plan: 'docs/project/gone/gone/PLAN.md' })],
        plans: [plan('mc', 'mc-brief', 'ready')],
      });
      assert.deepEqual([remove.length, orphans.length], [0, 1]);
    });
  });
});
