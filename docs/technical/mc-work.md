# mc work — a workarea, and what its tests can import

A piece of work is a directory under `~/mc`. `mc work add <name> <repo>
[branch] [--from <ref>]` makes it and puts a git worktree in it at
`~/mc/<name>/<repo>`, on a branch cut from the repository's base; it installs
the pre-push guard into the repository's common hooks, and it makes sure the
dependency tree that checkout's tests will resolve is there. The worktree is
the deliverable — the guard and the tree are reported and never fatal, because
a session with a checkout and no tree can still work, and it is told which
packages it will not find
([`src/mc/work-area.js`](../../src/mc/work-area.js), `addWorktree`).

## Where a workarea's dependencies come from

**`~/mc/node_modules`. One directory, above every workarea and inside none of
them.** Node resolves a bare specifier by walking `node_modules` up every
parent of the importing file, so a checkout at `~/mc/<area>/<repo>/src/…`
reaches this one with nothing in the checkout at all. The name lives in
[`src/mc/paths.js`](../../src/mc/paths.js) (`WORK_DEPS`) with the rest of the
work root's shape; [`src/mc/work-deps.js`](../../src/mc/work-deps.js) builds it.

**The failure it exists for is a test going red because of where it was run.**
Five of this repository's test files imported `@xterm/addon-serialize`,
`@xterm/headless` or `node-pty` — all three declared in `package.json`, none of
them present in a fresh worktree. Measured 2026-09-02 on a clean `origin/main`
worktree, whole suite, twice: **14 failing files without a dependency tree, 9
with**, and the five in the difference failed with `ERR_MODULE_NOT_FOUND`. So
one commit had three answers depending on where it was measured — the main
checkout has a real `node_modules` and ran 9 red, a workarea mc had just made
ran 14, and the merge gate's candidate ran the same 14 while declaring it had
run everything. A session reading that sees its own change blamed for a package
nobody removed.

**Above the workareas rather than in them**, for two reasons that were both
measured rather than argued:

- A `node_modules` entry *inside* `<workarea>/<repo>/` is visible to git and to
  `scripts/affected-tests.js`, and a symlink there is not matched by
  `.gitignore`'s `node_modules/`. Measured 2026-09-02: the selector reported it
  as an unexplained changed path and fell back to the whole suite — 250 files
  instead of 41. That is the reading that would quietly undo the selector's
  whole value.
- An `npm ci` per workarea is a copy of the same tree per place. There were 40
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
lockfile that has moved means one `npm ci`, paid by whichever workarea happened
to be next. Measured 2026-09-02: `mc work add deps-check memoro-cli` was 22 s
in total, worktree and install together, and a second workarea on the same
lockfile pays one file read.

The cheaper form — symlinking `~/mc/node_modules/<pkg>` at
`~/memoro-cli/node_modules/<pkg>` — was measured first and not taken. It ties
every workarea's tests to one checkout's install: the packages a session
resolves would be whatever the user's own checkout last installed, and an `npm
ci` there while a session is running pulls them out from under it. This form
owns what it holds.

Two consequences worth knowing before they surprise somebody:

- **The manifest copied is the repository checkout's own**, which is `main`, not
  the new workarea's branch. One directory holds one tree, so reading each
  branch's manifest would have two workareas reinstalling over each other. A
  branch that adds a dependency does not get it from here until it lands; the
  session on that branch installs it itself, and nothing stops it.
- **One directory holds one manifest, so it serves one repository**, and which
  one is written down (`SHARED_TREE_REPOS` in `work-deps.js`) rather than
  decided by whichever workarea was made first. memoro is not on it: it declares
  `prepare: 'npm ci'` in the gate table (measured, D-0089) and its dependencies
  are its own. A repository that is not on the list is left alone and told so —
  `state: 'not-shared'`.

## It is not a piece of work, and nothing had to be taught that

Both listings that matter — `mc status`'s `areasWithCheckout` and the runner's
`workareas()` — name a directory under the work root only when it holds a
checkout of a repository mc knows, and this one holds none. So the page and
the runner already skipped it and no filter was written; what the project owed
was the assertion, and
[`tests/mc/work-deps.test.js`](../../tests/mc/work-deps.test.js) makes it
against a real work root rather than trusting the reasoning. `mc --json` and
`mc repo --json` were run with the tree in place and neither mentions it.

One caller does return it: `listWorkAreas` lists every non-dot directory, so
the tree joins `bin/`, `brief/`, `decisions/` and `inbox/` in a list nothing
renders bare today. A future caller of that function inherits the whole crowd,
not this one directory.

## What the page's data says about it

Every worktree on a WORK row carries `dependencies` — `present`, `missing`, or
`null` for a directory that is not a Node project or declares nothing
([`work-status.js`](../../src/mc/work-status.js), `dependencyState`; read it
with `mc --json`, no row of prose prints it). The answer comes from
[`dependencyTree`](../../src/mc/dependency-tree.js), which looks for each
declared name the way node does — `node_modules/<name>` here, then in every
directory above. A workarea therefore reads `present` with no `node_modules` of
its own, which is the point of the tree living one directory up: the field says
what the tests will find, not what `ls` finds.

The old question — *is there a `node_modules` in this directory* — is not the
question node answers, and asking it that way would report every workarea as
missing while its imports resolved perfectly well.

## The gate's candidate stands in the same tree

The merge gate builds its throwaway worktree under the work root too, at
`<work root>/gate/<repo>/candidate`, so the same one tree is two parents above
it: one copy for the workareas and the rounds together, no `npm ci` per round,
and nothing inside the checkout. That half is written down in
[`mc-merge.md`](mc-merge.md) § *Where the candidate's dependencies come from*.

## How it is tested

[`tests/mc/work-deps.test.js`](../../tests/mc/work-deps.test.js) drives
`ensureWorkDeps` against a temporary work root with the install stubbed: the
lockfile-unchanged path installs nothing, a moved lockfile installs once, the
manifest written is the repository's minus `scripts` and `bin`, a repository
that is not on the list is refused by name, a failed install is reported rather
than thrown, and `mc work add` leaves the tree beside the area rather than in
it. [`tests/mc/dependency-tree.test.js`](../../tests/mc/dependency-tree.test.js)
holds the parent walk, including the half-installed tree an existence check
called present.
