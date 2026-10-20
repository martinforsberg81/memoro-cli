section: Added

- **`mc hook pre-tool` refuses a hand-edit of a programme's plan files.**
  A plan, draft, state or closeout file under `~/mc/programs/` changes only
  through its verb (`mc project`, `mc step`, `mc project criterion met`). A
  `Write`, `Edit` or `MultiEdit` of one is refused, and so is a Bash command that
  writes one with a redirect, `tee`, `sed -i`, `mv`, `cp`, `rm`, `truncate` or
  `install`; that Bash refusal carries the usual `MC_HOOK_ALLOW=1` escape. The
  matcher in `~/.claude/settings.json` becomes `Bash|Write|Read|Edit|MultiEdit`,
  so `mc hook install --check` reports drift until `mc hook install` runs again.
  Codex sessions get no mc hook and are not covered.
