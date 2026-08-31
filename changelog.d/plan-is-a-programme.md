section: Changed

- **A planning session is a programme's, and no longer borrows the runner's
  workarea.** `mc plan <name>` made `~/mc/<name>` on branch `<name>` — exactly
  the directory and branch `mc run` gives the project of that name — so one
  word was the session, the project and the workarea at once, and the planning
  session sat in the folder the runner would later merge into, close and hand
  back to git. It also read as a workarea to everything else: `mc status` and
  `mc run` listed it under *workareas with no project on main* every round.
  `mc plan [<programme>]` is now a session for one **programme**. It lives in
  `~/mc/plan/<programme>/` with both repositories checked out on branch
  `plan/<programme>`, because a programme spans them and is not split on repo.
  The runner cannot reach it, and not by a rule about names that could drift:
  `mc run`'s `workareas()` and `mc status`'s `areasWithCheckout()` both list
  top-level directories under `~/mc` that hold a checkout, and `~/mc/plan/`
  holds none — the programmes are one level below, where neither looks. What
  the two share is a `PLAN.json` on `main` and nothing else.
  With no programme named the command asks rather than requiring the name to be
  remembered: every programme on `main` in either repository, the ones already
  being planned, or a new one to name. The list is read from the tree
  (`listProgrammes`) rather than from the plans, so a programme whose projects
  `mc run` has archived is still offered — which is when it matters most,
  because the next piece of that work belongs under the heading that already
  exists rather than under a parallel one somebody invents.
  `--repo` is gone: a programme is not in one repository. The questions a
  planning session raises are read from `~/mc/plan/<programme>/decisions/` by
  `mc brief` and `mc status`, exactly as a workarea's are.
