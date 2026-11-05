# Vault row-revision rollout prerequisite

This is an ordering record, not deployment authorization or production evidence.

Related work: [CLI #1309](https://github.com/martinforsberg81/memoro-cli/pull/1309)
and [strict server #14880](https://github.com/martinforsberg81/memoro/pull/14880),
owned by programmes `vault/vault-cli-required-revisions` and
`vault/vault-required-revisions`. The server's `docs/technical/vault.md`
("Row revision and conflicts") is the API reference.

## Before enabling strict writes

1. Martin must arrange migration `0386_vault_secret_row_revision.sql` before
   deploying the API that requires it. It backfills opaque tokens and installs
   triggers that rotate them on secret/envelope changes. Code landing is not
   evidence that the migration has run remotely.
2. Upgrade every deployed first-party vault writer to revision-capable code:
   web save/delete/legacy upgrade, CLI `rm`, `rotate`, `migrate`, `adopt`, and
   managed Claude and Codex custody persistence. Land the CLI prerequisite
   before completing the strict-server goal; audit its resulting `origin/main`
   commit there. Numeric `revision`, config revision and import revision are
   not substitutes for the row's 32-lowercase-hex `row_revision`.
3. The server goal must record the landed-client audit and green repository,
   HTTP and web caller checks, including stale-write and invalid-batch refusal.
   CLI evidence must include exact token propagation, refusal before mutation,
   stale-write no-retry and unchanged ciphertext, with fault-sensitive checks.
   These are code-readiness evidence only. Martin still decides production
   rollout after confirming migration and deployed-client capability.

## Refusal and recovery

A CLI command reading no valid row token refuses with "the vault API did not
return a valid row_revision", naming migration 0386 and a revision-capable
client. Claude custody reports `managed-claude-custody-revision-required`;
Codex persistence reports `managed-domain-custody-revision-required`. No
missing-token compatibility write is attempted. On strict servers an older
writer missing a valid `expectedRevision` receives HTTP 400; a stale token
receives HTTP 409 `VAULT_SECRET_CONFLICT`.

Update the server capability/client as appropriate, then explicitly restart
from a fresh read. Do not invent a token, use numeric arithmetic, downgrade to
an omission fallback or silently replay a stale write. A custody conflict can
leave a locally rotated credential unpersisted; keep the concurrent winner
rather than overwrite it. Rotate's compensation may remove only its own
backup, using that backup's read token.

No deployment, remote migration, live-provider test or production verification
is performed by either code goal. Client auto-upgrade policy is not defined
here.
