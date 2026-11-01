section: Removed

- **53 test files that could not catch an accident.** Martin, 2026-11-01: a
  test exists to stop important functionality being broken by mistake; with
  that as the measure, a test whose subject nobody has changed and that has
  never gone red protects nothing. Measured over 1 333 merge rounds and the
  last 90 days (918 commits): never red, the modules it imports changed at
  most three times, nothing on the critical path (gate, merger, runner, plan
  schema, worktree removal, push guard, vault, keychain). Removed, with the
  two helpers only they used: `github-contract`, `model-config`,
  `model-capacity`, `codex-capacity`, `billing-route`, `awake-clock`,
  `stay-awake`, `managed-generation-journal`, `managed-provider-archive`,
  `adapters/managed-runtime/*`, `runtime/broker/c1-artifacts`,
  `language-manifest`, `language-runs`, `dependency-tree`, `deploys`,
  `ios-builds`, `plan-branch`, `plan-intake`, `project-prs`, `repo-derived`,
  `checkpoint`, `commands/{flags,model,worker,work-attach-model}`,
  `lib/{api,claude,codex,version}`, `prompt`, `first-run`, `local-auth-mode`,
  `menu-state`, `merge-red`, `no-prompts`, `rm-tree`, `runtime-secrets`,
  `standing`, `github-backoff`, `test-times`, `programme-contract`,
  `unknown-command`, `isolate-home`, `cli/lifecycle/squash-phantom`,
  `architecture/plan-paths`, `adapters`, `adapters/tool-names`,
  `default-tool-consumer`, `scripts/changelog-fold`. `child-async.test.js`
  stays: it is the rule that the merger's path holds no synchronous child.
  The vault and security tests on the same measure stay until Martin says
  otherwise. Three technical documents that cited the removed files as proof
  now say the test is gone.
