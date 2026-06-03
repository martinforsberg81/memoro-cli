/**
 * Pre-launch vault unlock grind (pre-launch slot).
 *
 * Problem this solves: `mc new` / `mc resume` / bare `mc` launch the tool
 * session at a pre-launch slot that calls `materialiseForSession`. If the
 * vault is LOCKED, the old behaviour printed a one-line hint and launched
 * anyway WITHOUT materialised tokens. A session that never materialises its
 * bearer-token can't connect to the coordinator WS channel — it becomes
 * invisible and can't do Memoro work. The user then has to kill the
 * session, run `mc vault unlock`, and start over. Pre-launch is the ONLY
 * place to fix this without a restart.
 *
 * The grind: BEFORE the tool spawns, if the vault is configured AND locked,
 * ASK the user to unlock now ("Vault is locked — unlock now? [Y/n]"), read
 * the master password (reusing the existing hidden prompt), unlock,
 * materialise, and THEN continue to launch — so the session starts
 * CONNECTED. If the user declines, launch in degraded mode as an EXPLICIT
 * choice (not a silent default).
 *
 * Design constraints honoured here:
 *   - ALL side-effects injectable (Pattern 4): vaultState / promptConfirm /
 *     promptPassword / unlock / materialise / log. Tests drive every branch
 *     deterministically without touching keychain/crypto/stdin.
 *   - Exit-before-side-effect (Pattern 3): no half-launch. A wrong password
 *     offers retry, never crashes. On exhausted retries the user CHOOSES
 *     degrade or abort. We never throw mid-flow.
 *   - Vault crypto / storage / materialiseForSession internals are reused
 *     untouched — this module only orchestrates the existing API.
 *
 * The default I/O bindings live in `defaultGrindDeps()` so the two call
 * sites (`mc new`, bare `mc` / `runWrap`) share ONE wiring. The decision
 * core `runUnlockGrind` is pure w.r.t. injected deps.
 *
 * Outcome reasons (stable strings — tests + callers branch on these):
 *   - 'not-configured'   vault never set up → nothing to unlock, launch normal
 *   - 'already-unlocked' cache/env key present → materialised, launch connected
 *   - 'unlocked'         user unlocked now → materialised, launch connected
 *   - 'declined'         user said no to the prompt → degraded launch (explicit)
 *   - 'aborted'          user gave up after a bad password → degraded launch
 *   - 'unlock-error'     out of attempts / unexpected error → degraded launch
 *
 * Every outcome is non-fatal: the caller ALWAYS proceeds to launch. The
 * difference is whether tokens are materialised (connected) or not
 * (degraded). `materialised` carries the materialiseForSession result when
 * one ran, else null.
 */

const DEFAULT_MAX_PASSWORD_ATTEMPTS = 3;

/**
 * Run the pre-launch unlock grind.
 *
 * @param {object} arg
 * @param {string}  arg.sessionId          registry entry name / session id
 * @param {string} [arg.worktreePath]      worktree dir (threaded to materialise)
 * @param {object}  arg.deps               injected portals (see defaultGrindDeps)
 *
 * deps shape:
 *   - vaultState():        Promise<{ configured: boolean, unlocked: boolean }>
 *       Reports whether a vault exists for this account and whether a usable
 *       key is already available (cache hit or MC_VAULT_PASSPHRASE).
 *   - promptConfirm(q):    Promise<boolean>   default-Y confirmation
 *   - promptPassword(q):   Promise<string>    hidden master-password prompt
 *   - unlock(password):    Promise<{ ok: boolean, error?: string }>
 *       Derive + server-unlock + cache the key. Returns { ok: false } on a
 *       bad password rather than throwing.
 *   - materialise({sessionId, worktreePath}): Promise<{ ok, hint?, ... }>
 *   - log(line):           void               human-readable status to stderr
 *   - maxPasswordAttempts: number (default 3)
 *
 * @returns {Promise<{ reason: string, materialised: object|null }>}
 */
