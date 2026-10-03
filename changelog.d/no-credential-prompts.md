section: Fixed

- **No child of mc asks for a credential, and git and the keychain cannot
  hang it.** On 2026-09-20 the login keychain locked with nobody at the
  machine: git's credential helper came back empty and git wrote
  `Username for 'https://github.com':` into the page, while every `security`
  and `git credential-osxkeychain` call waited on a modal and each retry
  stacked one more. `mc` now sets `GIT_TERMINAL_PROMPT=0`,
  `GH_PROMPT_DISABLED=1` and `GCM_INTERACTIVE=never` at its entry
  (`src/mc/no-prompts.js`, unless already set), so every child it spawns
  fails with a message instead of asking. `git()` in `src/mc/git.js` stops a
  call after five minutes by default (`timeoutMs` per call; the runner's own
  git has run every fetch and push under 120 s), and the keychain's `run()`
  stops `security`/`secret-tool` after 30 s, which also withdraws its modal.
  Both errors say what did not answer and name `security unlock-keychain`;
  a `setSecret` that timed out is thrown rather than written to the file
  fallback.
