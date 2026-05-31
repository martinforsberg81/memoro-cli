/**
 * `mc vault <verb>` — phase 1 (token vault, drev #3).
 *
 * Verbs: setup, unlock, lock, status, list, get, set, rm,
 *        change-password, rotate.
 *
 * Phase-1 scope (per docs/plans/worktree-lifecycle.md §12k.1):
 *   - Port `vault-client-crypto.js` to Node (done — src/mc/vault/).
 *   - CRUD against the existing Memoro `/api/vault/*` endpoints.
 *   - No JIT materialisation, no PreToolUse hook integration, no
 *     OS-keychain session cache for the vault-key. Every command that
 *     reads or writes a secret prompts for the master password. CI may
 *     pass it as `MC_VAULT_PASSPHRASE` to skip the prompt.
 *
 * Authority-lives-in-the-verbs: error messages and footers point at
 * other `mc vault` verbs (e.g. "Run `mc vault unlock` first") rather
 * than restating their logic.
 *
 * Exit-before-side-effect: every verb validates argv + checks for the
 * Memoro token before deriving keys or contacting the server.
 *
 * Pure helpers (validators, formatters, payload builders) live in
 * src/mc/vault/{types,client-crypto}.js so unit tests can hit them
 * in-process; this file owns I/O + orchestration only.
 */

import {
  deriveVaultKeys,
  encryptSecretPayload,
  decryptSecretPayload,
} from '../vault/client-crypto.js';
import {
  buildSecretPayload,
  normaliseSecretPayload,
  parseTypeFlag,
  formatListJson,
  formatListLine,
  MC_SECRET_KINDS,
  WIRE_SECRET_TYPE,
} from '../vault/types.js';
import * as VaultApi from '../vault/api.js';

import { getSecret as keychainGet } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';
import { promptSecret, confirm } from '../../lib/prompt.js';

const PASSPHRASE_ENV = 'MC_VAULT_PASSPHRASE';

// ────────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ────────────────────────────────────────────────────────────────────────

const VERBS = {
  setup:             { handler: cmdSetup,            help: 'Create a vault for this Memoro account' },
  unlock:            { handler: cmdUnlock,           help: 'Validate the master password (phase 1: no-op cache)' },
  lock:              { handler: cmdLock,             help: 'End the server-side vault session' },
  status:            { handler: cmdStatus,           help: 'Show vault setup + unlock state' },
  list:              { handler: cmdList,             help: 'List secret labels (no values)' },
  get:               { handler: cmdGet,              help: 'Print a secret (prompts for confirmation)' },
  set:               { handler: cmdSet,              help: 'Store a new secret' },
  rm:                { handler: cmdRm,               help: 'Delete a secret' },
  rotate:            { handler: cmdRotate,           help: 'Replace a secret, keeping the old as <label>-prev' },
  'change-password': { handler: cmdChangePassword,   help: 'Change the master password (re-encrypts auth hash)' },
};

export async function run(argv, opts = {}) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  const verb = argv[0];
  const v = VERBS[verb];
  if (!v) {
    console.error(`mc vault: unknown verb "${verb}"`);
    printHelp();
    return 2;
  }
  try {
    return await v.handler(argv.slice(1), opts);
  } catch (err) {
    // Friendly error wrapping. Specific errors (vault locked, token
    // missing, etc.) are handled in-line; this catches the long tail.
    const json = argv.includes('--json');
    if (json) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    } else {
      console.error(`mc vault: ${err.message}`);
    }
    return 1;
  }
}

function printHelp() {
  console.log(`mc vault — Memoro token vault (phase 1)

USAGE
  mc vault <verb> [options]

VERBS`);
  for (const [name, v] of Object.entries(VERBS)) {
    console.log(`  ${name.padEnd(18)} ${v.help}`);
  }
  console.log(`
COMMON OPTIONS
  --json              Machine-readable output
  --no-confirm        Skip confirmation prompts (use with care)
  --type <kind>       For \`set\` and \`list\`: ${MC_SECRET_KINDS.join(' | ')}

MASTER PASSWORD
  Phase 1 prompts for the master password on every command that reads
  or writes a secret. CI: set ${PASSPHRASE_ENV} to skip the prompt
  (NEVER pass via a flag — those leak to shell history).

  Rough edge: phase 2 caches the unlocked key in the OS keychain with
  a 15-minute TTL so subsequent commands don't re-prompt.

PRECONDITIONS
  - Run \`mc auth memoro\` first to store your Memoro API token.
  - Run \`mc vault setup\` once per Memoro account to create the vault.
`);
}

