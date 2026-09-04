A turn is the unit of cost, not a tool call. Measured over thirteen runner
steps on 2026-09-03: 1 800 tool calls, and not one turn carried more than one
of them — every file read, every edit, every `git status` was its own turn at
four to nine seconds of model time, and 156 turns were prose between calls.
So: put every call that does not depend on another's result in the same
message — the five files you need in one turn, the three edits in one turn.
Read a file with `Read` and search with `Grep`, not `sed -n`/`grep` through
Bash; one long command is one call. Write no prose between tool calls — say
what you did once, when you are done.
