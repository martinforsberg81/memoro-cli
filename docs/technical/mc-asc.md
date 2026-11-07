# mc asc — memoro's App Store Connect side, and the iOS binary

**Status:** current · 2026-11-02 · `src/mc/commands/asc.js`,
`src/mc/ios-build.js`, `src/mc/ios-build-run.js`, `src/mc/ios-builds.js`

`mc asc` gathers everything about memoro's App Store presence under one verb.
Before it there was `mc build ios` for the binary and nothing else. Releasing
1.1.1 on 2026-11-02 needed the state of a version and a release, which no verb
had, so a session wrote throwaway scripts. `mc build ios` is gone and has no
alias. Its behaviour is `mc asc build`, unchanged, against the same register
`~/mc/runner/log/ios-builds.tsv`.

## The script subverbs

`status`, `metadata`, `screenshots`, `review-notes`, `iap`, `submit` and
`release` each run one script that memoro's `.mc/ios.json` on `origin/main`
declares, under the key of the same name (`review_notes` for
`review-notes`). The script runs as `origin/main` has it. `atRev` copies
`scripts/` and the declaration's `script_paths` (`marketing/`) at that commit
into a directory of their own, links the checkout's `node_modules` in, and
runs the copy with the working directory in the checkout. So the copy that is
sent to App Store Connect is main's, whatever branch Martin's checkout stands
on.

The selected entrypoint now runs through this installation's
`src/mc-cli.js keys run <absolute-script> …` adapter. `atRev` still selects
`origin/main` scripts and `script_paths`; keys receives the original control
environment (including an explicit `MC_KEYS_FILE`) and delivers shared dotenv
entries only to the trusted Node child. The controller never reads dotenv or
adds `MEMORO_DEV_VARS`. Unsupported declared command shapes are refused with a
value-free error. Capture, streaming, cwd, timeout, exit status and temporary
tree cleanup remain at their previous boundaries.

The trusted Memoro script reads `ASC_PRIVATE_KEY_PATH` and signs or passes it
to the provider-specific tool; the generic keys parser treats that value only
as text and never opens the referenced file. For IPA upload, altool still gets
the existing key id and issuer argv, and the trusted child retains altool's
private-key-path/symlink handling. Delivery of credentials is not approval to
submit, release or upload: submit/release keep their terminal confirmation and
state checks, and TestFlight upload keeps its consent, verification and
build-number recheck. Credential scripts alone use keys; setup, sync and Xcode
remain outside it. The verified builder wraps only its declared upload script.

- `mc asc status [<version>] [--json]` reads only: per iOS version its
  `appStoreState`, `releaseType`, attached build and processing state, phased
  release, the latest review submission, and the storefront version in us, se
  and dk (iTunes lookup).
- `mc asc metadata | screenshots | review-notes | iap [--dry-run]` run the
  sync scripts. Any further words (`--version=1.1.2`, `--locale=sv`) go to the
  script, which refuses what it does not take. `--dry-run` sends nothing.
- `mc asc submit <version> <build>` and `mc asc release <version> [--phased]`
  are a person's acts, asked the way `mc deploy` asks. Without a terminal they
  refuse with exit 2 before anything runs. Otherwise mc first runs the script
  with `--dry-run --json`. The script refuses a version in the wrong state
  (`submit` wants `PREPARE_FOR_SUBMISSION` with that VALID build and the
  review notes equal to `marketing/review/notes.md`; `release` wants
  `PENDING_DEVELOPER_RELEASE`). After that comes one `[y/N]` question, and
  only a yes runs the script for real. `--dry-run` alone is the reading: it
  asks nothing and sends nothing.

## The binary: mc asc build

`mc asc build` is the subverb a person types to find out whether memoro needs
a new iOS binary, and to make one. It is not a build system. memoro's own
scripts do the syncing and the uploading; Xcode's command-line tools do the
building. What the subverb adds is the same kind of thing `mc deploy` adds
around `npm run deploy` ([`mc-deploy.md`](mc-deploy.md)): a reading before
anything runs, one question before anything leaves the machine, its own
process, and a record.

