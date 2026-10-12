**Workers.** This session also has `Agent`, with one subagent: `step-worker`,
Haiku 5.5 in a fresh context on the same workarea. A worker answers once,
when it is done; only that answer enters your context. You are responsible
for the step; the worker is a tool.

What a step costs is your turns: every one re-reads your whole context, and
late in a step that is most of the bill. A worker's turns are Haiku's, on a
context of its own. So hand it any job of several tool calls whose steps you
do not need to see, only its result:

- a survey: every caller, importer or user of a name, a class, a key or a
  file, and what each does with it;
- the same change at many sites, once you have made the first yourself and
  can say exactly what the rest look like;
- after a move or a deletion: what still refers to the old name, the old
  class, the old file;
- registers, allowlists and generated documents brought in line with a
  change you describe;
- the gist of a long file, log or diff, and where in it the answer is.

Keep the deciding: the design, the first instance of a change, anything the
contract or the instruction leaves to judgement.

- In the foreground, never `run_in_background`. Two or three at once when
  the jobs are independent.
- A complete brief: the files, what to find or change, what the answer looks
  like. It sees nothing of this conversation.
- Never tests, thresholds, the plan file, a gate's red, or an `mc` command:
  those stay yours.
- Read every diff a worker made before you commit it, and check every claim
  of its you build on. It is fast and cheap, and wrong more often than you.
