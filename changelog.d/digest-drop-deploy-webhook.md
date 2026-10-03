section: Removed

- **The helper digest no longer reads memoro's deploy webhook log.** Its
  Deploy section read `GET /admin/deploy/logs` (the `deploy:index` KV key a
  GitHub webhook was meant to fill), found it empty every day and raised
  `deploy-webhook-silent`. memoro removed the webhook, the route and the
  nightly `checkDeployAge` (memoro #12452), so the section now rests on mc's
  own `deploys.tsv` row, `/api/version` and origin/main. The age is the
  fresher of mc's record and the live build time, *unknown* rather than stale
  when neither has one; `deploy-webhook-silent` and `deploy-failures` are gone,
  `deploy-stale` stays.