export async function runUnlockGrind({ sessionId, worktreePath, deps } = {}) {
  if (!deps) throw new Error('runUnlockGrind: deps required');
  const {
    vaultState,
    promptConfirm,
    promptPassword,
    unlock,
    materialise,
    log = () => {},
    maxPasswordAttempts = DEFAULT_MAX_PASSWORD_ATTEMPTS,
  } = deps;

  const state = await vaultState().catch(() => ({ configured: false, unlocked: false }));

  // No vault configured → nothing to unlock. Launch as usual; materialise
  // would only no-op. Stay silent (don't nag users without a vault).
  if (!state?.configured) {
    return { reason: 'not-configured', materialised: null };
  }

  // Already have a usable key (cache hit or env passphrase) → just
  // materialise and launch connected. No prompt — the user already unlocked.
  if (state.unlocked) {
    const m = await runMaterialise({ materialise, sessionId, worktreePath, log });
    return { reason: 'already-unlocked', materialised: m };
  }

  // Vault is configured but LOCKED. Ask before doing anything (never a
  // silent auto-unlock). Default Y — the user almost always wants tokens.
  const wantsUnlock = await promptConfirm('Vault is locked — unlock now?');
  if (!wantsUnlock) {
    log('mc: launching without vault tokens (you declined unlock). Session may not connect to the coordinator channel; run `mc vault unlock` then `mc resume` to reconnect.');
    return { reason: 'declined', materialised: null };
  }

  // Password loop. Wrong password → retry, never crash. On exhausted
  // attempts, let the user choose: degrade or abort. Either way we proceed
  // to launch (degraded) — exit-before-side-effect means we never leave a
  // half-unlocked state.
  let attempts = 0;
  while (attempts < maxPasswordAttempts) {
    attempts += 1;
    const password = await promptPassword('Master password: ');
    let res;
    try {
      res = await unlock(password);
    } catch (err) {
      // Defensive: unlock should soft-degrade, but if it throws we treat it
      // as a non-fatal failure and offer the same retry choice.
      res = { ok: false, error: err?.message || 'unlock error' };
    }
    if (res?.ok) {
      const m = await runMaterialise({ materialise, sessionId, worktreePath, log });
      return { reason: 'unlocked', materialised: m };
    }

    const remaining = maxPasswordAttempts - attempts;
    if (remaining > 0) {
      log(`mc: ${res?.error || 'wrong password'} — ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
      const retry = await promptConfirm('Try the master password again?');
      if (!retry) {
        log('mc: launching without vault tokens (unlock abandoned). Run `mc vault unlock` then `mc resume` to reconnect.');
        return { reason: 'aborted', materialised: null };
      }
      continue;
    }

    // Out of attempts.
    log(`mc: ${res?.error || 'wrong password'} — out of attempts; launching without vault tokens. Run \`mc vault unlock\` then \`mc resume\` to reconnect.`);
    return { reason: 'unlock-error', materialised: null };
  }

  // Unreachable (loop always returns), but keep the contract total.
  return { reason: 'unlock-error', materialised: null };
}

/**
 * Run materialiseForSession and surface any hint as a human line. Returns
 * the raw result (or null on throw). Kept tiny + shared so the
 * already-unlocked and just-unlocked branches behave identically.
 */
async function runMaterialise({ materialise, sessionId, worktreePath, log }) {
  try {
    const res = await materialise({ sessionId, worktreePath });
    if (res && res.ok === false && res.hint) {
      log(`mc: ${res.hint}`);
    }
    return res ?? null;
  } catch (err) {
    log(`mc: vault materialise failed (${err?.message || 'unknown'}); continuing without tokens`);
    return null;
  }
}

/**
 * Production wiring of the grind's injected portals. Binds the real vault
 * status probe, the existing hidden-password prompt, the real unlock
 * (derive → server unlock → cache), and materialiseForSession. Both call
 * sites (`mc new`, bare `mc`) use this so behaviour is identical.
 *
 * Soft-degrade everywhere: a probe failure reports "not configured" rather
 * than blocking the launch.
 */
export async function defaultGrindDeps() {
  const [
    { loadDefaultPortal, materialiseForSession, resolveVaultKeyForLifecycle },
    VaultApi,
    { deriveVaultKeys },
    { cacheVaultKey },
    { confirm, promptSecret },
  ] = await Promise.all([
    import('./lifecycle.js'),
    import('./api.js'),
    import('./client-crypto.js'),
    import('./key-cache.js'),
    import('../../lib/prompt.js'),
  ]);

  // Cache the portal so vaultState + unlock + materialise share one.
  let portalPromise = null;
  const getPortal = () => {
    if (!portalPromise) portalPromise = loadDefaultPortal();
    return portalPromise;
  };

  return {
    async vaultState() {
      const portal = await getPortal();
      if (!portal) return { configured: false, unlocked: false };
      const status = await VaultApi.getStatus(portal).catch(() => null);
      const configured = !!status?.vault?.setup;
      if (!configured) return { configured: false, unlocked: false };
      // "unlocked" for grind purposes = a usable key is already available
      // (keychain cache hit or MC_VAULT_PASSPHRASE) so materialise will
      // succeed without prompting. We DON'T trust the server-side unlocked
      // flag alone — without a local key, materialise still can't decrypt.
      const resolved = await resolveVaultKeyForLifecycle({ portal }).catch(() => null);
      return { configured: true, unlocked: !!resolved };
    },

    promptConfirm(question) {
      return confirm(question, { defaultYes: true });
    },

    promptPassword(question) {
      return promptSecret(question);
    },

    async unlock(password) {
      const portal = await getPortal();
      if (!portal) return { ok: false, error: 'no Memoro token' };
      const status = await VaultApi.getStatus(portal).catch(() => null);
      if (!status?.vault?.setup) return { ok: false, error: 'vault not set up' };
      const salt = status.vault.salt;
      const iterations = status.vault.iterations || 600_000;
      let authHash, vaultKeyBytes;
      try {
        ({ authHash, vaultKeyBytes } = await deriveVaultKeys(password, salt, iterations));
      } catch (err) {
        return { ok: false, error: err?.message || 'key derivation failed' };
      }
      const res = await VaultApi.unlockVault(portal, { authHash })
        .catch((err) => ({ ok: false, error: err?.message }));
      if (!res?.ok) return { ok: false, error: res?.error || 'wrong password' };
      // Cache the derived key so materialise (and later mc verbs) don't
      // re-prompt. Best-effort — a cache miss just means a re-prompt later.
      await cacheVaultKey(vaultKeyBytes).catch(() => {});
      return { ok: true };
    },

    materialise({ sessionId, worktreePath }) {
      return materialiseForSession({ sessionId, worktreePath });
    },

    log(line) {
      process.stderr.write(line.endsWith('\n') ? line : line + '\n');
    },
  };
}

/**
 * One-call entry the call sites use: build default deps (unless injected)
 * and run the grind. Keeps `mc new` / `runWrap` to a single line.
 */
export async function ensureVaultUnlockedForLaunch({ sessionId, worktreePath, deps } = {}) {
  const grindDeps = deps || await defaultGrindDeps();
  return runUnlockGrind({ sessionId, worktreePath, deps: grindDeps });
}
