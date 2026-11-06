# mc tidy — what mc may remove

Goal archive and machine tidying are different operations. Neither needs an
archive pull request for the goal's own records.

## Goal archive

`mc goal archive <programme>/<goal>` uses `archiveGoal`
(`src/mc/goal-archive.js`). Only a `done` or `dropped` goal can leave. It
refuses uncommitted work, an open pull request, unknown repositories or
GitHub state, and a dropped branch with unpushed commits. It checks the goal's
carried PRs as well as its branch.

The worktrees are removed through git, the local branch deleted, and the
goal directory moved to `goals/.archive/`. One row is appended to
`goals/goal_log.md`; phases are renumbered so there are no gaps. Nothing is
written into a repository. The runner calls the same operation once a goal
has been done or dropped for 24 hours, counted from its stage-setting log
entry, and in a disk pressure pass without the 24 hours (§ Disk pressure). A refusal is recorded once in LOG.md, not every chore pass.

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
| `~/mc/programs/<programme>/` | a planning area: `memoro/`, `memoro-cli/`, extra worktrees | an extra worktree whose content is on main (X); a programme's own checkouts once it has no goal that is not finished (I) |
| `~/mc/runner/step/<name>/` | an old execution area | the whole area, as W judges one, only in a person's `--apply` (U) |
| `~/mc/work/<name>/` | what is left of a retired workarea | the whole area, when every checkout in it is clean and landed, it holds nothing else and no process stands in it — and only in a person's `--apply` (W) |
| `~/.claude/projects/` | transcripts, `<uuid>/`, `memory/` | transcripts and leftovers (G, L) |
| `~/Library/Preferences/.wrangler/logs/` | Wrangler logs | regular `.log` files directly in the root, older than 72 hours (F) |
| `${MC_HOME}/shots/` | MC screenshots | regular `.png` files in non-hidden directories, recursively; hidden directories and `sessions/` stay (F) |
| `${CODEX_HOME:-~/.codex}/generated_images/` | Codex generation groups | regular `.png`, `.jpg`, `.jpeg` and `.webp` files directly in UUID-named session directories, older than 72 hours and only if the group is wholly old (F) |
| `~/mc/runner/scratch/<stem>/` | a runner session's scratch: logs, patches, replay worktrees, DerivedData | a clean registered worktree with ended ownership evidence, or marker-less legacy worktrees with a matching finalized runner log pair; `DerivedData` only with a valid ended ownership record (S); never logs, patches or the directory |
| `~/mc/gate-cache/`, `~/mc/gate/`, `~/.memoro/mc/selection/` | a directory per repository slug (`repoFileSlug` of its path) | a slug directory no repository mc knows hashes to, untouched for a day, with no process in it (K); under a slug a repository mc knows has, an entry no round has used for 14 days, or staging older than a day (A) |

In layout 2 the planning areas are `~/mc/programs/<programme>/`, of which tidy removes only git worktrees (X) and a programme's own checkouts once it is idle (I) ([mc-layout.md](mc-layout.md)).

Rule P was removed with projects; rules version 9 reads no execution
register, adds S, and includes the narrowly approved generated-file rule F.
Scratch cleanup follows S below; transcripts and logs outside F's exact
root and shape remain governed by their existing rules.

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
`ensurePlanArea`) go while their programme has no goal that is not finished:
every `goals/<goal>/GOAL.json` of the programme says `done` or `dropped`. A
GOAL.json that cannot be read or parsed counts as not finished. The
checkout is judged by the release verdict as X judges it, but no process may
stand anywhere in the programme's directory, since a planning session stands
there and not in the checkout. Removed the same way as X, and `mc plan
<programme>` adds it back when it next opens the programme. An lsof that fails
keeps every one, with its error.

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

