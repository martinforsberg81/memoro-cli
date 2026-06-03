/**
 * Drift guard for package-shipped canon (Grounding Phase 5).
 *
 * The universal-canon files live in TWO places by design:
 *   - their authoring home in the repo (`docs/coding-agent-protocol.md`,
 *     `.claude/skills/agent-coordination.md`, `.claude/commands/be-coordinator.md`)
 *   - a checked-in canonical COPY under `canon/`, shipped in the npm tarball
 *     so any repo grounds with the full role without carrying the files.
 *
 * We chose a checked-in copy (not a symlink / build step) for install
 * simplicity — but a copy can silently drift from its source. This test is
 * the self-watching mechanism: it FAILS if the packaged copy and its repo
 * source diverge byte-for-byte, forcing a deliberate re-copy. The fix when it
 * fails is the one documented in the assertion message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CANON_MANIFEST } from '../../src/mc/canon.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each packaged canon file ↔ its authoring source in the repo.
const PAIRS = [
  {
    name: CANON_MANIFEST.protocol,
    source: join(repoRoot, 'docs', 'coding-agent-protocol.md'),
    refresh: 'cp docs/coding-agent-protocol.md canon/coding-agent-protocol.md',
  },
  {
    name: CANON_MANIFEST.coordination,
    source: join(repoRoot, '.claude', 'skills', 'agent-coordination.md'),
    refresh: 'cp .claude/skills/agent-coordination.md canon/agent-coordination.md',
  },
  {
    name: CANON_MANIFEST.beCoordinator,
    source: join(repoRoot, '.claude', 'commands', 'be-coordinator.md'),
    refresh: 'cp .claude/commands/be-coordinator.md canon/be-coordinator.md',
  },
];

describe('package canon ↔ repo source (no drift)', () => {
  for (const { name, source, refresh } of PAIRS) {
    it(`canon/${name} is byte-identical to its repo source`, () => {
      const packaged = readFileSync(join(repoRoot, 'canon', name), 'utf8');
      const authored = readFileSync(source, 'utf8');
      assert.equal(
        packaged,
        authored,
        `canon/${name} has drifted from its source. Re-copy with:\n  ${refresh}`,
      );
    });
  }
});
