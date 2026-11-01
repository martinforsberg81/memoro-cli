section: Changed

- **Eleven memoro ratchets and snapshots leave the pull-request gate.** They were
  red when a change moved a pinned number, and most such pull requests landed
  later anyway. A repository declares them as `main_only`: they run in the whole
  suite on main, in a pull request that edits the test, and when nothing else
  was selected.
