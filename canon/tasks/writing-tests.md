---
name: writing-tests
description: Designing, adding, changing or retiring a test or gate in memoro or memoro-cli. Load before any test work, including planning protection and reviewing test value.
---
# Writing tests

Protect a consequential behaviour, not the shape of its implementation.
Read [the test strategy](references/test-strategy.md) before test work. It
covers risk selection, levels, evidence and retirement; authority is in roles.

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
- **A repository scan reads what git tracks** (`git ls-files` in a work tree),
  never a disk walk: a walk once picked up ignored probe scripts and made
  tests green locally and red on the merge candidate. Use the repository's
  helper where it has one (memoro: `scripts/lib/tracked-source-files.mjs`).

## Cost and retirement

Run each new or changed test through `mc gate <file>` and record its printed
`test <file> › <name> — 0.xyz s` timings. Over 1 s is the slow-test indicator,
not red: a new or changed test over it is rebuilt, or the PR says why its cost is
warranted and review judges that; rerunning is no fix. Only the stall guard (the
run's `--test-timeout`, 30 s) is red. `~/mc/runner/too-slow/<repo>.tsv` keeps slow
and cut tests until they pass under their row's limit. Also measure file/fixture
startup and the affected round: moving work outside the timed callback does not
make the suite cheaper. Preserve existing gate thresholds.

The 1 s indicator is per test; file fixture cost is reported separately, with the timings.
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
