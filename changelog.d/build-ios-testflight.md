section: Added

- **`mc build ios --testflight` builds memoro for TestFlight, checks the
  IPA, and uploads it after a yes.** The build number comes from App Store
  Connect (highest + 1), never from a file. The question is asked at the
  terminal before anything is built. The builder archives, reads the
  archived app back, exports with memoro's tracked ExportOptions.plist, and
  reads the IPA itself back: bundle id, commit, build number and an Apple
  Distribution signature. Before uploading it asks App Store Connect again,
  so a number taken meanwhile stops the build rather than renumbering it. It
  records the delivery id and prints the `asc:attach-build` command without
  running it. `--no-upload` stops at the verified IPA and asks nothing. Old
  archives are pruned to the newest five.
