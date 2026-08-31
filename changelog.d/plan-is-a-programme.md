section: Changed

- **`mc plan` is a session in a directory, told which programme it is for.**
  That is now the whole verb. It used to be `mc plan <name>`, which made
  `~/mc/<name>` on branch `<name>` — exactly the directory and branch `mc run`
  gives the project of that name — so one word was the session, the project and
  the workarea at once, and the planning session sat in the folder the runner
  would later merge into, close and hand back to git. It also read as a
  workarea to everything else: `mc status` and `mc run` listed it under
  *workareas with no project on main* every round.
  A planning session now lives in `~/mc/plan/<programme>/`, with both
  repositories checked out on branch `plan/<programme>` — a programme spans
  them and is not split on repo. The runner cannot reach it, and not by a rule
  about names that could drift: `mc run`'s `workareas()` and `mc status`'s
  `areasWithCheckout()` both list top-level directories under `~/mc` that hold a
  checkout, and `~/mc/plan/` holds none — the programmes are one level below,
  where neither looks.
  **The prompt predicts nothing.** It names the programme, where the session
  stands, and two things to read: `docs/project/README.md` and the programme's
  own directory. How many projects the programme needs, what they are called,
  whether a plan comes out of this session at all, and by what route it reaches
  `main` are not knowable when the session opens — they are Martin's and the
  session's to work out at the terminal. The `plan` role is frontmatter only
  now (`opus`, claude first); there is no overlay behind the prompt.
  With no programme named the command asks which. The list is read from the
  tree (`listProgrammes`) rather than from the plans, so a programme whose
  projects `mc run` has archived is still offered — which is when it matters
  most, because the next piece of that work belongs under the heading that
  already exists rather than under a parallel one somebody invents.
  `--repo` is gone: a programme is not in one repository. The questions a
  planning session raises are read from `~/mc/plan/<programme>/decisions/` by
  `mc brief` and `mc status`, exactly as a workarea's are.
