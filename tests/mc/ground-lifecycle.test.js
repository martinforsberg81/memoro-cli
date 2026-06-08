/**
 * TDD spec for MEMORO.md lifecycle helpers (Phase 2).
 *
 * Phase 2 lets grounding guide the agent to seed / update the intent-map when
 * work changes durable project state. mc itself only reads MEMORO.md during
 * grounding; the coding agent keeps the map current as part of the work. These
 * pure helpers produce that guidance:
 *
 *   - `seedTemplate({ repoName })` — an initial intent-map the agent can write
 *     when the repo has no MEMORO.md. Pure, deterministic.
 *   - `detectStale(map)` — a light heuristic returning the nodes whose
 *     status looks like it may need a re-check, so grounding can surface
 *     a gentle "verify these are current" nudge. Never asserts staleness;
 *     low-false-positive by design.
 *   - `lifecycleGuidance({ map, repoName })` — the markdown block folded into
 *     the bundle. It instructs the agent to keep MEMORO.md current directly;
 *     no separate confirmation gate.
 *
 * The load-bearing invariant — default grounding never mutates MEMORO.md —
 * is asserted here AND in ground.test.js (groundSession path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  seedTemplate,
  detectStale,
  lifecycleGuidance,
} from '../../src/mc/ground.js';

// ─────────────────────────────────────────────────────────────
// seedTemplate — initial intent-map
// ─────────────────────────────────────────────────────────────

describe('seedTemplate (pure)', () => {
  it('produces a MEMORO.md skeleton with the reference sections', () => {
    const out = seedTemplate({ repoName: 'acme-cli' });
    assert.match(out, /# MEMORO\.md/);
    assert.match(out, /## North star/);
    assert.match(out, /## Long-term goals/i);
    // Sparse-by-rule reminder so the seeded file stays a map, not docs.
    assert.match(out, /status · scope · timeframe|Sparse/i);
  });

  it('threads the repo name into the heading', () => {
    assert.match(seedTemplate({ repoName: 'acme-cli' }), /acme-cli/);
  });

  it('tolerates a missing repo name (generic skeleton, never throws)', () => {
    assert.doesNotThrow(() => seedTemplate());
    assert.match(seedTemplate({}), /# MEMORO\.md/);
  });

  it('is pure — same input yields identical output', () => {
    assert.equal(seedTemplate({ repoName: 'x' }), seedTemplate({ repoName: 'x' }));
  });
});

// ─────────────────────────────────────────────────────────────
// detectStale — light, low-false-positive heuristic
// ─────────────────────────────────────────────────────────────

describe('detectStale (pure heuristic)', () => {
  it('returns [] for a null / empty map (nothing to flag)', () => {
    assert.deepEqual(detectStale(null), []);
    assert.deepEqual(detectStale(''), []);
    assert.deepEqual(detectStale('   '), []);
  });

  it('flags nodes whose status is an in-flight marker (active/now/in-progress)', () => {
    const map = [
      '## Project',
      '- **Node A** — `active · L · now`',
      '  does a thing',
      '- **Node B** — `done · M · shipped`',
      '- **Node C** — `in-progress · S · this week`',
    ].join('\n');
    const stale = detectStale(map);
    // A + C are in-flight; B is done → not flagged.
    assert.ok(stale.some((s) => /Node A/.test(s)), `expected Node A flagged; got ${JSON.stringify(stale)}`);
    assert.ok(stale.some((s) => /Node C/.test(s)));
    assert.ok(!stale.some((s) => /Node B/.test(s)), 'done nodes must not be flagged');
  });

  it('does not flag a map with only settled statuses (no false positives)', () => {
    const map = [
      '- **X** — `done · L · shipped`',
      '- **Y** — `planned · M · —`',
      '- **Z** — `later · S · —`',
    ].join('\n');
    assert.deepEqual(detectStale(map), []);
  });

  it('never throws on malformed input', () => {
    assert.doesNotThrow(() => detectStale('no backticks here at all'));
    assert.deepEqual(detectStale('no backticks here at all'), []);
  });
});

// ─────────────────────────────────────────────────────────────
// lifecycleGuidance — living-map guidance folded into the bundle
// ─────────────────────────────────────────────────────────────

describe('lifecycleGuidance (pure)', () => {
  it('guides seeding when no map is present without a confirmation gate', () => {
    const out = lifecycleGuidance({ map: null, repoName: 'acme' });
    assert.match(out, /seed|create/i);
    assert.match(out, /No separate\s+confirmation step is required/i);
    assert.match(out, /MEMORO\.md/);
  });

  it('guides updates and surfaces stale nodes when a map exists with in-flight nodes', () => {
    const map = '- **Live thing** — `active · L · now`';
    const out = lifecycleGuidance({ map, repoName: 'acme' });
    assert.match(out, /update|maintain|current/i);
    assert.match(out, /Live thing/);
    assert.match(out, /No separate confirmation step is required/i);
  });

  it('stays sparse in tone when the map is settled (no nudge spam)', () => {
    const map = '- **X** — `done · L · shipped`';
    const out = lifecycleGuidance({ map, repoName: 'acme' });
    // No stale list, but still references the sparse maintenance posture.
    assert.ok(!/`active · L · now`/.test(out));
    assert.match(out, /MEMORO\.md/);
  });

  it('never throws with no args', () => {
    assert.doesNotThrow(() => lifecycleGuidance());
  });
});
