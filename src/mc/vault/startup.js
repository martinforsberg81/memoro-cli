/**
 * Vault startup UX for `mc new` / `mc resume`.
 *
 * The lifecycle still soft-degrades: a locked vault never blocks a coding
 * session. On an interactive TTY we offer one inline unlock attempt before
 * launching the tool, then retry materialisation.
 */
import { createInterface } from 'node:readline/promises';

import { run as runVault } from '../commands/vault.js';
import { materialiseForSession } from './lifecycle.js';

export async function materialiseVaultBeforeLaunch({
  sessionId,
  worktreePath,
  adapters,
  deps = {},
} = {}) {
  const materialise = deps.materialiseForSession || materialiseForSession;
  const unlock = deps.unlockVault || (() => runVault(['unlock']));
  const promptUnlock = deps.promptUnlock || defaultPromptUnlock;
  const env = deps.env || process.env;
  const stdin = deps.stdin || process.stdin;
  const stderr = deps.stderr || process.stderr;

  const first = await materialise({ sessionId, worktreePath, adapters });
  if (!shouldOfferUnlock(first, { env, stdin })) return first;

  const yes = await promptUnlock({
    question: 'mc: vault is locked. Unlock before starting this session? [y/N] ',
    stdin,
    output: stderr,
  });
  if (!yes) return first;

  const rc = await unlock();
  if (rc !== 0) {
    return {
      ...first,
      unlockAttempted: true,
      hint: `vault unlock failed; ${first.hint || `run \`mc vault unlock\` then \`mc open ${sessionId}\``}`,
    };
  }

  const second = await materialise({ sessionId, worktreePath, adapters });
  return { ...second, unlockAttempted: true };
}

export function shouldOfferUnlock(result, { env = process.env, stdin = process.stdin } = {}) {
  if (!result || result.ok || result.reason !== 'vault-locked') return false;
  if (env.MC_TEST_MODE === '1') return false;
  return !!stdin?.isTTY;
}

export async function defaultPromptUnlock({ question, stdin = process.stdin, output = process.stderr } = {}) {
  if (!stdin?.isTTY) return false;
  const rl = createInterface({ input: stdin, output });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(String(answer || '').trim());
  } finally {
    rl.close();
  }
}
