# mc-keys rulings

## Shared dotenv and trusted scripts

2026-11-04. Martin approved using the existing shared dotenv source for script
credentials, with scripts trusted to receive the entries they need and no
per-script declarations. He said: “Precis. Detta är rätt nivå i det här
skedet.”

Consequences: `mc keys run` is a generic Node runner that supplies all eligible
entries from `~/mc/self/memoro/.dev.vars`; it does not require manifests,
allowlists, source-closure verification or `origin/main` checks. Credentials
remain out of the parent/session environment and value-free records, and
output filtering remains accidental-output protection rather than a sandbox.
The scripts and dependencies are trusted with the delivered entries. This
ruling keeps mc keys separate from Memoro vault custody and does not alter
production/admin restrictions or unrelated C1 protections.
