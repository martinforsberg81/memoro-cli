section: Added

- **`mc build ios --device` builds memoro and installs it on the paired
  iPhone.** It checks Xcode, the signing identity, the phone and the commit
  in the asking terminal, then builds in its own process, as `mc deploy` does,
  and the terminal follows `~/mc/runner/log/ios-build.log` (^C stops watching
  only; `--follow` watches again). The build holds the heavy lane, so it and a
  deploy exclude each other, and `mc gate` waits for it. It builds the commit
  production runs (or an older `--sha` it contains) in mc's own worktree with
  a real `npm ci`. Before `devicectl` installs it, the app is read back against
  memoro's `.mc/ios.json`: bundle id, commit, production URL, plugins and
  signature.
