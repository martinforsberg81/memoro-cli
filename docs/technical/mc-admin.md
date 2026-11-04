# `mc-admin` — first read-only operations page

`mc-admin` prints one production operations snapshot and exits; rerun it to
refresh. `--json` emits the same safe projection in schema version 1. `--help`
is offline. The command refuses live collection in `MC_HEADLESS=1`.

The only reads are `GET https://meetmemoro.app/admin/health` and
`GET https://meetmemoro.app/admin/operations/status`, concurrently, with a
10-second timeout, no-store cache headers, redirect rejection and a 1 MiB
response limit per source. There are no retries, configurable destinations,
request bodies, writes, polls or local cache. Exit 0 means both source shapes
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
age, incident group/occurrence aggregates and service statuses. Queue health
means binding availability only, not delivery health or backlog. Financial,
user, content, identity and security dashboards are not connected. The web
links are fallback detail pages. Current production schema/token admission
and terminal appearance remain unverified; fixtures do not establish
production readiness.
