# mc layout — where programmes and runner areas are

`mc layout [--json]` prints the layout number and three roots: planning
sessions, legacy execution areas, and dependency-update areas. It is a reading,
not a migration. `src/mc/commands/layout.js` and `src/mc/paths.js` supply it.

## Current structure

```
~/mc/programs/<programme>/
  README.md                         the programme's aim
  memoro/  memoro-cli/               plan/<programme> worktrees
  goals/<goal>/
    GOAL.json  LOG.md                brief, state and session log
    memoro/  memoro-cli/             goal/<goal> worktrees, as repos declares
  goals/.archive/                   finished goals moved aside
  goals/goal_log.md                 archive rows
  evidence/<date>-<topic>/          the programme's evidence, with README.md
~/mc/restricted/
  README.md                         the rules below
  <programme>/<date>-<topic>/       restricted evidence, with README.md
~/mc/runner/
  deps/<name>/<repo>/               dependency-update worktrees
  log/  merges.json  register.lock  runner and merger records
~/mc/martin/items/<id>/              durable Martin desk records (outside programmes)
~/mc/archive/programs/              programmes archived by the person
```

The goal directory and branch are made by `mc goal new`; phases and stages
are described in [mc-goals.md](mc-goals.md). Projects went on 2026-11-03;
that document's § From a project describes migration of the old records.
No new execution area is made under `runner/step/`.

## Data outside the repositories

Development data that is worth keeping but does not belong in a repository
has two places, by sensitivity. Temporary run output (`runner/scratch/`, gate
receipts) is neither; it has its own retention.

**Programme evidence** — `programs/<programme>/evidence/<date>-<topic>/`.
Screenshots, measurements, logs, checksums and conclusions a goal or decision
cites. Nothing account-bearing, no owner originals, no production-derived
bytes. Each directory has a README.md naming the goal or decision it serves,
what produced it and what it shows. It goes with the programme into
`archive/programs/`.

**Restricted evidence** — `~/mc/restricted/<programme>/<date>-<topic>/`.
Data that must stay out of `programs/` and every repository: owner originals,
account-bearing manifests, production-derived bytes. Rules, also in
`~/mc/restricted/README.md`:

- `~/mc/restricted/` and every directory under it are mode 0700. The root is
  excluded from Time Machine once (`tmutil addexclusion ~/mc/restricted`, a
  per-path attribute). It is never inside a worktree, `programs/` or a synced
  folder, and nothing there is uploaded.
- Each entry has a README.md: owning programme and goal or decision, what it
  holds and its source, who created it and when, and the condition on which it
  is deleted. The README holds no restricted content itself.
- Checksums, dimensions and conclusions are written to the programme's
  `evidence/<date>-<topic>/`, never the bytes, storage keys or account ids.
- Only an interactive session creates, moves or deletes an entry. Headless
  sessions only read a copy they are pointed at.
- The entry is deleted when its README's condition holds, by the plan session
  that owns it, which records the deletion in the programme. When the
  programme is archived, `mc plan <programme> --archive` removes
  `~/mc/restricted/<programme>/` and keeps each README as
  `evidence/<entry>/RESTRICTED-README.md` in the archived programme; it refuses
  while an entry has no README.md.

mc enforces only the archive step and counts `restricted` as its own home
(`STATE_HOMES`); the rest is the creating session's duty. There is no hook.

## Compatibility and path helpers

`layoutVersion` reads `~/mc/runner/layout.json` on each call. A file with
schema `mc-layout` and version 2 selects layout 2; missing, unreadable or
unrecognised data selects layout 1. The one-time `mc layout migrate` ran on
2026-10-20 and is now refused with exit 2.

- `planAreaName` / `planAreaRoot`: `programs/<programme>` / `programs` in
  layout 2; `plan/<programme>` / `plan` in layout 1.
- `depsAreaName`: `runner/deps/<name>` in layout 2, `step/<name>` in layout 1.
- `stepAreaRoot`: `runner/step` in layout 2, `step` in layout 1. These roots
  remain for inspection and tidying of old areas, not for goal builds.
