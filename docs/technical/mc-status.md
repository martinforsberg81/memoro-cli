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

`prices.js` is a dated list-price table — `PRICES_DATED = '2026-06'` — with
cache writes at 2× input and cache reads at 0.1× input when a usage line
does not say which TTL it wrote (2× is the 1-hour rate, the claude default).
A write is priced at the TTL it carried — 1.25× input for 5 minutes, 2× for
1 hour — and since ruling 40 that TTL is the role's (build and review 5m,
the rest 1h). `streamSummary` sums each message's `usage.cache_creation`
split (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`) and hands
it to `estimateCost`, which returns dollars for one usage line, or `null`
for a model not in the table.

Two things are true about the number and both are printed with it:

- **It is a list-price estimate, never what Martin pays.** The subscription's
  quota is the real limit; the page says so and points at `/status`.
- **The page still aggregates at one model.** It sums usage at the runner's
  model, `opus` (`RUNNER_MODEL` in `status-collect.js`). Current runs.tsv
  rows carry their routed model, but `runnerSection` does not yet price that
  split. A non-Opus session can therefore be mispriced here.

The estimate is large and dominated by cache reads: a historical day of about 30 sessions
comes to roughly $120 list. The number is only summed on the page.

Interactive sessions are out of scope: `runs.tsv` is the runner's own
accounting and nothing else is counted.

