import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autonomousModelIdentity, independentModel, chooseAutonomousModel } from '../../src/mc/autonomous-models.js';
import { chooseCandidate } from '../../src/mc/model-choice.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { normaliseCapacity, applyRefusal, applyObservation } from '../../src/mc/model-capacity.js';
import { createRunner } from '../../src/mc/run.js';
import { runnerFixture } from './autonomous-run-fixture.js';
const now = new Date('2026-10-28T12:00:00Z');
const builder = DEFAULT_CATALOG.fast[0];
const reviewer = DEFAULT_CATALOG.review;
const history = { runs: [{ run_id: 'build-1', role: 'step' }], model_history: [{ run_id: 'build-1', model: builder, goal_revision: 1 }] };
const choose = overrides => chooseAutonomousModel({ state: history, role: 'review', catalog: DEFAULT_CATALOG, capacity: normaliseCapacity(null), now, ...overrides });

test('independence ignores effort and conservatively resolves Claude moving aliases', () => {
  assert.equal(autonomousModelIdentity({ ...reviewer, model: 'claude-opus-5-5', effort: 'medium' }), 'claude:opus');
  assert.equal(independentModel(reviewer, [{ ...reviewer, effort: 'low' }]), false);
  assert.equal(independentModel(reviewer, [{ ...reviewer, model: 'claude-opus-5-5' }]), false);
  assert.equal(independentModel(reviewer, [builder]), true);
});
test('reviewer is reserved from every autonomous build class without mutating legacy catalog', () => {
  const before = JSON.stringify(DEFAULT_CATALOG);
  const routed = choose({ role: 'step', cls: 'large' });
  assert.equal(routed.ok, false, 'reserved Opus is excluded; unobserved Codex cannot start');
  assert.equal(chooseCandidate({ cls: 'large', catalog: DEFAULT_CATALOG, capacity: normaliseCapacity(null), now }).candidate.model, 'opus');
  assert.equal(JSON.stringify(DEFAULT_CATALOG), before);
});
test('configured reviewer and persisted reservation survive catalog changes', () => {
  const catalog = { ...DEFAULT_CATALOG, review: builder };
  const route = choose({ role: 'step', state: { runs: [] }, catalog });
  assert.equal(route.ok, false, 'Haiku cannot be both builder and configured reviewer');
  const review = choose({ state: { ...history, reviewer_model: reviewer }, catalog });
  assert.equal(review.candidate.model, 'opus', 'existing reservation wins over a later catalog edit');
});
test('all historical builders count, including earlier goal revisions, with no capacity fallback', () => {
  const state = { ...history, model_history: [...history.model_history, { run_id: 'old-build', model: { ...reviewer, effort: 'low' }, goal_revision: 0 }],
    runs: [...history.runs, { run_id: 'old-build', role: 'step' }] };
  const result = choose({ state });
  assert.equal(result.ok, false); assert.equal(result.transient, true); assert.match(result.reason, /built reviewed changes/u);
  assert.equal(choose({ state: { runs: history.runs } }).ok, false, 'missing builder identity waits, never claims independence');
});
test('review capacity refusal and interactive reserve wait, never choose an available builder', () => {
  const refused = choose({ capacity: applyRefusal(normaliseCapacity(null), 'claude', '2026-10-29T12:00:00Z') });
  assert.equal(refused.ok, false); assert.equal(refused.transient, true); assert.match(refused.reason, /refused/u);
  const window = { fraction_used: 0.9, resets_at: '2026-10-29T12:00:00Z' };
  const capacity = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: window, seven_day: window } }, now);
  assert.equal(choose({ capacity }).ok, false, 'unlike legacy pinned review, autonomous review keeps interactive reserve');
  assert.equal(chooseCandidate({ cls: 'review', catalog: DEFAULT_CATALOG, capacity, now }).ok, true, 'legacy behavior unchanged');
});
test('real inactive runner persists actual builder identity and reviewer reservation before launching', async t => {
  const f = runnerFixture(t);
  f.deps.session = async () => {
    const state = f.state();
    assert.deepEqual(state.reviewer_model, reviewer);
    assert.equal(state.model_history[0].run_id, state.active_run.run_id);
    assert.deepEqual(state.model_history[0].model, builder);
    return { status: 1, stdout: '', stderr: '' };
  };
  await createRunner({ deps: f.deps, autonomous: f.capability }).runStep(f.project, f.world(f.record));
  assert.equal(f.state().phase, 'plan_pending');
  assert.equal(f.state().model_history.length, 1, 'failed attempts retain model provenance');
});
