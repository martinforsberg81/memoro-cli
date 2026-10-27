/**
 * The runner's record of subscription capacity (model-capacity.js).
 *
 * Three rules are pinned case by case: an absent or broken record is
 * unobserved, never zero usage; a window past its reset is expired, never zero;
 * and a failed observation keeps the snapshot before it and says it failed.
 * Claude's windows are read from a stream that ran anyway, and the record is
 * never the catalog's file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  STALE_MS, WINDOWS, applyFailure, applyObservation, applyRefusal, capacityPath, codexCandidateAt, normaliseCapacity,
  observeClaudeStream, providerAt, readCapacity, windowsAt, writeCapacity,
} from '../../src/mc/model-capacity.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'mc-capacity-'));
const NOW = new Date('2026-10-11T12:00:00Z');
const S = Math.floor(NOW.getTime() / 1000);
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const EMPTY = normaliseCapacity(null);

/** One `rate_limit_event` line as the claude stream carries it; a null window is absent from the stream. */
const streamLine = (five, seven) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { unifiedWindows: { five_hour: five, seven_day: seven } },
});

test('constants: the window names per provider and a three-hour staleness', () => {
  assert.deepEqual(WINDOWS.claude, ['five_hour', 'seven_day']);
  assert.deepEqual(WINDOWS.codex, ['primary', 'secondary']);
  assert.equal(STALE_MS, 3 * 60 * 60 * 1000);
});

test('an absent or broken file reads as unobserved, never as zero usage', () => {
  const root = fresh();
  for (const [label, contents] of [['absent', null], ['broken', '{ not json'], ['not an object', '[]']]) {
    if (contents !== null) writeFileSync(capacityPath(root), contents);
    const state = readCapacity({ root });
    assert.equal(state.providers.claude.observed_at, null, label);
    assert.equal(providerAt(state, 'codex', NOW).status, 'unobserved', label);
    assert.equal(windowsAt(state, 'claude', NOW).seven_day.status, 'unknown', label);
    assert.equal(windowsAt(state, 'claude', NOW).seven_day.fraction_used, null, label);
  }
});

test('writeCapacity writes whole at mode 0600 and leaves nothing beside the file', () => {
  const root = fresh();
  const state = applyObservation(EMPTY, 'codex', {
    windows: { primary: { fraction_used: 0.25, resets_at: at(3600).toISOString() }, secondary: null },
    models: [{ id: 'gpt-6.1-sol', efforts: ['medium'] }],
  }, NOW);
  assert.deepEqual(writeCapacity(state, { root }), state);
  assert.deepEqual(readCapacity({ root }), state);
  assert.equal(statSync(capacityPath(root)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ['model-capacity.json']);
  assert.equal(basename(capacityPath(root)), 'model-capacity.json');
  assert.equal(dirname(capacityPath(root)), root);
});

test('a malformed field reads as absent: a bad time makes the provider unobserved, a bad window drops alone', () => {
  const root = fresh();
  writeFileSync(capacityPath(root), JSON.stringify({ providers: { codex: { observed_at: 'yesterday', windows: { primary: { fraction_used: 0.1, resets_at: at(60).toISOString() } } } } }));
  assert.equal(providerAt(readCapacity({ root }), 'codex', NOW).status, 'unobserved');
  writeFileSync(capacityPath(root), JSON.stringify({ providers: { codex: {
    observed_at: NOW.toISOString(),
    windows: { primary: { fraction_used: 'lots', resets_at: at(60).toISOString() }, secondary: { fraction_used: 0.4, resets_at: at(600).toISOString() } },
  } } }));
  const windows = windowsAt(readCapacity({ root }), 'codex', NOW);
  assert.equal(windows.primary.status, 'unknown');
  assert.equal(windows.secondary.fraction_used, 0.4);
});

test('observeClaudeStream reads the plan windows as fractions and keeps a window the stream omits', () => {
  const first = observeClaudeStream(EMPTY, streamLine(
    { utilization: 0.08, resetsAt: S + 3600 },
    { utilization: 0.59, resetsAt: S + 400000 },
  ), NOW);
  assert.equal(first.providers.claude.windows.five_hour.fraction_used, 0.08);
  assert.equal(first.providers.claude.windows.seven_day.fraction_used, 0.59);
  assert.equal(first.providers.claude.observed_at, NOW.toISOString());

  const later = at(600);
  const second = observeClaudeStream(first, streamLine(null, { utilization: 0.61, resetsAt: S + 400000 }), later);
  assert.equal(second.providers.claude.windows.five_hour.fraction_used, 0.08, 'five_hour kept');
  assert.equal(second.providers.claude.windows.seven_day.fraction_used, 0.61);
  assert.equal(second.providers.claude.observed_at, later.toISOString());
});

test('observeClaudeStream changes nothing when the stream carries no windows, and passes over broken lines', () => {
  const seen = observeClaudeStream(EMPTY, streamLine({ utilization: 0.08, resetsAt: S + 3600 }, null), NOW);
  const unchanged = observeClaudeStream(seen, 'not a stream\n{"type":"assistant"}\n{"type":"rate_limit_event"', at(60));
  assert.deepEqual(unchanged, seen);
  assert.deepEqual(observeClaudeStream(EMPTY, '', NOW), EMPTY);
});

test('windowsAt: a window past its reset is expired and carries no usage; a window never seen is unknown', () => {
  const state = applyObservation(EMPTY, 'claude', {
    windows: { five_hour: null, seven_day: { fraction_used: 0.9, resets_at: at(3600).toISOString() } },
    models: null,
  }, NOW);
  assert.deepEqual(windowsAt(state, 'claude', NOW).seven_day, { status: 'known', fraction_used: 0.9, resets_at: at(3600).toISOString() });
  assert.deepEqual(windowsAt(state, 'claude', at(7200)).seven_day, { status: 'expired', fraction_used: null, resets_at: at(3600).toISOString() });
  assert.deepEqual(windowsAt(state, 'claude', NOW).five_hour, { status: 'unknown', fraction_used: null, resets_at: null });
});

test('providerAt: a snapshot is stale after three hours, and a failed try is marked while the snapshot stays', () => {
  const base = applyObservation(EMPTY, 'codex', {
    windows: { primary: { fraction_used: 0.2, resets_at: at(STALE_MS / 1000 * 3).toISOString() }, secondary: null },
    models: [],
  }, NOW);
  assert.equal(providerAt(base, 'codex', NOW).status, 'observed');
  const stale = providerAt(base, 'codex', at(STALE_MS / 1000 + 1));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.windows.primary.fraction_used, 0.2, 'stale keeps the snapshot, flagged');

  const failed = applyFailure(base, 'codex', { why: 'timed out after 20 s' }, at(60));
  const standing = providerAt(failed, 'codex', at(60));
  assert.equal(standing.status, 'failed');
  assert.equal(standing.failure.why, 'timed out after 20 s');
  assert.equal(standing.windows.primary.fraction_used, 0.2, 'failed keeps the last valid snapshot');
  assert.equal(standing.observed_at, NOW.toISOString());

  const recovered = applyObservation(failed, 'codex', { windows: { primary: null, secondary: null }, models: [] }, at(120));
  assert.equal(providerAt(recovered, 'codex', at(120)).status, 'observed');
  assert.equal(providerAt(recovered, 'codex', at(120)).failure, null);
});

