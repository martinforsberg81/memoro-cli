---
name: processes
description: Stopping or signalling processes on Martin's machine, where many mc sessions, gate rounds, dev servers and the runner run at once. Use before kill, pkill, killall, or when something looks stuck or hung.
---
# Signalling a process

Many sessions, gate rounds, dev servers and the runner share the machine. A
process that looks stuck is usually someone else's at work: on 2026-10-10 a
step session killed the merger's test process, taking it for its own hung
test.

- Your own: by the pid your command gave you.
- Another's: know what it is before you signal it. `ps -o pid,ppid,etime,command
  -p <pid>` and its parent chain say whose it is; `mc dev list`, `mc repo who
  <repo>` and `mc run` say what mc has running. Signal it by pid, never by
  name (`pkill`/`killall` take every match), and say what you stopped and why.
- A dev server stops through `mc test dev --stop`, the runner through
  `mc run stop`.
