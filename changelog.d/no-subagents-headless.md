section: Changed

- **A headless session may not spawn a subagent.** Every claude launch of
  the runner's gets `--disallowedTools Agent`. The step is bounded by its
  plan and reaches the strong model through `--advisor`; a subagent ran on
  whatever model the repository's instruction files named, outside the plan's
  `runner` choice. Over the first 41 sonnet step sessions (2026-09-11..12), 19
  spawned opus subagents on memoro's `CLAUDE.md` instruction — 2 111 of the
  era's 6 556 model requests and about a quarter of its cost, none of it in
  `runs.tsv` — and three of them ended without a PR, waiting for a report
  that never reaches a headless session.
