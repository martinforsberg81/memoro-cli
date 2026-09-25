/**
 * List prices, $ per million tokens, as published 2026-06 (sonnet-5 corrected
 * 2026-09-25 to its listed 2/10) and used by the investigation's `usage48h.py`.
 * An estimate for the eye, never what Martin pays: the subscription's quota
 * is the real limit. Cache reads are billed at 0.1× input. Cache writes are
 * 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL — and Claude
 * Code writes the 1-hour one (a step session's result line carries
 * `ephemeral_1h_input_tokens`, never the 5m counter; measured 2026-09-25 on
 * 2.1.280), so 2× is what a session's cache_write costs.
 */
export const PRICES_DATED = '2026-06';
export const CACHE_WRITE_FACTOR = 2;
export const CACHE_READ_FACTOR = 0.1;

export const PRICES = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
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
  return (input * p.input + output * p.output + cacheWrite * p.input * CACHE_WRITE_FACTOR + cacheRead * p.input * CACHE_READ_FACTOR) / 1e6;
}
