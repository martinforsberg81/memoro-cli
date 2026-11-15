/**
 * A provider's plan refusal, written wherever an unattended session was read.
 *
 * A session whose output says its plan refused it (a quota or rate limit, or a
 * login the tool's plan cannot get past) says nothing about the work, and
 * launching the same provider again would meet the same refusal. The runner
 * has always written that refusal for its own launches (`refuseProvider`); the
 * plan review, helper and manager turns, learning pass and desk preparation
 * parsed the same fields and dropped them. This one function is the rule for
 * all of them, for every tool alike:
 *
 *   - the read is `quota`, or it is `interrupted: 'login'` and the tool's
 *     adapter declares `LOGIN_REFUSES_PLAN`;
 *   - the session ran on the plan route (an API-billed session refused nothing
 *     about the plan);
 *   - the provider is refused until the reset the read names when that lies
 *     ahead, else for `QUOTA_SLEEP_MS` from now.
 *
 * The write is the provider's `refusal_until` in the capacity file, under the
 * runner lock; the runner passes its own `write` so its capacity observation
 * (in memory, flushed by its ticker) stays the one writer inside the runner.
 * A write that fails is said and the caller's own result stands.
 */
import { mkdirSync } from 'node:fs';

import { declared, requireCapability } from '../adapters/index.js';
import { applyRefusal, readCapacity, writeCapacity } from './model-capacity.js';
import { runnerDir, workRoot } from './paths.js';
import { realLock } from './runner-lock.js';
import { QUOTA_SLEEP_MS } from './run-plan.js';

/** The instant a refusal runs until: the reset when it lies ahead of `now`, else `now` + the quota sleep. */
export function refusalInstant(quotaReset, now) {
  const nowMs = now.getTime();
  return quotaReset instanceof Date && quotaReset.getTime() > nowMs ? quotaReset : new Date(nowMs + QUOTA_SLEEP_MS);
}

/** Whether this read means the launch's plan refused it. */
export function planRefused(read, launch) {
  return Boolean(read?.quota) || (read?.interrupted === 'login' && declared(launch.id, 'LOGIN_REFUSES_PLAN') === true);
}

/** The file write: the provider's `refusal_until` under the runner lock. */
function writeRefusal({ env, lock }) {
  return (provider, until) => {
    const root = runnerDir(env);
    mkdirSync(root, { recursive: true });
    lock(workRoot(env), () => writeCapacity(applyRefusal(readCapacity({ root }), provider, until), { root }), { name: 'plan-refusal' });
  };
}

/**
 * Write the plan refusal a read names, if it names one. `billing` is the route's
 * billing (`'plan'` or `'credits'`). Returns `{ provider, until }` when a
 * refusal was written (or attempted: `error` says why it failed), else null.
 */
export function refusePlanOnRead({ read, launch, billing, env = process.env, now = new Date(), lock = realLock, write = writeRefusal({ env, lock }), say = () => {} }) {
  if (billing !== 'plan' || !planRefused(read, launch)) return null;
  const provider = requireCapability(launch.id, 'BILLING_PROVIDER');
  const until = refusalInstant(read.quotaReset, now).toISOString();
  try { write(provider, until); } catch (error) {
    say(`could not record that ${provider} refused its plan until ${until}: ${error.message || String(error)}`);
    return { provider, until, error };
  }
  say(`${provider} refused until ${until}`);
  return { provider, until };
}
