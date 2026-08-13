# Credential-blind capabilities and complete GitHub writes

**Status:** accepted · 2026-07-24
Owners: `memoro` control plane + `memoro-cli` trusted runtime
Normative dependencies:

- `docs/plans/connected-capabilities.md` on current `memoro-cli` main
- `docs/plans/github-app-capability.md`
- `docs/plans/worktree-lifecycle.md` §12

## 1. Outcome

No secret stored in mc vault may ever become readable as plaintext by an
LLM tool or by a command surface the model controls.

This invariant applies to every observable surface:

- child environment;
- argv;
- files visible to the coding-tool process;
- prompt, stdin, transcript, logs, errors, or browser payloads;
- tool output;
- process inspection available from the coding-tool sandbox;
- indirect shell expansion, subprocesses, or credential-helper commands.

Vault encryption at rest is not sufficient. Decrypting a secret and writing it
to a tool-native credential file or repo-local `.env` file violates this
contract even if the file has mode `0600`, is later shredded, or a host-specific
hook attempts to deny direct reads.

The target is a credential-blind capability model:

```text
LLM tool
  -> token-free typed operation
  -> trusted broker
  -> source/session/resource-bound grant
  -> isolated provider executor
  -> provider API
```

The LLM receives capability descriptors, bounded results, and stable errors. It
never receives the credential backing the capability.

## 2. Current-state finding

The current vault lifecycle does not satisfy this invariant.

Today it can materialise decrypted values to:

- `~/.codex/auth.json`;
- `~/.claude/.credentials.json`;
- repo-bound dotenv files such as `.env`.

The Claude PreToolUse hook is defense in depth, not a security boundary:

- it is host-specific;
- Codex does not provide the same enforcement path;
- it deliberately fails open on missing or malformed state;
- path substring matching cannot cover every indirect read;
- the coding-tool process still shares the credential's filesystem and OS-user
  boundary.

Current materialisation and hook behavior must therefore be treated as legacy,
not expanded to new tools or providers.

## 3. Credential custody classes

Every connection or secret binding declares exactly one custody class.

### 3.1 Control-plane custody

Preferred for managed providers such as the Memoro GitHub App.

- Durable provider credentials stay in Memoro secret storage.
- The control plane mints provider tokens when required.
- Local and cloud brokers receive only short-lived Memoro capability grants.
- No provider credential reaches the local coding-tool machine.

### 3.2 Isolated local custody

For user-owned vault secrets that cannot be held centrally.

- Ciphertext remains in mc vault.
- Plaintext may exist only inside a dedicated credential executor.
- The executor must be outside the LLM-controlled process, filesystem,
  environment, and inspection boundary.
- Same-UID broker memory alone is not an adequate boundary where the coding
  sandbox can inspect peer processes.
- Platform enforcement may use a separate OS identity, sandbox/container, or an
  equivalent ACL-isolated service.
- The executor exposes only allowlisted typed operations, never `get secret`,
  arbitrary shell, arbitrary HTTP, or arbitrary provider API passthrough.

### 3.3 Workload custody

For cloud execution.

- A cloud workload identity is bound to one cloud session.
- Provider authority is resolved by the control plane or an isolated workload
  executor.
- Local Keychain, local vault plaintext, and the user's online Mac are never
  dependencies.

### 3.4 Native runtime custody

Codex, Claude, and other LLM hosts may own their native login.

- Native runtime authentication is not materialised from mc vault.
- mc reports readiness through the common connection registry.
- The host/provider owns any claim that its native credential is hidden from
  the model.
- mc must not silently convert a vault API key into a native runtime credential
  file.

## 4. Vault product contract

mc vault remains the encrypted custody and policy store for user-owned secrets.
Its role changes from secret materialisation to capability backing.

Allowed:

- create, import, label, rotate, revoke, and delete encrypted secrets;
- metadata-only status and audit;
- bind a secret label to a provider, resource, capability family, and typed
  operation set;
- decrypt inside an approved isolated executor;
- report use by opaque secret id/label without exposing the value.

Forbidden:

- materialise plaintext into a coding-tool credential file;
- materialise plaintext into a repo file or dotenv file;
- inherit plaintext in the coding-tool environment;
- pass plaintext through argv or stdin controlled by the coding tool;
- return plaintext through an mc command callable from a managed session;
- expose a generic authenticated HTTP proxy;
- expose a generic credential helper from which the model can request the
  token;
- treat PreToolUse hooks as the primary confidentiality boundary.

A future binding describes authority, not a destination file:

