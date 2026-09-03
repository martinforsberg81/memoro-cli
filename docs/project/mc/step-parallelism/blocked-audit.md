# Every blocked step, read

`step-parallelism` step 1, 2026-09-03. Refs read: memoro `6c04e604`
("Archive 1 done project: inbox-finish", #11279), memoro-cli `9a9ffe7`
("Plan: step-parallelism", #558). Everything here is read from `origin/main`
through `git show`, never from a checkout — a workarea's copy lags main, which
is how `mc status` came to show `email-window-layout` step 5 as `blocked`
after main already said `ready`.

Reproduce with the script beside this file:

```
git -C ~/memoro fetch origin && git -C ~/memoro-cli fetch origin
node docs/project/mc/step-parallelism/blocked-scan.mjs
node docs/project/mc/step-parallelism/blocked-scan.mjs \
  --memoro-ref 6c04e604319a87fa3accd77f9ebf0912b7a6f563 \
  --memoro-cli-ref 9a9ffe732887d6d334a78082a1d0dc0040404103   # the before state
```

## The counts

A plan has no status of its own — it is the state of its first unfinished step
— so the plan counts and the step counts are different questions and both are
here.

| | before | after |
|---|---|---|
| plans on main (memoro / memoro-cli) | 31 / 3 | 31 / 3 |
| plans whose next step is `blocked` (memoro) | **28** | **26** |
| plans whose next step is `ready` (memoro) | **3** | **5** |
| plans whose next step is `ready` (memoro-cli) | 3 | 3 |
| blocked **steps**, both repositories | **31** | **29** |
| … of them `blocked_by.kind: decision` | 21 | 21 |
| … of them `blocked_by.kind: project` | 10 | 8 |
| … blockers a machine can see are finished | **2** | **0** |

The project's `goal` quotes 28 blocked against 4 ready in memoro, measured the
same morning. The ready count is 3 here, not 4: `email-window-layout` step 5
was flipped and queued by hand between the two readings, which is the incident
this step exists because of.

## What was flipped, and nothing else was

Two steps, both waiting on `inbox-finish`. `inbox-finish` was delivered and
logged on 2026-09-03 (`project_log.md`, `36885fd808`) and its plan directory
was archived off main by #11279 — so the blocker was satisfied, and no
mechanism was ever going to say so.

| project | step | blocker | why it was earned |
|---|---|---|---|
| `home-on-msr` | 2 · H0b · The rest of the keys | `project: inbox-finish` | delivered and archived the same day; nothing else in the step depends on it |
| `time-axis` | 1 · Post 0 · Hygiene and the paper test | `project: inbox-finish` | the step's own instruction carries the ruling — Martin, 2026-09-02: *"Vänta till inbox-finish är klar."* Its second half (no sequencing rule against `home-on-msr`) is untouched |

Landed as memoro **#11280**, docs-only, through `mc merge memoro 11280 --docs`
(squashed to `8f358bc`). Each flipped step carries one `comments` paragraph
saying who unblocked it and on what evidence; `status` and `blocked_by` are
the only other fields that changed, and no other plan was touched.

## Every blocked step on main, before the sweep

Ordered as the scan met them. `blocker on main` is what the named project's
plan says on the same ref, and is `—` for a `decision`, which no machine can
check (see below).

| project | step | `blocked_by` | blocker on main | disposition |
|---|---|---|---|---|
| `avatar-image-animation` | 8 · Publish one avatar onto a release, end to end | `decision: plan-review` | — | stays blocked |
| `avatar-self-serve` | 11 · The two walls between a user and their own avatar | `decision: plan-review` | — | stays blocked |
| `canonical-response` | 9 · Close out | `decision: plan-review` | — | stays blocked |
| `pdf` | 6 · Waiting — 5. Read the instrument | `decision: plan-review` | — | stays blocked |
| `docx-editor` | 16 · Take the three `ime-*` rows | `decision: plan-review` | — | stays blocked |
| `docx-range-formatting` | 1 · Range-to-items resolution | `decision: plan-review` | — | stays blocked |
| `docx-save-compiler` | 1 · Baseline snapshot at load | `decision: plan-review` | — | stays blocked |
| `connections-section` | 11 · Every rail draws the standard tile | `decision: plan-review` | — | stays blocked |
| `no-text-in-code` | 1 · The seam | `decision: plan-review` | — | stays blocked |
| `swedish-chunks` | 3 · Extend A1 (14 → 70) with real Swedish | `decision: plan-review` | — | stays blocked |
| `swedish-grammar` | 6 · Author B2 (149), C1 (120), C2 (95), one PR each | `decision: plan-review` | — | stays blocked |
| `swedish-lemma-banding` | 3 · Stability check on `lemma:calibrate` | `decision: plan-review` | — | stays blocked |
| `language-voice-do-alarms` | 1 · Harness for DO eviction | `decision: plan-review` | — | stays blocked |
| `language-voice-transcript-hygiene` | 6 · Nothing buildable is left | `decision: plan-review` | — | stays blocked |
| `entity-detail-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 steps done | stays blocked |
| `home-on-msr` | 2 · H0b · The rest of the keys | `project: inbox-finish` | **not on main** | **→ ready** (#11280) |
| `learning-play-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `library-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `onboarding-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `photos-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `planning-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `settings-on-msr` | 1 · Freeze the answer key, verify the keys, re-plan | `project: home-on-msr` | blocked → now ready, 1 of 10 | stays blocked |
| `time-axis` | 1 · Post 0 · Hygiene and the paper test | `project: inbox-finish` | **not on main** | **→ ready** (#11280) |
| `web-renderer-close` | 1 · Schedule the closure against the interlock | `project: time-axis` | blocked → now ready, 0 of 9 | stays blocked |
| `network-review-entity-entry` | 3 · Close out | `decision: plan-review` | — | stays blocked |
| `network-review-rollout` | 3 · Composition fixtures | `decision: plan-review` | — | stays blocked |
| `cache-warming` | 3 · Wait for the audit | `decision: plan-review` | — | stays blocked — but see *the second blocker*, below |
| `tool-profiles-per-model` | 1 · Wait for the numbers | `decision: plan-review` | — | stays blocked — but see *the second blocker*, below |
| `mc-test` | 6 · Retire the surface-runtime blanket | `decision: test-architecture-2` | — | stays blocked |
| `step-parallelism` (memoro-cli) | 3 · The gate lock queues instead of refusing | `decision: step-parallelism-measurements` | — | stays blocked |
| `step-parallelism` (memoro-cli) | 4 · The lane count is a setting | `decision: step-parallelism-measurements` | — | stays blocked |

## Why the twenty-one `decision` blockers all stay

**There is no decision file anywhere in either repository.** `git ls-tree -r
origin/main | grep decisions/` returns nothing in both. The
`<area>/decisions/` apparatus was removed with the fourth step status
`waiting-decision` (`plan-schema.js` says so at the top), so a `decision`
blocker's name is a label with nothing behind it: the answer lives in a plan's
prose or in a conversation with Martin. A machine that judged one of them
stale would be guessing, and this audit does not guess either — every
`decision` row above was read, and each is still waiting.

**Eighteen of the twenty-one are one deliberate park.** `plan-review` is not a
plan that went wrong: #11152 converted all twenty-six PLAN.md files to
PLAN.json in one commit and blocked *every* plan's next step on it by design
(*"Nothing is handed out until the plans themselves have been gone through,
and reviewing them is not part of this migration"*, Martin 2026-08-30). It is
the backlog of plans Martin has not read, and it is real work rather than
bookkeeping: two of the twenty-six — `revise-test-architecture` and
`test-profile-separation` — were closed out on 2026-09-02 precisely because
the review found their converted step bodies were never written and could not
be run. Checked: each of the eighteen has had exactly one commit touching it
since the conversion, and it is `866fe3ea18`, the mechanical `comments` move
that touched all of them. None has been reviewed.

**`test-architecture-2`** (`mc-test` step 6) is a live question with three
preconditions named in its own instruction — the import closure exists,
`test-value-cleanup` is done, and `nightly-full` has reported on three
consecutive runs — and none is met. It also changes the gate's guarantee,
which the plan says explicitly is Martin's and not a session's.

**`step-parallelism-measurements`** is this project's own steps 3 and 4,
blocked by this plan's contract until Martin has read step 2's numbers.

## The second blocker: what `blocked_by` does not say

Two rows are the interesting failure, and neither is fixable by a machine.

`cache-warming` step 3 is titled *"Wait for the audit"* and its instruction
waits on **`region-cache-audit`**. `tool-profiles-per-model` step 1 is titled
*"Wait for the numbers"* and waits on the same project. `region-cache-audit`
was **delivered on 2026-08-30** and archived off main by #11143. But both
steps' `blocked_by` says `decision: plan-review`, because the conversion
carried one blocker per step and the park took the slot — so the thing they
are actually waiting for is finished, and nothing, including the mechanism
this step builds, can see it.

`blocked_by` holds one blocker; a step can be waiting on two things. Where the
two disagree, the machine reads the wrong one. That is not worth a schema
change on the strength of two rows, and it is not this step's to make. What it
is worth is saying here, so the plan review of those two plans knows the
region-cache numbers it is being asked to wait for already exist.

## What now says it without a person

`src/mc/stale-blockers.js` and the `blocker finished` line under QUEUE on the
page (`page-collect.js`, `page-render.js`, `docs/technical/mc-ui.md`). It
reports a step blocked on a **project** whose plan on `origin/main` is `done`
or is not there at all, drawn from the same plan records the runner's
`queue()` reads — never from a workarea.

It says *is not on main* rather than *is done*, because a project also leaves
main when it is abandoned or superseded, and then the blocked step's premise
may be dead rather than satisfied. Only a person can tell those apart, and
only a person flips a blocker: the line is the noticing, and nothing else.

`decision` blockers are never reported, for the reason above — there is
nothing to check them against.

Driven by `tests/mc/stale-blockers.test.js` against
`tests/fixtures/stale-blockers-main-2026-09-03.json`, which is three plan
records taken verbatim from memoro's `origin/main` at `6c04e604`:
`home-on-msr` and `time-axis` blocked on `inbox-finish` with `inbox-finish`
gone, and `web-renderer-close` blocked on `time-axis` as the control that must
stay quiet. Run against the real pre-sweep refs it names those two steps and
no others; against `origin/main` after the sweep it finds none.
