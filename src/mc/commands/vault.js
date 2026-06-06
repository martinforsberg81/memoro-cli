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
  formatListHeader,
  formatListLine,
  formatListWidths,
  MC_SECRET_KINDS,
  WIRE_SECRET_TYPE,
} from '../vault/types.js';
import * as VaultApi from '../vault/api.js';

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { getSecret as keychainGet } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';
import { promptSecret, confirm } from '../../lib/prompt.js';
import {
  cacheVaultKey,
  clearCachedVaultKey,
  readCachedVaultKey,
  inspectCachedVaultKey,
} from '../vault/key-cache.js';
import { buildVaultImportDryRun, parseDotenv, scanVaultImportFiles } from '../vault/import-scan.js';
import {
  SECRET_BINDINGS_RELATIVE_PATH,
  bindingForLabels,
  buildDotenvSecretBinding,
  persistSecretBindingPlan,
  planSecretBindingPersistence,
} from '../vault/bindings.js';

const PASSPHRASE_ENV = 'MC_VAULT_PASSPHRASE';

// ────────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ────────────────────────────────────────────────────────────────────────

const VERBS = {
  setup:             { handler: cmdSetup,            help: 'Create a vault for this Memoro account' },
  unlock:            { handler: cmdUnlock,           help: 'Validate the master password (phase 1: no-op cache)' },
  lock:              { handler: cmdLock,             help: 'End the server-side vault session' },
  status:            { handler: cmdStatus,           help: 'Show vault setup + unlock state' },
  scan:              { handler: cmdScan,             help: 'Scan local dotenv files for import candidates (no values)' },
  import:            { handler: cmdImport,           help: 'Import dotenv secrets into the vault (use --dry-run to preview)' },
  list:              { handler: cmdList,             help: 'List secret labels (no values)' },
  get:               { handler: cmdGet,              help: 'Print a secret (prompts for confirmation)' },
  set:               { handler: cmdSet,              help: 'Store a new secret (use --bind KEY to attach it to this repo)' },
  rm:                { handler: cmdRm,               help: 'Delete a secret' },
  rotate:            { handler: cmdRotate,           help: 'Replace a secret, keeping the old as <label>-prev' },
  'change-password': { handler: cmdChangePassword,   help: 'Change the master password (re-encrypts auth hash)' },
  'destroy-forgotten': { handler: cmdDestroyForgotten, help: 'Wipe the vault when the master password is lost (requires fresh login)' },
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
  --dry-run           Preview planned writes without mutating vault/files
  --no-confirm        Skip confirmation prompts (use with care)
  --bind <ENV_KEY>    For \`set\`: attach this secret to the current repo
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
// Verb: scan
// ────────────────────────────────────────────────────────────────────────

async function cmdScan(argv, opts = {}) {
  const flags = parseFlags(argv);
  const scan = scanVaultImportFiles(flags.positional, { cwd: opts.cwd || process.cwd() });
  const hasErrors = scan.files.some((f) => !f.ok);

  if (flags.json) {
    console.log(JSON.stringify(scan));
  } else {
    printScan(scan);
  }

  return hasErrors ? 1 : 0;
}

function printScan(scan) {
  if (!scan.files.length) {
    console.log('No dotenv secret files found.');
    return;
  }

  for (const file of scan.files) {
    console.log(file.file);
    if (!file.ok) {
      console.log(`  error: ${file.error}`);
      continue;
    }
    if (!file.keys.length) {
      console.log('  no keys found');
      continue;
    }
    const width = Math.max(8, ...file.keys.map((k) => k.name.length));
    for (const k of file.keys) {
      const label = `${k.classification === 'secret' ? 'likely secret' : k.classification === 'config' ? 'likely config' : 'unknown'} (${k.confidence})`;
      console.log(`  ${k.name.padEnd(width)}  ${label}  line ${k.line} - ${k.reason}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Verb: import
// ────────────────────────────────────────────────────────────────────────

async function cmdImport(argv, opts = {}) {
  const flags = parseFlags(argv);
  if (flags.positional.length !== 1) {
    emit(flags.json, { ok: false, error: 'usage: mc vault import <file> [--dry-run] [--json] [--no-confirm]' });
    return 2;
  }

  const plan = buildVaultImportDryRun(flags.positional[0], { cwd: opts.cwd || process.cwd() });
  if (flags.dryRun) {
    if (flags.json) {
      console.log(JSON.stringify(plan));
    } else {
      printImportPreview(plan, { dryRun: true });
    }
    return plan.ok ? 0 : 1;
  }

  if (!plan.ok) {
    if (flags.json) console.log(JSON.stringify(plan));
    else console.error(`mc vault: ${plan.error}`);
    return 1;
  }

  const selected = plan.candidates.filter((k) => k.selected);
  if (!selected.length) {
    emit(flags.json, {
      ok: true,
      imported: [],
      skipped: plan.candidates.map((k) => ({ name: k.name, reason: k.decision })),
      warnings: plan.warnings,
    }, 'No secrets selected for import.');
    return 0;
  }

  if (flags.json && !flags.noConfirm) {
    emit(flags.json, { ok: false, error: 'non-dry-run import with --json requires --no-confirm' });
    return 2;
  }

  if (!flags.noConfirm && !flags.json) {
    printImportPreview(plan, { dryRun: false });
    const ok = await confirm(`Import ${selected.length} secret${selected.length === 1 ? '' : 's'} into mc vault?`, { defaultYes: false });
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  return importSelectedSecrets({ file: flags.positional[0], plan, flags, opts });
}

function printImportPreview(plan, { dryRun = true } = {}) {
  if (!plan.ok) {
    console.error(`mc vault: ${plan.error}`);
    return;
  }

  const selected = plan.candidates.filter((k) => k.selected);
  const skipped = plan.candidates.filter((k) => !k.selected);
  console.log(`Vault import preview: ${plan.file}`);
  console.log(`  import ${selected.length} secret${selected.length === 1 ? '' : 's'} into mc vault`);
  console.log(`  skip   ${skipped.length} key${skipped.length === 1 ? '' : 's'}`);
  console.log(dryRun
    ? '  write  nothing (dry-run)\n'
    : `  write  vault entries + ${SECRET_BINDINGS_RELATIVE_PATH} after confirmation; source file unchanged\n`);

  if (plan.warnings?.length) {
    console.log('Warnings');
    for (const w of plan.warnings) {
      const where = w.lines?.length ? ` lines ${w.lines.join(', ')}` : '';
      console.log(`  ${w.key}${where}: ${w.message}`);
    }
    console.log('');
  }

  if (!plan.candidates.length) {
    console.log('No keys found.');
    return;
  }

  if (selected.length) {
    console.log('Will Import');
    const width = Math.max(8, ...selected.map((k) => k.name.length));
    for (const k of selected) {
      console.log(`  ${k.name.padEnd(width)}  -> ${k.label}`);
    }
    console.log('');
  }

  if (skipped.length) {
    console.log('Skipped');
    const width = Math.max(8, ...skipped.map((k) => k.name.length));
    for (const k of skipped) {
      const detail = k.duplicate ? 'duplicate; fix before import' : `${k.classification}, ${k.confidence}`;
      console.log(`  ${k.name.padEnd(width)}  ${detail}`);
    }
    console.log('');
  }

  console.log('Binding Preview');
  const bindings = Object.entries(plan.binding?.sources?.[0]?.keys || {});
  if (!bindings.length) {
    console.log('  no bindings would be written');
  } else {
    const width = Math.max(8, ...bindings.map(([key]) => key.length));
    for (const [key, label] of bindings) {
      console.log(`  ${key.padEnd(width)}  -> ${label}`);
    }
  }
  console.log(dryRun
    ? '\nNo changes made. Use --json for the exact machine-readable plan.'
    : '\nNo changes yet. Confirm to import selected secrets into mc vault.');
}

async function importSelectedSecrets({ file, plan, flags, opts }) {
  const cwd = opts.cwd || process.cwd();
  await planSecretBindingPersistence(plan.binding, { cwd });

  const portal = await loadPortal(opts);
  const config = await requireSetup(portal);
  if (!config) return 1;

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

  const values = readDotenvValueMap(file, { cwd });
  const existingLabels = await listVaultLabels(portal, vaultKey);
  const imported = [];
  const skipped = [];
  const bindableLabels = new Set();

  for (const candidate of plan.candidates) {
    if (!candidate.selected) {
      skipped.push({ name: candidate.name, label: candidate.label, reason: candidate.decision });
      continue;
    }
    if (existingLabels.has(candidate.label)) {
      skipped.push({ name: candidate.name, label: candidate.label, reason: 'label already exists' });
      bindableLabels.add(candidate.label);
      continue;
    }
    const token = values.get(candidate.name);
    if (!token) {
      skipped.push({ name: candidate.name, label: candidate.label, reason: 'empty value' });
      continue;
    }

    const payloadData = buildSecretPayload({
      kind: 'api_token',
      token,
      provider: providerFromLabel(candidate.label),
      account: plan.repo,
      extra: {
        source: 'vault_import',
        source_file: plan.file,
        env_key: candidate.name,
      },
    });
    const enc = await encryptSecretPayload(vaultKey, candidate.label, payloadData);
    const res = await VaultApi.createSecret(portal, {
      secretType: WIRE_SECRET_TYPE,
      encryptedLabel: enc.encryptedLabel,
      encryptedData: enc.encryptedData,
      iv: enc.iv,
      labelIv: enc.labelIv,
    });
    if (!res?.ok) {
      emit(flags.json, { ok: false, error: res?.error || `create failed for ${candidate.label}` });
      return 1;
    }
    existingLabels.add(candidate.label);
    bindableLabels.add(candidate.label);
    imported.push({ name: candidate.name, label: candidate.label, id: res.secret?.id || null });
  }

  const binding = bindingForLabels(plan.binding, bindableLabels);
  const bindingPlan = bindableLabels.size
    ? await planSecretBindingPersistence(binding, { cwd })
    : null;
  const bindingFile = bindingPlan
    ? await persistSecretBindingPlan(bindingPlan)
    : null;
  const writes = bindingFile?.changed
    ? [{ path: bindingFile.path, action: bindingFile.action }]
    : [];

  const result = {
    ok: true,
    imported,
    skipped,
    warnings: plan.warnings,
    binding,
    binding_file: bindingFile,
    writes,
  };

  if (flags.json) {
    console.log(JSON.stringify(result));
  } else {
    printImportResult(result);
  }
  return 0;
}

function printImportResult(result) {
  console.log(`Imported ${result.imported.length} secret${result.imported.length === 1 ? '' : 's'} into mc vault.`);
  if (result.imported.length) {
    const width = Math.max(8, ...result.imported.map((x) => x.name.length));
    for (const item of result.imported) {
      console.log(`  ${item.name.padEnd(width)}  -> ${item.label}`);
    }
  }
  const skipped = result.skipped.filter((x) => x.reason !== 'not selected by default');
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} key${skipped.length === 1 ? '' : 's'}:`);
    const width = Math.max(8, ...skipped.map((x) => x.name.length));
    for (const item of skipped) {
      console.log(`  ${item.name.padEnd(width)}  ${item.reason}`);
    }
  }
  if (result.writes?.length) {
    const write = result.writes[0];
    const verb = write.action === 'created' ? 'Created' : 'Updated';
    console.log(`\n${verb} ${write.path}.`);
  } else if (result.binding_file?.action === 'unchanged') {
    console.log(`\nRepo bindings already up to date in ${result.binding_file.path}.`);
  } else {
    console.log('\nNo files changed.');
  }
}

function readDotenvValueMap(file, { cwd }) {
  const diskPath = isAbsolute(file) ? file : join(cwd, file);
  const entries = parseDotenv(readFileSync(diskPath, 'utf8'));
  const values = new Map();
  for (const entry of entries) {
    // Duplicates are never selected by the plan, so "last wins" here is
    // only relevant for non-selected metadata keys. Keep it simple.
    values.set(entry.key, entry.value);
  }
  return values;
}

async function listVaultLabels(portal, vaultKey) {
  const listRes = await VaultApi.listSecrets(portal);
  const wire = listRes?.secrets || [];
  const labels = new Set();
  for (const s of wire) {
    try {
      const { label } = await decryptSecretPayload(vaultKey, s);
      labels.add(label);
    } catch { /* skip undecryptable */ }
  }
  return labels;
}

function providerFromLabel(label) {
  const idx = String(label || '').indexOf(':');
  return idx > 0 ? label.slice(0, idx) : null;
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
  // Capture vaultKeyBytes too — phase 2 caches the raw key bytes in
  // the OS keychain so subsequent mc commands (and `mc new` / `mc
  // resume` materialisation) don't re-derive PBKDF2.
  const { authHash, vaultKeyBytes } = await deriveVaultKeys(password, config.salt, config.iterations);
  const res = await VaultApi.unlockVault(portal, { authHash });
  if (!res?.ok) {
    emit(flags.json, { ok: false, error: res?.error || 'unlock failed' });
    return 1;
  }
  // §12f: cache the vault-key under the OS keychain. Best-effort:
  // a cache failure is *not* an unlock failure — the verb still
  // succeeded server-side, we just lose the no-prompt UX for
  // subsequent calls. tests + CI pass via opts.cacheDeps.
  await cacheVaultKey(vaultKeyBytes, { deps: opts.cacheDeps });
  emit(flags.json,
    { ok: true },
    'Vault unlocked. Key cached for 15 min — subsequent commands won\'t re-prompt.',
  );
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: lock
// ────────────────────────────────────────────────────────────────────────

async function cmdLock(argv, opts = {}) {
  const flags = parseFlags(argv);
  // §12f: clear the OS-keychain cache FIRST so a "lock" is local-
  // first — even if the server-side lock call fails, the user's
  // intent (drop the cached key) is honoured. tests inject via
  // opts.cacheDeps.
  await clearCachedVaultKey({ deps: opts.cacheDeps });
  const portal = await loadPortal(opts);
  const res = await VaultApi.lockVault(portal);
  emit(flags.json,
    { ok: !!res?.ok },
    res?.ok ? 'Vault locked: cached key cleared and server session ended.' : 'mc vault: cached key cleared; server reported no active vault session.',
  );
  return res?.ok ? 0 : 1;
}

// ────────────────────────────────────────────────────────────────────────
// Verb: status
// ────────────────────────────────────────────────────────────────────────

async function cmdStatus(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);
  const [res, cacheInfo] = await Promise.all([
    VaultApi.getStatus(portal),
    inspectCachedVaultKey({ deps: opts.cacheDeps }).catch(() => ({ present: false, expiresAt: null, expiresInMs: 0 })),
  ]);
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
        // §12f: cache state — surfaces "is the key cached, and for
        // how long?" without exposing the key itself.
        cache: {
          present: !!cacheInfo.present,
          expires_at: cacheInfo.expiresAt || null,
          expires_in_ms: cacheInfo.expiresInMs || 0,
        },
      },
    }, null, 2));
  } else {
    console.log(`mc vault status`);
    console.log(`  setup:      ${v.setup ? 'yes' : 'no'}`);
    console.log(`  unlocked:   ${v.unlocked ? 'yes (server session live)' : 'no'}`);
    if (cacheInfo.present) {
      const mins = Math.round(cacheInfo.expiresInMs / 60_000);
      console.log(`  cached key: yes (${mins} min${mins === 1 ? '' : 's'} until lock)`);
    } else {
      console.log(`  cached key: no`);
    }
    if (v.iterations) console.log(`  pbkdf2:     ${v.iterations} iterations`);
    if (v.createdAt) console.log(`  created:    ${v.createdAt}`);
    if (!v.setup) {
      console.log(`\nRun \`mc vault setup\` to create the vault.`);
    } else if (!cacheInfo.present) {
      console.log(`\nRun \`mc vault unlock\` to cache the key for 15 min.`);
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

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

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
        target_tool: norm.target_tool,
        target_auth_mode: norm.target_auth_mode,
        target_location: norm.target_location,
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
    const widths = formatListWidths(decrypted);
    console.log(formatListHeader(widths));
    for (const s of decrypted) console.log(formatListLine(s, widths));
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

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

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
        target_tool: payload.target_tool,
        target_auth_mode: payload.target_auth_mode,
        target_location: payload.target_location,
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
  const cwd = opts.cwd || process.cwd();
  const binding = flags.bind
    ? buildDotenvSecretBinding({ file: flags.bindFile || '.env', key: flags.bind, label })
    : null;
  const bindingPlan = binding
    ? await planSecretBindingPersistence(binding, { cwd })
    : null;

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
    targetTool: flags.targetTool,
    targetAuthMode: flags.targetAuthMode,
    targetLocation: flags.targetLocation,
  });

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

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
  const bindingFile = bindingPlan
    ? await persistSecretBindingPlan(bindingPlan)
    : null;
  const result = {
    ok: true,
    secret: { id: res.secret?.id, label, kind },
    binding,
    binding_file: bindingFile,
    writes: bindingFile?.changed ? [{ path: bindingFile.path, action: bindingFile.action }] : [],
  };
  emit(flags.json, result, formatSetResult(label, kind, bindingFile));
  return 0;
}