### Why the binary is built from the commit production runs

memoro's iOS app is Capacitor with `server.url` pointing at production. The
binary does not carry the web app. It loads whatever production serves when it
starts. So most changes to memoro need no new binary at all: `mc deploy` puts
them on every phone the next time the app opens.

What a binary does carry is the native layer: the app-local Swift plugins, the
Capacitor config, the sync script's Info.plist edits and the native packages
built from `node_modules`. That layer has to agree with the web it meets. A
plugin the web calls has to be in the binary, with the interface the web
expects. So a binary is built from **the commit production runs**, read from
`<server_url>/api/version` (`commit_full`). `--sha` can name an older commit,
but only one production already contains. A commit production does not run
yet is refused before anything is built:

    production runs <live>, which does not contain <sha> — mc deploy first

Every binary carries its commit in its Info.plist, under the key the
declaration names (`info_plist_commit_key`, `MemoroBuildCommit`). memoro's
sync script writes it there from the environment variable `env.build_commit`.

memoro is read only through its declaration, `.mc/ios.json` on memoro's
`origin/main` (introduced by `ios-build-declaration`). It is read from
`origin/main` rather than the working tree, so a stale or dirty checkout
cannot change what is built. No memoro path, bundle id or team id is written
in mc's code.

### The question alone

`mc asc build` with no flag builds nothing and touches no worktree. It
fetches, reads the declaration, asks production what it runs, and diffs that
commit against the commit of the last shipped binary (`lastShipped`: the last
TestFlight upload or `--shipped` seed in the register). Only the declaration's
`native_paths` count, and only packages under its `native_dependency_prefixes`
in `package-lock.json`. The answer names what differs, or says
`no native change since build <n> — mc deploy is enough`. When `origin/main`
has native changes production does not run yet, it says to deploy first.
`--json` prints the same reading as an object.

### The preflights

`--device` and `--testflight` check, in the asking terminal and in this
order, before anything starts (`devicePreflight`). Each refusal is one line
that names the fix:

1. no other iOS build is running (exit 2, `mc asc build --follow` watches it);
2. `xcrun xcodebuild -version` answers;
3. the signing identity is in the login keychain: `Apple Development` for a
   device, `Apple Distribution` for TestFlight;
4. a device build only: exactly one paired iPhone, or the one `--device-id`
   names (`xcrun devicectl list devices`);
5. memoro's checkout, fetched, with a readable declaration on `origin/main`;
6. production answers `/api/version`, and the commit to build is one it
   contains and one that is on `origin/main`.

A missing Xcode sign-in or a locked keychain is not mended here. The verb
names what a person does, and stops.

### The number

A TestFlight build number comes from App Store Connect, never from a file.
After the preflights, the asking process runs the declaration's `list_builds`
command as `origin/main` has it, whatever memoro's checkout stands on
(`atRev`): the script's top directory (`scripts/`) is written out from
`origin/main` with `git archive` into a temporary directory, `node_modules`
there links to the checkout's, and the script runs from that copy with the
checkout's `scripts/` as its working directory. So `origin/main`'s script
gets `origin/main`'s helpers and the checkout's installed packages. Piping
only the script on stdin, as mc did before, ran it against the checkout's
helpers: on 2026-10-26 the checkout was 57 commits behind and lacked
`scripts/lib/dev-vars-path.mjs`, and the script stopped at its import.

The declared `list_builds` script is invoked through `mc keys run`; it receives the control environment and reads credentials in the trusted child.
The command's `builds[].version` values are parsed as integers, and the build
is `max + 1` (`listBuilds`). When the call fails, the verb exits 1 with
`App Store Connect's build numbers could not be read (<reason>) — no build number can be chosen`,
where the reason is the first output line that names an error (`reasonLine`).
Node prints where it threw before what it threw, so the first line alone can be
`node:internal/modules/esm/resolve:274`. The sentence does not say App Store
Connect failed to answer, because the script can fail before it asks. It does
not fall back to anything.

