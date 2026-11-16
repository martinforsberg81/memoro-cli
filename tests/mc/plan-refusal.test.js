/**
 * What a plan refusal writes (plan-refusal.js): agy's quota refuses the model
 * that was refused until the reset it names, never the provider; claude's and
 * codex's quota and a login refusal still refuse the provider. The agy text is
 * the one recorded on 2026-11-16 (nine Argon reviews, 'Resets in 149h56m21s').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireCapability } from '../../src/adapters/index.js';
import { applyObservation, capacityPath, readCapacity } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { chooseCandidate } from '../../src/mc/model-choice.js';
import { runnerDir } from '../../src/mc/paths.js';
import { refusePlanOnRead } from '../../src/mc/plan-refusal.js';
import { QUOTA_SLEEP_MS, readSessionOutput } from '../../src/mc/run-plan.js';

const NOW = new Date('2026-11-16T13:31:00Z');
const RECORDED = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 149h56m21s.';
const RESET = new Date(NOW.getTime() + ((149 * 60 + 56) * 60 + 21) * 1000).toISOString();
const ARGON = { tool: 'agy', model: 'gemini-4-argon-high', effort: 'high' };
const FLASH = { tool: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' };
const OPUS = { tool: 'claude', model: 'opus', effort: 'high' };
const AGY = { id: 'antigravity-cli' };
const win = (fraction_used) => ({ fraction_used, resets_at: '2026-11-20T00:00:00.000Z' });

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-refusal-'));
  const env = { MC_WORK_ROOT: root };
  mkdirSync(runnerDir(env), { recursive: true });
  return { env, stored: () => readCapacity({ root: runnerDir(env) }), file: () => JSON.parse(readFileSync(capacityPath(runnerDir(env)), 'utf8')), done: () => rmSync(root, { recursive: true, force: true }) };
};
const agyQuota = (model) => readSessionOutput({ toolId: AGY.id, stdout: '', stderr: RECORDED, exitCode: 1, now: NOW, model });

test('an agy quota read is written as its model\'s refusal until the reset it names, and review passes that model by', () => {
  const w = workspace();
  try {
    const read = agyQuota(ARGON.model);
    assert.equal(read.quota, true);
    assert.equal(read.quotaReset.toISOString(), RESET);
    const said = [];
    const written = refusePlanOnRead({ read, launch: AGY, model: ARGON.model, billing: 'plan', env: w.env, now: NOW, say: (text) => said.push(text) });
    assert.deepEqual(written, { provider: 'agy', model: ARGON.model, until: RESET });
    assert.match(said[0], /agy:gemini-4-argon-high refused until/u);
    const stored = w.stored().providers.agy;
    assert.equal(stored.refusal_until, null, 'the provider is not refused');
    assert.deepEqual(stored.model_refusals, { [ARGON.model]: RESET });

    // The plan's windows are known and roomy, as agy's usage read had them on 2026-11-16.
    let capacity = applyObservation(w.stored(), 'agy', { windows: { five_hour: win(0.57), weekly: win(0.16) } }, NOW);
    capacity = applyObservation(capacity, 'claude', { windows: { five_hour: win(0.9), seven_day: win(0.9) } }, NOW);
    const review = (list) => chooseCandidate({ cls: 'review', catalog: { ...DEFAULT_CATALOG, review: list }, capacity, now: NOW });
    assert.equal(review([ARGON, OPUS]).spec, 'claude:opus:high', 'Argon is passed by');
    assert.equal(review([ARGON, FLASH, OPUS]).spec, 'agy:gemini-3.8-flash-high:high', 'another agy model stays eligible');
    const only = review([ARGON]);
    assert.equal(only.ok, false, 'a spent model with no other candidate waits, and is not sent to an API key');
    assert.equal(only.retry_at, RESET);
    assert.match(only.reason, /agy:gemini-4-argon-high refused until/u);
    const later = new Date(Date.parse(RESET) + 1000);
    assert.equal(chooseCandidate({ cls: 'review', catalog: { ...DEFAULT_CATALOG, review: [ARGON, OPUS] }, capacity, now: later }).spec, 'agy:gemini-4-argon-high:high', 'a passed instant holds nothing');

  } finally { w.done(); }
});

test('an agy quota that names no reset refuses the model for the quota sleep, and one with no model is written provider-wide', () => {
  const w = workspace();
  try {
    const read = { quota: true, quotaReset: null };
    refusePlanOnRead({ read, launch: AGY, model: FLASH.model, billing: 'plan', env: w.env, now: NOW });
    assert.deepEqual(w.stored().providers.agy.model_refusals, { [FLASH.model]: new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString() });
    assert.equal(w.stored().providers.agy.refusal_until, null);
    refusePlanOnRead({ read, launch: AGY, billing: 'plan', env: w.env, now: NOW });
    assert.equal(w.stored().providers.agy.refusal_until, new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString());
  } finally { w.done(); }
});

test('a claude or codex quota still refuses the whole provider and writes no model refusal', () => {
  const w = workspace();
  try {
    const until = new Date(NOW.getTime() + 3 * 3600_000);
    for (const [launch, provider] of [[{ id: 'claude-code' }, 'claude'], [{ id: 'codex' }, 'codex']]) {
      const written = refusePlanOnRead({ read: { quota: true, quotaReset: until }, launch, model: 'some-model', billing: 'plan', env: w.env, now: NOW });
      assert.deepEqual(written, { provider, model: null, until: until.toISOString() });
      assert.equal(w.stored().providers[provider].refusal_until, until.toISOString());
      assert.deepEqual(w.stored().providers[provider].model_refusals, {});
    }
    refusePlanOnRead({ read: { quota: true, quotaReset: null }, launch: { id: 'codex' }, model: 'some-model', billing: 'plan', env: w.env, now: new Date(NOW.getTime() + 4 * 3600_000) });
    assert.equal(w.stored().providers.codex.refusal_until, new Date(NOW.getTime() + 4 * 3600_000 + QUOTA_SLEEP_MS).toISOString(), 'no reset named: the quota sleep');
  } finally { w.done(); }
});

test('a login refusal on agy refuses the provider, an API-billed refusal writes nothing, and the file stays readable without model_refusals', () => {
  const w = workspace();
  try {
    assert.equal(refusePlanOnRead({ read: { quota: false, interrupted: 'login' }, launch: AGY, model: ARGON.model, billing: 'credits', env: w.env, now: NOW }), null);
    assert.equal(w.stored().providers.agy.refusal_until, null);
    refusePlanOnRead({ read: { quota: false, interrupted: 'login' }, launch: AGY, model: ARGON.model, billing: 'plan', env: w.env, now: NOW });
    assert.equal(w.stored().providers.agy.refusal_until, new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString());
    assert.deepEqual(w.stored().providers.agy.model_refusals, {});
    const raw = w.file();
    delete raw.providers.agy.model_refusals;
    writeFileSync(capacityPath(runnerDir(w.env)), JSON.stringify(raw));
    assert.deepEqual(readCapacity({ root: runnerDir(w.env) }).providers.agy.model_refusals, {});
  } finally { w.done(); }
});

test('a quota read of a tool that declares no QUOTA_SCOPE is refused, naming the tool and the capability', () => {
  assert.equal(requireCapability('antigravity-cli', 'QUOTA_SCOPE'), 'model');
  assert.throws(() => refusePlanOnRead({ read: { quota: true }, launch: { id: 'cursor' }, model: 'm', billing: 'plan', now: NOW, write: () => {} }), /cursor.*QUOTA_SCOPE|QUOTA_SCOPE.*cursor/u);
});
