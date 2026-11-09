/**
 * List prices, $ per million tokens, as published 2026-06 (sonnet-5 corrected
 * 2026-09-25 to its listed 2/10) and used by the investigation's `usage48h.py`.
 * An estimate for the eye, never what Martin pays: the subscription's quota
 * is the real limit. Cache reads are billed at 0.1× input. A cache write's
 * factor follows the TTL it carried: 1.25× input for 5 minutes, 2× for 1
 * hour. Since ruling 40 the TTL is the session's role (`step` 5m,
 * every other role 1h), and a message's `usage.cache_creation` splits the
 * write into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. A
 * usage line without the split is priced at 2×: the 1-hour claude default.
 */
export const PRICES_DATED = '2026-06';
export const CACHE_WRITE_5M_FACTOR = 1.25;
export const CACHE_WRITE_1H_FACTOR = 2;
export const CACHE_READ_FACTOR = 0.1;

/**
 * OpenAI's standard (not Flex/Batch, not Fast) short-context list prices, as
 * published on platform.openai.com/docs/pricing, read 2026-11-09. OpenAI
 * counts differently from Anthropic: its `input_tokens` already include the
 * `cached_input_tokens`, so the uncached part is the difference, and a cached
 * token has its own listed price rather than a factor. Codex reports no
 * cache-write tokens, so writes are priced as plain input (an underestimate
 * of at most the 30-minute write premium, 1.25×).
 */
export const OPENAI_PRICES_DATED = '2026-11-09';

export const PRICES = Object.freeze({
  'gpt-6-astra': { input: 10, output: 50, cachedInput: 1, inputIncludesCached: true },
  'gpt-6.1-sol': { input: 2, output: 10, cachedInput: 0.1, inputIncludesCached: true },
  'gpt-6.1-terra': { input: 1, output: 5, cachedInput: 0.05, inputIncludesCached: true },
  'gpt-6-sol': { input: 2, output: 10, cachedInput: 0.2, inputIncludesCached: true },
  'gpt-6-luna': { input: 0.1, output: 0.5, cachedInput: 0.01, inputIncludesCached: true },
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

/**
 * Dollars for one usage line, or null when the model is not in the table.
 * `cacheWrite5m`/`cacheWrite1h`, when either is given, replace `cacheWrite`.
 */
export function estimateCost({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite5m, cacheWrite1h } = {}, model) {
  const p = priceFor(model);
  if (!p) return null;
  if (p.inputIncludesCached) {
    const cached = Math.min(cacheRead, input);
    return ((input - cached) * p.input + cached * p.cachedInput + output * p.output) / 1e6;
  }
  const split = cacheWrite5m != null || cacheWrite1h != null;
  const writes = split
    ? (cacheWrite5m || 0) * CACHE_WRITE_5M_FACTOR + (cacheWrite1h || 0) * CACHE_WRITE_1H_FACTOR
    : cacheWrite * CACHE_WRITE_1H_FACTOR;
  return (input * p.input + output * p.output + writes * p.input + cacheRead * p.input * CACHE_READ_FACTOR) / 1e6;
}

/**
 * One runs.tsv row's list-price estimate, by the model the row names; a row
 * from before the `model` column (or a merge row's `-`) is priced at
 * `fallback`, which is what those sessions ran on. Null when the model has
 * no price, or the row no tokens.
 */
export function rowCost(row, fallback = null) {
  const model = row.model && row.model !== '-' ? row.model : fallback;
  const n = (value) => {
    const v = Number(value);
    return Number.isFinite(v) ? v : 0;
  };
  if (![row.input, row.output, row.cache_read, row.cache_write].some((value) => n(value) > 0)) return null;
  return estimateCost({ input: n(row.input), output: n(row.output), cacheRead: n(row.cache_read), cacheWrite: n(row.cache_write) }, model);
}
