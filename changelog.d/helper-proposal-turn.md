section: Added

- **`mc helper` reads its own digest and proposes what to do about it.**
  The verb had one half: `--collect`, the script that writes
  `~/mc/intake/errors-<date>.md` from what memoro already records. The bare
  verb now runs that and then one headless turn with the `helper` role
  (`canon/roles/helper.md`, Sonnet), standing in `~/mc/intake/` with the
  digest, every PLAN.md frontmatter on origin/main and the project log in
  its prompt. It writes zero or more
  `~/mc/intake/proposals/<date>-<slug>.md` — evidence, a proposed project or
  step, and a one-line "done when" — and nothing else: not `queue.md`, not a
  PLAN.md, not production. What it wrote is measured from the directory, not
  taken from what the turn said. `mc brief --collect` lists the proposals in
  a new **Proposals** section, which is where Martin queues one or drops it.
