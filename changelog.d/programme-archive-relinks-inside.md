section: Fixed

- **`mc plan <programme> --archive` no longer relinks a directory above the
  programme's.** A relative link to a directory counted as removed when it held
  a removed file and no file under the programme's directory was left, so
  README's `[docs/](docs/)` became a permalink in memoro's archives of
  legal-readiness, surface-window-styling and language-voice. Only the
  programme's directory and what is under it can be removed now
  (`removedKind`).
