# MC credential scope

**Status:** in-flight

## Outcome

`mc` protects provider and Memoro credentials without acting as a
general-purpose development sandbox. Managed sessions retain the user's normal
coding-tool, operating-system, and repository-policy capabilities.

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
- Preserve each coding tool's native user and repository permission policy.
  Adapters layer the credential boundary through the tool's own configuration
  mechanism; `mc` does not translate ordinary approvals into a shared policy.
- Add regression coverage for both unrestricted development behavior and
  credential isolation.

## Non-goals

- `mc` does not replace permissions configured by the user, operating system,
  provider, or repository instructions.
- `mc` does not invent cross-tool approval semantics. Codex, Claude, and Gemini
  remain authoritative for their own permission modes, rules, and prompts.
- `mc` does not decide which ordinary development commands, repositories,
  hosts, or tools the user may access.
- This work does not weaken authentication, vault custody, provider-artifact
  binding, or resume identity checks.

## Completion criteria

- A managed agent can run repository Node/npm workflows, use ordinary network
  and filesystem capabilities, and invoke the installed `mc` CLI.
- Credential-bearing paths and authority remain unavailable and canaries
  remain absent from child environment, argv, output, logs, and transcripts.
- Managed Codex resumes the exact persisted rollout and never creates a
  replacement conversation for a missing registered provider ID.
- Targeted policy, credential-boundary, broker, resume, packaging, and live
  two-generation tests pass.

## Delivery plan

1. Separate credential-specific denials from the general managed profile.
2. Preserve native tool policy below a credential-only managed layer:
   - Codex loads the user's normal `config.toml`, profile files, and rules,
     then applies the hash-bound credential profile.
   - Claude must preserve its native permission settings when its managed
     adapter is enabled; no Claude policy is synthesized from mc fields.
   - Gemini must follow the same rule when its currently planned adapter lands.
3. Render a permissive development profile with credential isolation.
4. Make allowed development capabilities positive C1 controls.
5. Update documentation and regression tests.
6. Package, install, and run continuity plus C1 live validation.