The number is asked for once more just before the upload. A number that has
appeared in App Store Connect meanwhile fails the build at `number-taken`. The
binary already carries that number in its Info.plist, and is never
renumbered. Building again takes the next one.

### The question

At a terminal, before the builder starts (`interactive`/`ask` from
`src/mc/prompt.js`, as `mc deploy` asks):

    upload memoro me (build <n>) from <short sha> — production runs <short live> — to TestFlight after it is built and verified? [y/N]

Anything but yes writes a `refused` row and exits 1. The yes travels into the
builder's job as `upload: true`; the builder uploads nothing without it.
`--yes` is that yes given on the command line, so a headless session can
upload: it asks nothing and needs no terminal, and the verification before the
upload is the same. `--no-upload` skips the question, because nothing leaves
the machine. The two together are a bad argument. Without a terminal,
`--testflight` alone is refused with exit 2:
`mc asc build --testflight asks before it uploads — run it in a terminal, or add --yes or --no-upload`.

### The builder's order

The builder runs in its own process (`ios-build-run.js` → `buildIos`). It is
started detached exactly as `mc deploy`'s deployer is, with its log at
`~/mc/runner/log/ios-build.log`. The terminal follows the log, and ^C stops
only the watching; `mc asc build --follow` watches again. Every external
command goes through one `step` that prints `▸ <label>`, streams the output to
the log, keeps the last 64 KB for the failure note, and stops a command past
its timeout with SIGTERM and then SIGKILL.

(a) memoro's lane, held (below).

(b) mc's own worktree of memoro at `~/.memoro/mc/build/memoro`, put on exactly
the commit: `worktree add --detach`, or `checkout --detach --force` and
`clean -ffdx` when it exists. Then HEAD and a clean status are checked.

(c) A real `npm ci`. Never memoro's shared-cache link, because a native patch
edits a package in `node_modules` in place.

(d) The declaration's `setup` commands, each as memoro wrote it.

(e) The declaration's `sync`, with `env.build_commit` set to the commit. A
device build unsets `env.build_number`, so the declaration's default stands.
A TestFlight build sets it to the number from App Store Connect.

