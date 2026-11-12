# Local programme backup lifecycle

The programme-work-backup delivery adds installation-local lifecycle records
and checksummed archive primitives. Lifecycle state is stored below the local
runner directory, not in programme data or an archive. A missing programme
fence means legacy active work; a present unreadable, corrupt or unknown-version
record refuses writer admission. Installation identity, transaction records,
fences and writer leases are persisted under a strict runner lock using
file-and-parent-directory fsync around atomic replacement.

`beginBackup(selection)` creates one durable `draining` transaction and binds
each selected programme to it. The complete selection is authoritative even
if a process stops before every per-programme fence is written. New cooperative
writers are refused for selected programmes, while unrelated programmes remain
eligible. A writer admitted first retains a local lease until its caller
releases it; there is no PID/timeout expiry. Transition to `held` requires that
no selected leases remain. `released` can only follow `held`; a restart does
not clear a hold. Goal metadata, goal state, PR ownership and goal log writes
through `src/mc/goals.js` use this admission boundary. Legacy goal conversion
and phase reconstruction also retain a programme writer lease across their
direct file writes and renumbering. A runner conversion refused by a selected
programme hold is deferred for that programme while unrelated programmes are
still converted; it is not reported as a dropped or failed goal.

The archive storage format is a private directory with `manifest.json`, its
SHA-256 sidecar, content-addressed file payloads, and repository bundle slots.
The v2 manifest records typed file, directory and symlink members. Verification
rejects malformed, escaping, absolute, duplicate, case-colliding and
symlink-parent paths, unsupported schema versions, and payload or bundle digest
mismatches. Archive output paths must be absolute and existing output is never
overwritten. These primitives do not by themselves establish a complete
programme inventory or a recoverable Git snapshot.

The currently routed command surface is:

- `mc backup inspect --archive <path> [--json]` verifies the archive before
  reporting its inventory.
- `mc backup verify --archive <path> [--json]` reports verification details.
- `mc backup status --id <id> [--json]` reads the durable transaction and its
  admitted writer leases.
- `mc backup release --id <id> [--json]` releases only a transaction already
  in `held`; draining transactions cannot be released through this command.

Capture, resume and restore commands are not yet delivered. The archive
primitives must not be presented as proof of complete capture or inactive
restoration. Restore must remain inert, validate the full archive and local
repository declarations before mutation, and must not make restored work
runnable or enqueue merges.

Related contracts: [layout and local/restricted data](mc-layout.md),
[goal lifecycle](mc-goals.md), [runner admission](mc-run.md), and
[merge admission](mc-merge.md).
