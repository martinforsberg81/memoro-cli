# Where a step's time goes — measured 2026-09-03

Produced by [`measure.py`](measure.py) beside this file, over every step
session the runner started 2026-09-01..03 (`--since 2026-09-01 --until
2026-09-04`), plus `runner.log` and `gate-rounds.jsonl` for the parts a
session cannot see. 60 sessions with ≥10 turns, all 60 with a transcript.
Rerun the script for the window after the changes in step 1 landed; the
table to compare against is the one below.

## The session

| | median | p75 | p90 | max |
|---|---|---|---|---|
| session wall-clock | 19.1 min | 36.4 | 59.1 | 72.2 |
| of which API (model) time | 11.9 min | 22.0 | 33.3 | 38.3 |
| turns | 76 | 121 | 202 | 352 |
| cost | $5.8 | 14.2 | 27.1 | 51.1 |
| test-class commands per session | 11 | 21 | 28 | 43 |
| model time per turn | 4.3 s | 9.0 | 18.8 | — |

Over the whole 2026-08-25..09-03 history (`runs.tsv`, 306 step rows) the
median step is 12.5 min, p75 25.9, p90 45.5 — the September sessions are the
longer ones.

**Tool calls: 5 598 through Bash against 255 native `Read`/`Grep`/`Glob`/
`Edit`/`Write`.** 2 803 of the Bash calls are `sed -n`, `grep -n`, `cat` — a
screen of a file at a time, each one a model turn. Their tool time is 0.5 h;
their model time is roughly half of every session's API time. This is what
`--permission-mode auto` asks for (it tells the session to work through Bash,
and routes each call through a classifier), and it is why step 1 launches
the session with `acceptEdits` instead.

**Where the tool time went (12.5 h over 60 sessions):**

| class | calls | wall | share |
|---|---|---|---|
| tests (`npm test`, `node --test`, `npm run ci`, `test:*`) | 784 | 6.6 h | 50 % |
| other (dev servers, screenshots, proof scripts) | 612 | 2.7 h | 21 % |
| poll/wait (`sleep` loops around a backgrounded test) | 216 | 1.9 h | 15 % |
| write/script (`cat >`, `python3 -`, `node -e`) | 525 | 0.8 h | 6 % |
| read/search via Bash | 2 803 | 0.5 h | 3 % |
| git/gh | 608 | 0.4 h | 3 % |

Of the 630 test commands in the 2026-09-01..03 window, 170 were the exact
command a session had already run. Full-suite runs (`npm test`, `npm run ci`)
took a median 6 s (selection empty) but p75 111 s and p90 147 s; 18 Bash
calls were killed at claude's 120 s default timeout, after which the session
backgrounded the run and polled it in 120 s `sleep` loops — the 1.9 h above.
Step 1 gives the session a 10-minute Bash ceiling and tells the role to run
the selection once.

## The runner and the gate

Neither is where the time is.

| | n | median | p90 | max |
|---|---|---|---|---|
| landing a step (`land=` in runner.log, since 09-02) | 21 | 0.9 min | — | 4.4 |
| runner overhead per step (wall − session − land) | 64 | 1 s | — | 30 s |
| gate round, memoro, merge, green (`gate-rounds.jsonl`) | 65 | 0.8 min | 7.6 | 21.6 |
| gate round, memoro-cli, merge, green | 32 | 1.5 min | 4.0 | 6.8 |
| of a memoro gate round: the suite | 48 | 1.6 min | 4.8 | 12.3 |

**Gate-lock refusals** (`another gate round is running` in `gate-rounds.jsonl`
reasons): 9 in the whole file, 0 since 2026-09-02. The refusal is real but
rare under two lanes; step 3 makes it a wait rather than a loss before the
lane count can rise.

## The lanes

Between 2026-09-02 00:00 and 09-03 11:00 (`runner.log`):

| lane | steps | span | busy | idle |
|---|---|---|---|---|
| memoro | 38 | 35.3 h | 20.2 h | 43 % |
| memoro-cli | 23 | 17.9 h | 7.9 h | 56 % |

The idle time was not the runner sleeping. It was awake and logging 200–600
lines an hour of things it could not run:

- **2026-09-02 13:00–19:00:** every memoro plan's next step was `blocked`
  (26 of 33 still are — 18 on `plan-review`, see step 0's audit).
- **2026-09-02 22:00–09-03 04:00 and intermittently since 08-30:** ~30 plans
  "do not parse" — the `what_the_code_taught_us` → `comments` migration
  (#528) left the runner's checkout and main disagreeing until the runner
  was restarted 09-03 10:22.
- **Every round:** `email-window-layout` — third in `queue.md` — skipped on
  "dirty worktree" 134 times, `home-on-msr` 142 times, `inbox-finish` 103
  times. Three modified files nobody had committed. Step 1 makes the line name
  the files; the two workareas were committed by hand on 09-03.
- **A round is as long as the slower lane.** `round()` ran the two lanes under
  one `Promise.all`, so memoro-cli's lane sat idle whenever memoro's had a
  long list — and a memoro-cli step that became ready in that time waited for
  a round boundary nobody needed. Step 1 gives each lane its own rounds.
- 28 "staying on" lines: after a merge the runner stays on the same project
  for up to 8 steps, so `action-window` had 6.8 h of the memoro lane while
  `email-verification-round` and `items-sweep` in `queue.md` waited.

## What this says about four lanes

The lane was busy 44–57 % of the time, and its busy time is dominated by the
session's own turns and test reruns — not by the gate, not by the runner. Four
lanes would multiply the same sessions. The order that follows is the plan's:
fewer turns and one test run first (step 1), measured again (step 2), the gate
lock queueing instead of refusing (step 3), and only then the count (step 4).

## After — the first sessions on the step-1 launch

`measure.py --since 2026-09-03T19:35 --until 2026-09-05 --min-turns 5`, run
at 2026-09-03 21:00Z: **4 sessions** (mc-cut ×2, mc-workarea-deps,
email-window-layout). Four is what existed; Martin chose not to wait for
twenty (*"20 är bara taget ur luften"*).

| | before (60) | after (4) |
|---|---|---|
| session wall-clock, median | 19.1 min | 16.3 min |
| API (model) time, median | 11.9 min | 9.6 min |
| turns, median | 76 | 78 |
| test-class commands per session, median | 11 | 4 |
| poll/wait share of tool time | 15 % | 0 % (one call) |
| Bash calls : native Read/Grep/Edit/Write | 5 598 : 255 | 188 : 142 |
| Bash calls killed at the 120 s timeout | 18 | 0 |
| cost, median | $5.8 | $8.7 |

What moved: the verification half. Test commands per step fell from 11 to
4, the `sleep`-loop polling is gone, and reads go through `Read` rather than
`sed -n`. Tool time is now a few minutes of a step, not half of it.

What did not: **turns**. A step is still ~78 model turns at ~4.5 s each, and
that is now nearly the whole of its wall-clock. Cost per session is up
because the same turns read whole files instead of screens — more tokens per
turn, fewer wasted calls — and four sessions is too few to call that a trend.

**Recommendation (step 3):** a step's wall-clock is model time now, and no
runner setting shortens a model turn. Throughput from here is lanes.
`landPr` waits for a held gate instead of parking the project (step 2), so a
second lane per repository costs nothing it did not already cost. Start at
`mc run lanes 2` — four sessions on this machine, which is what Martin asked
for — and read `runner.log` for `waiting for the gate` lines and the page for
memory before going to 3. Gate-lock refusals since 2026-09-02: 0 before this
change; the lines to count afterwards are `waited Ns for the gate`.
