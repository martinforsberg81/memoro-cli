section: Added

- **Antigravity CLI (`agy`) in the interactive entrances.** `mc plan` and
  `mc martin` open agy with `--agy`, and the server's `mc session` starts it,
  in the terminal that starts it: no join, no PTY host, no Remote Control, and
  `--bg` is refused with the tool-neutral reason. One agy session at a time per
  conversation, held by the register. agy's conversations are listed, resumed
  and deleted (`mc conversations`), its tail, model and provider counts show on
  the page, the desk cost counts the conversations that carry mc's launch
  marker, `mc hook install` registers agy's hooks in `~/.gemini/config/hooks.json`
  and `mc skills sync` its skills, and `mc tidy` (rules version 14) removes a
  conversation's `.system_generated/` directory once it is a week old and
  closed. The retired `mc helper` desk and `mc work` stay retired.
