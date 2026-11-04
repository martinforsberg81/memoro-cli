# `mc-admin` — read-only operations, usage and costs

`mc-admin` prints one production admin snapshot and exits; rerun it to
refresh. `--json` emits the same safe projection in schema version 2. `--help`
is offline. The command refuses live collection in `MC_HEADLESS=1`.

The only reads are GETs under `https://meetmemoro.app/admin/`:
`health`, `operations/status`, `usage-summary` and `costs/summary`, concurrently, with a
10-second timeout, no-store cache headers, redirect rejection and a 1 MiB
response limit per source. There are no retries, configurable destinations,
request bodies, writes, polls or local cache. Exit 0 means all four source shapes
were accepted, not that the system is healthy. Exit 1 means usage, missing
credentials, headless refusal, runner failure or an unavailable source.

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
not exclude an ordinary account. Totals exclude deleted accounts. Activity
counts distinct active accounts with an active auth session last seen in each
window, not product events or daily active user history. Yesterday is a UTC
calendar day; seven days is the trailing 168 hours. The server returns the exact
inclusive starts and exclusive ends. No account ids, names, addresses or roles
lists reach either output mode.

Costs select recorded external-vendor USD this month, AI metered month-to-date
and today's estimated AI USD, retaining server actual/partial/estimate labels.
No vendor import rows means unknown cost, never a zero bill. Through-date and
represented-day count show import coverage; even imported amounts may be
incomplete. AI metering overlaps vendor imports and is never added to them.
No income, margin, projections, plan management, per-user consumer detail or
currency conversions are imported. Missing or malformed sources remain
independently unavailable, with accepted sources still shown and exit 1.

JSON schema 2 adds `sources.usage` and `sources.costs`; fetch-time/age semantics
and existing operation/service fields are retained. Server support requires
Memoro's GET-only admin report routes; a server that has not deployed them
reports those sources unavailable rather than silently omitting them.
