# The shared dependency tree — what a checkout's tests can import

Every checkout mc makes under `~/mc` — a runner area's, a goal's worktree, a
programme's planning checkouts, the merge gate's candidate — resolves its
packages from one directory above it, `~/mc/node_modules`, or attaches the
repository's own cache. This is how, and why. The workareas this was first
written for were retired on 2026-11-03 ([`mc-work.md`](mc-work.md)); the tree
outlived them unchanged.

## Where a checkout's dependencies come from

**`~/mc/node_modules`. One directory, above every area and inside none of
them.** Node resolves a bare specifier by walking `node_modules` up every
parent of the importing file, so a checkout at `~/mc/programs/<programme>/goals/<goal>/<repo>/src/…`
reaches this one with nothing in the checkout at all. The name lives in
[`src/mc/paths.js`](../../src/mc/paths.js) (`SHARED_DEPS`) with the rest of the
work root's shape; [`src/mc/shared-deps.js`](../../src/mc/shared-deps.js) builds it.

**The failure it exists for is a test going red because of where it was run.**
Five of this repository's test files imported `@xterm/addon-serialize`,
`@xterm/headless` or `node-pty` — all three declared in `package.json`, none of
them present in a fresh worktree. Measured 2026-09-02 on a clean `origin/main`
worktree, whole suite, twice: **14 failing files without a dependency tree, 9
with**, and the five in the difference failed with `ERR_MODULE_NOT_FOUND`. So
one commit had three answers depending on where it was measured — the main
checkout has a real `node_modules` and ran 9 red, an area mc had just made
ran 14, and the merge gate's candidate ran the same 14 while declaring it had
run everything. A session reading that sees its own change blamed for a package
nobody removed.

**Above the areas rather than in them**, for two reasons that were both
measured rather than argued:

- A `node_modules` entry *inside* `<area>/<repo>/` is visible to git and to
  `scripts/affected-tests.js`, and a symlink there is not matched by
  `.gitignore`'s `node_modules/`. Measured 2026-09-02: the selector reported it
  as an unexplained changed path and fell back to the whole suite — 250 files
  instead of 41. That is the reading that would quietly undo the selector's
  whole value.
- An `npm ci` per area is a copy of the same tree per place. There were 40
  directories under `~/mc` on 2026-09-02, and the dependency tree is the same
  handful of packages for all of them.

## What the directory holds, and why this and not the other one

