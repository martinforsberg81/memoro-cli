/** One plan-first billing answer for every provider that has a plan and every session role. */
import { fileURLToPath } from 'node:url';

import { adapterOfProvider, apiProviders, billingProviders } from '../adapters/index.js';
import { readBillingApi, readBillingState } from './billing.js';
import { providerAt, readCapacity } from './model-capacity.js';
import { runnerDir } from './paths.js';

const WRAPPER = fileURLToPath(new URL('./billing-gateway-session.js', import.meta.url));
// Used only by a runner-owned wrapper and reserved before it starts the tool.
export const RESERVE_UNAVAILABLE_EXIT = 86;
export const RESERVE_DISABLED_EXIT = 87;
export const RESERVE_RETRY_MS = 60_000;

export function gatewayRefusal(launch, result) {
  if (!launch?.reserve || result?.timedOut || result?.stalled || result?.handedOff) return null;
  if (result.admissionWait) return { provider: launch.reserve, wait: result.admissionWait };
  if (result.status === RESERVE_UNAVAILABLE_EXIT) return { provider: launch.reserve, unavailable: true };
  if (result.status === RESERVE_DISABLED_EXIT) return { provider: launch.reserve, unavailable: false };
  return null;
}

export const disabledReserve = provider => `${provider} API off — waiting for an eligible route`;
export const heldReserve = (provider, until) => `${provider} API reserve unavailable before launch — eligible again after ${until}`;

const after = (value, now) => Number.isFinite(Date.parse(value || '')) && Date.parse(value) > now.getTime();

/**
 * `api` is `readBillingApi`'s switch per API provider: a provider switched off
 * stays on its plan when the plan is spent, and the session meets the plan's
 * own refusal instead of the API key. Absent, both are on. `'first'` is on,
 * and a `runner` launch also takes the API key while the plan has room, unless
 * billing-state.json marks the credit unusable. `model` names the
 * model the launch will run: a refusal of that model alone spends the plan for it.
 */
export function billingRoute({ provider, model = null, capacity, state, api, now = new Date(), runner = false } = {}) {
  if (!billingProviders().includes(provider)) throw new Error(`unknown billing provider: ${provider} declares no BILLING_PROVIDER`);
  const standing = providerAt(capacity, provider, now);
  // A model's refusal spends the plan for that model only; another model of the provider still has it.
  const refused = standing.refusal_until || (model ? standing.model_refusals[model] : null) || (adapterOfProvider(provider).PLAN_STATE != null && after(state?.plan?.refused_until, now) ? state.plan.refused_until : null);
  const full = Object.values(standing.windows).filter((window) => window.status === 'known' && window.fraction_used >= 1);
  const spent = refused ? `plan refused until ${refused}` : full.length ? 'plan reached 100 %' : null;
  if (spent && api?.[provider] === false) return { billing: 'plan', why: `${spent}; API off` };
  if (spent && !apiProviders().includes(provider)) return { billing: 'plan', why: `${spent}; no API route` };
  if (spent) return { billing: 'credits', why: spent };
  // API first: a runner session spends the API key while the plan still has room,
  // and goes back to the plan while the credit is marked unusable.
  if (runner && api?.[provider] === 'first' && apiProviders().includes(provider)) {
    const unusable = after(state?.credits?.unusable_until, now) ? state.credits.unusable_until : null;
    if (!unusable) return { billing: 'credits', why: 'API first' };
    return { billing: 'plan', why: `API first, but the API is unusable until ${unusable}${state.credits.why ? ` (${state.credits.why})` : ''}` };
  }
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

/**
 * The refusal a whole provider is held under at `now`, or null: the capacity
 * snapshot's (`{ until, cause, since }`), else, for a provider that keeps plan
 * state, a live `plan.refused_until` of billing-state.json, which a quota
 * wrote (`{ until, cause: 'quota', since: null }`).
 */
export function providerRefusal({ provider, capacity, state, now = new Date() } = {}) {
  const standing = providerAt(capacity, provider, now);
  if (standing.refusal_until) return { until: standing.refusal_until, cause: standing.refusal_cause, since: standing.refusal_since };
  if (adapterOfProvider(provider)?.PLAN_STATE != null && after(state?.plan?.refused_until, now)) return { until: state.plan.refused_until, cause: 'quota', since: null };
  return null;
}

/**
 * Compact, secret-free status for the single MC billing line. A provider held
 * under a refusal says until when, why and since when:
 * `claude 101% (refused until <instant> — quota, first seen <instant>) API`.
 */
export function billingStatus({ capacity, state, api, now = new Date() } = {}) {
  return billingProviders().map((provider) => {
    const standing = providerAt(capacity, provider, now);
    const held = providerRefusal({ provider, capacity, state, now });
    const refused = held ? ` (refused until ${held.until} — ${held.cause}${held.since ? `, first seen ${held.since}` : ''})` : '';
    const windows = Object.values(standing.windows).filter((window) => window.status === 'known');
    const used = windows.length ? `${Math.round(Math.max(...windows.map((window) => window.fraction_used)) * 100)}%` : '?';
    const freshness = standing.status === 'failed' ? ' (read failed)' : standing.status === 'stale' ? ' (stale)' : '';
    const route = billingRoute({ provider, capacity, state, api, now });
    const spent = Object.entries(standing.model_refusals).map(([model, until]) => ` (${model} refused until ${until})`).join('');
    return `${provider} ${used}${freshness}${refused}${spent} ${route.billing === 'plan' ? 'plan' : 'API'}${api?.[provider] === false ? ' (API off)' : api?.[provider] === 'first' ? ' (API first for runner sessions)' : ''}`;
  }).join(' · ');
}

/** Replace a tool launch only when its provider's plan is spent. */
export function gatewayLaunch({ provider, model, bin, args, billing, sessionDirectory = null, runnerAdmission = false } = {}) {
  if (billing !== 'credits') return { bin, args };
  if (!provider || !bin || !Array.isArray(args)) throw new Error('API launch needs provider and tool');
  return {
    bin: process.execPath, args: [WRAPPER, ...(runnerAdmission ? ['--runner-admission'] : []),
      ...(sessionDirectory ? ['--session-directory', sessionDirectory] : []), provider, model || '*', bin, ...args],
    ...(runnerAdmission ? { reserve: provider } : {}),
  };
}
