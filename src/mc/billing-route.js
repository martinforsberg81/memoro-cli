/** One plan-first billing answer for both providers and every session role. */
import { fileURLToPath } from 'node:url';

import { readBillingApi, readBillingState } from './billing.js';
import { providerAt, readCapacity } from './model-capacity.js';
import { runnerDir } from './paths.js';

const WRAPPER = fileURLToPath(new URL('./billing-gateway-session.js', import.meta.url));
const after = (value, now) => Number.isFinite(Date.parse(value || '')) && Date.parse(value) > now.getTime();

/**
 * `api` is `readBillingApi`'s `{ claude, codex }`: a provider switched off
 * stays on its plan when the plan is spent, and the session meets the plan's
 * own refusal instead of the API key. Absent, both are on.
 */
export function billingRoute({ provider, capacity, state, api, now = new Date() } = {}) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('unknown billing provider');
  const standing = providerAt(capacity, provider, now);
  const refused = standing.refusal_until || (provider === 'claude' && after(state?.plan?.refused_until, now) ? state.plan.refused_until : null);
  const full = Object.values(standing.windows).filter((window) => window.status === 'known' && window.fraction_used >= 1);
  const spent = refused ? `plan refused until ${refused}` : full.length ? 'plan reached 100 %' : null;
  if (spent && api?.[provider] === false) return { billing: 'plan', why: `${spent}; API off` };
  if (spent) return { billing: 'credits', why: spent };
  const windows = Object.values(standing.windows);
  const unknown = windows.some((window) => window.status !== 'known');
  const why = standing.status === 'failed' ? 'last usage read failed; subscription availability unknown'
    : standing.status === 'stale' ? 'usage is stale; subscription availability unknown'
      : standing.status === 'unobserved' ? 'plan status unknown'
        : unknown ? 'subscription usage unknown' : 'plan available';
  return { billing: 'plan', why };
}

/** Preserve a chooser's API reserve (including model unavailability), but never override API off. */
export function billingRouteNow(provider, { now = new Date(), env = process.env, capacity = readCapacity({ root: runnerDir(env) }), state = readBillingState({ root: runnerDir(env) }), api = readBillingApi({ root: runnerDir(env) }), route = null } = {}) {
  if (route?.billing === 'credits') return api?.[provider] === false
    ? { billing: 'unavailable', why: `${route.why}; ${provider} API off` }
    : { billing: 'credits', why: route.why };
  return billingRoute({ provider, capacity, state, api, now });
}

/** Compact, secret-free status for the single MC billing line. */
export function billingStatus({ capacity, state, api, now = new Date() } = {}) {
  return ['claude', 'codex'].map((provider) => {
    const standing = providerAt(capacity, provider, now);
    const windows = Object.values(standing.windows).filter((window) => window.status === 'known');
    const used = windows.length ? `${Math.round(Math.max(...windows.map((window) => window.fraction_used)) * 100)}%` : '?';
    const freshness = standing.status === 'failed' ? ' (read failed)' : standing.status === 'stale' ? ' (stale)' : '';
    const route = billingRoute({ provider, capacity, state, api, now });
    return `${provider} ${used}${freshness} ${route.billing === 'plan' ? 'plan' : 'API'}${api?.[provider] === false ? ' (API off)' : ''}`;
  }).join(' · ');
}

/** Replace a tool launch only when its provider's plan is spent. */
export function gatewayLaunch({ provider, model, bin, args, billing } = {}) {
  if (billing !== 'credits') return { bin, args };
  if (!provider || !bin || !Array.isArray(args)) throw new Error('API launch needs provider and tool');
  return { bin: process.execPath, args: [WRAPPER, provider, model || '*', bin, ...args] };
}