test('applyRefusal: a refusal reads until its instant and clears when set to null', () => {
  const refused = applyRefusal(EMPTY, 'claude', at(3600).toISOString());
  assert.equal(providerAt(refused, 'claude', NOW).refusal_until, at(3600).toISOString());
  assert.equal(providerAt(refused, 'claude', at(7200)).refusal_until, null);
  assert.equal(providerAt(applyRefusal(refused, 'claude', null), 'claude', NOW).refusal_until, null);
});

test('codexCandidateAt: available only when the current model list holds the model at that effort', () => {
  const listed = applyObservation(EMPTY, 'codex', {
    windows: { primary: null, secondary: null },
    models: [{ id: 'gpt-6.1-sol', efforts: ['medium', 'high'] }],
  }, NOW);
  assert.deepEqual(codexCandidateAt(listed, { model: 'gpt-6.1-sol', effort: 'high' }, NOW), {
    available: true, why: 'gpt-6.1-sol at high is in the codex model list',
  });
  assert.equal(codexCandidateAt(listed, { model: 'gpt-6-luna', effort: 'high' }, NOW).why, 'gpt-6-luna is not in the codex model list');
  assert.equal(codexCandidateAt(listed, { model: 'gpt-6.1-sol', effort: 'low' }, NOW).why, 'gpt-6.1-sol does not offer effort low');
});

test('codexCandidateAt: never observed, unread, failed or stale is unavailable, never guessed', () => {
  const candidate = { model: 'gpt-6.1-sol', effort: 'high' };
  assert.equal(codexCandidateAt(EMPTY, candidate, NOW).available, false);
  assert.equal(codexCandidateAt(EMPTY, candidate, NOW).why, 'codex is unobserved');

  const unread = applyObservation(EMPTY, 'codex', { windows: { primary: null, secondary: null }, models: null }, NOW);
  assert.equal(codexCandidateAt(unread, candidate, NOW).why, 'codex model/list was not read');

  const listed = applyObservation(EMPTY, 'codex', { windows: { primary: null, secondary: null }, models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }] }, NOW);
  const failed = applyFailure(listed, 'codex', { why: 'model/list did not answer' }, at(60));
  assert.deepEqual(codexCandidateAt(failed, candidate, at(60)), {
    available: false, why: 'the last codex poll failed: model/list did not answer',
  });
  assert.equal(codexCandidateAt(listed, candidate, at(STALE_MS / 1000 + 1)).why, 'codex is stale');
});
