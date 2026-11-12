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
still converted; it is not reported as a dropped or failed goal. A goal-bound
`mc ask` checks lifecycle admission at the eventual goal write after the model
response; a hold that begins during that response leaves the goal files
unchanged and reports that the answer was not recorded in the goal.
`mc plan <programme> --archive` also takes a programme lease before its
preflight fetch and retains it through document merging, worktree release,
restricted-README reconciliation and the final directory move. A programme
already draining or held is refused before those side effects. This guard does
not make other goal/programme cleanup routes safe by implication.
Goal archival and dropped-goal finalization each acquire a programme lease at
their shared `src/mc/goal-archive.js` boundary. This covers both direct
`mc goal archive` calls and runner finalization through GitHub close, queue
reconciliation, worktree/branch removal, goal movement and phase renumbering;
the lease is retained until all local reconciliation returns.
The `mc tidy --apply` path rechecks the local programme lifecycle at the final
goal-worktree removal boundary. A draining, held, moved, corrupt or unreadable
programme record retains the checkout even when an earlier tidy list selected
it; the state is read again inside the existing goal-worktree removal lock.
This guard protects goal checkout bytes and branch registration only, not
other tidy target kinds or complete backup capture.
The installed mc PreToolUse hook also refuses direct `Write`, `Edit` and
`MultiEdit` operations whose target is anywhere under a selected programme's
`programs/<programme>/` tree, including nested goal worktrees. It consults the
durable lifecycle record for each target: draining, held, moved or inactive
work is refused, and malformed state fails closed. Unrelated programmes and
targets outside the programmes root remain editable. This is a cooperative
editor boundary, not an OS-level prohibition on arbitrary processes or shell
commands.

The direct irreversible `mc merge <repo> <pr> --admin` and documents-only
`mc merge` routes have no merger round to own admission. Before their first
GitHub operation, they inspect active and archived goal PR references; an
owning programme must admit a writer lease, retained through remote merge and
local outcome reconciliation. A malformed goal ownership census fails closed.
This is per referenced PR and does not authorize a held programme through
`--admin`. Ordinary queued merge-round admission remains separately owned by
the merger and repository-merge paths described in [mc-merge.md](mc-merge.md).

The archive storage format is a private directory with `manifest.json`, its
SHA-256 sidecar, content-addressed file payloads, and repository bundle slots.
Archive files are fsynced before close; payload, bundle and archive directories
are fsynced before the sibling-directory rename, and the containing directory
is fsynced after publication. Restore fsyncs materialized files and staging
directories before its final rename, then fsyncs the parent. A persistence
failure refuses publication rather than reporting a durable archive or restore.
The v2 manifest records typed file, directory and symlink members. Verification
rejects malformed, escaping, absolute, duplicate, case-colliding and
symlink-parent paths, unknown manifest/member fields, duplicate programme or
bundle identities, non-content-addressed payload references, unmanifested
storage files, unsupported schema versions, and payload or bundle digest
mismatches. Symlink targets must use portable relative POSIX spelling: POSIX
and Windows absolute or drive-relative targets, NUL and backslash separators
are refused so an archive cannot gain a different escape meaning on a Windows
restore host. Archive output paths must be absolute and existing output is never
overwritten. Verification also refuses caller-supplied archive paths that
traverse symlinked parents instead of canonicalizing the alias and then
opening its payloads. These primitives do not by themselves establish a complete
programme inventory or a recoverable Git snapshot.

The currently routed command surface is:

- `mc backup create --programme <name> [--programme <name> ...] --output <absolute-path> [--json]`
  or `mc backup create --all-programmes --output <absolute-path> [--json]`
  explicitly selects local `programs/<name>` directories. It persists a
  draining hold before inventory, refuses to capture while admitted writers
  remain, then advances to held before reading. When present, the matching
  existing output paths are rejected before creating a lifecycle transaction,
  so a known collision does not strand an otherwise active programme behind a
  new hold. A matching legacy `plan/<name>` tree is captured below the archive namespace
  `<name>/legacy-plan/`, distinct from current `programs/<name>` members.
  Two no-follow inventories of every selected local tree and the before/after
  set of local roots must match before the private archive is published. This
  is a deliberately
  incomplete content-only implementation: it refuses selected directories
  containing Git worktrees, and does not yet reconcile listed-only or archived
  programmes, process census, repository identity,
  refs/index semantics, general ignored/restricted data or external dependencies.
  Before opening entries, the no-follow inventory excludes `.dev.vars`, `.env`
  and `.env.*`, and records credential omissions without values. It also
  records but does not copy generated dependency/build residue (`node_modules`,
  `public/dist`, `public/modules`, `scripts/dev/local-schema.sql`, Python
  `__pycache__`, `.test-timing`, `.venv-*`) using the approved regeneration
  sources, and host metadata (`.DS_Store`). `.wrangler` is recorded as an
  excluded host dependency because local D1 state belongs to the source host;
  no runnable/full-recovery claim is made for work requiring it. These exact
  omissions do not classify any other ignored entry: unclassified ignored data
  and required external dependencies still prevent a complete recovery claim.
  The
  held fence remains until explicit release on refusal. It does not claim a
  complete programme backup.

- `mc backup inspect --archive <path> [--json]` verifies the archive before
  reporting its inventory.
- `mc backup verify --archive <path> [--json]` reports verification details.
- `mc backup restore --archive <path> --output <inactive-root> [--json]`
  verifies and materializes a content-only archive into a new private sibling
  staging directory, then publishes it with one rename. The output must not
  exist. A `.mc-inactive-restore.json` receipt marks the root inactive and
  records the archive digest; restore never adds queue entries. This initial
  restore path refuses archives containing Git bundles until local repository
  declarations and worktree reconstruction are available. Its receipt says
  `content-only`; it is not a complete programme recovery or a runnable tree.
- `mc backup status --id <id> [--json]` reads the durable transaction and its
  admitted writer leases.
- `mc backup resume --id <id> [--json]` advances an existing `draining`
  transaction to `held` only after the admitted writer census is empty. A
  pending lease or any other transaction state is refused; restart does not
  expire the drain.
- `mc backup release --id <id> [--json]` releases only a transaction already
  in `held`; draining transactions cannot be released through this command.

Complete Git reconstruction is not yet delivered. The delivered content-only
restore is deliberately limited to archives with no bundles; a bundle-bearing
programme archive is refused without creating a destination. Future Git
restore must validate local repository declarations before mutation, keep the
result inactive, and must not enqueue merges.

Related contracts: [layout and local/restricted data](mc-layout.md),
[goal lifecycle](mc-goals.md), [runner admission](mc-run.md), and
[merge admission](mc-merge.md).
