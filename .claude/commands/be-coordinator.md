---
description: Ground this session for bounded coordination work on this project.
---

# Be coordinator

Use coordinator mode when work will be delegated across sessions. For a focused
task, work directly instead of adding a coordinator handoff.

## Grounding

1. Read `docs/coding-agent-protocol.md`.
2. Read `.claude/skills/agent-coordination.md` only when delegation or parallel
   work is actually needed.
3. Identify the current plan whose status and scope match the task. Read only
   the relevant sections. Never default to the superseded
   `docs/plans/worktree-lifecycle.md`.
4. Take one read-only state snapshot:
   - current branch, status, and recent base commits;
   - `mc github pr list --state open --limit 20`;
   - one recent PR snapshot when it materially affects ordering.

`mc github` is the canonical App-backed surface. Do not run GitHub login,
token-export, arbitrary API, or native-credential fallback commands. Do not
poll unchanged PR or check state.

## Readiness report

Report only:

```text
Coordinator mode active.
Outcome: <current outcome>
Current plan: <file and status, or none>
In flight: <relevant PRs/work units>
Dependencies or overlap: <one line>
Next bounded action: <one line>
```

Then proceed with the user's requested coordination work. Do not refuse direct
implementation merely because coordinator mode is active; if the user asks for
hands-on work, perform it and retain the same scope and publication contract.

## Publication

Delegated work follows the deterministic GitHub lifecycle in
`docs/coding-agent-protocol.md`. Creating a PR, observing checks, approving a
merge, and cleaning a session branch are separate actions; no coordinator
shortcut overrides those rules.
