---
status: ready
next: "Step 2 — the plan role and the runner's triage prompt end with `mc merge <repo> <pr> --docs`, so a plan lands the moment it is opened — done when a plan written by `mc plan` is on main without Martin clicking, observed once."
budget: 150k
needs: []
---

# mc merge — one verb for landing a pull request

## Goal

`mc merge <repo> <pr>` is the only way a pull request lands through mc.
Two forms, one door: the gate round (what `mc repo merge` was — lease, fresh
baseline, candidate with main merged in, the suite on both, squash) and
`--docs`, which lands a pull request that touches nothing outside `docs/`
without a suite, because there is nothing to run. `--docs` exists so that a
plan PR — the deliverable of `mc plan` and of the runner's triage — is on
main seconds after it is opened, by the session that opened it; today it
waits for a click and the runner does not see it (Martin, 2026-08-26:
"inte tillräckligt smidigt"). `mc repo merge` is gone, not aliased.

## Success criteria

- [ ] `mc merge <repo> <pr> [<pr>...] [--check] [--json]` does exactly what
      `mc repo merge` did, through the same `runGate`/`runMergeRound`.
- [ ] `mc merge <repo> <pr> --docs`: reads the PR's files with `gh`; refuses,
      naming the first file, if any path is outside `docs/`; refuses a draft
      or a closed PR; waits for GitHub's mergeability (up to ~60 s); squash-
      merges with subject `<title> (#<n>)`; reads the merge commit back and
      prints it; records a round with `mode: docs` in the repo round log.
      No suite, no lease, no worktree, no model.
- [ ] `--docs` with several PRs, or with `--check`, is refused.
- [ ] `mc repo merge …` prints one line — "mc repo merge is now mc merge" —
      and exits 2; it is not in `mc repo`'s usage or help.
- [ ] Help text: `mc merge` block replaces the `mc repo merge` block.
- [ ] Tests: the docs form on a stubbed `gh` (docs-only merges; one file
      outside docs refuses; draft refuses; batch refuses); the gate form's
      argument errors moved from `repo merge` to `merge`.

## Contract

- The gate form's behaviour does not change in this project — only its name.
- `--docs` never merges a file outside `docs/`. The check is on the PR's
  file list from GitHub, not on a local diff.
- Merge authority is still Martin's: `--docs` is a standing rule he gave
  (docs-only lands directly), written once in the roles; anything else is
  the gate.

## Steps

- [x] **1. The verb** (2026-08-26; the plan role's last line also lands the PR)
      — — `src/mc/commands/merge.js`, `src/mc/docs-merge.js`,
      the pointer in `repo.js`, help, tests. Done when both forms run from
      `mc merge` and `mc repo merge` only points.
- [ ] **2. Roles and runner** — `canon/roles/plan.md` and
      `~/mc/bin/runner.sh`'s triage prompt end with the docs merge. Done
      when a plan lands without a click, once, in `runner.log` or a plan
      session's last line.
- [ ] **3. Close-out** — `docs/technical/mc-merge.md`, `project_log.md`.

## What the code taught us

- The gate's argument grammar lived inside `repo.js`'s `parseArgs`; it is
  now `parseMergeArgs`, exported, and `mc repo merge` answers only with
  where it went. `gate()` and `resolveRepoPath()` are exported for the new
  door; nothing in the round itself moved.
- `--docs` is not run live yet: no docs-only PR was open when it was
  built. The first `mc plan` PR after this lands is the live test.

## Documents

- `src/mc/repo-merge.js`, `src/mc/repo-gate.js` — the gate round, unchanged
- `~/mc/runner/log/natt-1.md` §"Vad som gick fel" 2 — plan PRs are docs-only and should land first
- `docs/project/mc/mc-plan/PLAN.md` — the writer of the PRs this lands
