/**
 * Mechanisms that should be in force, and whether they are.
 *
 * Five times in one week something was built, merged, and not in force: the
 * guard on 24-hour-old code (188 knocks, none landed), `mc suite claim`'s
 * exit code one step from the action, `changelog.d` bypassed by mc's own
 * repository, #381 conflicted for fourteen hours, and the push-guard merged
 * and installed nowhere (D-0180, fifth instance, 2026-08-24). Five instances
 * are not five mistakes; they are a shape — and the shape survives because
 * discovering each one takes somebody remembering to ask.
 *
 * So the asking is a list, and the list is read by something that already
 * runs: `mc doctor` carries it, and the runner's own rounds call it. What
 * belongs on it is judgement; the rule of membership is narrow on purpose:
 * a mechanism that *exists on this machine* and is *not doing its job right
 * now*. Never a style opinion, never a wish — those would train the reader to skim, which is the failure
 * mode this list exists to end.
 *
 * Everything is read, nothing is fixed: this flags and does not decide.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { mcHome } from './paths.js';
import { pushGuardState } from './push-guard.js';
import { readRatchet } from './red-ratchet.js';
import { readRounds } from './repo-round-log.js';
import { knownRepositories } from './work-area.js';
import { workRoot } from './paths.js';

/**
 * Every mechanism not in force, each as one plain sentence.
 *
 * Empty means everything that exists here is doing its job — it never means
 * "nothing was checked", because a check that cannot run reports itself as
 * a broken mechanism rather than staying quiet.
 */
export function notInForce({ root = mcHome(), env = process.env, deps = {} } = {}) {
  const broken = [];
  const safely = (what, fn) => {
    try { fn(); } catch (error) {
      broken.push(`${what} could not be checked: ${error?.message || String(error)}`);
    }
  };

  // The push-guard, per repository mc can see. Merged 2026-08-24 and
  // installable on neither of the repos it exists for — found only because
  // PM happened to run the install two minutes later.
  safely('push-guard', () => {
    for (const repo of (deps.repos || knownRepositories)(env)) {
      const state = (deps.guardState || pushGuardState)(repo);
      if (state.installed) continue;
      broken.push(`push-guard is not in force on ${basename(repo)} — ${state.reason || 'not installed'}; mc repo guard ${basename(repo)}`);
    }
  });

  // The red floor, for a repository whose last gate round stood on red.
  // A floor nobody recorded is a comparison the next round cannot make
  // (the 57 that passed through, 2026-08-23). A repository whose rounds
  // are green needs no floor and earns no line.
  //
  // Fed by `standing_red`, which rounds stopped writing on 2026-08-31 when
  // the baseline went (see `red-ratchet.js`). So this answers only from the
  // lines written before that, and goes quiet as they age out. Left standing
  // rather than removed: whether main keeps a floor anywhere is an open
  // question, and this is the only place still asking it.
  safely('red-ratchet', () => {
    const rounds = (deps.rounds || (() => readRounds({ root }).rounds))();
    const latest = new Map();
    for (const round of rounds) if (round.repo) latest.set(round.repo, round);
    for (const repo of (deps.repos || knownRepositories)(env)) {
      const last = latest.get(basename(repo));
      if (!last || !(last.standing_red > 0)) continue;
      const ratchet = (deps.ratchet || readRatchet)(repo);
      if (!ratchet.present) broken.push(`red-ratchet is not in force on ${basename(repo)} — the last gate round stood on ${last.standing_red} red and no floor is recorded`);
    }
  });

  return broken;
}
