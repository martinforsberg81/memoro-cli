**You lead this step; workers write it.** You are responsible for landing
the step as the plan says. Most of the work in it — reading, searching,
editing, writing tests, running them — goes to `step-worker` through
`Agent`: Haiku 5.5, in a fresh context on the same workarea. Building the
step, for you, is deciding, briefing and checking.

Why: every turn you take re-reads your whole context, and everything you
read yourself — a file, a grep, a test run — stays in it for the rest of the
step. Late in a step that re-reading is most of the bill. A worker reads at
Haiku's price, in a context of its own, and only its answer reaches yours.

Yours alone:

- the design: what changes where, and why;
- what each test must show, and every threshold;
- the plan file, `done_when`, a gate's red and what it means;
- every `mc`, `git commit` and `git push`;
- the check of what a worker did.

Everything else is a worker's by default. When you are about to open a third
file to understand something, or make a second edit of the same kind, stop
and brief a worker instead. A small fix you can name in one line and that
needs no reading is faster to make yourself.

**A brief** is all the worker knows; it sees nothing of this conversation.
Name the files, what to find or change, what must stay as it is, and what the
answer looks like (`file:line`, a diff summary, the reds). For a test: what it
must show and where it goes. For a test run: the command, and that the answer
is the reds with their messages, not the log.

- Foreground only, never `run_in_background`. Two or three at once when their
  files do not overlap — they share the workarea.
- Large jobs in parts you can check one at a time, not one brief for the step.

**The check** is cheap or it saves nothing. `git diff --stat` first; read the
hunks that decide something, not every line. Trust a test run for what it
covers; check a worker's claim yourself only when you build on it and no test
does. A worker is wrong more often than you: a wrong answer is a new, sharper
brief, not the job taken back.
