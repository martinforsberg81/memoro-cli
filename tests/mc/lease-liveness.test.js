/**
 * Whether a lease's holder is still working (designnote §4b).
 *
 * The incident: a lease reading `grindvarv #344` had stood for 27 minutes with
 * a silent holder and looked, to everybody, exactly like one somebody had
 * walked away from. It was a running round, minutes from being force-released
 * out from under itself.
 *
 * Age cannot answer that question. A gate round *should* take half an hour and
 * a forgotten lease can be two minutes old, so no threshold separates them —
 * which is why what is asserted here is a fact read off the board and never a
 * clock, a TTL, or an expiry.
 *
 * And the honesty rule, which is the one that matters most: a holder mc cannot
 * see reads `unknown`, never a blank and never a guess. A blank is what
 * somebody weighing `--force` would read as "dead".
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { addArea, fixture as repoFixture } from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { livenessForLeases, livenessOf } from '../../src/mc/lease-liveness.js';
import { livenessRow } from '../../src/mc/repo-render.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

/** A lease as `readLease` returns one. */
function lease({ holder = 'mc-repo', kind = 'work-area', errand = 'grindvarv #344', ageMin = 27 } = {}) {
  return {
    held: true,
    holder,
    holder_kind: kind,
    errand,
    since: new Date(NOW - ageMin * 60_000).toISOString(),
    age_ms: ageMin * 60_000,
  };
}

/** The board's answer for one area, in the shape `workStatus` returns it. */
function area({ name = 'mc-repo', working = false, waiting = false, seenMinAgo = null } = {}) {
  return {
    name,
    working,
    waiting,
    conversations: seenMinAgo === null ? [] : [{ id: 'a', updated_ms: NOW - seenMinAgo * 60_000 }],
  };
}

const plain = (text) => text;

/** A shell standing in one of the work areas — that is who holds a lease. */
function inArea(fx, name) {
  return { cwd: join(fx.workRoot, name) };
}

describe('a holder\'s liveness comes from the board', () => {
  it('a holder mid-turn is working, however old the lease is', () => {
    // The incident, inverted: 27 minutes and plainly alive. The age says
    // nothing; the board says everything.
    const answer = livenessOf(lease({ ageMin: 27 }), new Map([
      ['mc-repo', area({ working: true, seenMinAgo: 0 })],
    ]));
    assert.equal(answer.state, 'working');
    assert.equal(answer.known, true);
    assert.equal(answer.last_seen_ms, NOW);
  });

  it('a holder that has stopped and wants a person is waiting', () => {
    const answer = livenessOf(lease(), new Map([['mc-repo', area({ waiting: true, seenMinAgo: 3 })]]));
    assert.equal(answer.state, 'waiting');
  });

  it('a holder with nothing running is idle, and says when it was last seen', () => {
    const answer = livenessOf(lease(), new Map([['mc-repo', area({ seenMinAgo: 240 })]]));
    assert.equal(answer.state, 'idle');
    assert.equal(answer.last_seen_ms, NOW - 240 * 60_000);
  });

  it('an area that exists but has never run anything has no last-seen to give', () => {
    const answer = livenessOf(lease(), new Map([['mc-repo', area({ seenMinAgo: null })]]));
    assert.equal(answer.state, 'idle');
    assert.equal(answer.last_seen_ms, null, 'it invented a time');
  });

  it('a free lease has no holder to ask about', () => {
    assert.equal(livenessOf({ held: false }, new Map()), null);
  });
});

