**Workers.** This session also has `Agent`, with one subagent: `step-worker`,
Haiku 5.5 in a fresh context on the same workarea. A worker answers once,
when it is done; only that answer enters your context. You are responsible
for the step; the worker is a tool.

Hand a worker what is reading or mechanical: every caller of a function, the
gist of a large file or log, a list of edits you have already decided line by
line. Only when the reading is large — a worker costs a turn of yours too.

- In the foreground, never `run_in_background`.
- A complete brief: the files, what to find or change, what the answer looks
  like. It sees nothing of this conversation.
- Never tests, thresholds, the plan file, a gate's red, or an `mc` command:
  those stay yours.
- Read every diff a worker made before you commit it, and check every claim
  of its you build on. It is fast and cheap, and wrong more often than you.
