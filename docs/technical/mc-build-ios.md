# mc build ios — memoro's iOS binary, paired with the web it will meet

**Status:** current · 2026-10-18 · `src/mc/commands/build.js`,
`src/mc/ios-build.js`, `src/mc/ios-build-run.js`, `src/mc/ios-builds.js`

`mc build ios` is the verb a person types to find out whether memoro needs a
new iOS binary, and to make one. It is not a build system. memoro's own
scripts do the syncing and the uploading; Xcode's command-line tools do the
building. What the verb adds is the same kind of thing `mc deploy` adds around
`npm run deploy` ([`mc-deploy.md`](mc-deploy.md)): a reading before anything
runs, one question before anything leaves the machine, its own process, and a
record.

## Why the binary is built from the commit production runs

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
`origin/main` (memoro project `ios-build-declaration`). It is read from
`origin/main` rather than the working tree, so a stale or dirty checkout
cannot change what is built. No memoro path, bundle id or team id is written
in mc's code.

## The question alone

`mc build ios` with no flag builds nothing and touches no worktree. It
fetches, reads the declaration, asks production what it runs, and diffs that
commit against the commit of the last shipped binary (`lastShipped`: the last
TestFlight upload or `--shipped` seed in the register). Only the declaration's
`native_paths` count, and only packages under its `native_dependency_prefixes`
in `package-lock.json`. The answer names what differs, or says
`no native change since build <n> — mc deploy is enough`. When `origin/main`
has native changes production does not run yet, it says to deploy first.
`--json` prints the same reading as an object.

## The preflights

`--device` and `--testflight` check, in the asking terminal and in this
order, before anything starts (`devicePreflight`). Each refusal is one line
that names the fix:

1. no other iOS build is running (exit 2, `mc build ios --follow` watches it);
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

## The number

A TestFlight build number comes from App Store Connect, never from a file.
After the preflights, the asking process runs the declaration's `list_builds`
command in memoro's checkout. memoro's script reads its own App Store Connect
credentials; mc reads no key. The command's `builds[].version` values are
parsed as integers, and the build is `max + 1` (`listBuilds`). When the call
fails, the verb exits 1 with
`App Store Connect did not answer (<first stderr line>) — no build number can be chosen`.
It does not fall back to anything.

The number is asked for once more just before the upload. A number that has
appeared in App Store Connect meanwhile fails the build at `number-taken`. The
binary already carries that number in its Info.plist, and is never
renumbered. Building again takes the next one.

## The question

At a terminal, before the builder starts (`interactive`/`ask` from
`src/mc/prompt.js`, as `mc deploy` asks):

    upload memoro me (build <n>) from <short sha> — production runs <short live> — to TestFlight after it is built and verified? [y/N]

Anything but yes writes a `refused` row and exits 1. The yes travels into the
builder's job as `upload: true`; the builder uploads nothing without it.
`--no-upload` skips the question, because nothing leaves the machine. Without
a terminal, `--testflight` alone is refused with exit 2:
`mc build ios --testflight asks before it uploads — run it in a terminal, or add --no-upload`.

## The builder's order

The builder runs in its own process (`ios-build-run.js` → `buildIos`). It is
started detached exactly as `mc deploy`'s deployer is, with its log at
`~/mc/runner/log/ios-build.log`. The terminal follows the log, and ^C stops
only the watching; `mc build ios --follow` watches again. Every external
command goes through one `step` that prints `▸ <label>`, streams the output to
the log, keeps the last 64 KB for the failure note, and stops a command past
its timeout with SIGTERM and then SIGKILL.

(a) The heavy lane, held (below).

(b) mc's own worktree of memoro at `~/.memoro/mc/build/memoro`, put on exactly
the commit: `worktree add --detach`, or `checkout --detach --force` and
`clean -ffdx` when it exists. Then HEAD and a clean status are checked.

(c) A real `npm ci`. Never memoro's shared-cache link, because a native patch
edits a package in `node_modules` in place.

(d) The declaration's `setup` commands, each as memoro wrote it.

(e) The declaration's `sync`, with `env.build_commit` set to the commit. A
device build unsets `env.build_number`, so the declaration's default stands.
A TestFlight build sets it to the number from App Store Connect.

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
the declaration's `upload` command runs in the build worktree with the IPA
appended, for at most 30 minutes. A delivery id the script prints
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

## The read-back

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

## The register

`~/mc/runner/log/ios-builds.tsv` (`ios-builds.js`) is shaped like
`deploys.tsv`. The asking process writes a `running` row before the builder
starts, the builder's pid is put on it, and the builder completes it however
it ends: `installed`, `built`, `uploaded`, or `failed` with `stopped_at` and a
note. A no at the question is a `refused` row. A row has the commit, the kind
(`device`, `testflight`, `seed`), the version, the build number, the commit
production ran, the artifact, the delivery id and the pid. The last
`uploaded` TestFlight row, or `seed` row, is the binary people have, and it
is what the bare question compares against.

## The heavy lane

The builder holds the heavy gate lock as a deploy does (`holdHeavyLane`
from `commands/deploy.js`, with `mode: 'ios-build'`). It first waits for the
rounds in flight, then takes `gate-running.json`, and gives it back however
the build ends. The merger's heavy rounds wait for it, and a `mc gate` started
meanwhile waits in its detached child (`await-deploy.js`), as it does for a
deploy. A build and a deploy exclude each other. Both compile on the same
machine, and both would take three times as long side by side.

## What it never does

- It opens no GUI application. No `npx cap open`, no `open`, no Xcode.app or
  Simulator.app, and no simulator is booted. Only `xcodebuild`,
  `xcrun devicectl`, `plutil`, `codesign`, `unzip` and memoro's own scripts
  run.
- It uploads nothing without a yes at a terminal.
- It attaches nothing to an App Store version and submits nothing for review.
  `asc:attach-build` is printed, never run. What's New, review and release
  are a person's acts in App Store Connect.
- It never chooses a build number from a file, and never renumbers a binary.
- It does not bump the marketing version. That is a commit in memoro
  (`IOS_MARKETING_VERSION`), read back from the built app here.
