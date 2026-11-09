# mc tidy — what mc may remove

Goal archive and machine tidying are different operations. Neither needs an
archive pull request for the goal's own records.

## Goal archive

`mc goal archive <programme>/<goal>` uses the shared archive safety checks in
`src/mc/goal-archive.js`. Only a `done` or `dropped` goal can leave. It refuses
uncommitted work, an open pull request, unknown repositories or GitHub state,
and a dropped branch with unpushed commits. It checks the goal's carried PRs as
well as its branch.

Dropping persists `dropped` first, then a retryable finalizer closes PRs owned
only by that goal and removes their queued/red merge rows under the merge lock.
An unfinished co-owner keeps the PR open and queued; its ownership is recorded.
Branch-discovered PRs are included. A live runner session, GitHub uncertainty,
close failure or unsafe worktrees retain the active dropped goal and the
explicit refusal; cleanup is
retried on drop or ordinary runner reconciliation, without a mend/build wake.
Archived goal references continue to count when deciding ownership.

The worktrees are removed through git, the local branch deleted, and the
goal directory moved to `goals/.archive/`. One row is appended to
`goals/goal_log.md`; phases are renumbered so there are no gaps. Nothing is
written into a repository. Dropped goals are finalized and archived as soon as
safe, including on the next ordinary runner reconciliation even when their log
has no stage timestamp. Done goals retain the 24-hour hold, counted from their
stage-setting log entry; disk pressure may still archive done goals without the
hold (§ Disk pressure). A refusal is recorded once in LOG.md, not every chore
pass.

