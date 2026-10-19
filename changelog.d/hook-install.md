section: Added

- **`mc hook install [--check]`: mc writes and checks its own hook registration.**
  mc's two entries in `~/.claude/settings.json` were pasted there by hand from
  `mc hook`'s usage text, and nothing saw them drift. `mc hook pre-tool` now
  answers the Read tool too, so memoro's `block-sqlite-state.sh` runs through it
  (matcher `Bash|Write|Read`), but a settings file still at `Bash|Write` never
  sent Read and nothing said so. `mc hook install` writes the two entries,
  changing no other entry, writes nothing on a second run and refuses a file that
  is not JSON. `mc hook install --check` exits 1 on drift. The page's MC line now
  names drift: `hooks: pre-tool on Bash|Write, want Bash|Write|Read · mc hook install`.
