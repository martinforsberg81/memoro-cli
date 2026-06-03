/**
 * TDD spec for the package-canon-aware orchestrator role (Phase 5).
 *
 * Before Phase 5, `buildRole` pointed only at the repo's own `.claude`/`docs`
 * files and degraded to terse framing when they were absent. Phase 5 makes the
 * role UNIVERSAL: the package ships the canon, so even an empty repo grounds
 * with the full role — the orchestrator framing PLUS the two load-bearing
 * purposes inline PLUS pointers to the canonical protocol (repo copy when
 * present, else the package copy that `mc setup` / `mc adapter sync`
 * materialise).
 *
 * Terse fallback now means ONLY a broken install (package canon unreadable) —
 * never merely "repo has no .claude". The canon resolution is injected
 * (Pattern 2) so these run in-process with no real package read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRole } from '../../src/mc/ground.js';

// A package-canon stub that "ships" all three assets (truthy content).
const FULL_CANON = {
  protocol: '# protocol',
  coordination: '# coordination',
  beCoordinator: '# be-coordinator',
};

describe('buildRole — universal (package canon)', () => {
  it('an EMPTY repo still gets the FULL role, not terse fallback', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mc-role-empty-'));
    const out = buildRole(empty, { exists: () => false, canon: () => FULL_CANON });

    // Framing + the two load-bearing purposes are present inline.
    assert.match(out, /orchestrator/i);
    assert.match(out, /altitude/i);
    assert.match(out, /context/i);        // purpose 1: protect context
    assert.match(out, /brief/i);          // purpose 2: brief-as-quality

    // Canonical sources are still surfaced (from the package), not dropped.
    assert.match(out, /coding-agent-protocol\.md/);
    assert.match(out, /agent-coordination\.md/);

    rmSync(empty, { recursive: true, force: true });
  });

  it('points at the REPO copy when the repo carries the files (override)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-role-repo-'));
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'agent-coordination.md'), 'x');
    writeFileSync(join(dir, '.claude', 'commands', 'be-coordinator.md'), 'x');
    writeFileSync(join(dir, 'docs', 'coding-agent-protocol.md'), 'x');

    const out = buildRole(dir, { canon: () => FULL_CANON });
    // Repo-relative pointers (the layered override).
    assert.match(out, /`docs\/coding-agent-protocol\.md`/);
    assert.match(out, /`\.claude\/skills\/agent-coordination\.md`/);
    assert.match(out, /`\.claude\/commands\/be-coordinator\.md`/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to TERSE only when the package canon is unreadable (broken install)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mc-role-broken-'));
    const out = buildRole(empty, {
      exists: () => false,
      canon: () => ({ protocol: null, coordination: null, beCoordinator: null }),
    });
    // Framing always survives.
    assert.match(out, /orchestrator/i);
    // No canonical-source pointers when neither repo nor package has them.
    assert.ok(!/agent-coordination\.md/.test(out), 'no canon pointer on broken install');
    assert.ok(!/coding-agent-protocol\.md/.test(out));
    rmSync(empty, { recursive: true, force: true });
  });

  it('never throws when the canon resolver itself throws', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mc-role-throw-'));
    assert.doesNotThrow(() =>
      buildRole(empty, { exists: () => false, canon: () => { throw new Error('boom'); } }),
    );
    const out = buildRole(empty, { exists: () => false, canon: () => { throw new Error('boom'); } });
    assert.match(out, /orchestrator/i);
    rmSync(empty, { recursive: true, force: true });
  });
});
