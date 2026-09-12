section: Removed

- **`/memoro-update`, `/memoro-coordinator` and `/memoro-coordinator-suggest`
  are gone.** mc rewrote `/memoro-update` on every launch and on
  `mc hook install`, so deleting the file never held; the two coordinator
  commands opened a role that `mc` itself is now. A launch now sweeps every
  managed command file earlier versions wrote (`uninstallCommands`, on the
  managed marker only), so they disappear the next time `mc` starts.
