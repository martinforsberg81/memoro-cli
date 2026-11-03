# mc layout — where programmes, step areas and deps areas are

Ruling 51 moves a programme's directory, the runner's step and deps areas, and
each project's register beside its plan. mc knows two layouts at once:

- **layout 1** — legacy: `<work root>/plan/`, `~/mc/step/`, `~/mc/runner/projects/`.
- **layout 2** — current: `~/mc/programs/`, `~/mc/runner/step/`,
  `~/mc/runner/deps/`, and each project's `STATE.json` beside its `PLAN.json`.

Every module asks which one holds; none of them knows the paths of its own. Layout
1's code is still here. It goes in a later project, after the compatibility
period. Both are still supported, and the layout file decides.

## The two layouts side by side

Layout 2 is the tree in [ruling 51](../project/mc/rulings.md) and
[`mc-project.md` § Structure](../project/mc/mc-project.md#structure):

```
~/mc/programs/<programme>/            the programme's directory; its session starts here
  memoro/  memoro-cli/                the programme session's worktrees (branch plan/<programme>)
  rulings.md, project_log.md, …       the programme's documents
  <project>/
    DRAFT.json → PLAN.json            what is to be done
    STATE.json                        where it stands (the register)
    CLOSEOUT.json                     what it came to

~/mc/runner/
  step/<project>/<repo>/              a step's worktree
  deps/<name>/<repo>/                 mc deps bump
  log/  merges.json  held.json  …     what is running now, raw logs, caches
  register.lock                       the lock (see below)

~/mc/work/<name>/<repo>/              a person's workareas, unchanged
```

Legacy layout 1, before migration:

```
<work root>/plan/<programme>/<repo>/         the programme session's worktrees
~/mc/step/<project>/<repo>/           a step's worktree; step/deps-… for mc deps bump
~/mc/runner/projects/<project>.json   the register
~/mc/runner/projects/.lock            the lock
~/mc/work/<name>/<repo>/              unchanged
```

## What decides which holds

`~/mc/runner/layout.json`, written by `mc layout migrate --apply` and never
before it:

```json
{ "schema": "mc-layout", "version": 2, "migrated": "2026-…" }
```

`layoutVersion()` in `src/mc/paths.js` returns `2` only when the file parses,
has `schema: "mc-layout"` and `version: 2`. A missing, unreadable or
unrecognised file is layout 1. It is not cached: a long-lived runner sees the
file the moment it appears. `mc layout` prints `layout 1` or `layout 2` and the
roots in use.

Without the file nothing moves. A merged pull request is live on this machine at
once (`deployPull` in `src/mc/repo-merge.js` pulls the installation every `mc`,
the merger and every build session run), so no change may move anything before
the file says so.

## The helpers every module asks

All in `src/mc/paths.js`. Each takes an optional `root` (the work root) and, where
it reads the file, a `read` function, so a test can run on a temporary root.

- `planAreaName(programme)` — `programs/<p>` in layout 2, `plan/<p>` in layout 1.
- `stepAreaName(project)` — `runner/step/<p>` in layout 2 (no legacy fallback);
  layout 1's answer, including the legacy `~/mc/<p>/` checkout, otherwise.
- `depsAreaName(name)` — `runner/deps/<n>` in layout 2, `step/<n>` in layout 1.
- `planAreaRoot()` and `stepAreaRoot()` — the directories those areas sit in.
- `areaKindOf(areaName)` — pure, and knows **both** spellings whatever the file
  says, because a transcript or a lease written before the move must still be
  read. It returns `{ kind, name, area }` for `plan`, `step`, `deps`, `work` and
  `legacy` areas, and `null` for a kind's root alone or anything that is not an
  area.
- `areaOfPath(path, root)` — the area a path lies in, by `areaKindOf` on the path
  below the root; `null` outside the root.
- `sessionName(areaName)` — the name a session is shown under; a step area is its
  project's name in both layouts.

`STATE_HOMES` is the same in both layouts.

## The register

Gone with projects on 2026-11-03 (goal `mc/projects-to-goals`). A project's
state was one JSON file beside its plan, read and written by `register.js`; a
project's remaining steps are goals now (`mc goal from-project`), and a goal's
state is its own `GOAL.json` and `LOG.md`. The lock that guarded the register
guards the runner's other files still: `runner/register.lock`
(`src/mc/runner-lock.js`).

## A programme's directory

In layout 2 a programme's directory holds the planning session's worktrees and
also the programme's documents and its projects. So mc removes only git
worktrees from it, never another file or directory, and never the directory
itself. `src/mc/work-area.js`:

- `isProgrammeArea(name)` is a plan area under `programs/`.
- `inspectWorkArea` lists as a worktree only an entry that holds a `.git`.
- `releaseWorkArea` and `discardWorkArea` remove the git worktrees named, and
  for a programme's directory never the area, its conversations, or its
  `held_by`: `removes_area` is `false`.
- Archiving a programme releases `memoro/` and `memoro-cli/`, then moves the
  directory whole to `~/mc/archive/programs/<programme>` (`-2`, `-3`, … when
  that name was archived before; ruling 57, `shelveProgramme` in
  `src/mc/archive-programme.js`). Nothing under `archive/` is read as live: its
  plans, `STATE.json` files and documents are out of every listing.

In layout 1 a plan area holds only checkouts, so the only change there is that a
stray non-git directory is no longer listed or removed.

`mc project new` refuses a project named like a repository (`memoro`): that name
is the programme session's worktree of the repository.

## The plan-file guard

`src/mc/hooks.js`. `PLAN.json`, `DRAFT.json`, `STATE.json` and `CLOSEOUT.json`
under `~/mc/programs/` are written by verbs only: `mc project`, `mc step`, the
runner, the merger. A planning session stands right beside them, so the guard
catches a mistake; it does not stop an intent.

- `protectedPlanFile(path, { programs })` is true when the resolved path lies
  under `programs/` and its basename is one of the four names.
- `Write`, `Edit` and `MultiEdit` of such a file are refused with id `plan-file`,
  and the reason says to use `mc project` and `mc step`. There is no
  `MC_HOOK_ALLOW=1` escape for these tools. A relative path is resolved against
  the session's `cwd`.
- A Bash rule with the same id refuses a redirect, `tee`, `sed -i`, or a `mv`,
  `cp`, `rm`, `truncate` or `install` naming one of the four files. It sits under
  the usual `MC_HOOK_ALLOW=1` escape. It may match such a name outside
  `programs/`, which is accepted: no repository holds such a file any more.
- The `PreToolUse` matcher is `Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*`
  (the Chrome tools since chrome-turn, see `mc-hooks.md`). `mc hook install`
  writes it; `mc hook install --check` reports the old matcher as drift until it
  is run.

Codex sessions get no mc hook (`src/adapters/codex.js`), so they are not covered.

## mc layout migrate

The one-time move from layout 1 to layout 2. It ran on Martin's machine on
2026-10-20 and went with projects on 2026-11-03: most of what it moved was
project registers. `mc layout` (`src/mc/commands/layout.js`) prints the layout
and its roots; `mc layout migrate` says it is gone and exits 2.

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
  `mc language`, `mc asc`, `mc plan`, `mc step`, `mc project`, `mc deps`,
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

## What is left for later

Layout 1's branches in `paths.js`, `register.js`, `work-area.js` and the other
modules stay until a later project removes them, once this machine is on layout
2 and the runner has run on it. The technical documents that still describe
layout 1 are rewritten then too; this document is the one that says which layout
holds.
