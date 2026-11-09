# mc status — gone, and where the page went

`mc status` answers about nothing any more. **The page is `mc`** (decision
mc-3, 2026-08-29) — one surface that lists, and no other — and `mc status
<name>`, which answered about one project, went with projects on 2026-11-03
(see [mc-goals.md § From a project](mc-goals.md#from-a-project)); one goal
is shown by `mc goal show <programme>/<goal>`. So the verb, with or without a
name, says where things went and exits 2:

```
mc: mc status is now mc — one page, and it is what mc prints
    mc                  the page, and at a terminal a way in
    mc --json           the same page, as one object
    mc goal show <programme>/<goal>   one goal
```

The page itself is [`docs/technical/mc-ui.md`](mc-ui.md). What it reads:
`nowBlock` and `pidAlive` in
`src/mc/status-collect.js`, and the price table in `src/mc/prices.js`. The
routing is `src/mc-verbs.js`, and `tests/mc/front-door.test.js` runs it.

## The cost estimate

`prices.js` is a dated list-price table: Anthropic's `PRICES_DATED = '2026-06'`
and OpenAI's `OPENAI_PRICES_DATED = '2026-11-09'` (standard tier, short
context, from platform.openai.com/docs/pricing).

The two providers count cached tokens differently, and `estimateCost` follows
each:

- **Anthropic:** `input_tokens` exclude the cache. Without a TTL split:
  cache writes at 2× input and cache reads at 0.1× input. A write is priced at the TTL it carried — 1.25× input for 5 minutes, 2× for
  1 hour — and at 2× when the usage line does not split it (the claude
  default). Since ruling 40 the TTL is the role's (build and review 5m, the
  rest 1h). `streamSummary` sums each message's `usage.cache_creation` split
  (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`) and hands it to
  `estimateCost`.
- **OpenAI:** `input_tokens` include `cached_input_tokens` (runs.tsv's
  `cache_read` for a codex row), so the uncached part is the difference, and
  cached input has its own listed price (gpt-6.1-sol $0.10 against $2.00).
  Codex reports no cache-write tokens; writes are priced as plain input, an
  underestimate of at most the 1.25× 30-minute write premium.

`estimateCost` returns dollars for one usage line, or `null` for a model not in
the table. `rowCost` prices one runs.tsv row by its own `model`; a row from
before the `model` column is priced at the runner's model, `opus`
(`RUNNER_MODEL`).

Two things are true about the number and both are printed with it:

- **It is a list-price estimate, never what Martin pays.** The subscription's
  quota is the real limit; the page says so and points at `/status`.
- **Each session is priced at its own model.** `runnerSection` sums `rowCost`
  over the day's rows; `day.unpriced` counts rows with tokens whose model has
  no price. (Until 2026-11-09 every token was priced as Opus input, which put
  codex's cached input at full price and the day at roughly nine times its
  list cost.)

The estimate is large and dominated by cache reads: a historical day of about 30 sessions
comes to roughly $120 list. The number is only summed on the page.

Interactive sessions are out of scope: `runs.tsv` is the runner's own
accounting and nothing else is counted.

## Current disk state

The page's current disk row is the fresh `diskSummary` measurement collected
in `page-collect.js` and drawn by `page-render.js`; the runner's `disk.json`
refusal is kept only as historical structured data. Cleanup pressure starts
below 30 GB, but the page pauses new sessions only when `admission_blocked`
is true: below 20 GB or with an unknown reading. Between 20 and 30 GB cleanup
can retry toward 40 GB while sessions remain allowed. Current pressure and a
failed measurement remain visible, with a future retry time only while active
at the page collection observation time.
The state is shared with `mc tidy`; see [mc-tidy.md § Disk pressure](mc-tidy.md#disk-pressure).

