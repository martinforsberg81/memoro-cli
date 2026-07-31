# MC secret-only boundary

**Status:** in-flight

## Outcome

`mc` protects provider and Memoro secrets without acting as a general-purpose
development sandbox. Managed sessions retain the user's normal coding-tool,
operating-system, and repository-policy capabilities.

## Scope

- Remove mc-imposed restrictions on ordinary filesystem access, command
  execution, Node/npm, networking, login shells, package installation,
  subagents, and coding-tool features.
- Keep provider credentials out of model-visible environment variables, argv,
  logs, transcripts, workspaces, and readable credential files.
- Keep credential custody, Keychain-backed tokens, and credential-domain IPC
  unavailable to model-directed commands.
- Preserve exact provider-session continuity and fail closed rather than
  silently replacing a missing provider-native session.
- Add regression coverage that proves both unrestricted development behavior
  and secret isolation.

## Non-goals

- `mc` does not replace permissions configured by the user, operating system,
  provider, or repository instructions.
- `mc` does not decide which ordinary development commands, repositories,
  hosts, or tools the user may access.
- This work does not weaken authentication, vault custody, provider-artifact
  binding, or resume identity checks.

## Completion criteria

- A managed agent can run repository Node/npm workflows, use ordinary network
  and filesystem capabilities, and invoke the installed `mc` CLI.
- Secret-bearing paths and authority remain unavailable and secret canaries
  remain absent from child environment, argv, output, logs, and transcripts.
- Managed Codex resume restores the exact persisted rollout and never creates a
  replacement conversation for a missing registered provider ID.
- Targeted policy, credential-boundary, broker, resume, packaging, and live
  two-generation tests pass.

## Delivery plan

1. Separate secret-specific denials from the existing general managed
   permission profile.
2. Render a permissive development profile with only secret-specific path and
   authority isolation.
3. Update the hostile boundary probe so allowed development capabilities are
   positive controls while secret access remains a failing condition.
4. Update documentation and regression tests.
5. Package, install, and run continuity plus C1 live validation.
