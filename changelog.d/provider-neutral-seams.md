section: Changed

- **Tool-specific seams now ask the adapter.** Launching, billing, routing, status, conversation, cost and skill code in `src/mc/` reads capabilities the claude and codex adapters declare instead of comparing tool names; a tool that declares nothing is refused with an error naming the tool and the capability, or read as unknown.
- **antigravity-cli (`agy`) is a planned tool and gemini-cli is gone.** The registry lists antigravity-cli beside cursor and windsurf as planned; no adapter exists yet.
- **A claude plan review gets `--add-dir`.** The plan-review launch now passes the allowed directory to claude as it already did for codex.
