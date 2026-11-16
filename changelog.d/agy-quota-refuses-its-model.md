section: Fixed

- **An agy quota refusal now refuses the model it refused, not agy.** On
  2026-11-16 nine Argon reviews met `RESOURCE_EXHAUSTED (code 429) … Resets in
  149h56m21s`, and the refusal was written for the whole provider with a reset
  of thirty minutes: every agy model was passed by, and the runner tried Argon
  again and again. The quota is a model's, so it is now written for
  `agy:<model>` until the reset the message names (relative times such as
  `149h56m21s` are read, up to eight days), else for the quota sleep. Review
  passes that model by; another agy model stays eligible. Claude's and codex's
  quota, a login refusal and agy's full measured window still refuse the
  provider. Each adapter declares which in `QUOTA_SCOPE`, and a tool that
  declares none is refused by name. A model-scoped quota from the intake drain,
  the learning pass or desk preparation no longer pauses every lane, and `mc run
  --billing` names the refused model and its reset. `model-capacity.json` gains
  an optional `model_refusals` map; a file without it reads as before.
