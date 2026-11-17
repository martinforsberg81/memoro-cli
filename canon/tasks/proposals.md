---
name: proposals
description: What to do with something you found that is not your job in mc (memoro, memoro-cli) — a bug, a gap, a wrong document. Use before writing a file under ~/mc/areas/<repo>/<area>/proposals/ or ~/mc/intake/, or when a finding is outside your task.
---
# Proposals

What you found that is not your job is a proposal: one file per finding,
`<date>-<system>-<slug>.md`, in the area it belongs to:
`~/mc/areas/<repo>/<area>/proposals/`. An area is an area page a repository
declares (`page` in its `.mc/areas.json`; `<area>` is the page's file name
without `.md`), such as `memoro/trust` or `memoro-cli/system`. Areas are
permanent; a programme is an order that ends, so no proposal lives in a
programme (Martin, 2026-11-17). The date, the system and the `.md` are mc's: it
counts what is there by area and system and orders by name.

- The area is the one whose page would change, or whose standards the change
  would follow: its page's opening paragraph says what it covers. Pick one.
  There is no place without an area: when none fits, it goes to
  `memoro-cli/system` when mc would change and `memoro/delivery` when memoro
  would.
- `<system>` is `mc` (memoro-cli, mc itself on this machine) or `memoro` (the
  deployed service): the one whose change would resolve it, the first when
  both would change.
- Inside it: prose, not a form — what you saw, which system and why, what you
  read, and what you would do.
- Say so in one line, with where it went, and carry on with your own work.
  Nothing wakes for it: it waits until an order takes it in at the desk.
- Not `~/mc/intake/`: that is raw material, drained one file per turn by a
  session that judges it; writing there asks a second session to work it out
  again from less than you had.
- Never touch a proposal already waiting unless your task is to consume it.
  The same rule holds for every writer: build, review, plan, intake and the desks (manager, martin).
- A proposal is taken in by an order: the desk names it in the programme
  document it serves, and moves it to the area's `proposals/archive/` with
  first line `Utfall: ordered in <programme>`. One the desk declines goes there
  with `Utfall: ej aktuellt — <why>`, and one that main has already resolved
  with `Utfall: resolved — <where>`. Read the area's `archive/` to judge
  whether a new one repeats something already taken or declined.
- A proposal that reports an incident from an app review or a user's report
  carries the task id, or the timestamp and build, of the original. A proposal
  that carries neither is archived when it is next read, with a one-line
  `Utfall`, and is reopened only by a report that carries them.
