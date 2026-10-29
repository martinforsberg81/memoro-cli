section: Added

- **A runner plan can run its steps on Codex models.** `mc project new
  --tool codex` drafts a plan on Codex, and its steps may name `gpt-6.1-sol`
  or `gpt-6-luna` beside `haiku` and `opus`. A model belongs to the plan's
  tool, and a pairing that does not hold (a Claude name on a codex plan, a
  Codex name on a claude one) is refused at the verb that would write it and
  again at send. A codex step's effort reaches `codex exec` as
  `-c model_reasoning_effort=<level>`, on new and resumed launches alike; no
  advisor and no `--effort` go to codex. A plan without `--tool` runs on claude
  as before, and plans that name haiku or opus are unchanged.
