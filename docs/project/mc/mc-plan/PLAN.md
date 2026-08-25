---
status: ready
next: "Step 2 — verify how the plan overlay reaches codex through the adapter (`-c instructions=` carries the profile today; `instructionsFor` drops the overlay for codex) and document the result under What the code taught us — done when `mc plan <name> --codex` starts codex with the same role text reachable, or the step writes it into the workarea's AGENTS.md and says so."
budget: 150k
needs: []
---

# mc plan — a planning session that ends in a PLAN.md

## Goal

`mc plan <name>` is how new work enters the system when Martin wants to think
it through with a session rather than let the runner triage it blind. It
opens a fresh, ordinary (foreground, not tmux) session primed with the `plan`
role: read the workarea, the old plan, the inbox, what already exists under
`docs/project/`; talk it through with Martin; write
`docs/project/<programme>/<name>/PLAN.md` with goal, success criteria,
contract, steps with "done when"; open a PR; stop. The runner takes it from
there once merged. The session is meant to be closed or cleared right after —
its result is the file, not the conversation.

## Success criteria

- [ ] `mc plan <name> [--repo memoro|memoro-cli] [--codex|--claude] [--model]`
      exists, listed in `src/mc/help-text.js`.
- [ ] It runs in the foreground with `stdio: 'inherit'` (the existing path in
      `src/mc/work-open.js:102`), never in tmux, and never with `--resume`.
- [ ] `canon/roles/plan.md` carries the role: what to read, the PLAN.md
      shape (frontmatter `status`, `next`, `budget`, `needs`; sections Goal ·
      Success criteria · Contract · Steps · What the code taught us ·
      Documents), the programme rule (extend an existing programme, never
      create a parallel one; check `docs/project/` on main and open "Plan:"
      PRs), the decision rule (`../decisions/<programme>-<n>.md`, one question
      per file, options and a recommendation), and "open a PR titled
      `Plan: <name>`; do not merge".
- [ ] The overlay is plain text the launch adapter appends for whichever tool
      is chosen (claude via `--append-system-prompt`; codex via whatever
      `src/adapters` already does for role text — if codex has no channel,
      the step writes it into the workarea's `AGENTS.md` and says so).
- [ ] A test covers the prompt/overlay assembly (no session started).

## Contract

- No tmux, no daemon, no inbox, no knock. The session is a normal terminal
  program Martin runs and closes.
- The session never merges. The PR is the deliverable.
- Role text lives in the repo (`canon/roles/`), not in `~/.memoro/mc/roles/`
  and not in any model's memory. `~/.memoro/mc/roles/` may keep a pointer for
  compatibility but is not the source.
- Reuse `work-open.js`'s launch path and `resolveLaunch`; do not add a second
  launcher.

## Steps

- [x] **1. Role + verb** (2026-08-25: `canon/roles/plan.md`, `src/mc/commands/plan.js`, `readCanonRole` in roles.js, `prompt` on `openInWorkArea`)
      — `canon/roles/plan.md`, `src/mc/commands/plan.js`,
      help text, foreground launch. Done when `mc plan <name>` opens the
      session described above.
- [ ] **2. Codex channel** — verify how the overlay reaches codex through the
      adapter; document the result under "What the code taught us". Done when
      `mc plan <name> --codex` starts codex with the same role text reachable
      (or the AGENTS.md fallback is in place and tested).
- [ ] **3. Close-out** — `docs/technical/mc-plan.md`, `project_log.md` row.

## What the code taught us

- `openInWorkArea` had overlay and model but no opening words; a `prompt`
  option now rides as the last positional argument for a new conversation
  (both tools take it that way) and never for a resume.
- Roles that belong to verbs live in `canon/roles/` and are read with
  `readCanonRole`; the user's `~/.memoro/mc/roles/` catalogue is untouched.
- `instructionsFor` already drops the overlay for codex — step 2 is that
  question, not a new one.

## Documents

- `~/mc/bin/runner.sh` — `triage_prompt` is the role's first draft
- `docs/project/mc/mc-brief/PLAN.md` — sibling verb, same launcher
- `~/memoro/docs/project/README.md` — the plan-directory convention
