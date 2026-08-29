section: Changed

- **Bare `mc` is the page, and it is the only surface that lists.** It printed
  the V1 sessions table — one row, a session nobody had opened since June — in
  front of a system running fifty workareas. It now prints what `mc status`
  built earlier in this project: NOW, QUEUE, DECISIONS, INTAKE and WORK,
  offline and under a tenth of a second, and at a terminal it ends in the menu
  `mc work` used to carry. A number opens the workarea WORK gave that number,
  `n` starts one, `b` runs `mc brief`, `p <name>` `mc plan`, `s <name>` `mc
  status <name>`, `w` switches to `mc --watch`, `q` quits, and any other line
  is read as an `mc work` command exactly as it always was. Without a
  terminal, or with `--json`, it prints and exits 0; bare `mc work` routes to
  the same page. `mc --watch [seconds]` is the same page redrawn every 15
  seconds until ctrl-c, with no prompt and the cursor put back on the way out.
  The first-run hint moved here with the front door.
