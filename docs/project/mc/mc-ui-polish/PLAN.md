---
status: ready
next: "Step 1 — the page in colour: the palette below applied in page-render.js after clipping, names white, one colour per plan status and per step kind, budget and STOP in warning colours, --json and NO_COLOR untouched — done when `script -q /dev/null mc` shows every rule below and the snapshot test pins them."
budget: 150k
needs: [mc-ui]
---

# mc ui polish — the page reads at a glance

## Goal

`mc` (mc-ui step 4, #441) is the page, and it is fast. It is also flat:
measured 2026-08-29, page-render.js paints 14 things grey, 3 green, 2 bold,
1 yellow — every project name in WORK is grey, a running step and a queued
one look alike, and nothing says "look here". Martin (2026-08-29): "dags
att vi också lyfter UI till den polerade nivån vi hade för gamla mc med
färger etc." This project is that lift, and nothing else: no new data, no
new section, no new flag.

## The rules

Plain 16-colour SGR only (`status-render.js`'s SGR table; add `white` and
`bgred` if needed, nothing 256-colour). Colour only at a TTY and when
`NO_COLOR` is unset or empty, as today. `--json` is byte-identical. Every
escape is added **after** `clip`/`pad` decided the width.

- **Header** — `MEMORO·CLI` bold white, version grey, rule grey; on the
  right the counts each in their meaning's colour: decisions yellow when
  > 0, queue count white, cost grey.
- **Section titles** — bold cyan (`NOW`, `QUEUE`, `DECISIONS`, `INTAKE`,
  `WORK`); the count after it grey; the verb hint on the right grey.
- **Step kinds, one colour each, used everywhere a kind is printed:**
  step green, reconcile magenta, triage blue, brief/plan (foreground)
  cyan.
- **Plan statuses, one colour each, used everywhere a status is printed:**
  ready green, blocked red, waiting-decision yellow, done grey, no plan
  dim grey.
- **NOW** — the live step: green `●`, name bold white, kind in its colour,
  elapsed white; elapsed turns yellow past 75 % of budget and red bold
  past 100 % (`over_budget`). "between steps" grey. A pending STOP: red
  bold `STOP requested`. A stale file: red. Quota line yellow only when
  the last answer is under 6 h old, else grey. Foreground sessions cyan.
- **QUEUE** — number grey, name white (bold for the first), kind in its
  colour; a skipped project's reason dim grey on the same row.
- **DECISIONS** — a yellow `●` per row, the file path grey, the question
  white; "… N more" grey.
- **INTAKE** — new-error count red when > 0, proposals yellow when > 0,
  digest age green under 24 h and yellow after; "no digest yet" grey.
- **WORK** — number grey, name white, status in its colour, `next` plain,
  the last-run cell grey with the kind in its colour, PR number cyan; a
  live tmux/foreground marker green `●` before the name; "no PLAN.md on
  main" rows all grey.
- **`mc --watch`** — redraw only the lines that changed (the old board
  did this; the rule lives in `status-render.js`'s header comment), so
  the page does not flicker; the header carries `watch · 15 s` grey.

## Success criteria

- [ ] `script -q /dev/null mc` shows every rule above; a snapshot test
      with colour forced on pins the escapes per row and proves they sit
      outside the clipped width (a coloured row is as wide as its plain
      twin by `width()`).
- [ ] `mc --json` and `NO_COLOR=1 mc` are unchanged from before this
      project (test compares against the plain render).
- [ ] `mc --watch 1` for 30 s in a terminal: no flicker, only changed
      lines rewritten.

## Contract

- No new section, datum, flag or key. `mc` without a TTY prints exactly
  what it prints today.

## Steps

- [ ] **1. The palette** — one PR.
- [ ] **2. Close-out** — a short `docs/technical/mc-ui.md` addition with
      the palette table, `project_log.md` row.
