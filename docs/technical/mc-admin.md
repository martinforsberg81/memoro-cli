# `mc-admin` — read-only operations, usage and costs

`mc-admin` prints one production admin snapshot and exits; rerun it to
refresh. `--json` emits the same safe projection in schema version 2. `--help`
is offline. The command refuses live collection in `MC_HEADLESS=1`.

The only reads are GETs under `https://meetmemoro.app/admin/`:
`health`, `operations/status`, `usage-summary` and `costs/summary`, concurrently, with a
10-second timeout, no-store cache headers, redirect rejection and a 1 MiB
response limit per source. There are no retries, configurable destinations,
request bodies, writes, polls or local cache. Exit 0 means all four sources
were accepted and no lagging daily rollup was reported, not that the system
is healthy. Exit 1 means invalid arguments, missing credentials, headless
refusal, runner failure, an unavailable source, partial usage or a daily
usage rollup behind yesterday UTC.

The parent delegates only `scripts/admin-dashboard.js` and an optional
validated `--json` argument to the existing `runScriptWithKeys` boundary.
Only that trusted child reads `ADMIN_TOKEN` from its inherited environment;
the parent never reads dotenv or receives a token value. The child admits
explicit aggregate fields and fixed failure codes; raw responses, errors,
headers, identities and arbitrary nested metadata are excluded. Rerunning is
the refresh mechanism. Operation counts admit only tasksTotal, tasksCompleted,
tasksFailed, tasksRunning, jobs, requests, completedRequests and failedRequests;
new aggregate fields require explicit admission. Service vectorCount is shown
in both output modes, including zero.

The page shows server-owned operation conclusions, source availability and
age, incident group/occurrence aggregates and service statuses. Fetch time and
source ages use the clock after both responses have been collected, so time
spent waiting for responses does not mark fresh source timestamps as future.
Queue health means binding availability only, not delivery health or backlog.
Content, identity, security and account-specific support remain outside this page. The web
links are fallback detail pages. Current production schema/token admission
and terminal appearance remain unverified; fixtures do not establish
production readiness.

## Selected usage and cost data

Usage has five disjoint groups: regular, managed test, managed review, admin
and other managed accounts (sandbox/service).
Admin takes precedence when it is also a managed account; inactive controls do
not exclude an ordinary account. Text shows the exact sum of the validated group
totals, which exclude deleted accounts.

The usage section leads with distinct accounts with signed-in app requests,
distinct accounts that asked the assistant (a separate population), and the
number of assistant questions. It shows the latest nightly UTC date and
distinct populations for the seven inclusive UTC dates ending there, then
the current account total and five group rows. Rollup groups can be revised
for seven days. A complete zero is numeric; an incomplete week says
collecting (since the day after the coverage marker, if known). A missing
rollup date waits for the first nightly rollup and displays only account
totals, not activity counts. Waiting and collecting by themselves are not
errors. A dated rollup older than yesterday UTC keeps its actual dates and
`usage available`, but gets a freshness notice under ATTENTION and exit 1.

The optional daily projection must match the server's allowlist at every
object level. It validates dates, seven-day span, coverage and null states,
safe nonnegative integer counts, group membership and headline sums. For
each population a complete weekly group count must be at least the daily
count and at most the current group total. After deletion or a group change
a historical count can fail this check; the CLI falls back rather than
clipping it. No account ids, names, addresses, arbitrary extension fields
or raw error details reach either output mode.

An older server that omits the extension keeps `usage available` and shows
“Daily usage is unavailable on this server.” followed by the account total
and legacy session-recency report. An explicit daily error or invalid
extension keeps that same legacy report, shows `usage partial` and a fixed
ATTENTION line, and exits 1. Session recency counts distinct active accounts
with an active auth session last seen in yesterday's UTC calendar day or
the trailing 168 hours, not product events or daily active user history.
A return visit or sign-out can change earlier counts. The fallback displays
the server's exact inclusive starts and exclusive ends.

Costs select recorded external-vendor USD this month, AI metered month-to-date
and today's estimated AI USD, retaining server actual/partial/estimate labels.
No vendor import rows means unknown cost, never a zero bill. Through-date and
represented-day count show import coverage; even imported amounts may be
incomplete. AI metering overlaps vendor imports and is never added to them.
No income, margin, projections, plan management, per-user consumer detail or
currency conversions are imported. Missing or malformed sources remain
independently unavailable, with accepted sources still shown and exit 1.

JSON remains schema 2. `sources.usage.data` retains the legacy groups and exact
UTC windows whenever the legacy read is accepted, and adds `dailyUsage`,
null for an omitted or rejected extension. Older clients can ignore the
additive server fields. Fetch-time/age semantics, costs and existing
operation/service fields are retained. A server without the GET-only report
routes still reports those sources unavailable rather than omitting them.