describe('what mc cannot see, it says it cannot see', () => {
  it('a shell holder is unknown, with the reason', () => {
    // `user@host` — somebody's own terminal. It has no row on the board, and
    // the absence of a row is not evidence of anything.
    const answer = livenessOf(lease({ holder: 'martin@laptop', kind: 'shell' }), new Map());
    assert.equal(answer.state, 'unknown');
    assert.equal(answer.known, false);
    assert.match(answer.reason, /shell/u);
  });

  it('a work area the board has never heard of is unknown, not dead', () => {
    const answer = livenessOf(lease({ holder: 'deleted-area' }), new Map());
    assert.equal(answer.state, 'unknown');
    assert.match(answer.reason, /deleted-area/u);
  });

  it('a board that could not be read makes every holder unknown, not idle', async () => {
    // The failure mode worth naming: an aggregator that threw, read as "no
    // areas", would report every live holder as idle — which is the reading
    // that ends a running round.
    const answers = await livenessForLeases([lease()], {
      status: null,
      env: { MC_WORK_ROOT: '/nowhere/at/all/that/exists', HOME: '/nowhere/at/all' },
    });
    const answer = answers.get('mc-repo');
    assert.equal(answer.state, 'unknown');
    assert.equal(answer.known, false);
  });

  it('never reports a state outside the four it has words for', () => {
    const cases = [
      livenessOf(lease(), new Map([['mc-repo', area({ working: true })]])),
      livenessOf(lease(), new Map([['mc-repo', area({ waiting: true })]])),
      livenessOf(lease(), new Map([['mc-repo', area()]])),
      livenessOf(lease({ kind: 'shell' }), new Map()),
    ];
    for (const answer of cases) {
      assert.ok(['working', 'waiting', 'idle', 'unknown'].includes(answer.state), answer.state);
    }
  });
});

describe('asking the board costs one narrow question', () => {
  it('answers each holder from the one report, and free leases not at all', async () => {
    const status = { areas: [area({ working: true, seenMinAgo: 0 })] };
    const answers = await livenessForLeases(
      [lease(), lease({ holder: 'other-area' }), { held: false }],
      { status },
    );
    assert.equal(answers.get('mc-repo').state, 'working');
    assert.equal(answers.get('other-area').state, 'unknown', 'it guessed about an area not on the board');
    assert.equal(answers.has(null), false, 'a free lease got an answer');
    assert.equal(answers.size, 2);
  });

  it('a page with no held leases asks the board nothing at all', async () => {
    const answers = await livenessForLeases([{ held: false }, { held: false }]);
    assert.equal(answers.size, 0);
  });
});

describe('the line a person reads before deciding to force', () => {
  it('says the state and when the holder was last seen', () => {
    const row = livenessRow(plain, lease(), livenessOf(lease(), new Map([
      ['mc-repo', area({ working: true, seenMinAgo: 0 })],
    ])), NOW);
    assert.match(row, /holder working/u);
    assert.match(row, /last seen just now/u);
  });

  it('reads an hours-old idle holder as exactly that', () => {
    const row = livenessRow(plain, lease(), livenessOf(lease(), new Map([
      ['mc-repo', area({ seenMinAgo: 180 })],
    ])), NOW);
    assert.match(row, /holder idle/u);
    assert.match(row, /last seen 3h ago/u);
  });

  it('prints "liveness unknown" and why — never a blank', () => {
    const row = livenessRow(plain, lease({ kind: 'shell' }), livenessOf(lease({ kind: 'shell' }), new Map()), NOW);
    assert.match(row, /liveness unknown/u);
    assert.ok(row.length > 'liveness unknown'.length, 'the reason was dropped');
    // The words that must not appear: an unknown holder is not an idle one.
    assert.doesNotMatch(row, /idle|dead|gone|abandoned/u);
  });

  it('a free lease has no second line to print', () => {
    assert.equal(livenessRow(plain, { held: false }, null, NOW), null);
  });
});

/**
 * At the command line — and the rule that stays untouched.
 *
 * Nothing here blocks a `--force`. Martin's standing line is warn, log, never
 * bar the way, and the whole design of §4b is to give the human better grounds
 * for a decision that remains theirs. A liveness line that refused a force
 * would be the opposite of what it is for.
 */
