section: Fixed

- **A daily help page that fits, and help without side effects.** The first
  screen of `mc --help` is 37 lines at 80 columns, grouped by task, with the
  displaced descriptions retained in IN FULL. Vault subcommand `--help` and
  `-h` now print usage and exit 0 before authentication or a handler runs;
  the other verbs already shared that dispatcher behavior. Regression tests
  walk documented literal subcommand prefixes in both help surfaces.

- **One shared reference for seven commands.** Run, project, step, goal,
  status, model and helper now return their IN FULL text from a static help
  source. Project editing and model mutation forms are visible there too.
  Runner help names PLAN.json and separate collection/intake cadences; its
  documented synopses are checked through the real parser, with negative
  controls, rather than only the help interceptor.