- `areaKindOf` recognises both spellings of plan, step, deps, work and legacy
  areas; `areaOfPath` locates a path within one. This lets old transcripts
  and leases remain readable.
- `STATE_HOMES` names mc-owned directories excluded from ordinary areas.

Only git worktrees are released from a layout 2 planning area. Other files,
including goals and programme documents, are kept. Programme archive moves
the directory aside only after its repository changes have landed.
The runner's queue lock is `runner/register.lock` (`runner-lock.js`).

## Goal-file guard

`src/mc/hooks.js` refuses direct Write, Edit and MultiEdit of GOAL.json under
`programs/`, with id `goal-file`; a relative path is resolved against cwd.
There is no escape for those tools. Bash writes naming GOAL.json are caught
by a separate rule, with the usual `MC_HOOK_ALLOW=1` escape. Use the `mc goal`
verbs so each write is validated. See [mc-hooks.md](mc-hooks.md).

## The repositories

A second pair of layouts, independent of the work root's: where mc's two
repositories, `memoro` and `memoro-cli`, live. `src/mc/repos.js` knows both, and
`defaultRepos(env)` is the one answer every caller asks (`brief-collect.js`
re-exports it).

- **The primary checkouts** — `~/memoro` and `~/memoro-cli`, working trees whose
  `.git` every worktree hangs off. `/opt/homebrew/bin/mc` resolves into
  `~/memoro-cli`, so whatever is checked out there is the running mc.
- **Bare repositories** — `~/mc/repos/<name>.git` (`reposHome`), which every
  worktree hangs off, and `~/mc/self/<name>` (`selfHome`), a worktree of each on
  `main`: the one mc is linked to (memoro-cli) and the one `mc shot` and `mc test
  dev` serve outside a worktree (memoro).

Which holds is decided per repository by what exists: `<name>.git` under
`~/mc/repos/` is the bare layout; otherwise the primary checkout, as before. A
machine without `~/mc/repos/` gets exactly the answer it got before the module
existed. `MC_REPOS_HOME` moves the primary checkouts, the bare repositories and
`self/` together, so a test's fixture never reaches this machine's.

`defaultRepos` answers `{ name, git, path, bare, checkout }` per repository, and
a caller takes the field for what it does:

- `path` — where git plumbing runs: `fetch`, `show`, `rev-parse`, `log`,
  `branch`, `merge-base`, `worktree add|list|prune|repair`, and `gh`. The bare
  directory, or the primary checkout. Most callers take this one (`mc deploy`,
  `mc language`, `mc asc`, `mc plan`, `mc goal`, `mc deps`,
  tidy, the runner).
- `checkout` — a working tree on `main`, for reading a file or running a
  porcelain command: `self/<name>` when it exists, else the primary checkout,
  else `null`. `sharedWorktree` (`mc test`, `mc shot`), the helper digest's
  `memoroRoot` and `mc asc`'s declared scripts take it, and
  each says what it does without one — `no memoro checkout to serve — ~/mc/self/memoro
  is missing`.
- `git` — the git directory, which is what `--git-common-dir` of any worktree
  names: how `knownRepo` (hooks.js) recognises a directory as one of these
  repositories, and how the runner and the readers ask whether a repository is
  on this machine at all (`gitDirOf` for a `{ name, path }` a test built).

Two small rules come with the bare form. A worktree's repository is
`repositoryDir(commonDir)` — the parent of a `.git`, but the common directory
itself when it is bare — and a repository's name is `repoNameOf(path)`, which
drops `.git`, so a worktree of `memoro-cli.git` is still `memoro-cli/` in its
area and `memoro-cli` to the gate table and the dependency tree. A bare
repository has no `package.json` to copy, so `ensureSharedDeps` reads main's two
files with `git show origin/main:…` (shared-deps.js).

### `mc repos`

`mc repos` (`src/mc/commands/repos.js`) prints which of the two each repository
is in: `bare` or `primary`, its git directory, the checkout mc serves and its
linked worktrees. This machine moved to the bare layout on 2026-10-25; the
one-off command that made the move is gone with it.