describe('mc repo who, and force left exactly as it was', () => {
  it('prints the liveness line under the lease', () => {
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'a round'], fx.env, inArea(fx, 'alpha'));
      const asked = runMcCli(['repo', 'who', 'repo'], fx.env);
      assert.equal(asked.status, 0, asked.stderr);
      assert.match(asked.stdout, /alpha .*a round/u);
      // A fresh area with no conversation in it has nothing to have been seen
      // doing — said plainly rather than dressed up as a time.
      assert.match(asked.stdout, /holder idle/u);
      assert.match(asked.stdout, /nothing has run there/u);
    } finally { fx.cleanup(); }
  });

  it('--json carries the liveness for a surface that reads no prose', () => {
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    try {
      runMcCli(['repo', 'claim', 'repo', 'a round'], fx.env, inArea(fx, 'alpha'));
      const asked = runMcCli(['repo', 'who', 'repo', '--json'], fx.env);
      const page = JSON.parse(asked.stdout);
      assert.equal(page.holder, 'alpha');
      assert.equal(page.liveness.known, true);
      assert.ok(['working', 'waiting', 'idle'].includes(page.liveness.state));
      // A free one carries null rather than a fabricated fourth state.
      runMcCli(['repo', 'release', 'repo'], fx.env, inArea(fx, 'alpha'));
      assert.equal(JSON.parse(runMcCli(['repo', 'who', 'repo', '--json'], fx.env).stdout).liveness, null);
    } finally { fx.cleanup(); }
  });

  it('a holder outside the work root reads unknown at the command line too', () => {
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    try {
      // Claimed from outside any work area: the holder is `user@host`.
      runMcCli(['repo', 'claim', 'repo', 'from a shell'], fx.env, { cwd: fx.root });
      const asked = runMcCli(['repo', 'who', 'repo'], fx.env);
      assert.match(asked.stdout, /liveness unknown/u);
      assert.doesNotMatch(asked.stdout, /holder idle/u, 'an unseen holder was reported as idle');
    } finally { fx.cleanup(); }
  });

  it('a refused claim says whether the other round is alive', () => {
    // The decision point: this is the message that offers `--force`, so it is
    // the one that must not show an age without a life.
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    addArea(fx, 'beta', 'beta');
    try {
      runMcCli(['repo', 'claim', 'repo', 'their round'], fx.env, inArea(fx, 'alpha'));
      const refused = runMcCli(['repo', 'claim', 'repo', 'my round'], fx.env, inArea(fx, 'beta'));
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /is held by alpha/u);
      assert.match(refused.stderr, /holder idle|holder working|liveness unknown/u);
      assert.match(refused.stderr, /--force ends it/u);
    } finally { fx.cleanup(); }
  });

  it('force still works, whatever the liveness says', () => {
    // No code block, by design. Warn, log, never bar the way — the liveness
    // line is grounds for a human decision, not a gate on one.
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    addArea(fx, 'beta', 'beta');
    try {
      runMcCli(['repo', 'claim', 'repo', 'their round'], fx.env, inArea(fx, 'alpha'));
      const forced = runMcCli(['repo', 'release', 'repo', '--force'], fx.env, inArea(fx, 'beta'));
      assert.equal(forced.status, 0, forced.stderr);
      assert.match(forced.stdout, /took the lease .* from alpha — logged/u);
      assert.match(runMcCli(['repo', 'who', 'repo'], fx.env).stdout, /free/u);
    } finally { fx.cleanup(); }
  });

  it('claim and release say exactly what they said before', () => {
    const fx = repoFixture({ name: 'lease-liveness' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const grew = /^mc: (holder \w+|liveness )/mu;
      const claimed = runMcCli(['repo', 'claim', 'repo', 'a round'], fx.env, inArea(fx, 'alpha'));
      assert.match(claimed.stdout, /alpha holds .*a round/u);
      assert.equal(claimed.stdout.split('\n').filter(Boolean).length, 2);
      assert.doesNotMatch(claimed.stdout, grew, 'claiming grew a line it did not have');
      const released = runMcCli(['repo', 'release', 'repo'], fx.env, inArea(fx, 'alpha'));
      assert.match(released.stdout, /released/u);
      assert.doesNotMatch(released.stdout, grew);
    } finally { fx.cleanup(); }
  });
});
