/**
 * Pure helpers for `mc adapter materialise` (plan §13c — materialise
 * package-canon into a repo).
 *
 * Phase 5 made the orchestrator canon *ship* in the mc package (`canon/`:
 * coding-agent-protocol.md, agent-coordination.md, be-coordinator.md) and
 * `buildRole` inlines the role at grounding time. But a fresh repo never
 * receives the actual skill/command FILES — so `/be-coordinator`, the
 * agent-coordination skill, etc. don't exist on disk there. This verb
 * copies the canon files OUT of the package (`canonRoot()`) and INTO a
 * target repo's `.claude/` + `docs/`, so any repo can carry the
 * orchestrator tooling.
 *
 * Relationship to `mc adapter sync`: SAME verb family, OPPOSITE direction.
 *   - `sync`        reads the repo's `docs/coding-agent-protocol.md` and
 *                   WRITES thin pointer wrappers (CLAUDE.md, AGENTS.md).
 *   - `materialise` reads the PACKAGE `canon/` and WRITES the full canon
 *                   files into the repo (including the very
 *                   `docs/coding-agent-protocol.md` that `sync` later reads).
 * They are complementary: materialise lays down the canonical sources;
 * sync then points the per-tool wrappers at them.
 *
 * This file is pure: no fs, no process. The verb in
 * `src/mc/commands/adapter.js` injects fs deps + the package-canon content,
 * then drives these helpers to produce a plan.
 *
 * Drift model (distinct from adapter-sync's stamped wrappers): canon files
 * are full content COPIES of the package source, not generated wrappers, so
 * there is no embedded stamp to compare. The drift signal is a plain
 * byte-compare against the packaged source:
 *   - missing    → file absent on disk; materialise would create.
 *   - up-to-date → byte-identical to the packaged canon; no action.
 *   - drift      → present but differs (hand-edited / older copy). Refuse to
 *                  overwrite without --force.
 */

/**
 * Logical canon asset → its repo-relative destination. The INVERSE of the
 * `canon/` ← repo-source mapping guarded by `tests/mc/canon-drift.test.js`;
 * kept in lock-step with `CANON_MANIFEST` (canon.js) so the resolver, the
 * role builder, the drift guard, and this materialiser never disagree about
 * which files constitute the canon or where they live on disk.
 *
 * Verified against the real on-disk layout (Pattern 6):
 *   - coding-agent-protocol.md → docs/coding-agent-protocol.md
 *   - agent-coordination.md    → .claude/skills/agent-coordination.md
 *   - be-coordinator.md        → .claude/commands/be-coordinator.md
 */
export const CANON_DESTINATIONS = {
  protocol: 'docs/coding-agent-protocol.md',
  coordination: '.claude/skills/agent-coordination.md',
  beCoordinator: '.claude/commands/be-coordinator.md',
};

/**
 * Compare the on-disk content against the packaged canon. Returns a
 * discriminated state the caller acts on:
 *
 *   - `missing`    — file doesn't exist; materialise would create.
 *   - `up-to-date` — byte-identical to the packaged canon; no action.
 *   - `drift`      — file exists but differs; refuse without --force.
 *
 * Pure + total: a null `existing` is "missing", a null `packaged` is the
 * caller's responsibility to filter (a broken-install canon file).
 */
export function detectCanonDrift({ existing, packaged }) {
  if (existing == null) return { state: 'missing' };
  if (existing === packaged) return { state: 'up-to-date' };
  return { state: 'drift' };
}

function driftStateToAction(state) {
  switch (state) {
    case 'missing':    return 'create';
    case 'up-to-date': return 'noop';
    case 'drift':      return 'drift';
    default:           return 'skip';
  }
}

/**
 * Plan the materialisation — pure function over the packaged canon + the
 * on-disk reads. Returns an array of per-file actions; the caller writes
 * (or doesn't, under --dry-run / on drift without --force) based on
 * `action` and `--force`.
 *
 * @param {object} arg
 * @param {{protocol:string|null,coordination:string|null,beCoordinator:string|null}} arg.canon
 *   — packaged canon content (from readPackageCanon). A null entry means the
 *   package install is broken/missing that file; it is surfaced as a `skip`
 *   action with a reason, never written (soft-degrade, Pattern 2).
 * @param {Function} arg.resolveDest — (relPath) => absPath in the target repo.
 * @param {Function} arg.readDest    — (absPath) => string|null content on disk.
 * @param {object}   [arg.destinations] — manifest-key → repo-relative path;
 *   defaults to CANON_DESTINATIONS (injectable for tests).
 */
export function planMaterialise({
  canon,
  resolveDest,
  readDest,
  destinations = CANON_DESTINATIONS,
}) {
  if (!canon || typeof canon !== 'object') {
    throw new TypeError('planMaterialise: canon object required');
  }
  if (typeof resolveDest !== 'function' || typeof readDest !== 'function') {
    throw new TypeError('planMaterialise: resolveDest + readDest functions required');
  }
  const actions = [];
  for (const [key, relPath] of Object.entries(destinations)) {
    const packaged = canon[key];
    if (packaged == null) {
      // Broken / incomplete package install — never invent content.
      actions.push({
        key,
        destPath: relPath,
        absPath: null,
        action: 'skip',
        reason: 'canon file missing from the mc package install',
      });
      continue;
    }
    const absPath = resolveDest(relPath);
    const existing = readDest(absPath);
    const drift = detectCanonDrift({ existing, packaged });
    actions.push({
      key,
      destPath: relPath,
      absPath,
      action: driftStateToAction(drift.state),
      driftState: drift.state,
      packagedContent: packaged,
      existingContent: existing,
    });
  }
  return actions;
}
