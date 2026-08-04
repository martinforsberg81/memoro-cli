---
name: agent-coordination
description: Coordinate bounded work across implementation sessions without duplicating repository or publication instructions.
---

# Coordinator ↔ implementation sessions

Use this skill only when work is actually delegated across sessions or agents.
A multi-file or multi-PR task handled in one session does not require a
coordinator ritual. Repository rules and the GitHub lifecycle remain owned by
`docs/coding-agent-protocol.md`; this skill does not restate them.

## Roles

- **Coordinator:** owns the outcome, contract, ordering, integration review,
  and user-facing status.
- **Implementation session:** owns one bounded work unit, its focused tests,
  and an evidence-backed handoff.

Both roles inspect the relevant code and current repository state. Delegation
does not reduce review depth or transfer merge authority implicitly.

## Required work-unit contract

Before delegating, state:

1. Outcome and user impact.
2. Files or subsystem in scope.
3. Explicit non-goals.
4. Completion criteria and proportional validation.
5. Dependencies, ordering, and known overlap with other work.
6. Decisions that require escalation rather than guessing.

Read only current plan sections needed for that contract. A superseded or
historical plan is context, never an executable instruction source.

## Bounded loop

1. **Delegate:** give one independent work unit and the contract above.
2. **Inspect:** the implementation session reads the relevant code and asks
   only when a missing choice materially changes the result.
3. **Implement and verify:** keep the diff focused, preserve unrelated work,
   and run checks proportional to the changed paths and risk.
4. **Handoff:** report the exact branch/head, complete diff scope, validation,
   remaining gaps, and any material judgment calls.
5. **Integrate:** review the complete combined diff and one current GitHub
   snapshot. Publish and merge only through the lifecycle in
   `docs/coding-agent-protocol.md` and only with the required authority.

Repeat only when a new work unit exists. Do not repeatedly rediscover the same
base, reread unchanged files, poll checks, or re-resolve already settled scope.

## Parallel-work rules

- Parallelize only independent work with disjoint or explicitly coordinated
  ownership.
- Give every work unit its own session/worktree and branch.
- Do not let two sessions edit the same plan or source surface silently.
- Preserve session branches after merge; lifecycle tooling owns cleanup.
- Stop on unexpected conflicts, moved heads, or material scope expansion.

## Review rules

The coordinator reviews the full PR diff, not only the PR body or one or two
files. Confirm:

- the implementation matches the contract and non-goals;
- tests demonstrate the changed behavior without unnecessary new coverage;
- errors, security boundaries, and destructive paths fail safely;
- the PR head is the exact head that was validated;
- GitHub checks were observed once and classified according to the canonical
  repository protocol.

## Brief template

```text
Outcome:
Scope:
Non-goals:
Relevant current references:
Completion criteria:
Validation:
Dependencies/overlap:
Escalate when:

Final report:
- branch and exact head
- changed files and behavior
- validation evidence
- judgment calls
- gaps or blockers
```

## When to coordinate

Use this skill for genuinely parallel work, cross-repository sequencing, or a
delivery plan whose work units have independent owners. For a focused task,
inspect, implement, verify, and publish directly.
