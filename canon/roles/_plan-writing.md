How a plan is written, and it is one shape wherever it is written. Two roles
write plans — the planning session for a programme it has thought through, the
brief for a proposal Martin has said GO to — and this is the half they share.

A plan is instructions for a headless session that has read nothing else, with
nobody watching. That is the whole test of one: can that session do this step,
and know when it is finished? It is one file, `PLAN.json`, under
`docs/project/<programme>/<project>/` in the repository the work is in. The
programme is a directory that already exists, or one you make; the `<project>`
directory name is what the runner will call that project's branch and its
workarea, and you create neither. Every field and what it must hold is in
`src/mc/plan-schema.js`, and what each is for is in `docs/project/README.md`
§ *What a PLAN.json is* and § *Who writes what*, in the repository you are
writing in. Read them rather than working from this paragraph.

Write each step for the session that will be handed it and nothing else. Its
`instruction` is as long as the work is — three pages of interface, order and
edge cases where the work has them, because the under-specified step is the
expensive one — and its `done_when` is the sentence that session's pull
request is measured against. Name the file that carries every claim you make,
and only if you opened it: a plan is acted on without being checked, so a
plausible-sounding claim from a grep becomes the next session's premise.

What a step session may not touch is the other half of the same thought.
`goal`, `contract`, `out_of_scope` and the criteria are frozen, and it writes
only its own step's `status`, `pr` and `comments`, plus `met` on the criteria
it met — checked by the runner on the way back in. A step that finds the plan
wrong stops and asks rather than repairing it, which costs a round. So
whatever the work will need has to be in the plan before it starts.

A plan that does not validate is refused at the runner's door rather than
run, and a plan nobody can read is a project that logs a skip line every round
until somebody notices. Validate before you push: `readPlanText` prints every
problem at once, and `mc status <project>` prints them for a plan already on
`main`.

A proposal that becomes a project is deleted in the same commit that creates
it, and named in the pull request body — `~/mc/proposals/` is in neither
repository, so that body is the only place the record can live. Whatever the
proposal held that the plan needs — the measurement, the file and the line,
the reason the fix is that one — has to be in the plan first, because
afterwards there is no other copy.

A decision the plan leans on is cited by name and never by path, and a ruling
belongs to its programme: `docs/project/<programme>/rulings.md`, with the
question, Martin's answer quoted, and the plan that carries it.
`docs/project/README.md` § *Citing a decision* is the rule, and a path out of
the repository is a citation no reader with a checkout can follow.
