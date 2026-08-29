---
status: done
next: "Nothing — the plan is finished. `docs/technical/mc-merge.md` describes both forms of the verb, `docs/project/project_log.md` carries the row, and `docs/mc-command-matrix.md` lists `mc merge` where it listed `mc repo merge`."
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

- [x] `mc merge <repo> <pr> [<pr>...] [--check] [--json]` does exactly what
      `mc repo merge` did, through the same `runGate`/`runMergeRound`.
- [x] `mc merge <repo> <pr> --docs`: reads the PR's files with `gh`; refuses,
      naming the first file, if any path is outside `docs/`; refuses a draft
      or a closed PR; waits for GitHub's mergeability (up to ~60 s); squash-
      merges with subject `<title> (#<n>)`; reads the merge commit back and
      prints it; records a round with `mode: docs` in the repo round log.
      No suite, no lease, no worktree, no model.
- [x] `--docs` with several PRs, or with `--check`, is refused.
- [x] `mc repo merge …` prints one line — "mc repo merge is now mc merge" —
      and exits 2; it is not in `mc repo`'s usage or help.
- [x] Help text: `mc merge` block replaces the `mc repo merge` block.
- [x] Tests: the docs form on a stubbed `gh` (docs-only merges; one file
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
- [x] **2. Roles and runner** (2026-08-29; `mc plan`'s own first prompt
      was the missing third place) — `canon/roles/plan.md`,
      `~/mc/bin/runner.sh`'s triage prompt and `planLaunch()` in
      `src/mc/commands/plan.js` all end with the docs merge. Observed: the
      runner's `canonical-response` triage on 2026-08-29 opened memoro
      #11039 and landed it itself with `mc merge memoro 11039 --docs`
      (`~/mc/runner/log/canonical-response-20260829T033139Z.json`, first
      line of `.result`); the round log has four `mode: docs` rounds
      (memoro-cli #419, #420; memoro #11025, #11039), none of them clicked.
- [x] **3. Close-out** (2026-08-29) — `docs/technical/mc-merge.md` (both
      forms, the six measured `mode: docs` rounds, the three places that say
      it), the `project_log.md` row, and the last user-visible places that
      still said the old name: `docs/mc-command-matrix.md`, `mc repo rounds`
      with no rounds yet, the merge log's "Run by" line and the freshen
      sender. `mc repo merge` now survives only in CHANGELOG history.

## What the code taught us

- The gate's argument grammar lived inside `repo.js`'s `parseArgs`; it is
  now `parseMergeArgs`, exported, and `mc repo merge` answers only with
  where it went. `gate()` and `resolveRepoPath()` are exported for the new
  door; nothing in the round itself moved.
- `--docs` was not run live when it was built; it has been now — four
  rounds, four merges, no refusals (see step 2).
- The role was not the last word a plan session hears. `mc plan` builds its
  own first prompt in `planLaunch()`, and that prompt ended with "open a PR
  … and stop" — the most recent instruction, contradicting the role two
  screens above it. The prompt now ends with the merge and names the
  repository, so `<repo>` is filled in rather than guessed.
- The rename was not finished in the code when step 1 called it done. Six
  strings still said `mc repo merge` where a person would read them: the
  matrix row, `mc repo rounds`' empty answer, the merge log line the gate
  writes into the repository, and the freshen half's inbox sender and two
  of its messages. No test asserted any of them, which is why they lasted.
- `~/mc/bin/runner.sh` is not in this repository and no test can reach it;
  the repository's half of this step is locked by assertions on the role
  overlay and on `planLaunch()`'s last line.

## Documents

- `src/mc/repo-merge.js`, `src/mc/repo-gate.js` — the gate round, unchanged
- `~/mc/runner/log/natt-1.md` §"Vad som gick fel" 2 — plan PRs are docs-only and should land first
- `docs/project/mc/mc-plan/PLAN.md` — the writer of the PRs this lands
