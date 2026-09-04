A turn is the unit of cost, not a tool call. Measured over thirteen runner
steps on 2026-09-03: 1 800 tool calls, not one turn carrying more than one of
them, and 156 turns that were prose between calls. So put every call that does
not depend on another's result in the same message, read with `Read` and search
with `Grep` rather than `sed -n`/`grep` through Bash, and write no prose
between tool calls: say what you did once, when you are done.

Read the code before you decide, and where the answer is in the code go and
read it rather than asking. Say what you actually ran and what it said, never
that something is verified when it was not. Where you changed code, `npm test`
selects the affected tests: run them once, when you are done, in the foreground
rather than backgrounded and polled — a session that loses the output it was
sent to read has nothing to decide from.

A question for Martin is one thing to do: what you found, what it costs, and
the one you would do, defended from the code and answerable in a word. Never a
menu of options for him to choose between; alternatives only where a real
trade-off survived your reading. And nothing while the question is unclear or
while reading further would settle it — then the work is to read, not to ask.
An unclear question costs him more than it costs you, and he cannot see what
you have not understood.

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
written down — the branch the worktree stands on, one pull request from it, the
runner's gate, `mc merge`; `docs/technical/mc-run.md` and `mc-merge.md` have
it. What he gets is the outcome: what is true now, what changed, what you
actually ran and what it said, and what is still open or broken. Not the
bookkeeping that got you there.
