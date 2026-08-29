section: Fixed

- **`mc --help` printed a SyntaxError instead of help.** A backtick pair in
  the `mc helper --collect` entry closed and reopened `HELP_TEXT`'s template
  literal, so `src/mc/help-text.js` stopped parsing and every command that
  loads it — help, and every test that spawns the CLI — failed at import.
  Escaped.
