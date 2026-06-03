/**
 * Tests for the pre-launch vault unlock grind (src/mc/vault/unlock-grind.js).
 *
 * Strategy: the decision core `runUnlockGrind` takes ALL side-effects as
 * injected deps (vaultState / promptConfirm / promptPassword / unlock /
 * materialise / log). Every branch is driven deterministically here without
 * touching the real keychain, crypto, network, or stdin.
 *
 * Per the protocol (PR #48): we assert on the HUMAN-READABLE path too — the
 * lines the user actually sees in each branch via `log` — not just the
 * returned reason string.
 *
 * Covered branches:
 *   - vault not configured          → no prompt, launch normal (silent)
 *   - already unlocked (cache/env)  → no prompt, materialise, connected
 *   - locked → decline              → no password prompt, degraded + explicit line
 *   - locked → accept → good pw     → unlock + materialise, connected
 *   - locked → bad pw → retry → good→ eventually unlocked
 *   - locked → bad pw → abort       → degraded, no further prompts
 *   - locked → bad pw × max         → degraded, out-of-attempts line
 *   - unlock throws                 → treated as bad pw (no crash)
 *   - materialise hint surfaced     → hint reaches the log
 *   - vaultState throws             → soft-degrade to not-configured
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runUnlockGrind,
  defaultGrindDeps,
  ensureVaultUnlockedForLaunch,
} from '../../../src/mc/vault/unlock-grind.js';

/**
 * Build a deps object with recordable I/O. Each prompt/unlock can be a
 * value or a queue (array) consumed in order, so a single test can script a
 * multi-attempt password flow.
 */
function makeDeps({
  state = { configured: true, unlocked: false },
  confirmAnswers = [true],     // queue of booleans for promptConfirm
  passwords = ['pw'],          // queue of strings for promptPassword
  unlockResults = [{ ok: true }], // queue of { ok, error? } OR a function
  materialiseResult = { ok: true, materialised: [] },
  maxPasswordAttempts,
} = {}) {
  const calls = { confirm: [], password: [], unlock: [], materialise: [], log: [] };
  const confirmQ = [...confirmAnswers];
  const pwQ = [...passwords];
  const unlockQ = Array.isArray(unlockResults) ? [...unlockResults] : unlockResults;

  const deps = {
    async vaultState() {
      if (typeof state === 'function') return state();
      return state;
    },
    async promptConfirm(q) {
      calls.confirm.push(q);
      return confirmQ.length ? confirmQ.shift() : false;
    },
    async promptPassword(q) {
      calls.password.push(q);
      return pwQ.length ? pwQ.shift() : '';
    },
    async unlock(pw) {
      calls.unlock.push(pw);
      if (typeof unlockQ === 'function') return unlockQ(pw);
      const r = unlockQ.length ? unlockQ.shift() : { ok: false, error: 'wrong password' };
      if (r instanceof Error) throw r;
      return r;
    },
    async materialise(arg) {
      calls.materialise.push(arg);
      return typeof materialiseResult === 'function' ? materialiseResult(arg) : materialiseResult;
    },
    log(line) { calls.log.push(line); },
  };
  if (maxPasswordAttempts != null) deps.maxPasswordAttempts = maxPasswordAttempts;
  return { deps, calls };
}

const logText = (calls) => calls.log.join('\n');