```json
{
  "schema": 2,
  "secret": "cloudflare-production",
  "provider": "cloudflare",
  "resource": {
    "type": "worker",
    "id": "worker_opaque_id"
  },
  "operations": [
    "worker.read",
    "worker.deploy"
  ],
  "sources": ["local", "cloud"]
}
```

## 5. Immediate containment

Containment precedes new provider work.

1. Stop automatic vault materialisation in `mc new`, `mc open`, and
   `mc resume`.
2. Reject repo bindings with `materialise: file` in managed sessions.
3. Stop Codex and Claude adapter token-file materialisation.
4. Do not add an override that re-enables plaintext inside a managed session.
5. Preserve encrypted vault entries; do not delete or rotate automatically.
6. Add a metadata-only audit that reports:
   - secret label or opaque id;
   - binding type;
   - affected session id;
   - materialisation destination;
   - created/shredded/leftover state;
   - never the secret value.
7. Detect and remove remaining managed materialisation blocks/files where
   ownership is provable. Report uncertain files instead of deleting them.
8. Explain that secure deletion cannot be guaranteed on SSDs. Rotation remains
   a user decision informed by the audit.

## 6. Provider executor contract

All vault-backed provider use goes through the connected-capability framework.

An executor request binds:

- Memoro user;
- local device or cloud workload source;
- coding session;
- provider;
- stable provider resource id;
- typed operation and normalized parameters;
- effect (`read` or `write`);
- expiry and nonce/idempotency identity;
- required state preconditions.

An executor response:

- is schema-validated;
- is bounded in size;
- excludes credentials and raw authorization headers;
- redacts provider error bodies;
- includes stable repair actions;
- is safe for prompt/transcript exposure.

For HTTP providers, the executor performs the authenticated HTTP request itself.
For CLI-only providers, the CLI runs inside the isolated executor. The coding
tool must not spawn that authenticated CLI directly.

## 7. GitHub write gap found during acceptance

GitHub reads now work through the central App and session broker. Writes are not
complete.

Observed user-facing failure:

> The active GitHub adapter lacks create permission, while native `gh` is
> blocked by the managed-session write policy.

This is currently fail-closed behavior, not a `gh auth` regression:

- production `GITHUB_OPERATIONS_WRITE_V1` remains disabled;
- a session grant therefore lacks `session.write`;
- the descriptor does not advertise `pull_request.create`;
- the managed `gh` shim correctly refuses native CLI passthrough.

The current typed write surface contains only:

- `pull_request.create`;
- `pull_request.update`.

It does not yet provide:

- authenticated remote branch publication/push;
- `pull_request.merge`;
- a complete commit -> publish -> PR -> checks -> merge workflow.

Turning on the existing write flag alone is not sufficient.

## 8. Correct GitHub write model

### 8.1 Local commit

`git commit` is a local worktree operation and requires no GitHub credential.

- It remains owned by the coding host and the user's native approval policy.
- mc must not add a second approval preference.
- Errors must distinguish local workspace/policy failure from GitHub
  capability failure.

### 8.2 Remote branch publication

The LLM must not receive a GitHub installation token or a credential helper.

Add a typed operation such as:

```text
repository.branch.publish
```

The trusted path must:

- derive repository, branch, base SHA, and local head from the registered
  session;
- reject repository/branch authority supplied by the LLM;
- package the exact local Git objects or an equivalent verified tree;
- publish through a control-plane or isolated executor using the GitHub App;
- use expected-base and expected-head preconditions;
- be idempotent;
- reject force-push in v1;
- never expose an installation token to local `git` or the LLM child.

A raw short-lived token handed to `git push` in the coding-tool process is not
acceptable.

### 8.3 Pull-request create/update

Keep the existing typed operations, but require:

- the session branch to be published and server-known;
- exact expected head/base SHA;
- repository binding from the session grant;
- idempotency;
- pull-request write permission on the App installation;
- bounded title/body fields;
- stable stale-state and repair errors.

### 8.4 Merge

Add:

```text
pull_request.merge
```

It binds:

- PR number from the current repository;
- expected PR head SHA;
- expected base branch and base SHA where applicable;
- allowlisted merge method;
- required checks/mergeability policy;
- idempotency key.

No arbitrary `gh pr merge` passthrough, GraphQL, or `gh api` is permitted.

### 8.5 Approval ownership

