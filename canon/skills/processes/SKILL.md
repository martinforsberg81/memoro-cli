---
name: processes
description: Stopping or signalling processes on Martin's machine, where many mc sessions, gate rounds, dev servers and the runner run at once. Use before kill, pkill, killall, or when something looks stuck or hung.
---
# Processes you did not start

Never signal a process you did not start in this session: not with `kill`,
`pkill` or `killall`, and not by name. A gate round, a test run, a dev server
or a session that looks stuck is someone's; a pid you did not get from your own
command is not yours. On 2026-10-10 a step session killed the merger's test
process, taking it for its own hung test.

- Say what you saw — pid, command, how long — to Martin, or as a proposal, and
  carry on.
- Your own: by the pid your command gave you.