describe('runUnlockGrind', () => {
  it('vault not configured → no prompts, launch normal, silent', async () => {
    const { deps, calls } = makeDeps({ state: { configured: false, unlocked: false } });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'not-configured');
    assert.equal(r.materialised, null);
    assert.equal(calls.confirm.length, 0, 'must not prompt when no vault');
    assert.equal(calls.password.length, 0);
    assert.equal(calls.materialise.length, 0);
    assert.equal(calls.log.length, 0, 'no nag when there is nothing to unlock');
  });

  it('already unlocked → no prompt, materialises, connected', async () => {
    const { deps, calls } = makeDeps({ state: { configured: true, unlocked: true } });
    const r = await runUnlockGrind({ sessionId: 's', worktreePath: '/wt', deps });
    assert.equal(r.reason, 'already-unlocked');
    assert.equal(calls.confirm.length, 0, 'no confirm — already have a key');
    assert.equal(calls.password.length, 0);
    assert.deepEqual(calls.materialise[0], { sessionId: 's', worktreePath: '/wt' });
  });

  it('locked → user declines → degraded launch as an explicit choice', async () => {
    const { deps, calls } = makeDeps({ confirmAnswers: [false] });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'declined');
    assert.equal(r.materialised, null);
    assert.match(calls.confirm[0], /locked.*unlock now/i, 'asks the documented question');
    assert.equal(calls.password.length, 0, 'no password prompt after decline');
    assert.equal(calls.materialise.length, 0, 'no materialise when declined');
    // Human-readable path: the user is told they are degraded + how to fix.
    assert.match(logText(calls), /without vault tokens/i);
    assert.match(logText(calls), /mc vault unlock/);
  });

  it('locked → accept → correct password → unlock + materialise, connected', async () => {
    const { deps, calls } = makeDeps({
      confirmAnswers: [true],
      passwords: ['correcthorse'],
      unlockResults: [{ ok: true }],
    });
    const r = await runUnlockGrind({ sessionId: 'sess', worktreePath: '/w', deps });
    assert.equal(r.reason, 'unlocked');
    assert.equal(calls.unlock[0], 'correcthorse');
    assert.deepEqual(calls.materialise[0], { sessionId: 'sess', worktreePath: '/w' });
  });

  it('locked → bad password → retry → correct password → unlocked', async () => {
    const { deps, calls } = makeDeps({
      confirmAnswers: [true, true],          // unlock-now? yes ; retry? yes
      passwords: ['wrong', 'right'],
      unlockResults: [{ ok: false, error: 'wrong password' }, { ok: true }],
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'unlocked');
    assert.equal(calls.password.length, 2, 'prompted twice');
    assert.equal(calls.materialise.length, 1);
    // The user is told the password was wrong with attempts remaining.
    assert.match(logText(calls), /wrong password.*attempt/i);
  });

  it('locked → bad password → user abandons retry → degraded', async () => {
    const { deps, calls } = makeDeps({
      confirmAnswers: [true, false],         // unlock-now? yes ; retry? no
      passwords: ['wrong'],
      unlockResults: [{ ok: false, error: 'wrong password' }],
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'aborted');
    assert.equal(r.materialised, null);
    assert.equal(calls.password.length, 1);
    assert.equal(calls.materialise.length, 0);
    assert.match(logText(calls), /without vault tokens/i);
  });

  it('locked → wrong password every attempt → degraded after max attempts', async () => {
    const { deps, calls } = makeDeps({
      confirmAnswers: [true, true, true],    // unlock-now? + 2 retries
      passwords: ['a', 'b', 'c'],
      unlockResults: [
        { ok: false, error: 'wrong password' },
        { ok: false, error: 'wrong password' },
        { ok: false, error: 'wrong password' },
      ],
      maxPasswordAttempts: 3,
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'unlock-error');
    assert.equal(calls.password.length, 3, 'tried exactly max attempts');
    assert.equal(calls.materialise.length, 0);
    assert.match(logText(calls), /out of attempts/i);
    assert.match(logText(calls), /mc vault unlock/);
  });

  it('unlock that throws is treated as a failed attempt, never crashes', async () => {
    const { deps, calls } = makeDeps({
      confirmAnswers: [true, false],         // unlock-now? yes ; retry? no
      passwords: ['boom'],
      unlockResults: [new Error('keychain exploded')],
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'aborted');
    // The thrown message is surfaced to the user, not swallowed.
    assert.match(logText(calls), /keychain exploded/);
  });

  it('materialise hint after unlock is surfaced to the user', async () => {
    const { deps, calls } = makeDeps({
      state: { configured: true, unlocked: true },
      materialiseResult: { ok: false, hint: 'no matching secret for claude' },
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'already-unlocked');
    assert.match(logText(calls), /no matching secret for claude/);
  });

  it('materialise that throws does not crash the grind', async () => {
    const { deps, calls } = makeDeps({
      state: { configured: true, unlocked: true },
      materialiseResult: () => { throw new Error('disk full'); },
    });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'already-unlocked');
    assert.equal(r.materialised, null);
    assert.match(logText(calls), /materialise failed.*disk full/i);
  });

  it('vaultState that throws soft-degrades to not-configured (launch normal)', async () => {
    const { deps, calls } = makeDeps({ state: () => { throw new Error('network down'); } });
    const r = await runUnlockGrind({ sessionId: 's', deps });
    assert.equal(r.reason, 'not-configured');
    assert.equal(calls.confirm.length, 0);
  });

  it('throws if deps are missing (programmer error, not a runtime path)', async () => {
    await assert.rejects(() => runUnlockGrind({ sessionId: 's' }), /deps required/);
  });
});

describe('defaultGrindDeps (production wiring smoke test)', () => {
  // Importing smoke test (per the agent-coordination anti-patterns): the
  // production wiring is dynamically imported at runtime, so a typo in those
  // imports would never surface in the decision-core tests. Build the deps
  // and assert the contract shape WITHOUT invoking real I/O.
  it('builds a deps object with the full grind contract', async () => {
    const deps = await defaultGrindDeps();
    for (const fn of ['vaultState', 'promptConfirm', 'promptPassword', 'unlock', 'materialise', 'log']) {
      assert.equal(typeof deps[fn], 'function', `deps.${fn} must be a function`);
    }
  });

  it('exports the one-call entry callers use', () => {
    assert.equal(typeof ensureVaultUnlockedForLaunch, 'function');
  });
});
