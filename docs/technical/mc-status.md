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

`prices.js` is a dated list-price table: Anthropic's `PRICES_DATED = '2026-11-09'`
(platform.claude.com/docs/about-claude/pricing, standard tier, global
routing) and OpenAI's `OPENAI_PRICES_DATED = '2026-11-09'` (standard tier,
short context, platform.openai.com/docs/pricing). The runner's aliases are
priced as the models claude resolves them to: `opus` is Opus 5.5 ($4/$20),
`sonnet` Sonnet 5.5, `haiku` Haiku 5.5, `fable` Fable 5.1.

The two providers count cached tokens differently, and `estimateCost` follows
each:

- **Anthropic:** `input_tokens` exclude the cache. Without a TTL split:
  cache writes at 2× input and cache reads at 0.1× input, unless the model
  lists its own read price — 0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on
  Fable 5.1. A write is priced at the TTL it carried — 1.25× input for 5
  minutes, 2× for 1 hour — and at 2× when the usage line does not split it
  (the claude default). Since ruling 40 the TTL is the role's (build and
  review 5m, the rest 1h).
- **Haiku 5.5's long-prompt tier:** a request whose prompt (input, cache
  reads and cache writes) is over 100,000 tokens costs 5× ($0.50/$2.50).
  Only a single request can be tiered, so `streamSummary` prices every
  message on its own (`estimateCost(…, { request: true })`). Measured
  2026-11-09: 57 % of Haiku's prompt tokens were in requests over the line.
- **OpenAI:** `input_tokens` include `cached_input_tokens` (runs.tsv's
  `cache_read` for a codex row), so the uncached part is the difference, and
  cached input has its own listed price (gpt-6.1-sol $0.10 against $2.00).
  Codex reports no cache-write tokens and no per-request usage; writes are
  priced as plain input and no long-context tier is applied, so a codex
  session is a lower bound.

A runner session's cost is recorded when it ends, in runs.tsv's `cost`
column (dollars, four decimals). A claude session that answered records
claude's own `total_cost_usd` (`costBasis: 'list'`), which prices every
request at its tier; checked by hand on 2026-11-09 against a Haiku 5.5
session ($3.04 computed, $3.02 reported). A claude session ended before its
result line (a landing through `mc merge`) is priced from its stream message
by message; the stream's `output_tokens` are each message's count when it
started, so that cost leaves out most of the output. Codex is priced on its
totals. `rowCost` takes that recorded cost; a row without one
(before 2026-11-09) is priced on its totals by its own `model`, at the base
tier — an underestimate for long Haiku prompts — and a row from before the
`model` column at the runner's model, `opus` (`RUNNER_MODEL`).
`estimateCost` returns dollars for one usage line, or `null` for a model not
in the table.

Two things are true about the number and both are printed with it:

- **It is a list-price estimate, never what Martin pays.** The subscription's
  quota is the real limit; the page says so and points at `/status`.
- **Each session is priced at its own model.** `runnerSection` sums `rowCost`
  over the day's rows; `day.unpriced` counts rows with tokens whose model has
  no price. (Until 2026-11-09 every token was priced as Opus 5 input, which
  put codex's cached input at full price and the day at roughly nine times
  its list cost.)

The number is only summed on the page.

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

