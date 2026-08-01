/**
 * Managed-session vault startup.
 *
 * Vault plaintext must never cross into an LLM-controlled process, file, or
 * environment. Managed launches therefore do not unlock or materialise the
 * vault. Provider use is added back only through credential-blind typed
 * capabilities backed by an isolated executor.
 */

export async function materialiseVaultBeforeLaunch({
  sessionId,
  worktreePath,
  adapters,
  deps = {},
} = {}) {
  return {
    ok: true,
    policy: 'credential-blind-v1',
    materialised: [],
    skipped: [{ reason: 'plaintext-materialisation-disabled' }],
  };
}

export function shouldOfferUnlock(result, { env = process.env, stdin = process.stdin } = {}) {
  return false;
}

export async function defaultPromptUnlock({ question, stdin = process.stdin, output = process.stderr } = {}) {
  return false;
}
