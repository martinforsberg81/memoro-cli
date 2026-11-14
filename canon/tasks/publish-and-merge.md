---
name: publish-and-merge
description: How a change in an mc repository (memoro, memoro-cli) is tested and gets from a branch to main with mc gate, mc publish and mc merge. Use before running any test, pushing a branch, opening or editing a pull request, or merging one.
---
# Publish and merge
The verbs replace `node --test`, `npm test`, `npm run ci`, `git push`, `gh pr create`/`edit` and `gh pr merge`; `mc hook pre-tool` turns
those to the verb. When the raw command is really meant, put `MC_HOOK_ALLOW=1`
in it and say why in the reply.
## What runs where

Main is where work meets; production is what users have. A merge checks four
things: a clean merge onto current main; the change's own tests; no command
gates; and the review's verdict on the judged head. Review judges whether the
change is well written, free of bugs and works as intended.

The change's own tests are every added or modified test file, every test that
directly imports an added or modified source (one hop, read at head), and, for
a deleted or renamed source, its direct importer tests at the base. Memoro
also runs the eight-file mandatory core in `config/testing-registry.mjs`.
No transitive import closure, pin, scan, area blanket or registry target widens
this set. Bare `mc gate` and the merge round use the same scope without cost
deferral or command gates.

The daily full run retains every test, including deferred tests and main-only
ratchets, every CI binding command and all three contract suites, including
`test:browser-contracts`. The wide selection remains available through
`mc gate --whole-selection`; named gates and `mc test <repo> --full` remain
optional tools, never landing requirements. Wide regression protection belongs
to the daily full run and before a deploy, not to a merge. Main may carry a
red this merge did not look for: the daily run finds it within a day and sends
it to a main-red mend; the deploy gate keeps it from production. Until the
separate deploy-gate goal lands, the person deploying must read that full run.

## `mc gate` — the tests your change reaches
- Bare: the repository's selector maps the branch's and the tree's changes
  against `origin/main` to the change's own test files, with no command gates. `mc gate <files…>
  [--test-name-pattern <p>]` is a focused rerun.
- Before review/finish/mend authorizes merge, complete final-tree bare `mc gate`:
  GREEN or only adjudicated untouched-baseline `SETTLED` failures (Martin, 2026-11-11).
  Record scope, revision, frozen base, log and failed members; finish RUNNING with `mc gate --wait`.
  Baseline-only failures do not hold delivery; receipts stay incomplete: reuse passed members only,
  with independent merger measurement on its current base, never another Martin question.
  Partial, deferred, interrupted, unattributed or change-caused failures are not acceptance.
  Repairs need final-tree acceptance; unchanged retries retain evidence and approved exceptions.
- A rerun on identical content reuses each file and command gate that passed there and runs
  the rest; a resumed whole selection is a completed GREEN. Any content change means a new whole
  selection; `--fresh` re-executes the current request. Red files green alone, or untouched and red alike at the base, are `SETTLED`.
- It answers within 540 s with GREEN/RED, failing lines and log path; give the
  Bash call `timeout: 600000`. Past budget: `RUNNING`, exit 3; `mc gate --wait`
  reads the same log. Do not poll or run in the background. Red: fix, then run
  its `re-run:` line.
- `--full` and bypasses (`npm test`, `npm run ci`, bare `node --test`) are refused:
  the whole suite is the nightly's; the merge round measures only the change's own tests.
  Never run `npm ci`/`npm install`; memoro re-attaches its cache with `npm run deps:ensure`.
- Never lower a threshold, or skip, weaken or delete a test to turn it green.
## `mc publish` — push and open the pull request
- Refuses on `main`, a dirty tree or moved origin; never forces. Then pushes and
  opens a PR, or edits only requested fields (`--title`, `--body`, `--body-file`,
  `--base`) on an open one.
- Then it queues the pull request for the merger in the same call.
  `--no-merge` pushes and opens and queues nothing; so does `--json`.
- The body says what changed, why, impact, root cause, what did and did not run,
  known gaps and each changed test's `mc gate` timing (`test <file> › <name> —
  0.xyz s`). Never claim a run you did not make; "suite not run" is acceptable.
## `mc merge <repo> <pr>` — the one door to main
`mc goal stage merge` queues every registered PR for the ordinary measured round,
reusing the session’s change-scope receipt (exact or delta), measuring the rest on the current base.
No criteria or reviewed-head re-check; done after all land. Conflicts go to a session.
- Queues the pull request and returns. The merger takes the queue one at a
  time per repository lane, runs the gate round on a candidate with the
  current base and squashes only on green. No flag lands a red.
- A pull request whose every file is a document under `docs/` (no script) runs
  the repository's change scope and lands in the call when it is green.
- `mc merge <repo> <a> <b>` takes one base; not atomic: a red lands a prefix and stops.
- Do not poll: no loop, no `sleep`, no `mc merge watch` unless asked. One
  `gh pr view --json …` snapshot is the state; an empty check list is normal.
- A red's files are in `~/mc/runner/merge-red/<repo>-<pr>.txt`; rerun with
  `mc gate` before fixing. A round reports its ceiling and continues; interrupted
  members run alone; a stall goes back in line. For other non-PR stops,
  run `mc repo who <repo>` and requeue.
- `--admin` squashes with GitHub's admin override and no gate round: for a
  change the round cannot measure, after you measured what it reaches; the
  PR says what ran. The hook refuses it headless. `gh pr merge` skips mc's
  books (the landed line, the installation pull).
