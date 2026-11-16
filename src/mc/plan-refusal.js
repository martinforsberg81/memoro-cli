/**
 * A provider's plan refusal, written wherever an unattended session was read.
 *
 * A session whose output says its plan refused it (a quota or rate limit, or a
 * login the tool's plan cannot get past) says nothing about the work, and
 * launching the same provider again would meet the same refusal. The runner
 * has always written that refusal for its own launches (`refuseProvider`); the
 * helper and manager turns, learning pass and desk preparation
 * parsed the same fields and dropped them. This one function is the rule for
 * all of them, for every tool alike:
 *
 *   - the read is `quota`, or it is `interrupted: 'login'` and the tool's
 *     adapter declares `LOGIN_REFUSES_PLAN`;
 *   - the session ran on the plan route (an API-billed session refused nothing
 *     about the plan);
 *   - what is refused is the launch's model when the read is a quota and the
 *     tool's adapter declares `QUOTA_SCOPE` 'model' (agy: a spent model says
 *     nothing about the plan's others), else the whole provider — a login
 *     refusal, and a quota the adapter declares 'plan' (claude, codex);
 *   - the refusal runs until the reset the read names when that lies ahead,
 *     else for `QUOTA_SLEEP_MS` from now.
 *
 * The write is the provider's `refusal_until`, or its `model_refusals` entry
 * for the model, in the capacity file, under the runner lock; the runner passes its own `write` so its capacity observation
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

/**
 * Whether a read's quota is the plan's (every model of the provider is refused
 * with it, and every lane may sleep on it) or one model's. A tool that declares
 * no `QUOTA_SCOPE` is refused, as the other seams do.
 */
export function quotaScopeOf(launch) {
  return requireCapability(launch.id, 'QUOTA_SCOPE');
}

/** The fields of a turn's result that say whether its quota may pause every lane (`quotaScope`). */
export function quotaFields(read, launch) {
  return read?.quota ? { quotaScope: quotaScopeOf(launch) } : {};
}

/** The file write: the provider's `refusal_until`, or the model's `model_refusals` entry, under the runner lock. */
function writeRefusal({ env, lock }) {
  return (provider, until, model = null) => {
    const root = runnerDir(env);
    mkdirSync(root, { recursive: true });
    lock(workRoot(env), () => writeCapacity(applyRefusal(readCapacity({ root }), provider, until, model), { root }), { name: 'plan-refusal' });
  };
}

/**
 * Write the plan refusal a read names, if it names one. `billing` is the route's
 * billing (`'plan'` or `'credits'`); `model` is the model the launch ran. Returns
 * `{ provider, model, until }` when a refusal was written (or attempted: `error`
 * says why it failed), else null; `model` is null for a provider-wide refusal.
 * A model-scoped quota whose launch names no model is written provider-wide.
 */
export function refusePlanOnRead({ read, launch, model = null, billing, env = process.env, now = new Date(), lock = realLock, write = writeRefusal({ env, lock }), say = () => {} }) {
  if (billing !== 'plan' || !planRefused(read, launch)) return null;
  const scope = read.quota ? quotaScopeOf(launch) : 'plan';
  const provider = requireCapability(launch.id, 'BILLING_PROVIDER');
  const refusedModel = scope === 'model' && model ? model : null;
  const until = refusalInstant(read.quotaReset, now).toISOString();
  const what = refusedModel ? `${provider}:${refusedModel}` : provider;
  try { write(provider, until, refusedModel); } catch (error) {
    say(`could not record that ${what} refused its plan until ${until}: ${error.message || String(error)}`);
    return { provider, model: refusedModel, until, error };
  }
  say(`${what} refused until ${until}`);
  return { provider, model: refusedModel, until };
}
