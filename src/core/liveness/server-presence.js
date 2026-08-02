/**
 * THE server-side liveness judgment.
 *
 * A server-active record may only be bypassed with positive local proof
 * that the exact runtime generation exited — hostname equality is never
 * proof. A stale record (its generation locally proven exited, or a
 * record carrying no generation at all) is repairable by publishing
 * terminal presence for the proven generation.
 *
 * Consumers (open/resume today; reconcilers tomorrow) act on decisions,
 * never re-derive them — the "already active forever" dead-end family
 * from the 2026-08-01 crash incident came from exactly such local
 * re-derivations.
 *
 * Decisions:
 *   clear             no server-active record — proceed.
 *   repairable-stale  local exit proof covers the record — publish
 *                     terminal presence for runtimeGeneration, refresh,
 *                     then judge again.
 *   exited-match      the record names the exact generation the local
 *                     journal proves exited — bypass is safe.
 *   active-elsewhere  no local proof covers the record — the session may
 *                     genuinely be running on another source.
 */
export function judgeServerActiveRecord({ active, localPresence } = {}) {
  if (!active) return { decision: 'clear' };
  const localGeneration = nonEmpty(localPresence?.runtime_generation);
  const exitedLocally = localPresence?.verdict === 'exited' && localGeneration !== null;
  const serverGeneration = nonEmpty(active.runtime_generation);

  if (exitedLocally && serverGeneration !== null && serverGeneration === localGeneration) {
    return { decision: 'exited-match', runtimeGeneration: localGeneration };
  }
  if (exitedLocally && serverGeneration === null) {
    return { decision: 'repairable-stale', runtimeGeneration: localGeneration };
  }
  return { decision: 'active-elsewhere' };
}

/**
 * True when the record should be repaired before the final judgment —
 * covers both the generationless record and the exact-match record
 * (repairing the matching record clears it server-side so later opens
 * never re-litigate it).
 */
export function serverActiveRecordRepairable({ active, localPresence } = {}) {
  const { decision } = judgeServerActiveRecord({ active, localPresence });
  return decision === 'repairable-stale' || decision === 'exited-match';
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
