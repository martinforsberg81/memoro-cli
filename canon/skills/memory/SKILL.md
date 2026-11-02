---
name: memory
description: What may go in an agent's own memory store (~/.claude/projects/*/memory/) in mc work, and where a rule about how to work goes instead. Use before writing, correcting or reading a memory.
---
# Memory

A memory holds only a fact about a project that its repository does not
record: a decision and its reason, a costly trap, where a programme's plan
lives.

- **A rule about how to work is never a memory.** A memory is read by one
  agent; mc's skills and roles (`canon/` in memoro-cli) by all of them. Write
  the rule there, in a pull request, or a proposal for it. A memory may point
  there. (Martin, 2026-08-29, after a merge-gate rule had been saved as a
  memory and nowhere else.)
- No facts about Martin, and nothing the repository already records.
- One store per repository. Claude's is
  `~/.claude/projects/<cwd-with-slashes-as-dashes>/memory/`, keyed on the
  working directory, so a session started in a workarea writes a store nobody
  reads. Check that it is the repository's own before writing.
- `MEMORY.md` is an index under 17 KB: one line per memory.
- Delete a wrong memory rather than adding a correction beside it.