// ────────────────────────────────────────────────────────────────────────
// Verb: setup
// ────────────────────────────────────────────────────────────────────────

async function cmdSetup(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);

  // Pre-check: don't ask the user for a master password if the vault
  // already exists. exit-before-side-effect.
  const status = await VaultApi.getStatus(portal);
  if (status?.vault?.setup) {
    emit(flags.json, { ok: false, error: 'Vault already exists. Use `mc vault unlock` to use it.' });
    return 1;
  }

  const password = await readMasterPassword('Choose a master password (min 12 chars, no recovery if lost): ', opts);
  const confirmPwd = await readMasterPassword('Confirm master password:                                       ', opts);
  if (password !== confirmPwd) {
    emit(flags.json, { ok: false, error: 'passwords do not match' });
    return 1;
  }
  if (password.length < 12) {
    emit(flags.json, { ok: false, error: 'master password must be at least 12 characters' });
    return 1;
  }

  // Setup salt dance: the server-side /api/vault/setup endpoint
  // *generates* the salt and stores it, but the client must already
  // have derived an auth-hash against SOME salt to send in the
  // request body. We use the browser flow:
  //
  //   1. derive against a placeholder salt, POST /setup
  //   2. server returns the authoritative server-generated salt
  //   3. re-derive against the server's salt
  //   4. if the new auth-hash differs (it does — different salt ⇒
  //      different PBKDF2 output), unlock with the placeholder hash
  //      and use change-password to swap it for the real one
  //
  // Since this is fresh setup, there are zero secrets, so the
  // implicit key rotation in step 4 has no re-encryption work.

  // Step 1: Generate a placeholder salt + auth hash for the setup POST.
  const placeholderSaltBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(placeholderSaltBytes);
  const placeholderSaltB64 = bytesToBase64(placeholderSaltBytes);
  const { authHash: placeholderAuthHash } = await deriveVaultKeys(password, placeholderSaltB64);
  const setupRes = await VaultApi.setupVault(portal, { authHash: placeholderAuthHash });
  if (!setupRes?.ok) {
    emit(flags.json, { ok: false, error: setupRes?.error || 'setup failed' });
    return 1;
  }

  // Step 2: Server returned the authoritative salt. Re-derive against
  // it and replace the auth hash via change-password (the only verb
  // that updates auth_hash + salt atomically). This matches the
  // browser flow.
  const serverSalt = setupRes.salt;
  const { authHash: realAuthHash } = await deriveVaultKeys(password, serverSalt);

  // Sanity: the auth hash derived against the server's salt must be
  // different from the placeholder (since the salts differ); but in
  // the (statistically impossible) edge case they collide, no harm done.
  if (realAuthHash !== placeholderAuthHash) {
    // We need to be unlocked to call change-password. Unlock with the
    // placeholder hash (still valid until we replace it).
    const unlockRes = await VaultApi.unlockVault(portal, { authHash: placeholderAuthHash });
    if (!unlockRes?.ok) {
      emit(flags.json, {
        ok: false,
        error: `vault created but auth-hash sync failed (unlock: ${unlockRes?.error || 'unknown'}). Run \`mc vault change-password\` to repair.`,
      });
      return 1;
    }
    const cp = await VaultApi.changePassword(portal, {
      currentAuthHash: placeholderAuthHash,
      newAuthHash: realAuthHash,
      newSalt: serverSalt, // keep the server's salt; pass it back explicitly
    });
    if (!cp?.ok) {
      emit(flags.json, {
        ok: false,
        error: `vault created but auth-hash sync failed (${cp?.error || 'unknown'}). Run \`mc vault change-password\` to repair.`,
      });
      return 1;
    }
    // Lock after setup — phase 1's contract is "every command prompts".
    await VaultApi.lockVault(portal).catch(() => {});
  }

  emit(flags.json,
    { ok: true, vault: { setup: true, salt: serverSalt } },
    `Vault created. Run \`mc vault unlock\` to use it.`,
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: unlock
// ────────────────────────────────────────────────────────────────────────

async function cmdUnlock(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const password = await readMasterPassword('Master password: ', opts);
  const { authHash } = await deriveVaultKeys(password, config.salt, config.iterations);
  const res = await VaultApi.unlockVault(portal, { authHash });
  if (!res?.ok) {
    emit(flags.json, { ok: false, error: res?.error || 'unlock failed' });
    return 1;
  }
  emit(flags.json,
    { ok: true },
    'Vault unlocked. Subsequent `mc vault` commands will still re-prompt in phase 1.',
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: lock
// ────────────────────────────────────────────────────────────────────────

async function cmdLock(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);
  const res = await VaultApi.lockVault(portal);
  emit(flags.json,
    { ok: !!res?.ok },
    res?.ok ? 'Vault session locked on the server.' : 'mc vault: server reported no active vault session.',
  );
  return res?.ok ? 0 : 1;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: status
// ────────────────────────────────────────────────────────────────────────

async function cmdStatus(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);
  const res = await VaultApi.getStatus(portal);
  if (!res?.ok) {
    emit(flags.json, { ok: false, error: res?.error || 'status failed' });
    return 1;
  }
  const v = res.vault || {};
  if (flags.json) {
    console.log(JSON.stringify({
      ok: true,
      vault: {
        setup: !!v.setup,
        unlocked: !!v.unlocked,
        iterations: v.iterations || null,
        created_at: v.createdAt || null,
      },
    }, null, 2));
  } else {
    console.log(`mc vault status`);
    console.log(`  setup:      ${v.setup ? 'yes' : 'no'}`);
    console.log(`  unlocked:   ${v.unlocked ? 'yes (server session live)' : 'no'}`);
    if (v.iterations) console.log(`  pbkdf2:     ${v.iterations} iterations`);
    if (v.createdAt) console.log(`  created:    ${v.createdAt}`);
    if (!v.setup) {
      console.log(`\nRun \`mc vault setup\` to create the vault.`);
    } else if (!v.unlocked) {
      console.log(`\nRun \`mc vault unlock\` to use the vault.`);
    }
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: list
// ────────────────────────────────────────────────────────────────────────

async function cmdList(argv, opts = {}) {
  const flags = parseFlags(argv);
  const typeFilter = parseTypeFlag(flags.type); // throws on unknown
  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, authHash } = await deriveVaultKeys(password, config.salt, config.iterations);

  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return 1;
  }

  const listRes = await VaultApi.listSecrets(portal);
  const wire = listRes?.secrets || [];

  // Decrypt + normalise each. Errors per-entry are surfaced as bad
  // entries (don't break the whole list on a single bad row).
  const decrypted = [];
  for (const s of wire) {
    try {
      const { label, data } = await decryptSecretPayload(vaultKey, s);
      const norm = normaliseSecretPayload(data) || { kind: 'api_token' };
      if (typeFilter && norm.kind !== typeFilter) continue;
      decrypted.push({
        id: s.id,
        kind: norm.kind,
        label,
        provider: norm.provider,
        account: norm.account,
        created_at: s.created_at,
        updated_at: s.updated_at,
      });
    } catch {
      decrypted.push({
        id: s.id, kind: 'api_token',
        label: `<undecryptable ${s.id}>`,
        provider: null, account: null,
        created_at: s.created_at, updated_at: s.updated_at,
      });
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(formatListJson({ secrets: decrypted }), null, 2));
  } else if (decrypted.length === 0) {
    console.log('No secrets stored. Add one with `mc vault set <label>`.');
  } else {
    console.log(`mc vault — ${decrypted.length} secret${decrypted.length === 1 ? '' : 's'}:\n`);
    console.log(`  ${'label'.padEnd(32)}  ${'kind'.padEnd(28)}  id`);
    for (const s of decrypted) console.log(formatListLine(s));
    console.log(`\nRun \`mc vault get <label>\` to print a value.`);
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: get
// ────────────────────────────────────────────────────────────────────────

async function cmdGet(argv, opts = {}) {
  const flags = parseFlags(argv);
  const label = flags.positional[0];
  if (!label) {
    emit(flags.json, { ok: false, error: 'label required: `mc vault get <label>`' });
    return 2;
  }

  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, authHash } = await deriveVaultKeys(password, config.salt, config.iterations);
  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return 1;
  }

  const found = await findSecretByLabel(portal, vaultKey, label);
  if (!found) {
    emit(flags.json, { ok: false, error: `no secret with label ${JSON.stringify(label)}` });
    return 1;
  }
  const payload = normaliseSecretPayload(found.data) || { kind: 'api_token', token: '', provider: null };
  if (!payload.token) {
    emit(flags.json, { ok: false, error: 'secret has no token field' });
    return 1;
  }

  // HARD CONFIRMATION before echoing a secret. --no-confirm for scripts;
  // --json implies non-interactive ⇒ also bypasses confirmation. Even
  // then, the secret value is segregated under `.value` so callers that
  // only need metadata can still avoid touching it.
  if (!flags.noConfirm && !flags.json) {
    const ok = await confirm(`About to print the secret value for "${label}" to your terminal. Continue?`, { defaultYes: false });
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  if (flags.field) {
    const fieldVal = payload[flags.field] ?? found.data?.[flags.field];
    if (fieldVal == null) {
      emit(flags.json, { ok: false, error: `secret has no field ${JSON.stringify(flags.field)}` });
      return 1;
    }
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, value: String(fieldVal) }));
    } else {
      // Field output: NO trailing newline-only metadata, so a shell pipe
      // gets just the value. Caller asked for the field — give them the field.
      process.stdout.write(String(fieldVal));
      if (process.stdout.isTTY) process.stdout.write('\n');
    }
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify({
      ok: true,
      secret: {
        id: found.id,
        label: found.label,
        kind: payload.kind,
        provider: payload.provider,
        account: payload.account,
        scopes: payload.scopes,
        expires_at: payload.expires_at,
        value: payload.token,
      },
    }));
  } else {
    console.log(payload.token);
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: set
// ────────────────────────────────────────────────────────────────────────

async function cmdSet(argv, opts = {}) {
  const flags = parseFlags(argv);
  const label = flags.positional[0];
  if (!label) {
    emit(flags.json, { ok: false, error: 'label required: `mc vault set <label> [--provider X] [--account Y] [--type api_token|oauth_token]`' });
    return 2;
  }
  const kind = parseTypeFlag(flags.type) || 'api_token';

  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  // Read the secret value FIRST (before deriving keys / hitting server)
  // so the user fails fast on a typo'd label vs the slow PBKDF2.
  // Sources:
  //   --stdin   (piped value, no echo, no history)
  //   else      (interactive hidden prompt)
  // Intentionally no --token flag — that would leak to shell history.
  let token;
  if (flags.stdin) {
    token = await readAllStdin();
  } else {
    token = await readMasterPassword(`Secret value for "${label}" (hidden): `, opts);
  }
  token = (token || '').trim();
  if (!token) {
    emit(flags.json, { ok: false, error: 'secret value is empty' });
    return 1;
  }

  // Optional metadata. None of these is required.
  const payloadData = buildSecretPayload({
    kind,
    token,
    provider: flags.provider,
    account: flags.account,
    scopes: flags.scopes ? flags.scopes.split(',').map(s => s.trim()).filter(Boolean) : null,
    expiresAt: flags.expiresAt,
  });

  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, authHash } = await deriveVaultKeys(password, config.salt, config.iterations);
  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return 1;
  }

  // Reject duplicate labels — silent overwrite would be surprising.
  const existing = await findSecretByLabel(portal, vaultKey, label);
  if (existing) {
    emit(flags.json, { ok: false, error: `label ${JSON.stringify(label)} already exists. Use \`mc vault rotate ${label}\` to replace.` });
    return 1;
  }

  const enc = await encryptSecretPayload(vaultKey, label, payloadData);
  const res = await VaultApi.createSecret(portal, {
    secretType: WIRE_SECRET_TYPE,
    encryptedLabel: enc.encryptedLabel,
    encryptedData: enc.encryptedData,
    iv: enc.iv,
    labelIv: enc.labelIv,
  });
  if (!res?.ok) {
    emit(flags.json, { ok: false, error: res?.error || 'create failed' });
    return 1;
  }
  emit(flags.json,
    { ok: true, secret: { id: res.secret?.id, label, kind } },
    `Stored "${label}" (${kind}). Use \`mc vault list\` to verify, \`mc vault get ${label}\` to read.`,
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: rm
// ────────────────────────────────────────────────────────────────────────

async function cmdRm(argv, opts = {}) {
  const flags = parseFlags(argv);
  const label = flags.positional[0];
  if (!label) {
    emit(flags.json, { ok: false, error: 'label required: `mc vault rm <label>`' });
    return 2;
  }
  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, authHash } = await deriveVaultKeys(password, config.salt, config.iterations);
  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return 1;
  }

  const found = await findSecretByLabel(portal, vaultKey, label);
  if (!found) {
    emit(flags.json, { ok: false, error: `no secret with label ${JSON.stringify(label)}` });
    return 1;
  }

  if (!flags.noConfirm && !flags.json) {
    const ok = await confirm(`Delete secret "${label}" (${found.id})?`, { defaultYes: false });
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  const res = await VaultApi.deleteSecret(portal, found.id);
  if (!res?.ok) {
    emit(flags.json, { ok: false, error: res?.error || 'delete failed' });
    return 1;
  }
  emit(flags.json,
    { ok: true, deleted: { id: found.id, label } },
    `Deleted "${label}".`,
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: rotate
// ────────────────────────────────────────────────────────────────────────

async function cmdRotate(argv, opts = {}) {
  const flags = parseFlags(argv);
  const label = flags.positional[0];
  if (!label) {
    emit(flags.json, { ok: false, error: 'label required: `mc vault rotate <label>`' });
    return 2;
  }
  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  // Read new value first (fail fast).
  let token;
  if (flags.stdin) {
    token = await readAllStdin();
  } else {
    token = await readMasterPassword(`New secret value for "${label}" (hidden): `, opts);
  }
  token = (token || '').trim();
  if (!token) {
    emit(flags.json, { ok: false, error: 'secret value is empty' });
    return 1;
  }

  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, authHash } = await deriveVaultKeys(password, config.salt, config.iterations);
  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return 1;
  }

  const existing = await findSecretByLabel(portal, vaultKey, label);
  if (!existing) {
    emit(flags.json, { ok: false, error: `no secret with label ${JSON.stringify(label)} to rotate. Use \`mc vault set\` to create.` });
    return 1;
  }
  const existingPayload = normaliseSecretPayload(existing.data) || { kind: 'api_token' };

  // Preserve metadata from the existing secret unless flags override.
  const newPayload = buildSecretPayload({
    kind: parseTypeFlag(flags.type) || existingPayload.kind,
    token,
    provider: flags.provider ?? existingPayload.provider,
    account: flags.account ?? existingPayload.account,
    scopes: flags.scopes ? flags.scopes.split(',').map(s => s.trim()).filter(Boolean) : existingPayload.scopes,
    expiresAt: flags.expiresAt ?? existingPayload.expires_at,
  });

  // Step 1: stash the old value as <label>-prev. Auto-purge after 24h
  // is NOT implemented in phase 1 — the user must `mc vault rm
  // <label>-prev` once the new token is confirmed working. The
  // command output makes this explicit; documented as a follow-up.
  const prevLabel = `${label}-prev`;
  const prevExisting = await findSecretByLabel(portal, vaultKey, prevLabel);
  if (prevExisting) {
    // Replace any stale -prev silently — its presence means the user
    // rotated before and never cleaned up; the new rotation supersedes.
    await VaultApi.deleteSecret(portal, prevExisting.id).catch(() => {});
  }
  const prevEnc = await encryptSecretPayload(vaultKey, prevLabel, normaliseSecretPayload(existing.data) || existing.data);
  const prevRes = await VaultApi.createSecret(portal, {
    secretType: WIRE_SECRET_TYPE,
    encryptedLabel: prevEnc.encryptedLabel,
    encryptedData: prevEnc.encryptedData,
    iv: prevEnc.iv,
    labelIv: prevEnc.labelIv,
  });
  if (!prevRes?.ok) {
    emit(flags.json, { ok: false, error: `failed to stash previous as "${prevLabel}": ${prevRes?.error || 'unknown'}` });
    return 1;
  }

  // Step 2: overwrite the original with the new value.
  const newEnc = await encryptSecretPayload(vaultKey, label, newPayload);
  const updRes = await VaultApi.updateSecret(portal, existing.id, {
    secretType: WIRE_SECRET_TYPE,
    encryptedLabel: newEnc.encryptedLabel,
    encryptedData: newEnc.encryptedData,
    iv: newEnc.iv,
    labelIv: newEnc.labelIv,
  });
  if (!updRes?.ok) {
    emit(flags.json, { ok: false, error: `failed to update "${label}": ${updRes?.error || 'unknown'}` });
    return 1;
  }

  emit(flags.json,
    { ok: true, rotated: { id: existing.id, label, prev_label: prevLabel } },
    `Rotated "${label}". Old value stashed as "${prevLabel}" — delete with \`mc vault rm ${prevLabel}\` once the new token works.`,
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: change-password
// ────────────────────────────────────────────────────────────────────────

async function cmdChangePassword(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const oldPassword = await readMasterPassword('Current master password:        ', opts);
  const newPassword = await readMasterPassword('New master password (min 12):   ', opts);
  const confirmPwd  = await readMasterPassword('Confirm new password:           ', opts);
  if (newPassword !== confirmPwd) {
    emit(flags.json, { ok: false, error: 'new passwords do not match' });
    return 1;
  }
  if (newPassword.length < 12) {
    emit(flags.json, { ok: false, error: 'new password must be at least 12 characters' });
    return 1;
  }
  if (oldPassword === newPassword) {
    emit(flags.json, { ok: false, error: 'new password must differ from current' });
    return 1;
  }

  // Derive current auth hash with the existing salt, unlock, then
  // submit the change-password call. The server requires unlocked
  // state to accept the change.
  const { authHash: currentAuthHash, vaultKey } = await deriveVaultKeys(oldPassword, config.salt, config.iterations);

  const unlock = await VaultApi.unlockVault(portal, { authHash: currentAuthHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'current password rejected' });
    return 1;
  }

  // CRITICAL: changing the master password CHANGES the vault key,
  // because the vault key is the first 256 bits of the PBKDF2 output
  // (and the auth hash is the last 256). Different password ⇒ different
  // PBKDF2 output ⇒ different vault key. Every previously stored secret
  // was encrypted with the OLD vault key and would be unreadable under
  // the new key.
  //
  // The server's change-password route only updates the auth hash + salt;
  // it does NOT re-encrypt blobs. So the client must:
  //
  //   1. derive the NEW vault key + auth hash client-side
  //   2. pull all secrets
  //   3. decrypt-with-old + re-encrypt-with-new into a staging list
  //   4. commit the auth-hash rotation via /change-password
  //   5. push the re-encrypted blobs via /secrets/:id PUT
  //
  // If step 3 fails partway, we never call /change-password — the vault
  // stays usable under the old password. If step 5 fails, we've already
  // rotated the auth hash, so we keep going (best effort) and surface
  // which secrets need manual re-set. This is a narrow window but
  // documented in the error message.

  const newSaltBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(newSaltBytes);
  const newSaltB64 = bytesToBase64(newSaltBytes);
  const { authHash: newAuthHash, vaultKey: newVaultKey } =
    await deriveVaultKeys(newPassword, newSaltB64, config.iterations);

  // Step 2 + 3: pull, decrypt + re-encrypt to an in-memory staging list.
  const listRes = await VaultApi.listSecrets(portal);
  const wire = listRes?.secrets || [];
  const restaged = [];
  for (const s of wire) {
    try {
      const { label, data } = await decryptSecretPayload(vaultKey, s);
      const enc = await encryptSecretPayload(newVaultKey, label, data);
      restaged.push({ id: s.id, label, enc });
    } catch (err) {
      emit(flags.json, {
        ok: false,
        error: `re-encrypt failed for secret ${s.id} (${err.message}). Aborting — vault is unchanged.`,
      });
      return 1;
    }
  }

  // Step 4: commit auth-hash rotation. Past this point the OLD password
  // no longer works.
  const cp = await VaultApi.changePassword(portal, {
    currentAuthHash, newAuthHash, newSalt: newSaltB64,
  });
  if (!cp?.ok) {
    emit(flags.json, { ok: false, error: cp?.error || 'change-password failed' });
    return 1;
  }

  // Re-unlock with the new auth hash before mutating secrets — the
  // change-password call may have invalidated the session.
  await VaultApi.unlockVault(portal, { authHash: newAuthHash }).catch(() => {});

  // Step 5: push re-encrypted blobs.
  const failures = [];
  for (const item of restaged) {
    const updRes = await VaultApi.updateSecret(portal, item.id, {
      encryptedLabel: item.enc.encryptedLabel,
      encryptedData: item.enc.encryptedData,
      iv: item.enc.iv,
      labelIv: item.enc.labelIv,
    }).catch((err) => ({ ok: false, error: err.message }));
    if (!updRes?.ok) failures.push({ id: item.id, label: item.label, error: updRes?.error });
  }

  if (failures.length) {
    emit(flags.json, {
      ok: false,
      changed_password: true,
      failures,
      error: `password changed; ${failures.length}/${restaged.length} secret(s) failed to re-encrypt on the server. Affected labels: ${failures.map(f => f.label).join(', ')}. Use \`mc vault set\` to re-store them.`,
    });
    return 1;
  }

  emit(flags.json,
    { ok: true, re_encrypted: restaged.length },
    `Master password changed. ${restaged.length} secret${restaged.length === 1 ? '' : 's'} re-encrypted.`,
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

async function loadPortal(opts = {}) {
  // Allow opts.portal injection (tests). Production reads token from
  // the OS keychain and apiUrl from config + env.
  if (opts.portal) return opts.portal;
  const config = await readConfig();
  const apiUrl = getApiUrl([]) || config.apiUrl;
  const token = await keychainGet(ACCOUNTS.TOKEN);
  if (!token) {
    throw new Error('no Memoro token. Run `mc auth memoro` first.');
  }
  return { apiUrl, token };
}

async function requireSetup(portal) {
  const status = await VaultApi.getStatus(portal);
  if (!status?.vault?.setup) {
    console.error('mc vault: no vault on this account. Run `mc vault setup` first.');
    return null;
  }
  return {
    salt: status.vault.salt,
    iterations: status.vault.iterations || 600_000,
    createdAt: status.vault.createdAt,
  };
}

async function findSecretByLabel(portal, vaultKey, label) {
  const listRes = await VaultApi.listSecrets(portal);
  const wire = listRes?.secrets || [];
  for (const s of wire) {
    try {
      const { label: l, data } = await decryptSecretPayload(vaultKey, s);
      if (l === label) {
        return { id: s.id, label: l, data, raw: s };
      }
    } catch { /* skip undecryptable */ }
  }
  return null;
}

/**
 * Master-password reader. Sources (highest precedence first):
 *   1. opts.promptStub() — only used by tests via the `opts` arg the
 *      dispatcher threads through. Lets us script different answers
 *      for different prompts within one command (e.g. current vs new
 *      vs confirm in change-password).
 *   2. MC_VAULT_PASSPHRASE env — CI path; one value for all prompts.
 *   3. promptSecret(prompt) — interactive hidden prompt.
 *
 * NEVER reads from a flag. Flag values would leak to shell history.
 */
async function readMasterPassword(prompt, opts = {}) {
  if (typeof opts.promptStub === 'function') {
    return opts.promptStub(prompt);
  }
  if (process.env[PASSPHRASE_ENV]) {
    return process.env[PASSPHRASE_ENV];
  }
  return promptSecret(prompt);
}

async function readAllStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Tiny flag parser shared across verbs. Positional args (no leading -)
 * are collected into .positional. Flags follow the conventions:
 *   --json
 *   --no-confirm
 *   --stdin
 *   --type <kind>
 *   --provider <name>
 *   --account <name>
 *   --scopes a,b,c
 *   --expires-at <iso>
 *   --field <name>
 */
function parseFlags(argv) {
  const out = {
    positional: [],
    json: false,
    noConfirm: false,
    stdin: false,
    type: null,
    provider: null,
    account: null,
    scopes: null,
    expiresAt: null,
    field: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-confirm') out.noConfirm = true;
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--account') out.account = argv[++i];
    else if (a === '--scopes') out.scopes = argv[++i];
    else if (a === '--expires-at') out.expiresAt = argv[++i];
    else if (a === '--field') out.field = argv[++i];
    else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function emit(json, jsonObj, humanLine = null) {
  if (json) {
    console.log(JSON.stringify(jsonObj));
    return;
  }
  // Errors always print to stderr in non-JSON mode regardless of whether
  // the caller supplied a humanLine. Earlier behaviour silently swallowed
  // errors when humanLine was omitted — which made `mc vault setup`
  // failures invisible until the user noticed `mc vault status` said
  // "setup: no" minutes later.
  if (jsonObj?.ok === false) {
    console.error(`mc vault: ${jsonObj.error}`);
    return;
  }
  if (humanLine != null) {
    console.log(humanLine);
  }
}
