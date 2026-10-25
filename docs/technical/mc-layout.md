# mc layout — where programmes, step areas and registers are, and the move between them

Ruling 51 moves a programme's directory, the runner's step and deps areas, and
each project's register beside its plan. mc knows two layouts at once:

- **layout 1** — today's: `~/mc/plan/`, `~/mc/step/`, `~/mc/runner/projects/`.
- **layout 2** — ruling 51's: `~/mc/programs/`, `~/mc/runner/step/`,
  `~/mc/runner/deps/`, and each project's `STATE.json` beside its `PLAN.json`.

Every module asks which one holds; none of them knows the paths of its own. Layout
1's code is still here. It goes in a later project, once this machine is on
layout 2 — until then both are supported, and the layout file decides.

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

Layout 1, which this machine is on until it migrates:

```
~/mc/plan/<programme>/<repo>/         the programme session's worktrees
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
the merger and every step session run), so no change may move anything before
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

`src/mc/register.js`. A project's state is one JSON file, the same shape in both
layouts:

- **Layout 1:** `~/mc/runner/projects/<project>.json`.
- **Layout 2:** `~/mc/programs/<programme>/<project>/STATE.json`, found by
  `findProjectDir` (`src/mc/plan-write.js`). `registerPath` returns `null` when
  there is no such project.

`registerDir()` is `null` in layout 2 — nothing lists or creates a register
directory there. A write to a project with no path is refused with a message
naming `~/mc/programs`; a read of one is no entry. `listEntries` reads every
`STATE.json` under `programs/`, archived projects included.

**The lock** guards every read-patch-write of the register and of the other
runner files that share its discipline (`merges.json`, deploys, language runs,
iOS builds). It stays under `runner/` in both layouts:
`runner/projects/.lock` in layout 1 (so old and new code still exclude each
other) and `runner/register.lock` in layout 2 (`realLock`). `overlayPlans` takes
the lock for its seed and its reconcile and re-reads the entry inside it, so a
concurrent `updateStep` is not overwritten. `mc run` passes the real lock to its
writes; before this change its writes took none.

Every register write appends a line to `runner/log/register.log`, unchanged.

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
- Archiving a programme releases `memoro/` and `memoro-cli/` and keeps the rest;
  `mc plan <programme> --archive` says "the programme's directory stays".

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
- The `PreToolUse` matcher is `Bash|Write|Read|Edit|MultiEdit`. `mc hook install`
  writes it; `mc hook install --check` reports the old matcher as drift until it
  is run.

Codex sessions get no mc hook (`src/adapters/codex.js`), so they are not covered.

## mc layout migrate

`mc layout` (`src/mc/commands/layout.js`) prints the layout and its roots.
`mc layout migrate` moves a layout-1 machine to layout 2
(`src/mc/layout-migrate.js`). It is a person's command, run from a terminal
standing outside every area it moves, with the runner stopped. Nothing in mc
calls it.

- `mc layout migrate` (no flag) is the dry run. It prints the moves under their
  headings, `PLANNING SESSIONS`, `STEP AREAS`, `REGISTERS`, `TRANSCRIPTS`,
  `HOOKS`, `LAYOUT`, then any `REFUSED` lines, and a count. It writes nothing.
  It exits 0 with no refusal, 1 otherwise. `--json` prints
  `{ layout, moves, refusals }`. In layout 2 it says `layout 2 — nothing to move`.
- `--apply` makes the plan again from the facts — it never trusts an earlier dry
  run. Any refusal prints the list, exits 1 and touches nothing.

**What it refuses.** Each refusal names its path or pid:

- Something that must not run while areas move: a runner or its predecessor
  alive; a step session with a live pid; the merger alive; a `merges.json` entry
  in `mending` or `landing`; a foreground planning session with a live pid in an
  old area; any process standing in an old area; a dev server serving one.
- The plan itself: a destination that exists, or two moves to one destination;
  a `plan/<p>` whose name is not a valid programme name; a register whose JSON
  does not parse.

**The order of the moves.** Each move is `{ kind, from, to, how }`:

1. Planning areas: every entry of `plan/<p>/` into `programs/<p>/`. A git
   worktree moves with `git worktree move`, so git rewrites both its pointers;
   anything else (`.claude/`, files, untracked directories) is renamed whole. Then
   `plan/<p>/` and `plan/` are removed, each only when empty.
2. Step areas: `step/<x>/<entry>` into `runner/step/<x>/` (or `runner/deps/<x>/`
   for a `deps-` area); a legacy `~/mc/<x>/` into `runner/step/<x>/`. Emptied
   directories go, `step/` last.
3. Registers: `runner/projects/<x>.json` to its project's `STATE.json`. A register
   with no project directory goes to `runner/log/closed/registers/`.
4. Transcripts (below).
5. Hooks: `mc hook install`, for the new matcher.
6. Layout: `runner/layout.json`, always last.

The layout file is written last. Until it is, every reader reads layout 1, and a
run that stops half way leaves moves that the next run finishes.

**The transcript rewrite, and why.** `mc plan` finds a programme's conversation
by the `cwd` recorded inside its transcript, not by the name of the directory
(`listConversations` and `within` in `src/mc/conversations.js`). Moving the
worktrees alone would leave the conversation under `plan/<p>`, where `mc plan`
no longer looks, and a resumed session would start fresh. So for each Claude
project directory whose head `cwd` is in an old area, `--apply` rewrites every
transcript in it (sub-agents' under `<id>/` too):

- every line's `cwd`, `payload.cwd` and `relocatedCwd` equal to the old area
  path, or below it, has that prefix replaced; `relocatedCwd` matters because
  Claude Code prefers the last `relocated` entry over the head's `cwd`;
- a line is parsed and serialised again only when it changed; every other line
  is written back byte for byte;
- the file is written to `<file>.migrating` and renamed over the original, keeping
  its times, since the newest conversation is the one resumed;
- the directory is renamed to `encodePath(<new cwd>)`. When that already exists
  (another old directory mapped to the same name) its entries are moved in, and
  a file both hold is a failure. `memory/` moves unchanged.

**Its log.** Each move, as it is attempted, is one JSON line in
`~/mc/runner/log/layout-migrate.log`: `{ at, how, from, to, ok, error }`. Each is
also one `moved <from> → <to>` line on stdout.

**A failure, and a second run.** At the first move that fails, `--apply` stops,
prints what failed and that a second run continues from there, and exits 1. It
never forces, never overwrites, never removes a file it has not moved, and never
unlocks a locked worktree. A second `--apply` re-reads the facts, so it finds
only what is left; after success it says `layout 2 — nothing to move`. It ends by
naming the next things a person does: `mc layout` to see the roots, `mc run
start`.

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
  `mc language`, `mc build ios`, `mc plan`, `mc step`, `mc project`, `mc deps`,
  tidy, the runner).
- `checkout` — a working tree on `main`, for reading a file or running a
  porcelain command: `self/<name>` when it exists, else the primary checkout,
  else `null`. `sharedWorktree` (`mc test`, `mc shot`), the helper digest's
  `memoroRoot` and `mc build ios`'s declared `list_builds` script take it, and
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
repository has no `package.json` to copy, so `ensureWorkDeps` reads main's two
files with `git show origin/main:…` (work-deps.js).

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
