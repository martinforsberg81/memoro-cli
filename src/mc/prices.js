/**
 * List prices, $ per million tokens, as published 2026-06 and used by the
 * investigation's `usage48h.py`. An estimate for the eye, never what Martin
 * pays: the subscription's quota is the real limit. Cache writes are billed
 * at 1.25× input, cache reads at 0.1× input.
 */
export const PRICES_DATED = '2026-06';

export const PRICES = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
});

/** The short names the runner and `--model` use, to a priced family. */
const ALIASES = { opus: 'claude-opus-5', fable: 'claude-fable-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };

export function priceFor(model) {
  const name = ALIASES[model] || model || '';
  let best = null;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (name.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, price };
  }
  return best?.price || null;
}

/** Dollars for one usage line, or null when the model is not in the table. */
export function estimateCost({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}, model) {
  const p = priceFor(model);
  if (!p) return null;
  return (input * p.input + output * p.output + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1) / 1e6;
}
