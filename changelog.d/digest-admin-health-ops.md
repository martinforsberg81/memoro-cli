section: Changed

- **The helper digest reads service health and the operations projection.**
  memoro #12461 put `GET /admin/health` and `GET /admin/operations/status` on
  the admin-token surface (production build 24645, 2026-10-03), so the digest
  now asks both with the token it already uses. Health renders the overall
  verdict and one row per service — secrets, D1, R2, KV, both Vectorize
  indexes, queues — with `/ping-d1` kept beside it as the reading that needs
  no credential. The standing "Not readable" section is replaced by
  "Operations": one row per operation with the server's conclusion, the
  nightly tasks that did not complete, and the incident summary. New
  conditions for the delta: `health-<service>`, `nightly-tasks-failed`,
  `nightly-stale` and `operations-action-<key>` (one stable name per
  operation, so the claims resolver's standing backlog is new once). Both
  routes count towards `networkDown`, and an offline run raises none of them.