function formatSetResult(label, kind, bindingFile) {
  const lines = [`Stored "${label}" (${kind}). Use \`mc vault list\` to verify, \`mc vault get ${label}\` to read.`];
  if (bindingFile?.changed) {
    const verb = bindingFile.action === 'created' ? 'Created' : 'Updated';
    lines.push(`${verb} ${bindingFile.path}.`);
  } else if (bindingFile?.action === 'unchanged') {
    lines.push(`Repo bindings already up to date in ${bindingFile.path}.`);
  }
  return lines.join('\n');
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

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

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

  const got = await getUnlockedVaultKey({ portal, config, flags, opts });
  if (!got) return 1;
  const { vaultKey } = got;

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
    targetTool: flags.targetTool ?? existingPayload.target_tool,
    targetAuthMode: flags.targetAuthMode ?? existingPayload.target_auth_mode,
    targetLocation: flags.targetLocation ?? existingPayload.target_location,
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
  const { authHash: newAuthHash, vaultKey: newVaultKey, vaultKeyBytes: newVaultKeyBytes } =
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

  // §12f: any cached vault-key is now stale (the password change
  // rotated the key). Refresh the cache with the NEW key so the next
  // verb runs without re-prompting. Best-effort: cache failure here
  // just means the next verb prompts.
  await cacheVaultKey(newVaultKeyBytes, { deps: opts.cacheDeps });

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
// Verb: destroy-forgotten
// ────────────────────────────────────────────────────────────────────────
//
// Wipes the entire vault — used when the master password is lost. The
// vault is zero-knowledge so there is no recovery; the only option is
// to destroy and re-setup.
//
// Server-side gate: the Memoro session must have been created within
// the last 5 minutes (proves the user just re-OAuth'd). On a stale
// session the server returns 403 with code OAUTH_STALE; we surface
// that with a clear "log out + log in, then retry" message.
//
// The `mc vault destroy` verb (which requires unlock) handles the
// non-forgotten path; this verb is the recovery escape hatch only.

async function cmdDestroyForgotten(argv, opts = {}) {
  const flags = parseFlags(argv);
  const portal = await loadPortal(opts);

  if (!flags.noConfirm && !flags.json) {
    console.log('This will permanently delete ALL secrets in your vault.');
    console.log('The vault is zero-knowledge — no recovery is possible after this.');
    const ok = await confirm('Type "yes" to continue', { defaultYes: false });
    if (!ok) {
      console.log('Cancelled.');
      return 1;
    }
  }

  const res = await VaultApi.destroyVaultForgotten(portal);
  if (res?.ok) {
    emit(flags.json,
      { ok: true },
      'Vault destroyed. Run `mc vault setup` to create a fresh vault.',
    );
    return 0;
  }

  if (res?.code === 'OAUTH_STALE') {
    emit(flags.json,
      { ok: false, error: res.error, code: 'OAUTH_STALE' },
      [
        'Fresh authentication required.',
        '',
        'To destroy a vault when the master password is lost, the server',
        'needs proof that you just re-authenticated. Steps:',
        '',
        '  1. Run `mc auth logout`',
        '  2. Run any mc command (e.g. `mc auth status`) — it will reopen',
        '     the browser OAuth flow.',
        '  3. Within 5 minutes, run `mc vault destroy-forgotten` again.',
      ].join('\n'),
    );
    return 1;
  }

  emit(flags.json, { ok: false, error: res?.error || 'destroy failed' });
  return 1;
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

/**
 * §12f: get an unlocked vault-key, checking the OS-keychain cache first.
 *
 * Cache hit → use it directly (no PBKDF2, no server unlock — the
 * cache existence implies the user unlocked recently and we trust the
 * server's 15-min session window too).
 *
 * Cache miss → fall back to the phase-1 prompt flow: derive from
 * master password, server unlock, then cache for next time so the
 * second verb in a row doesn't re-prompt.
 *
 * Returns { vaultKey } on success, null on failure (after emitting an
 * error to the caller's emit channel).
 *
 * Test injection: opts.cacheDeps threads through to readCachedVaultKey
 * and cacheVaultKey.
 */
async function getUnlockedVaultKey({ portal, config, flags, opts }) {
  // 1. Cache hit?
  const cached = await readCachedVaultKey({ deps: opts.cacheDeps }).catch(() => null);
  if (cached) {
    return { vaultKey: cached.vaultKey };
  }

  if (!canPromptForVaultKey({ flags, opts })) {
    emit(flags.json, {
      ok: false,
      error: `vault locked; run \`mc vault unlock\` first, or set ${PASSPHRASE_ENV} for non-interactive use`,
    });
    return null;
  }

  // 2. Cache miss → prompt + derive + cache.
  const password = await readMasterPassword('Master password: ', opts);
  const { vaultKey, vaultKeyBytes, authHash } = await deriveVaultKeys(
    password, config.salt, config.iterations,
  );
  const unlock = await VaultApi.unlockVault(portal, { authHash });
  if (!unlock?.ok) {
    emit(flags.json, { ok: false, error: unlock?.error || 'unlock failed' });
    return null;
  }
  // Cache for the next call. Best-effort — failure here just means
  // the next verb will re-prompt.
  await cacheVaultKey(vaultKeyBytes, { deps: opts.cacheDeps });
  return { vaultKey };
}

function canPromptForVaultKey({ flags = {}, opts = {} } = {}) {
  if (typeof opts.promptStub === 'function') return true;
  if (process.env[PASSPHRASE_ENV]) return true;
  if (flags.json) return false;
  return process.stdin.isTTY === true;
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
 *   --dry-run
 *   --no-confirm
 *   --stdin
 *   --bind <ENV_KEY>
 *   --bind-file <path>
 *   --type <kind>
 *   --provider <name>
 *   --account <name>
 *   --target-tool <tool>
 *   --target-auth-mode <mode>
 *   --target-location <location>
 *   --scopes a,b,c
 *   --expires-at <iso>
 *   --field <name>
 */
function parseFlags(argv) {
  const out = {
    positional: [],
    json: false,
    dryRun: false,
    noConfirm: false,
    stdin: false,
    bind: null,
    bindFile: null,
    type: null,
    provider: null,
    account: null,
    targetTool: null,
    targetAuthMode: null,
    targetLocation: null,
    scopes: null,
    expiresAt: null,
    field: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-confirm') out.noConfirm = true;
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--bind') out.bind = argv[++i];
    else if (a === '--bind-file') out.bindFile = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--account') out.account = argv[++i];
    else if (a === '--target-tool') out.targetTool = argv[++i];
    else if (a === '--target-auth-mode') out.targetAuthMode = argv[++i];
    else if (a === '--target-location') out.targetLocation = argv[++i];
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
