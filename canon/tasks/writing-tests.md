---
name: writing-tests
description: Designing, adding, changing or retiring a test or gate in memoro or memoro-cli. Load before any test work, including planning protection and reviewing test value.
---
# Writing tests

Protect a consequential behaviour, not the shape of its implementation.
Read [the test strategy](references/test-strategy.md) before test work. It
covers risk selection, levels, evidence and retirement; authority is in roles.

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

## Admission and evidence

For each addition or change, name the concrete fault and consequence, the gap
in existing protection, the cheapest credible test level, fault-sensitive
proof, and execution/maintenance cost. Record this in the goal, PR or log,
not a new registry or one policy file per test. No coverage or count targets.
Demonstrate the relevant test fails with the fault and passes without it;
use the pre-fix behaviour or a small, deliberate fault. Revert injected faults
before publication. Record exactly what ran; absent proof remains a gap.
Do not manufacture permanent wording tests to prove this strategy exists.

## Construction

Assert observable results through the real mechanism under test. Substitute
external dependencies at their boundaries, not the mechanism being proved.
Use small, isolated fixtures and deterministic clocks; avoid real waits,
network, repeated process launches and whole-system setup for local decisions.

- **A pinned number is a summary of a list, and the list is what to pin.**
  Where a test asserts a count, assert the members beside it. A sum can be
  right for the wrong reason, and every check that reads only the sum passes
  it.
- **A repository scan reads what git tracks**, never a disk walk (a walk once
  read ignored probes: green locally, red on the merge candidate), through the
  repository's helper (memoro: `scripts/lib/tracked-source-files.mjs`). A test
  of code that reads disk itself reads the same set through that code.

## Cost and retirement

Run each new or changed test through `mc gate <file>` and record its printed
`test <file> › <name> — 0.xyz s` timings. Over 1 s is the slow-test indicator,
per test and not red: a new or changed test over it is rebuilt, or the PR says why
its cost is warranted and review judges that; rerunning is no fix. Only the stall
guard (the run's `--test-timeout`, 30 s) is red; `~/mc/runner/too-slow/<repo>.tsv`
keeps slow and cut tests until they pass under their row's limit. Report fixture
startup and the affected round separately: moving work outside the timed callback
does not make the suite cheaper. Preserve existing gate thresholds.
Usage and help examples in tests use placeholders such as `<programme>/<goal>`, never a real goal name.

Classify existing checks as keep, rebuild, consolidate or retire using the
same admission criteria. For retirement, name lost protection and its
replacement or the residual risk recorded in planning. Slowness, age and a
red result alone are not reasons to delete. Follow the publish-and-merge skill
for gate and publication mechanics.

When demonstrating a source fault, use the bounded [independent replay procedure](scratch-and-probes.md#independent-fault-replay).
It runs in the goal's worktree and returns that worktree to exactly the judged
HEAD with clean status, verified before and after; the normal check runs again
there on the clean judged head.
