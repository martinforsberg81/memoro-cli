section: Fixed

- **A `tool: codex` step in `mc run` could not have opened a PR, and would
  have died on its own model name.** The codex lane was wired but never
  started, and both of its faults were in the arguments mc builds. It ran
  `codex exec --full-auto`, which is codex's workspace-write sandbox: no
  network — so no `git push` and no `gh pr create` — and no writes outside
  the working directory, which takes the commit too, because a workarea's
  `.git` is a file pointing into the main checkout's
  `.git/worktrees/<name>`. And a plan that named no model got `opus`, a
  claude alias codex has no model for. Now codex gets `--sandbox
  danger-full-access`, the same trust the claude lane already has with
  `--permission-mode auto` — the workarea is the boundary the runner trusts,
  not a sandbox inside it — and a plan on a tool that is not claude gets the
  model it names or none at all, letting the tool pick its own. A step
  running on a tool's own default says so in `runner.log` rather than
  printing `null`.