- Codex/Claude/host policy decides whether the model may invoke a write.
- mc exposes the typed write and enforces hard capability/precondition policy.
- Memoro does not store or duplicate “Always ask” preferences.
- Denial messages must identify which layer denied the action:
  host approval, unavailable capability, missing App permission, unpublished
  branch, stale state, or server release gate.

## 9. Delivery plan

Each segment is a separate PR and is reviewed against this plan before the next
segment starts.

### S1 — Contract and containment (`memoro-cli`)

- Make this document normative from `docs/coding-agent-protocol.md`.
- Disable automatic plaintext materialisation for managed sessions.
- Block new file/env bindings.
- Add negative tests for Codex, Claude, and generic adapters.

Gate: starting a session creates no plaintext secret artifact.

### S2 — Metadata-only exposure audit (`memoro-cli`)

- Inventory manifests and provably managed artifacts without reading values.
- Report affected labels, sessions, paths, and cleanup state.
- Add safe cleanup for provably owned artifacts.
- Never auto-rotate or delete vault entries.

Gate: audit output contains no value, ciphertext, vault key, or credential
reference usable for retrieval.

### S3 — Capability-backed vault bindings (`memoro` + `memoro-cli`)

- Add binding schema v2.
- Add custody class, resource, source, and typed-operation policy.
- Keep legacy bindings readable only for audit/migration, not execution.
- Integrate the common connection registry and repair vocabulary.

Gate: no provider-specific auth branch in onboarding core.

### S4 — Isolated executor (`memoro-cli` and/or `memoro`)

- Define transport and OS isolation.
- Decrypt only inside the executor.
- Add audience-bound, short-lived grants.
- Add response redaction and bounded schemas.
- Prove the LLM child cannot inspect executor credentials.

Gate: adversarial exfiltration suite passes on every supported OS.

### G1 — GitHub branch publication (`memoro` + `memoro-cli`)

- Add `repository.branch.publish`.
- Publish exact verified Git state through the App.
- No token/credential-helper path.
- No force push.

Gate: a new session branch can be published without native `gh` or GitHub
credentials in the child.

### G2 — Complete PR writes (`memoro` + `memoro-cli`)

- Harden PR create/update around published branch state.
- Add `pull_request.merge`.
- Add exact preconditions, checks policy, idempotency, and safe results.
- Extend the session-scoped `gh` shim only for the allowlisted commands.

Gate: commit -> publish -> draft PR -> update -> checks -> merge works without
credential exposure or native CLI passthrough.

### G3 — Admin dogfood and release gate

- Keep writes admin-only initially.
- Run cross-user, repository crossing, replay, stale-head, suspended,
  transferred, renamed, revoked, and missing-permission tests.
- Verify host approval is the only interactive approval layer.
- Enable production writes only after the full workflow passes.

Gate: observed errors identify the denying layer and provide one correct repair
action.

### S5 — Provider migration

- Migrate Cloudflare and other vault-backed provider use to typed executors.
- Keep native runtime auth separate.
- Remove legacy materialisation code after metadata migration is complete.

Gate: no supported provider requires plaintext in an LLM-controlled surface.

## 10. Adversarial acceptance suite

For every supported LLM host and OS, attempt:

- direct file read;
- `env`, shell expansion, command substitution, and subprocess inheritance;
- indirect reads through Python/Node/shell;
- argv and process-list inspection;
- peer-process environment/memory inspection available to the sandbox;
- log, error, transcript, and browser-payload reflection;
- arbitrary HTTP proxying;
- credential-helper extraction;
- copied grant use across user, source, session, provider, and resource;
- grant replay after expiry/revocation;
- provider error-body injection.

Passing means the requested provider operation can succeed while the secret
value never appears in any LLM-observable byte stream or storage surface.

## 11. Non-goals

- Storing Memoro first-party device identity in mc vault.
- Treating file permissions or hooks as sufficient confidentiality.
- Giving an LLM a raw provider CLI with injected credentials.
- Arbitrary provider API, GraphQL, shell, or HTTP passthrough.
- Replacing host-native write approval settings.
- Automatically rotating or deleting the user's current vault secrets.

## 12. Definition of done

The plan is complete when:

1. No managed session materialises vault plaintext.
2. Existing exposure can be audited using metadata only.
3. Vault secrets back capabilities rather than files/env.
4. GitHub supports the complete local commit -> publish -> PR -> merge flow.
5. GitHub writes use the central App and never native credential fallback.
6. Cloudflare and future providers use the same custody/grant/executor model.
7. Local and cloud use the same operation and authorization semantics.
8. Windows, macOS, and Linux pass the same no-plaintext acceptance suite before
   being marked supported.