Projects went on 2026-11-03; their migration is described in
[mc-goals.md § From a project](mc-goals.md#from-a-project). Old execution
areas are no longer automatically closed. The tidy rules below inspect what
remains and leave its removal to a person.

## mc tidy

`mc tidy [--apply] [--json] [--days <n>]` (`src/mc/tidy.js`, the verb in
`src/mc/commands/tidy.js`) lists what it may remove, per root of
[Ruling 39](../project/mc/rulings.md) § 39. It exists because of 2026-09-26: the
data volume had 2.6 GB free, and a shell loop meant to remove orphaned
transcripts read a `find` that errored as "nothing here" and deleted nearly all
of `~/.claude/projects`, every `memory/` with it. So most of it is about what
stays.

| Root | What lives there | What tidy may remove |
|---|---|---|
| `~/mc/programs/<programme>/` | a planning area: `memoro/`, `memoro-cli/`, extra worktrees | an extra worktree whose content is on main (X); a programme's own checkouts once no planning session of it runs and they are untouched for 72 hours (I); clean inactive goal checkouts that cannot start a session now (P) |
| `~/mc/runner/step/<name>/` | an old execution area | the whole area, as W judges one, only in a person's `--apply` (U) |
| `~/mc/work/<name>/` | what is left of a retired workarea | the whole area, when every checkout in it is clean and landed, it holds nothing else and no process stands in it — and only in a person's `--apply` (W) |
| `~/.claude/projects/` | transcripts, `<uuid>/`, `memory/` | transcripts and leftovers (G, L) |
| `~/Library/Preferences/.wrangler/logs/` | Wrangler logs | regular `.log` files directly in the root, older than 72 hours (F) |
| `${MC_HOME}/shots/` | MC screenshots | regular `.png` files in non-hidden directories, recursively; hidden directories and `sessions/` stay (F) |
| `${CODEX_HOME:-~/.codex}/generated_images/` | Codex generation groups | regular `.png`, `.jpg`, `.jpeg` and `.webp` files directly in UUID-named session directories, older than 72 hours and only if the group is wholly old (F) |
| `~/mc/runner/scratch/<stem>/` | a runner session's scratch: logs, patches, replay worktrees, DerivedData, registered source exports | a clean registered worktree with ended ownership evidence, or marker-less legacy worktrees with a matching finalized runner log pair; `DerivedData` only with a valid ended ownership record; a verified registered export of an ended session (S, [Registered source exports](#registered-source-exports)); under S alone never logs, patches, receipts or the directory; the whole directory goes only as S-whole below |
| `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/` | Codex session transcripts | a regular `*.jsonl` file older than seven days and not held open, and the date directory its transcripts leave empty (C); nothing else under the Codex home |
| Exact native-phone outputs, worker bundles in registered worktrees, and named per-user caches | rebuildable outputs and caches | the allowlisted paths under B, with finished-goal ownership or 72-hour retention and fresh inactivity/identity checks |
| `~/mc/gate-cache/`, `~/mc/gate/`, `~/.memoro/mc/selection/` | a directory per repository slug (`repoFileSlug` of its path) | a slug directory no repository mc knows hashes to, untouched for a day, with no process in it (K); under a slug a repository mc knows has, an entry no round has used for 14 days, or staging older than a day (A) |

In layout 2 the planning areas are `~/mc/programs/<programme>/`, of which tidy removes only git worktrees (X), a programme's own checkouts once they are idle (I), and eligible goal checkouts (P) ([mc-layout.md](mc-layout.md)).

The old project rule P was removed with projects. Rules version 11 reuses P
for plan goal checkouts; it reads no execution register and retains S, F and
the rebuildable-cache rule B approved by Martin on 2026-11-06. Rules version 12
adds the `scratch-export` kind to S, the registered source exports below. Rules
version 13 adds S-whole, the whole-directory rule for an ended session's scratch,
and C, the Codex session transcripts, both below (Martin, 2026-11-09). Scratch
cleanup follows S and S-whole below and
[Registered source exports](#registered-source-exports); transcripts and logs
outside F's exact root and shape, and outside C's `sessions/` shape, remain
governed by their existing rules.

**F — generated files (72 hours, independent of `--days`).** The approved
Wrangler root is `~/Library/Preferences/.wrangler/logs/`; only direct regular
`.log` children qualify. The MC root is `${MC_HOME}/shots/`; it is walked
recursively without following symlinks, but hidden directories (including
browser profiles) and `sessions/` are not entered. Only regular `.png` files
qualify, both directly under `shots/` and in eligible subdirectories. The Codex
root is `${CODEX_HOME:-~/.codex}/generated_images/`; only
direct regular `.png`, `.jpg`, `.jpeg` or `.webp` children of UUID-named
session directories qualify. A Codex session image group stays intact if its
directory or any child was touched within 72 hours; in an old group only the
image files are eligible. Metadata, other file types, and session directories
are never removed. The exact 72-hour cutoff is retained. Unreadable or
uncertain roots and process/open-file evidence fail closed. A cwd in the
relevant subtree or an open file keeps candidates; lsof snapshots are bounded
to the approved inventory root or Codex session group. These rules never read
image contents or Wrangler log payloads and do not inspect credentials.
MC screenshots use bounded batches of exact file paths in `lsof`, never a
recursive open-file walk of the shots root. An unrelated inaccessible hidden
browser profile cannot block closed screenshots. An opened file stays; failed,
malformed or warning-bearing evidence keeps its entire batch. macOS `lsof`
returns exit 1 for a mixed batch of open and closed requested files; valid
NUL-delimited matches with no diagnostics identify the open files. Other
failures keep the batch.

**G — planning transcripts.** Per `~/.claude/projects/<dir>`, the transcripts
whose cwd is in `plan/<programme>`: the newest stays at any age, and so does
anything touched within `PROGRAMME_TRANSCRIPT_KEEP_MS` (72 hours). Martin,
2026-10-11: "alltid behålla den aktuella; gamla kan städas efter 72h". One
transcript in that directory that cannot be read keeps the whole group: it may
be the newest.

**X — a planning area's extra worktree.** Anything under `plan/<programme>/`
but `memoro/` and `memoro-cli/`, judged by `releaseVerdict` as the workarea
release judged it: no process stands in it, nothing uncommitted, and its
content on main (or its tip a merged pull request's head). Removed with
`git worktree remove` without `--force`, then `branch -D`. One `lsof` answers
for all of them; an lsof that fails keeps every one.

**I — a planning area's own checkouts** (`memoro/`, `memoro-cli/`, made by
`mc plan`; until 2026-11-07 also by the runner before a headless plan session)
go when no planning session of their programme is running — a foreground
`mc plan` record whose process lives, or a process standing in the programme's
directory — and they have been untouched for 72 hours (younger only in a
pressure pass). Whether the programme has open goals does not matter. The
checkout is judged by the release verdict as X judges it, but no process may
stand anywhere in the programme's directory, since a planning session stands
there and not in the checkout. Removed the same way as X, and `mc plan
<programme>` adds it back when it next opens the programme. An lsof that fails
keeps every one, with its error.

**P — unused draft goal worktrees.** In layout 2, a registered checkout at
`programs/<programme>/goals/<goal>/<declared-repo>` may be released automatically
while its valid `GOAL.json` says `stage: draft` (`plan` before 2026-11-07), or `status: Martin`, or its phase
is above its programme's lowest unfinished phase (the runner's own `phaseOpen`
rule), once its goal and checkout have been untouched for 72 hours. A goal with
`status: blocked` keeps its checkout; a goal in a finished stage is not reached. It must be on `goal/<goal>`, have no tracked or untracked
entry, and no live cwd, open file, or uncertain process evidence in the goal or
checkout. Its ignored entries may be only the `node_modules/` link the runner
attaches (when `node_modules/.memoro-deps.json` exists) and the rebuildable
residue of a memoro dev server, exactly `.wrangler/`, `public/dist/`,
`scripts/dev/local-schema.sql`, `.venv-<name>/`, and `__pycache__/` at any depth.
Any other ignored entry (`.mc/local.json`, a local database,
`scripts/admin/_venv/`, `.env*`, `*.log`, `tmp/`, `coverage/`, `.pr-review/`,
`public/modules/`) keeps the checkout, and its why names it. Commits beyond
`origin/main` keep the checkout unless every one is already on
`origin/goal/<goal>`: when a checkout is ahead, P runs one `git fetch -q origin`
per owning repository per pass (in `repo.path`, never in the checkout, never
with `--prune`, a refspec or `--force`), asks the same repository with
`git ls-remote --exit-code --heads origin refs/heads/goal/<goal>` whether origin
still has the branch, and then counts the commits on `origin/goal/<goal>`. A
fetch that fails, or a branch origin does not have, keeps the checkout; a stale
local tracking ref alone does not prove remote existence. A pass with nothing
ahead of `origin/main` fetches nothing. The preview records the count and the remote branch, and the apply
recheck compares them. Goal metadata,
checkout ownership, HEAD, and activity are recorded in the preview and fully
rechecked under the shared runner lock before each removal. The lock-held
recheck reads only that goal and checkout, without repeating the full tidy
inventory or byte estimates; unrelated caches, transcripts and checkouts stay
outside the allocation/admission critical section. Git removes only
the checkout without `--force`; its branch and every goal document, including
`GOAL.json` and `LOG.md`, stay unchanged. When the goal starts, the runner's
existing `placeGoalWorktrees` recovery calls `addGoalWorktree` on that branch.
During a disk-pressure pass only the 72-hour age condition is relaxed; all
other checks remain identical. Invalid or unreadable metadata, ignored local
state, active work, unknown ownership, or changed preview evidence means keep.
Nested cache targets are omitted when the checkout itself is selected. The
`node_modules/` narrowing of the ignored-files guard was made by a plan session
on 2026-11-07 and stands; a plan session may narrow a tidy guard when the rule's
never-removed boundary is kept (Martin, 2026-11-08).

**W — what is left under `~/mc/work/`.** The workareas were retired on
2026-11-03 (goal `mc/no-work`, [`mc-work.md`](mc-work.md)), and nothing makes
one any more. Every directory there is listed under W, never as routine, with
its verdict: kept because a process stands in it, because it holds more than
checkouts (its files are named), or because one of its checkouts is not
releasable — `releaseVerdict` says why: uncommitted changes, commits main
lacks, or a conflict nobody can settle — or a target, `a retired workarea:
<repos> landed with nothing uncommitted`. A target is removed only when the
list says `person: true`: `mc tidy` sets it unless `MC_HEADLESS=1`, and the
runner's daily apply never does, so there each one is kept with *only a
person's mc tidy --apply removes one*. The apply hands each checkout back with
`git worktree remove` without `--force` and `branch -D`, then removes the
directory; a checkout git refuses keeps the whole area. **U — an old execution area.** Nothing closes one any more, so tidy
judges every one under the step root as W judges a workarea, with the same
`person` rule and the kind `orphan-step-area`; one left directly under `~/mc`
is only listed.

**L — loose transcripts and leftovers.** What G leaves, by T1–T5, first
match wins: no cwd, kept; touched within `--days`, kept; its cwd gone,
removed; its cwd in an area, removed unless it is that area's latest; outside
the work root, kept. A `<uuid>/` with no transcript beside it and nothing
inside touched within `--days` is a leftover and goes.

**R — foreign worktrees.** Worktrees git knows of outside the work root
(`/private/tmp/claude-*`, `memoro/.claude/worktrees/agent-*`) are listed with
the rule `foreign-worktree` and never removed. After an apply,
`git worktree prune` runs on both repositories.

**K — slug directories no repository mc knows has.** The gate's directories
(`~/mc/gate/<slug>/` and `~/mc/gate/<slug>-freshen/`), its dependency cache
(`~/mc/gate-cache/<slug>/`) and its selection state
(`~/.memoro/mc/selection/<slug>/`) are named by `repoFileSlug` of a repository's
path, a hash of it, so a moved repository leaves its old directories where
nothing reads them again. A slug is known when it hashes to a repository's bare
path or its checkout (`defaultRepos`), and `<slug>-freshen` is known by its
`<slug>`. A known slug is never a target, whatever its age. An unknown one goes
when no file under it was touched within a day and no process stands in it
(`processesStandingIn`), through `rmTree`, which takes read-only files too. A
slug that is not a direct child of its root is refused at the apply. Measured
2026-10-25, after the move to `~/mc/repos/*.git`: `~/mc/gate-cache/memoro-a66fc130/`
(the hash of `/Users/martinforsberg/memoro`) held 2 GB until it was removed by
hand, and `~/.memoro/mc/selection/` held `memoro-1ee6756a`, `memoro-76f950b8`,
`memoro-ffede537` and `memoro-cli-1d5e7a04` beside the live `memoro.git-17111bc1`
and `memoro-cli.git-365b96c6`.

**A — gate-cache entries.** `~/mc/gate-cache/<slug>/<key>/` is the gate's dependency cache (`prepare-cache.js`): a `node_modules` a green `npm ci` left, with a `meta.json` whose `at` a store sets and every hit renews. Under a slug a repository mc knows has, an entry no round has used for fourteen days (`PREPARE_CACHE_MAX_AGE_MS`) goes, judged by `meta.at` or, without a meta, by the directory's own mtime; a `<key>.tmp-<pid>` staging directory goes once it is a day old, since a store that is running renews its mtime. Removal is through `rmTree`. A round that is cloning an entry as it goes falls back to `npm ci`, which is why no lock is taken. An entry under a slug no repository knows is K's, and goes whole with its slug.

**B — rebuildable caches.** `src/mc/tidy-caches.js` enumerates only the following
paths. This is used by ordinary unattended tidy and disk-pressure passes.

- Under `~/mc/runner/scratch/<stem>/`: `native-phone/derived`,
  `native-phone/packages/repositories`, `native-phone/packages/artifacts`,
  `native-phone/authorization-home/Library/Caches/org.swift.swiftpm`, and
  `native-phone/host/ios/App/App/public`. The regular `.mc-scratch.json` must
  identify the runner, match the stem, and record valid ordered start/end
  times. Its owning `goal:<programme>/<goal>` must also be `done` or `dropped`
  in a valid active or archived GOAL.json. An ended build may still supply
  compilation evidence to review, so unfinished, missing, invalid or reopened
  goals retain the outputs. A cwd or open file anywhere in the session retains its caches.
  Source checkouts, source web assets, logs, manifests, authentication files
  and the ownership record stay. These finished-goal outputs need no age delay.
- In Git-registered worktrees under `~/mc/`: only
  `.wrangler/dev-server/measure/bundle`. A live registered dev server or a
  process cwd anywhere in that worktree keeps it; so does an open bundle file.
  Local databases, settings and server state stay.
- `~/Library/Caches/org.swift.swiftpm`;
  `${MC_HOME}/build/ios-derived`;
  `~/Library/Containers/com.apple.CoreDevice.CoreDeviceService/Data/Library/Caches/AppInstallationBinaryDeltas`;
  `~/Library/Containers/com.apple.mediaanalysisd/Data/Library/Caches/com.apple.mediaanalysisd/com.apple.e5rt.e5bundlecache`.
  Only these generated caches are eligible. iOS archives and the simulator
  runtime stay; a cwd elsewhere in `${MC_HOME}/build` keeps its derived cache.

Shared caches and worker bundles retain **72 hours**, independent of `--days`,
judged by the newest mtime anywhere in the cache, directories included. Every
cache needs complete cwd and open-file evidence. Symlinks in the path to a
cache are refused; links inside a cache are unlinked without following them.
Unexpected file types and unreadable metadata retain the cache. Discovery
reads directory/file metadata, the runner ownership record and the owning
goal metadata; cache payloads and authentication files are never read.

The preview records a hash of the complete tree metadata and its owner.
Apply inventories the candidates again and, immediately before each removal,
rechecks that candidate's ownership, process/server state, open files and full
tree hash. A replaced directory, nested edit, new writer, changed owner or
unregistered worktree is retained. Only exact cache shapes can be removed,
even if a list is edited to name a broader parent. A cache inside a worktree
or area already selected for removal is omitted as a separate target, avoiding
double removal and double counting.

The OS-managed simulator dyld cache is not automatically purged: tidy has no
writer-ownership/idle receipt for it. Arbitrary temporary test fixtures without
ownership records are not adopted. The existing 14-day gate-cache policy and
Docker BuildKit cache protection remain unchanged.

**S — completed runner scratch replay worktrees.** The runner makes
`~/mc/runner/scratch/<stem>/` for each session (`MC_SCRATCH`) and writes
`.mc-scratch.json` into it: `{ schema: "mc-scratch", owner: "runner",
runner_pid, session, kind, stem, started }`, and `ended` and `exit` when the
session is over. Under it only two kinds of immediate child are judged: a
directory with a `.git` (a replay or probe worktree) and one named
`DerivedData`. A worktree must be registered in its owning repository's Git
worktree list. Each goes only when every applicable condition is proved, and
stays with the first that is not:

- with a record: it is a readable regular file, names `owner: "runner"`, a
  session and a start, and either has `ended`, or has no `ended` while its
  `runner_pid` is gone: that pid is not alive, or now runs something other
  than `mc run` (memoro-cli#1362). Such a session is a gone runner's, and the
  candidate is judged by the guards below as an ended one is. A `runner_pid`
  that is not a whole positive number keeps the item, and so does a `ps`
  failure; a record with no `ended` whose runner still stands is unfinished
  and kept. Invalid, unreadable or foreign records are never treated as absent;
- only when the record is absent, a worktree (never marker-less `DerivedData`)
  may use legacy proof: the exact scratch stem has both a regular
  `runner/log/<stem>.json.err` and `<stem>.jsonl`, with canonical paths inside
  the configured log root. `writeSessionLogs` writes `.json.err` only after
  the session resolves. Missing, ambiguous or escaped receipts keep the tree;
- `lsof` answers, and no process stands anywhere in the scratch directory;
- for a marker-less worktree, no file is open anywhere in its scratch session
  (marker-owned worktrees retain the existing candidate-open check);
- for a worktree: `git status --porcelain --untracked-files=all` is empty, and
  the owning repository and exact HEAD are read from Git. A detached HEAD is
  eligible: at apply, before removal, tidy retains that commit at
  `refs/mc/retained-replay/<full-sha>` in the owning repository if no ref
  already contains it. An existing different value or failed retention keeps
  the tree; dry runs never create refs;
- `lsof +D` on the candidate answers, and no process holds a file open in it.

A worktree is removed with `git worktree remove` in its own repository,
without `--force`, after apply rechecks registration, clean state, identity,
HEAD, any legacy receipts, process/open-file state and retention. A changed
tree, session directory identity (device/inode/birth time), worktree identity
or receipt stays. `DerivedData` uses `rmTree`. Logs, patches,
receipts, memory, other scratch children (except B's exact generated-cache
paths) and the parent directory stay. Apply
also requires the canonical target path to remain inside the scratch root and
have its exact allowed shape. Age and pid absence alone are never proof. This
rule runs in routine unattended tidy, including disk-pressure passes;
marker-less `DerivedData` is never adopted. Before 2026-11-05 the chore pass
removed every scratch directory not touched for two days, including evidence;
that sweep is gone.

**S-whole — an ended session's whole scratch directory.** An ended session's scratch directory goes whole once untouched for 7 days (72 hours under pressure), unless its stem or path is named in an unfinished goal's GOAL.json or LOG.md or in a waiting proposal; then it stays until that goal is finished. Each step of the decision is in the list with its reason:

- *Ended* is S's own test on `.mc-scratch.json`: the record names the runner and the session, and either has `ended`, or has no `ended` while its `runner_pid` is positively gone. A directory with no record is legacy and qualifies under the same age only when no process stands in it and no file in it is open.
- *Untouched* is the newest mtime of the directory itself and of its direct entries.
- *Unfinished* is any goal whose GOAL.json does not validly say `done` or `dropped`. A goal whose GOAL.json is missing or does not parse is read as unfinished: what it names is kept, and nothing else is held. *Waiting proposal* is a file `proposals/*.md` under the work root or under a programme (`programs/<programme>/proposals/`); `archive/` names nothing. A goal or proposal file that exists but cannot be read keeps every directory, with its why.
- A directory named by an unfinished goal or a waiting proposal is kept whatever its age, and its why names the reference (`S-named`).
- A directory is kept when a process stands in it or holds a file open in it; when it still holds a git worktree (a `.git` at depth 0 to 2) after S's worktree step, so a clean worktree S removes first goes through git and retains a detached HEAD as S always does; when S or B keeps something in it for its own reason (a dirty worktree, a registered export that does not verify, a marker-less `DerivedData`, a B cache whose goal is unfinished); when `exports/` holds an entry no receipt names; or when any fact cannot be read.
- Removal is `rmTree`, after the list. At apply the directory is judged again on fresh facts, and it is kept when its identity changed, when it became named or touched since the list was written, or when a worktree is still in it.

**C — Codex session transcripts.** A Codex session transcript under `~/.codex/sessions/` goes once older than 7 days and not held open; Codex's databases are never touched. The rule takes a regular `sessions/YYYY/MM/DD/*.jsonl` file (never a symbolic link), judged by its mtime and by one `lsof` batch over the candidates old enough to go, and a date directory whose entries are all such transcripts goes with them, through `rmdir` only when it is empty. An empty date directory untouched for 7 days goes too. `CODEX_HOME` is honoured. Nothing else under the Codex home is read or removed: the `thread_history_*.sqlite` and `logs_*.sqlite` databases, `generated_images/` (F), and every entry outside `sessions/`. A compressed `sessions/*.jsonl.gz` is not a `*.jsonl` file, so C keeps it, as "not a session transcript"; whether C should cover it is a question for planning.

### Registered source exports

The approved shared standard (Martin, 2026-11-09). It applies to every programme:

> A disposable source export is created by mc from a retained commit in a
> configured repository, for explicit repository-relative paths and one
> positively identified runner session. Its reconstruction receipt remains
> outside the removable tree. Reuse requires the same source, selected paths
> and unchanged export contents. The owning session may explicitly release
> the export; otherwise it becomes eligible after that session has ended.
> Removal writes a target list first and immediately rechecks ownership,
> source availability, contents, filesystem identity and process/open-file
> evidence. Failure or uncertainty retains the export with its reason.
> Unregistered contents, changed or additional files, legacy directories,
> evidence, patches and session records are not eligible under this rule.
> Pressure recovery relaxes none of these conditions. A configured dependency
> link may be unlinked only as an explicitly recorded attachment; its target
> is never traversed or removed.

What it means in `src/mc/scratch.js` and `mc scratch` (the command help is `mc scratch --help`):

- **Layout.** `<scratch>/<stem>/exports/<id>/` is the removable tree and nothing
  else; `<scratch>/<stem>/.mc-exports/<id>.json` is the receipt, outside it. The
  source is kept as `refs/mc/retained-export/<commit>`. `<id>` is the first 12
  hex digits of the commit and the first 16 of a key: sha256 over the repository
  name, the full commit and the canonical path set. No other directory under
  `exports/` is a target.
- **Creation.** `mc scratch export --repo <repo> --ref <ref> --path <path>…`
  needs `MC_SCRATCH` to name the runner-owned scratch directory exactly (its
  record names the runner, the session and a start, and no end). The ref is
  resolved once to a full commit. Paths are literal relative names, normalized,
  deduplicated and sorted. Absolute, traversing, wildcard, empty and `.git`
  selections are refused; `.` is the whole repository. The inventory is one
  `git ls-tree -r -l -z`. Contents stream from `git cat-file --batch` in whatever
  pieces the pipe delivers, never buffered whole; each object's id and size are
  checked before its file is written with `wx`. Regular and executable files (modes 100644, 100755) are written as
  committed. A selected symbolic link, submodule or other entry is refused, not
  omitted. No checkout and no `.git` is made. A failed creation removes its own
  partial tree; an interrupted one leaves a directory that no receipt names, and
  that is kept.
- **Retention.** The source ref is created with a zero old value, so an existing
  different commit fails creation. Retention is complete before the ready
  receipt is written, and it is never replaced or pruned by mc.
- **Receipt.** Written atomically, only after the tree verifies: schema, version,
  id, generation, state, key, owner (session, start, stem and the scratch
  directory's device, inode and birth time), repository (name and real path),
  commit, paths, retained ref, export directory identity (device, inode),
  inventory (path, mode, blob id, size) with its digest, bytes and the attachment
  if any. A receipt's own digest is never proof of its tree. The requested/listed
  id, receipt filename and payload id, export path and removal receipt path must
  agree; a mismatch is retained, never redirected.
- **Verification.** Every reuse, release and tidy removal runs the same check:
  the receipt's shape and key; the owner record names the same session and
  start, and the same directory; the configured repository and its real path; the
  retained ref names the commit; `ls-tree` at the commit for the literal paths
  equals the inventory exactly; the tree holds no entry that is not in the
  inventory, no directory outside it, and no link except a recorded `node_modules`;
  each file has the recorded size, mode and blob id (read in 1 MiB pieces, so
  memory is bounded).
  A `removing` receipt (a removal that stopped part way) may lack files, never
  add or change any. A receipt that does not verify is kept with its reason.
- **Reuse.** A repeated request in the same session, with the same key, returns
  the existing path only after verification. A changed tree is reported and kept;
  it is not overwritten. Create, reuse and release for one session are serialized
  in process and by a lock file in `.mc-exports/`. No scan of all scratch takes
  a lock.
- **Dependency link.** `--attach-deps <dir>` records one `node_modules` symlink to
  a prepared tree that holds `.memoro-deps.json`: the target's real path, device,
  inode and the marker's digest. Removal unlinks the link (`lstat`, never followed)
  and leaves the target and its contents as they were. A real `node_modules`
  directory, a different link, a changed target or any other extra entry keeps
  the export. The command installs nothing and runs no install script.
- **Release.** `mc scratch release <id>` previews by writing
  `.mc-exports/<id>.plan.json` (the receipt's digest and the export's identity) and
  removes nothing. `--apply` needs that plan and recomputes the decision; if the
  receipt, the tree, the link or the owner changed since the preview, it removes
  nothing and says so. The owning session may release while it still runs; no
  other process may stand in or hold a file open in the tree, and unknown process
  or open-file evidence keeps it. Explicit release reads only the selected
  receipt/tree. Immediately before each deletion, under that session's lock,
  re-read this candidate's receipt, owner, source, tree and attachment, compare
  with the saved plan, and refresh wall time, cwd and open-file evidence. Earlier
  inventory or another candidate's inspection is not deletion-time proof.
  Reject symlinked ancestors. Removal order: the receipt becomes `removing`,
  the recorded link is unlinked, the tree is removed through `rmTree` (which never
  follows a link), and the receipt becomes `released` with its time and bytes. The
  receipt, the plan's absence and every log, patch and record beside it remain.
  A permission error or partial removal is kept visible and retried safely.
- **Tidy (rule S).** A ready or `removing` export is a target only when its
  session has a recorded end, or its runner is positively gone (the rule for
  records without an end above), the tree passes verification, no process stands
  in it, and no file in it is open. It is listed as kind `scratch-export` with its
  identity; apply reads the fresh facts and removes only what the list still
  describes. Routine and pressure passes apply the same rule; pressure relaxes
  none of it. Only `<scratch>/<stem>/exports/<id>` with a receipt is ever a target.
- **Session end.** After the end marker and the finalized session logs are
  written, the runner awaits `mc scratch sweep` for its own scratch directory, in
  a bounded child process (no synchronous tree read or child wait on the runner's
  event loop). The sweep requires the recorded end, and touches nothing else. A
  refused or failed sweep is recorded as cleanup and changes no session exit, goal
  verdict or provider classification.
- **Not eligible, under this rule.** Unregistered exports, receipts that do not
  verify (malformed, forged, or whose inventory does not reconcile with the
  retained commit), dirty or registered worktrees of any other kind, and
  native-phone, host and public source stay under this rule. Logs, patches,
  results, session records and receipts in an ended, unreferenced directory now
  go whole under S-whole, after 7 days (72 hours under pressure); a directory
  that S-whole keeps keeps them too. Goal documents are not in a scratch
  directory, and their existing rules still apply.
- **Costs.** Git is reached for a fixed handful of commands per export (resolve,
  retain, list, and one list per verification), never once per file; the object
  reads are one streamed `cat-file --batch` per creation. No age threshold is added
  and no retention rule changes. Existing thresholds, lanes and the admission
  policy are unchanged.

## Disk pressure

`src/mc/disk-pressure.js` is the one policy the runner, the deployer and a
Docker start share (goal mc/disk-headroom, 2026-11-05). It reads the
filesystem's own available bytes (`statfs` `bavail` × `bsize`) on the volume
under `~/mc/runner/scratch/`: never a sum of file sizes and never Docker's
reclaimable estimate. Gigabytes are decimal (1 GB = 1e9 bytes).

| | bytes | what it means |
|---|---|---|
| reserve | 20e9 | the floor kept for mc's operations |
| automatic cleanup | 30e9 | below it a pressure pass starts |
| admission | 20e9 | new heavy work is allowed at or above this independent floor |
| recovery target | 40e9 | a pass stops here, or when its safe steps are exhausted |

Admission uses the 20 GB reserve directly; there is no additional admission
headroom. Automatic cleanup starts below 30 GB and still targets 40 GB. **This is a
controlled-workload policy.** It holds back mc's own new work: a headless
session, a deploy script, a stopped Docker runtime's start. It does not stop
other applications, it does not cap a build that is already running, and it
never kills running work or changes what production runs. A running external
operation may use more than the headroom; the monitor then reports pressure
and blocks new mc work.

**When it reads.** The runner reads every minute on its own timer
(`diskTick`), independent of the chores, the nightly and the lanes; the
deployer reads every minute while its script runs, with or without a
runner. A healthy reading writes nothing. Admission is asked at the top of a
lane's pass and before worktree/dependency allocation, after waiting for a slot,
then rechecked just before spawning; by the
deployer at the spawn; by `ensure` before it starts a stopped runtime. An
up runtime is not asked. A reading that fails is written as `unknown`, shown,
and refuses admission; cleanup and `mc tidy` still work.

**The pass.** Below 30 GB a pass runs at once, unless a cooldown holds. Its
steps, each measured after it, stop at 40 GB:

1. (runner only) finished goals archived through `archiveGoal` without the 24
   hours, with every refusal kept and logged as before; no goal is set done to
   free space;
2. tidy's file rules (`runTidy --apply`): the same rules, rule S among them;
3. Docker's images unused for three days, on a runtime that is already up
   (`tidyDocker` without `start`). A failed prune fails the pass. A runtime
   that is down is left down. `ensure`'s own pass has no Docker step, so a start
   does not prune through the runtime it is starting.

The build cache is never pruned (§ Docker): no `builder prune`, no `system
prune`, no cap. A pass that ends below 30 GB — exhausted, no progress, failed
— sets `cooldown_until` five minutes ahead, persisted, so a restart does not
repeat it; a healthy reading clears it and the pressure state. Passes are
single-flight in a policy instance. Cleanup and admissions use separate
persisted leases (`lease` and `admission_lease`) taken under a strict runner
lock: lock failure refuses new work. Cleanup never blocks a new session when
at least 20 GB is available. Each lease excludes other holders of its own
kind, including ones with the same pid, without an age-based takeover. Only
a dead holder is replaced. An admission keeps its lease through allocation
and the synchronous spawn boundary, not the lifetime of the work. Competing
admissions defer and remeasure on retry. Below 20 GB, a pending cleanup does
not admit work; the next attempt measures available space again.

A person's `mc tidy --docker --apply` is recovery and may start the runtime
under pressure; nothing else starts one to inspect or to clean.

**What it writes.** `~/mc/runner/disk-pressure.json`: `{ status, available_bytes,
volume, policy, cooldown_until, cooldown_why, lease, admission_lease, last_cleanup,
shortfall_bytes, last_refusal }`. `~/mc/runner/disk-pressure-events.json`: the
newest 100 events (`EVENTS_KEEP`), each `{ at, volume, trigger, before_bytes,
after_bytes, measured_delta_bytes, estimate_bytes, steps: [{ name, ok,
estimate_bytes, removed, kept, errors, available_after }], errors, failed,
outcome, shortfall_bytes, admission }`, with at most 20 kept reasons and
errors per step. The estimate is what the candidates were said to hold; the
measured delta is what the disk gave back, and the two are never merged. A
refused admission with no pass is an event too. `disk.json` still carries the
runner's refusal as historical diagnostic data; it does not define current
page state.

**Where it shows.** `diskSummary` reads the state file and takes one fresh
statfs measurement; that reading alone supplies the current disk text in the
page and `mc tidy`. At 30 GB or more the output is one healthy measured line.
Between 20 and 30 GB it shows cleanup pressure while explicitly allowing new
work. Below 20 GB, or with an unknown reading, new work waits. The structured
`admission_blocked` flag keeps the page from labelling cleanup-only pressure
as paused sessions. Admission between 20 and 30 GB does not clear the cleanup
cooldown; the monitor continues retrying toward 40 GB.
It does not repeat a past refusal, cleanup outcome, measured/estimated gain,
protected-data note, target shortfall or expired cooldown. Under pressure or
when measurement fails, it shows the current measured value or measurement
failure, and only a still-future retry time. The page's top-level pause notice
also follows this fresh summary, never the saved `disk.json` line. `--json`
keeps `last_refusal` and `last_cleanup` as named diagnostic history alongside
the current `available_bytes` and `status`; history is not erased to simplify
the human presentation.

The 18 GB lost in two hours that started this goal has not been attributed:
neither Docker nor any other writer is named as its cause here.

### The list file

Every run, the dry run too, writes `~/mc/runner/tidy/<yyyymmddThhmmssZ>.json`
with `writeJsonAtomic` before anything is removed:
`{ at, rules_version, days, person, pressure, targets: [{ path, kind, rule, why, bytes, identity? }], kept: [{ path, rule, why }] }`.
`person` says whose run it was (W); the apply reads it back from the file.
`pressure` is true only for a disk-pressure recovery pass; it permits younger P
worktrees and changes no other retention rule. A P target also records goal
stage/status and exact metadata, branch, HEAD, owner, Git common directory,
worktree identity, and activity time.
`--apply` reads that file back and acts on its `targets` only. Each one is
asked again: its realpath must lie under the root its kind allows, in the
shape that kind has, and its rule must still say so on facts read now. For F,
the target must also still be the same regular file (device, inode, size and
mtime) as the written list. A
target that fails either, or whose check throws, is kept with the reason.
What happened is appended to the same file as `applied: [{ path, ok, why }]`,
and logged as `tidy` with counts. The newest 30 list files are kept.

### When it runs

`mc tidy` by hand prints the disk (§ Disk pressure), the counts and bytes per
rule, the first ten targets, every keep worth reading, and the list file;
`--json` prints the list with `disk`. The bytes are the list's estimate. The
runner runs `mc tidy --apply` once a day by its own `runs.tsv` row (kind
`tidy`, note `freed=<bytes>,items=<n>,kept=<k>`), and its file rules in every
pressure pass. S-whole and C run in both: a pressure pass takes an ended scratch
directory after 72 hours instead of 7 days, and C's seven days hold in both. In
the chore pass
`runner.log` moves to `runner.log.1` once it passes 32 MiB
(`RUNNER_LOG_MAX_BYTES`).

### Docker

Docker's images are not files under a root, so they are not in the list.
`tidyDocker` (`src/mc/docker.js`) prunes them after the list has been
applied: `docker image prune --all --filter until=72h`. Docker itself never removes an image that a
container uses, so a running gate or dev server keeps its own. The dry run
removes nothing and reports `docker system df`'s reclaimable sizes. Those
sizes are an upper bound, because they ignore the three days. A failed prune
is printed as a line and makes the run exit 1. The file half still stands.

The runtime is asked through `runtimeOf`, which on OrbStack means
`orbctl status`, because any `docker` call starts the VM. A runtime that is
down is never started, not by the runner's run and not by `mc tidy --apply`.
It is left down and the output says so. `mc tidy --docker` tidies Docker and
nothing else. With `--apply` it starts the runtime through `ensure`, under a
lease for its own pid, and releases the lease when it is done, so the
runner's idle stop stops it again ([`mc-docker.md`](mc-docker.md)). Martin
asked for both on 2026-10-19. On 2026-10-10 OrbStack held 21 images (17 GB)
on an 8 GB machine whose disk was 98 % full. `mc deploy` no longer prunes
after a container rollout; memoro's `scripts/container-image.mjs --build`
prunes on the machine that builds. This keeps three days.

The build cache is never pruned. It was, from 2026-10-19 to 2026-10-25, with
the same three days, and OrbStack's builder was capped at 4 GB besides. With
the cache gone every deploy rebuilt the avatar-motion image from nothing: its
torch, pip and LivePortrait layers (1.45 GB compressed) are not reproducible,
so they came out with new digests every build, and every push to
registry.cloudflare.com re-uploaded them for most of an hour before a layer
commit timed out. Martin removed both on 2026-10-25. BuildKit's own GC bounds
the cache.

The runner's tidy line ends with what Docker reclaimed
(`· docker: images 12.4GB`), and has no such ending when
the runtime was down.

### Never touched

A retired workarea outside a person's `--apply`, and one with anything in it
but landed checkouts; a worktree with
uncommitted changes or commits main lacks that are not on its pushed branch; any `memory/` under
`~/.claude/projects`; `runs.tsv`; `~/.memoro/mc/gate-rounds.jsonl`;
`project_log.md`; Codex's databases (`thread_history_*.sqlite`, `logs_*.sqlite`)
and everything under the Codex home that is not a `sessions/` transcript (C);
anything outside the roots above. No `git worktree move`
and no `--force`. Deletion goes through node `fs`, with no shell, no `find`
and no globbing.

## How it is tested

`tests/mc/goal-archive.test.js` covers archive checks, worktree removal,
archive rows and phase renumbering. `tests/mc/tidy.test.js` covers the
per-root rules and rechecks on fixture facts, rule S on a temporary scratch
root with fake git and lsof, and the disk lines of the printout. S-whole is
tested on the same kind of temporary scratch root: the seven-day and 72-hour
windows, an ended, unnamed session taken whole, each keep with its own reason
(six days, a live or unreadable record, a worktree still held, a process,
an open or unknown file, a legacy directory's marker-less DerivedData), the
references of unfinished goals and waiting proposals against done, dropped and
archived ones, a goal file that cannot be read, the git order of a clean
worktree before its directory, and the apply's recheck. C is tested on a
temporary `CODEX_HOME`, with the open-file fake, a symbolic link, the date
directory it empties, a young transcript, and the databases beside it left
alone.
`tests/mc/run.test.js` drives the policy through the runner's fixture: the
exact line and one byte under it, recovery to 40 GB, exhausted candidates and
the persisted cooldown across a restart, an unreadable disk, two lanes at
once, a lease another process holds, a failed Docker prune, the monitor while
a session and a chore run, archiving under pressure and the bounded history.
`tests/mc/commands/deploy.test.js` and `tests/mc/docker.test.js` cover the
deploy script and a stopped runtime held back, and no build-cache prune. No
test fills a disk; real Git semantics beyond the fake's answers are not
claimed, and `git worktree remove` without `--force` is the runtime backstop. No historical execution record
is a substitute for a fresh release verdict.
