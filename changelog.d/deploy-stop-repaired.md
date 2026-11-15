section: Added

- **A deploy stopped by a technical fault is repaired and shipped without Martin.** A typed `mc deploy` that stops on a fault of
  mc's own machinery (a `failed` row, or a refusal because the worktree or the suites could not run) queues one deploy-mend
  request in `runner/deploy-mend.json`; the runner gives it a mend session, and once the repair has landed retries the
  deploy once through the same pick, gate and admission, under the holder `runner for <holder>, <started>`, never with
  `--accept-red`. A red gate, a decision or main's red queues nothing. `mc repo mend deploy <id> requeue|drop|repaired`
  and one line in `mc deploy`'s reading say where it stands (Martin, 2026-11-15: "Ja. Omstart ok.").
