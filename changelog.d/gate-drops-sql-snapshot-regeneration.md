section: Fixed

- **The gate no longer regenerates memoro's SQL snapshots.** memoro #14313
  (sql-shape-rules step 1) removed `sql:inventory`, `sql:coverage` and the
  files they wrote under `docs/plans/sql/`. memoro's gate declaration still
  ran both after merging main in, so every round after that landing went red
  on `derived: npm run sql:inventory -- --write failed — Missing script`. Both
  entries are gone; the build and token regenerations stay.
