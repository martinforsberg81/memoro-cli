# Incident: `mc end create-your-own-avatar` left session artifacts

Date: 2026-07-26
Command: `mc end create-your-own-avatar`

## Summary

Ending the session was confirmed, but teardown stopped before deleting any
session-owned artifacts. The registry still marked the session `live` even
though its local broker was no longer reachable.

## Observed failure

```text
mc: failed to end create-your-own-avatar: runtime sidecar cleanup failed (broker-host-pid-unverified)
```

The command reported the following leftovers:

- Codex transcript: approximately 3.3 GiB
- Worktree: approximately 2.2 GiB, with 287 dirty files
- Generated-images directory: approximately 19 MiB
- Broker host and guard-bin directories
- Registry entry and Git worktree/branch metadata

## Root condition

`mc status create-your-own-avatar` reported a stale session with no local
broker. `mc storage repair create-your-own-avatar --dry-run` classified it as
`registry-live-without-local-broker`.

The worktree's observed branch (`codex/avatar-state-signatures-v2`) differed
from the registry's session branch (`sess/create-your-own-avatar`). The
teardown therefore failed closed before destructive cleanup.

The unassociated local branch `codex/avatar-state-signatures-v2` was also
identified as no longer needed. It had no linked worktree and was removed
after the session teardown completed.

## Remediation

1. Mark the registry entry idle with the targeted storage repair.
2. Re-run `mc end create-your-own-avatar --force` after verifying that no
   broker or tool process remains.
3. Verify that the transcript, generated images, broker/guard artifacts,
   worktree, branch, and registry entry are absent.

The first `mc end` attempt failed with `broker-host-pid-unverified`. A targeted
`mc storage repair create-your-own-avatar --apply` was required to mark the
stale registry entry idle before `mc end --force` could complete. This is a
session-cleanup failure mode that should have regression coverage.

## Follow-up

Add a regression test covering a registry-live session whose local broker
host has disappeared, including the branch-mismatch and dirty-worktree
reporting path.
