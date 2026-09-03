section: Removed

- **`docs/plans/` no longer describes machinery that does not exist.** The
  directory `docs/project/` replaced held 34 files and 13 048 lines, and
  mc-cut had spent four steps deleting the code almost all of them planned:
  the session homes and runtime host (`mc-v1-session-architecture.md`), the
  broker and its cloud peer (`mc-v2-cloud.md`,
  `hosted-live-session-workspace.md`), the connection registry and the GitHub
  App capability (`connected-capabilities.md`,
  `github-app-capability.md`, 1 507 lines between them), managed providers and
  their containment (`mc-managed-only-cutover.md`,
  `mc-v2-local-codex-containment.md`), the fleet verbs (`session-fabric.md`,
  `worktree-lifecycle.md`), and the product definitions written above all of
  it. Thirty-two files and 12 603 lines are gone.

  **Two stay**, because `vault/` stays and they are the only record of why
  `src/vault/` is shaped as it is: `mc-custody.md`, whose S1–S3 are the CRK/DEK
  envelope, the per-device unlock cache and `mc vault adopt` as implemented;
  and `vault-import.md`, whose `scan`/`import`/`bindings` verbs still run.
  Both now say at the top what is live and what was withdrawn — the
  materialisation lifecycle `vault-import.md` plans for is refused by
  `mc vault bind` and `mc vault get` today. The credential-boundary rule the
  deleted `credential-blind-capabilities.md` carried is restated inline in
  `docs/coding-agent-protocol.md`, which is now its normative copy.