An `npm ci` of its own, run in the work root against a **copy of the
repository's `package.json` and `package-lock.json`** — the copy is the
manifest minus `scripts` and `bin`, because `npm ci` runs the root package's
lifecycle scripts and this repository's `postinstall` is `node
scripts/postinstall.js`, a path that does not exist in the work root. Dropping
the two fields that name files leaves the dependency declaration, which is all
`npm ci` needs to agree with the lockfile.

The way in is a byte comparison: the repository's lockfile against the copy at
the work root. Same bytes and a tree already there means nothing runs; a
lockfile that has moved means one `npm ci`, paid by whichever new worktree
happened to be next. Measured 2026-09-02: a new worktree of memoro-cli was 22 s
in total, worktree and install together, and a second one on the same lockfile
pays one file read.

The cheaper form — symlinking `~/mc/node_modules/<pkg>` at
`~/memoro-cli/node_modules/<pkg>` — was measured first and not taken. It ties
every area's tests to one checkout's install: the packages a session
resolves would be whatever the user's own checkout last installed, and an `npm
ci` there while a session is running pulls them out from under it. This form
owns what it holds.

Two consequences worth knowing before they surprise somebody:

- **The manifest copied is the repository checkout's own**, which is `main`, not
  the new worktree's branch. One directory holds one tree, so reading each
  branch's manifest would have two worktrees reinstalling over each other. A
  branch that adds a dependency does not get it from here until it lands; the
  session on that branch installs it itself, and nothing stops it.
- **One directory holds one manifest, so it serves one repository**, and which
  one is written down (`SHARED_TREE_REPOS` in `shared-deps.js`) rather than
  decided by whichever worktree was made first. memoro is not on it: it declares
  `prepare: 'npm ci'` in the gate table (measured, D-0089) and its dependencies
  are its own. A repository that is not on the list is left alone and told so —
  `state: 'not-shared'`.

## memoro attaches its own

memoro is not in `SHARED_TREE_REPOS`, because one directory holds one lockfile
and memoro writes inside its own `node_modules` (`.cache`, `.mf`), so a tree
shared with it would be written under by whatever else ran there. It keeps its
own, and a worktree `addWorktree` makes runs the repository's
`scripts/ensure-worktree-deps.mjs` when it has one (`attachRepoDeps` in
[`src/mc/shared-deps.js`](../../src/mc/shared-deps.js)). That script attaches the
checkout to memoro's per-lockfile cache under
`~/Library/Caches/memoro-dependency-cache/` as `package-links` — one symlink per
package, about 250 KB a checkout where a full `npm ci` was 510 MB. A repository
without the script gets `state: 'no-attach-script'` and nothing runs. The attach
is reported, never fatal: a failure is one line from the verb that made the
worktree, and the worktree is still the deliverable. `mc plan` and
`mc deps bump` attach through `addWorktree`; the runner passes `attach: false` because it
attaches before each goal build or review itself. `mc plan` also re-attaches a planning checkout that already stands each time its programme is opened, since that checkout is reused and its lockfile can move on main.

An exit of 0 is not taken for an attachment: `attachRepoDeps` reports
`attached` only when the script left `node_modules/.memoro-deps.json`, which
memoro writes on both its cache and its local `npm ci` path, and `failed`
otherwise. It runs the script by the checkout's real path, because memoro's
script runs only when `process.argv[1]` equals its `import.meta.url` and exits
0 having done nothing when the checkout is reached through a symlink (measured
2026-10-25: a worktree under macOS's `/var` → `/private/var` was reported
attached and had no `node_modules` at all).

## It is not an area, and nothing had to be taught that

The area's shared readers name a directory under the work root only when it
holds a checkout of a known repository, and this dependency root holds none.
It is not a programme or goal. The assertion is in
[`tests/mc/shared-deps.test.js`](../../tests/mc/shared-deps.test.js) makes it
against a real work root rather than trusting the reasoning. `mc --json` and
`mc repo --json` were run with the tree in place and neither mentions it.

One caller does return it: `listWorkAreas` lists every non-dot directory, so
the tree joins `bin/`, `brief/`, `decisions/` and `inbox/` in a list nothing
renders bare today. A future caller of that function inherits the whole crowd,
not this one directory.

## What the page's data says about it

Every worktree `workStatus` reads carries `dependencies` — `present`, `missing`, or
`null` for a directory that is not a Node project or declares nothing
([`work-status.js`](../../src/mc/work-status.js), `dependencyState`; no row of
prose prints it). The answer comes from
[`dependencyTree`](../../src/mc/dependency-tree.js), which looks for each
declared name the way node does — `node_modules/<name>` here, then in every
directory above. An area therefore reads `present` with no `node_modules` of
its own, which is the point of the tree living one directory up: the field says
what the tests will find, not what `ls` finds.

The old question — *is there a `node_modules` in this directory* — is not the
question node answers, and asking it that way would report every area as
missing while its imports resolved perfectly well.

## The gate's candidate stands in the same tree

The merge gate builds its throwaway worktree under the work root too, at
`<work root>/gate/<repo>/candidate`, so the same one tree is two parents above
it: one copy for the areas and the rounds together, no `npm ci` per round,
and nothing inside the checkout. That half is written down in
[`mc-merge.md`](mc-merge.md) § *Where the candidate's dependencies come from*.

## How it is tested

[`tests/mc/shared-deps.test.js`](../../tests/mc/shared-deps.test.js) drives
`ensureSharedDeps` against a temporary work root with the install stubbed: the
lockfile-unchanged path installs nothing, a moved lockfile installs once, the
manifest written is the repository's minus `scripts` and `bin`, a repository
that is not on the list is refused by name, a failed install is reported rather
than thrown, and a new worktree leaves the tree beside the area rather than
in it. The parent walk, including the half-installed tree an existence check
called present, had a test until 2026-11-01; it was removed with the tests
that never caught anything (the module had not changed in 90 days).
