/** Autonomous-only routing. Legacy classes and the operator's catalog stay intact. */
import { parseCandidate, candidateSpec } from './model-config.js';
import { chooseCandidate } from './model-choice.js';

// Effort is not independence. Claude aliases are conservatively one family:
// a moving `opus` alias must not evade the reservation via a dated name.
export function autonomousModelIdentity(value) {
  const checked = parseCandidate(candidateSpec(value || {}));
  const family = checked.tool === 'claude' && /^(?:claude-)?(opus|sonnet|haiku)(?:-|$)/u.exec(checked.model);
  return `${checked.tool}:${family ? family[1] : checked.model}`;
}
export function independentModel(reviewer, builders) {
  const identity = autonomousModelIdentity(reviewer);
  return builders.every(model => autonomousModelIdentity(model) !== identity);
}
export function builderModels(state) {
  const history = state.model_history || [];
  for (const run of state.runs.filter(run => run.role === 'step')) {
    if (!history.some(entry => entry.run_id === run.run_id)) throw new Error('historical builder model is unknown; review must wait');
  }
  history.forEach(entry => autonomousModelIdentity(entry.model));
  return history.map(entry => entry.model);
}
export function chooseAutonomousModel({ state, role = 'step', cls = 'fast', catalog, ...options }) {
  const wait = reason => ({ ok: false, transient: true, reason, retry_at: null });
  try {
    const reviewer = state.reviewer_model || catalog.review;
    autonomousModelIdentity(reviewer);
    if (role === 'review') {
      if (!independentModel(reviewer, builderModels(state))) return wait('reserved reviewer built reviewed changes; wait for an independent assignment');
      // Use the ordinary capacity/reserve rules, not legacy review's pinned
      // exception. The only candidate is the reserved model: no fallback.
      const route = chooseCandidate({ ...options, cls: 'fast', catalog: { ...catalog, fast: [reviewer] } });
      return { ...route, reviewer };
    }
    const pool = catalog[cls].filter(model => independentModel(reviewer, [model]));
    if (!pool.length) return wait('no autonomous builder remains after reserving the reviewer');
    return { ...chooseCandidate({ ...options, cls, catalog: { ...catalog, [cls]: pool } }), reviewer };
  } catch (error) { return wait(error.message); }
}
