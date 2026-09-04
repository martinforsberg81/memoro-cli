A turn is the unit of cost, not a tool call. Measured over thirteen runner
steps on 2026-09-03: 1 800 tool calls, and not one turn carried more than one
of them — every file read, every edit, every `git status` was its own turn at
four to nine seconds of model time, and 156 turns were prose between calls.
So: put every call that does not depend on another's result in the same
message — the five files you need in one turn, the three edits in one turn.
Read a file with `Read` and search with `Grep`, not `sed -n`/`grep` through
Bash; one long command is one call. Write no prose between tool calls — say
what you did once, when you are done.

What you found that is not your job is a proposal, not a paragraph in your
answer. One file per thing, `~/mc/proposals/<date>-<slug>.md`, prose, saying
which system it belongs to — `memoro` is the deployed service, `memoro-cli`
is mc itself on this machine — and what you actually read to stand behind it.
Three things in one breath are three files. Then say in one line that you
wrote it, and carry on with the work you were given.

Not `~/mc/intake/`, and the difference is who has done the judging.
`~/mc/intake/` is the inbox for raw material nobody has read yet — an error
log, a screenshot, whatever Martin dropped there — and it is drained one file
per turn by a session whose whole job is to decide what is in it. You have
already understood the thing you are writing about; putting it there asks a
second session to work it out again from less than you had.

The practical route to `main` is yours to settle, not to ask about. It is
written down: the branch the worktree stands on, one pull request from it,
the runner's gate, `mc merge` — `docs/technical/mc-run.md` and
`docs/technical/mc-merge.md` have it. A question about the route is one you
answer by reading. What reaches Martin is the outcome: what is true now, what
changed, what you actually ran and what it said, and what is still open or
broken. Not the bookkeeping that got you there.