**C — `mc shot --compare` trees.** The detached worktrees `shot-compare.js`
makes under `~/.memoro/mc/compare/` (`tidyRoots().compare`, under mc's home,
not the work root). One goes when it has not been used for `COMPARE_KEEP_MS`
(a day) and no live dev server stands in it (`serversFor`). Last use is the
directory's mtime, and that is only true because `compareTree` touches the
directory when it reuses one (a reuse writes nothing in it). The tree is
removed with `git worktree remove`, without `--force`, run in the repository
git names as its owner (`rev-parse --git-common-dir`), read again at the
apply. A tree with edits, or one whose server started after the list was
written, stays. These trees are no longer listed as `foreign-worktree`.

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
  session and a start, and has `ended`; invalid, unreadable, foreign or
  unfinished records are never treated as absent;
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
receipts, memory, other scratch children and the parent directory stay. Apply
also requires the canonical target path to remain inside the scratch root and
have its exact allowed shape. Age and pid absence alone are never proof. This
rule runs in routine unattended tidy, including disk-pressure passes;
marker-less `DerivedData` is never adopted. Before 2026-11-05 the chore pass
removed every scratch directory not touched for two days, including evidence;
that sweep is gone.

## Disk pressure

`src/mc/disk-pressure.js` is the one policy the runner, the deployer and a
Docker start share (goal mc/disk-headroom, 2026-11-05). It reads the
filesystem's own available bytes (`statfs` `bavail` × `bsize`) on the volume
under `~/mc/runner/scratch/`: never a sum of file sizes and never Docker's
reclaimable estimate. Gigabytes are decimal (1 GB = 1e9 bytes).

| | bytes | what it means |
|---|---|---|
| reserve | 20e9 | the floor kept for mc's operations |
| pressure and admission | 20e9 | below it a pressure pass starts; no new heavy work is admitted until it is back |
| recovery target | 40e9 | a pass stops here, or when its safe steps are exhausted |

Admission uses the 20 GB reserve directly; there is no additional admission
headroom. The cleanup target remains 40 GB. **This is a
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

**The pass.** Below 20 GB a pass runs at once, unless a cooldown holds. Its
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
prune`, no cap. A pass that ends below 20 GB — exhausted, no progress, failed
— sets `cooldown_until` five minutes ahead, persisted, so a restart does not
repeat it; a healthy reading clears it and the pressure state. Passes are
single-flight in a policy instance. Cleanup and admissions share a persisted
lease taken under a strict runner lock: lock failure refuses new work. A live
holder excludes other instances, including ones with the same pid, without
an age-based takeover. Only a dead holder is replaced. An admission keeps
the lease through allocation and the synchronous spawn boundary, not the
lifetime of the work. Competing callers defer and remeasure on retry.

A person's `mc tidy --docker --apply` is recovery and may start the runtime
under pressure; nothing else starts one to inspect or to clean.

**What it writes.** `~/mc/runner/disk-pressure.json`: `{ status, available_bytes,
volume, policy, cooldown_until, cooldown_why, lease, last_cleanup,
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
page and `mc tidy`. At 20 GB or more the human output is one concise measured
line, including the healthy interval from 20 GB to the 40 GB cleanup target.
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
`{ at, rules_version, days, person, targets: [{ path, kind, rule, why, bytes, identity? }], kept: [{ path, rule, why }] }`.
`person` says whose run it was (W); the apply reads it back from the file.
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
pressure pass. In the chore pass
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
uncommitted changes or commits main lacks; any `memory/` under
`~/.claude/projects`; `runs.tsv`; `~/.memoro/mc/gate-rounds.jsonl`;
`project_log.md`; anything outside the roots above. No `git worktree move`
and no `--force`. Deletion goes through node `fs`, with no shell, no `find`
and no globbing.

## How it is tested

`tests/mc/goal-archive.test.js` covers archive checks, worktree removal,
archive rows and phase renumbering. `tests/mc/tidy.test.js` covers the
per-root rules and rechecks on fixture facts, rule S on a temporary scratch
root with fake git and lsof, and the disk lines of the printout.
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
