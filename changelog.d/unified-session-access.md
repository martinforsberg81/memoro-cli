# Use one execution boundary for every mc coding tool

Normal mc plan/work commands now request host execution from every adapter.
Codex translates it into its full-access execution mode; Claude retains host
execution. Unknown adapter support fails explicitly. The MC_CODEX_WORKSPACE
workaround is removed. Approval policies and running sessions are unchanged.