(e′) The binary artifacts, prefetched (`swiftpm.js`). Every remote
`.binaryTarget(url:, checksum:)` in the generated `CapApp-SPM/Package.swift`,
the local packages it names and the checkouts in the cloned-packages
directory (where `capacitor-swift-pm` declares Capacitor's xcframework zips)
is fetched with `curl` into `<package cache>/artifacts/<url as SwiftPM
escapes it>` — `https___github_com_ionic_team_…_Capacitor_xcframework_zip` —
and its sha256 compared with the declared checksum before it is renamed into
place. A file already there that verifies is reused. A mismatch deletes the
download and stops the build at `prefetch` with the URL named. A device or
TestFlight build uses SwiftPM's own cache, `~/Library/Caches/org.swift.swiftpm`,
which its `xcodebuild` already reads; nothing else in its command changes.
SwiftPM's own download of these zips hung at "Resolve Package Graph" for over
20 minutes on 2026-10-25 while curl fetched them in seconds.

For a device build: `xcodebuild … -configuration Release -destination
generic/platform=iOS -derivedDataPath ~/.memoro/mc/build/ios-derived
-clonedSourcePackagesDirPath ~/.memoro/mc/build/ios-spm
-allowProvisioningUpdates build`, the read-back, then
`xcrun devicectl device install app`.

For TestFlight:

(f) `xcodebuild … archive` with the same two directories and
`-archivePath ~/.memoro/mc/build/archives/<n>/App.xcarchive`. Any directory
an earlier try at `<n>` left behind is removed first.

(g) The read-back on `<archive>/Products/Applications/App.app`, number
included.

(h) `xcodebuild -exportArchive` with the declaration's `export_options`
plist from the build worktree, into `archives/<n>/export`. memoro's tracked
plist keeps `manageAppVersionAndBuildNumber` off. The local file the old
manual procedure used let Xcode rewrite `CFBundleVersion` at export.

(i) The one `.ipa` in the export directory, with `Payload/App.app` unzipped
into a temporary directory and read back again. This catches an export that
changed the number. Then `codesign -dvv` of that app must have an
`Authority=Apple Distribution:` line. Any failure stops at
`export-read-back`, and nothing is uploaded.

(j) With `--no-upload`: the row is completed `built`, with the IPA as its
artifact, and the verb prints
`mc: built <ipa> — memoro me <version> (<n>) from <short sha>; not uploaded`.

(k) With the yes: the number is asked for again (`number-taken`, above). Then
the declaration's Node `upload` script runs in the verified build worktree
through `mc keys run`, with the IPA appended, for at most 30 minutes. Setup,
sync and Xcode do not receive delivered credentials. A delivery id the script prints
(`Delivery UUID: <uuid>` or similar) is kept on the row. The row is completed
`uploaded`, and the verb prints the command a person runs once App Store
Connect has processed the build:

    next, by hand when it has processed: npm run asc:attach-build -- <version> <n> --wait (in memoro)

After a successful build or upload, the five newest directories under
`archives/` are kept and the rest removed (`pruneArchives`). The one just
made is always kept.

The derived-data and SPM directories are fixed paths that stay between
builds. xcodebuild keys its package checkouts and module caches by path, so a
new path every time would be a cold build every time. They live under mc's
home, not `~/mc/`, for the reason the deploy worktree does.

### The read-back

`readBack` compares the built app with the declaration before anything
installs or uploads it. Each difference is one problem that names the field
and both values:

- Info.plist `CFBundleIdentifier` is the declared `bundle_id`;
- Info.plist `<info_plist_commit_key>` is the commit that was built;
- Info.plist `CFBundleVersion` is the number, when one was set (TestFlight);
- `capacitor.config.json` `server.url` is the declared `server_url`, so a
  build that would load a dev server never ships;
- `packageClassList` has every declared `app_local_plugins` entry;
- `codesign --verify --deep --strict` passes.

A TestFlight build is read back twice, from the archive and from the IPA
itself. The second time also checks the Distribution authority.

### The register

`~/mc/runner/log/ios-builds.tsv` (`ios-builds.js`) is shaped like
`deploys.tsv`. The asking process writes a `running` row before the builder
starts, the builder's pid is put on it, and the builder completes it however
it ends: `installed`, `built`, `uploaded`, or `failed` with `stopped_at` and a
note. A no at the question is a `refused` row. A row has the commit, the kind
(`device`, `testflight`, `seed`), the version, the build number, the commit
production ran, the artifact, the delivery id and the pid. The last
`uploaded` TestFlight row, or `seed` row, is the binary people have, and it
is what the bare question compares against.

### Memoro's lane

The builder holds the heavy gate lock as a deploy does (`holdBuildLane`
from `commands/deploy.js`, with `mode: 'ios-build'`). It first waits for the
rounds in flight, then takes `gate-running.json`, and gives it back however
the build ends. The merger's heavy rounds wait for it, and a `mc gate` started
meanwhile waits in its detached child (`await-deploy.js`), as it does for a
deploy. A build and a deploy exclude each other. Both compile on the same
machine, and both would take three times as long side by side.

### Simulator: mc asc build --sim

`mc asc build --sim [--release-check]` builds the worktree the caller stands
in — a branch's own native code — for the simulator. It is not a build of
production's commit: nothing is read back, signed for a device, installed or
uploaded, and no simulator is booted. It exists because every session that
changed native code hand-rolled this build, and one sat for 27 minutes at
"Checking out ion-ios-camera" with an empty packages directory.

The asking process checks that the cwd is in a git worktree with
`.mc/ios.json` in its working tree (the branch's own declaration, with the
keys above), that Xcode answers, and reads HEAD. It writes a `sim` row (its
derived data in `artifact` while it runs, the worktree in `note`) and starts
the same detached builder (`ios-build-run.js` → `buildSim`,
`ios-sim-build.js`), with its log beside the derived data
(`<derived>.log`). `mc asc build --follow` watches it as it does a device
build. A second `--sim` in the same derived data is refused while one runs
(exit 2); one elsewhere starts and waits in the build lane.

Where it builds:

- **Derived data**: `$MC_SCRATCH/DerivedData` in a runner session (tidy rule
  S reclaims it once the session has ended), else one shared
  `<mcHome>/build/ios-sim-derived`. Fixed, so a second build there is
  incremental.
- **Cloned packages**: `<derived>/SourcePackages`, made once from the shared
  `<mcHome>/build/ios-spm` (the device build's) with `cp -c -R`, an APFS
  clone. The paths the seed's `workspace-state.json` names are rewritten to
  the copy's. No seed: SwiftPM clones from the network, and the build says so.
- **Package cache**: `<derived>/PackageCache` (`-packageCachePath`), never
  the shared `~/Library/Caches/org.swift.swiftpm`; the artifacts are
  prefetched into it as (e′) above.

The builder's order: (a) the build lane (below), with
`mc: waiting for the build lane (<holder>, <age>)` once while another holds
it; (b) `npm ci`, only when `node_modules/.mc-sim-install` does not hold this
`package-lock.json`'s hash — a reinstall makes every package's sources new
and the build cold — and a `node_modules` that is a link to a shared install
is unlinked first, since the sync patches packages in place; (c) the
declaration's `setup`, only when the project does not exist yet
(`npx cap add ios` refuses an existing one); (d) the `sync`, told the commit
and no build number; (e) the seed and the prefetch; (f) `xcodebuild -project
… -scheme … -configuration Debug -sdk iphonesimulator -destination
'generic/platform=iOS Simulator' -derivedDataPath <derived>
-clonedSourcePackagesDirPath <derived>/SourcePackages -packageCachePath
<derived>/PackageCache build`, with `-disableAutomaticPackageResolution
-skipPackageUpdates` when the project's
`project.xcworkspace/xcshareddata/swiftpm/Package.resolved` pins exactly the
packages and revisions the build's own `<derived>/SourcePackages/workspace-state.json`
holds: the copy xcodebuild reads, made from the seed once and then kept, so a
seed refreshed since does not reach it. A missing or different
`Package.resolved`, or a kept copy that differs from it, resolves as usual. (g) With `--release-check`,
the same for `-configuration Release` with `CODE_SIGNING_ALLOWED=NO` into
the same derived data. Each `xcodebuild` prints how long it took, and the
row is completed `built` with `Debug-iphonesimulator/App.app` as its
artifact.

**The stall stop.** Each simulator `xcodebuild` runs in its own process
group. When its output has been silent for 5 minutes (`STALL_MS`), the whole
group gets SIGTERM, then SIGKILL, and the build fails with the stage it
stood at and its last line: `xcodebuild Debug stalled at Resolve Package
Graph: Fetching from https://… — silent for 5 min, stopped`. The stage is
the last heading `xcodebuild` printed (`Resolve Package Graph`, `Prepare
packages`, …) or build task (`CompileSwift`, `PhaseScriptExecution`, …).
The wall-clock limit of 60 minutes stays behind it. The builder's own stop
(SIGTERM, SIGINT or SIGHUP) reaches the same group the same way: the signal to
the group, then SIGKILL after the grace.

**The hook.** `mc hook pre-tool` refuses a raw `xcodebuild … build` or
`archive` whose `-sdk` or `-destination` names the simulator and points at
`mc asc build --sim`. `xcodebuild -version`, `-list` and
`-showBuildSettings` pass.

### What it never does

- It opens no GUI application. No `npx cap open`, no `open`, no Xcode.app or
  Simulator.app, and no simulator is booted — `--sim` builds for one and
  boots none. Only `xcodebuild`,
  `xcrun devicectl`, `plutil`, `codesign`, `unzip` and memoro's own scripts
  run.
- It uploads nothing without a yes at a terminal.
- It attaches nothing to an App Store version and submits nothing for review.
  `asc:attach-build` is printed, never run. What's New, review and release
  are a person's acts in App Store Connect.
- It never chooses a build number from a file, and never renumbers a binary.
- It does not bump the marketing version. That is a commit in memoro
  (`IOS_MARKETING_VERSION`), read back from the built app here.
