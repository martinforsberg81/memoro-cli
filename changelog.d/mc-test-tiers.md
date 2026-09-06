section: Changed

- **`mc test dev` measures two tiers.** A suite `.mc/test.json` marks
  `server: "static"` never talks to the app — it stubs its own document and
  imports the module graph — and is now run against the file server the
  declaration names as `environments.dev.static_service`, ensured through the
  same manifest protocol as the Worker. Six of memoro's ten are static, so
  `--suite msr-modality` starts no Worker at all, and a server that leaves
  mid-round takes only its own tier's suites: the Worker exiting — which it has
  done three times under a round — is not the file server's news. `--stop`
  stops every service the worktree has; the verdict line says which tier a
  suite ran on, and `--json` carries `static_base_url`, `static_instance_id`
  and `gone_tiers`. A profile's `readiness.timeout_ms` in `.mc/dev.json`,
  read by nothing since mc-cut, is now the window a service gets to register.
