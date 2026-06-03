/**
 * Adapter contract test (Grounding Phase 3).
 *
 * The grounding seam is shared: `groundSession` assembles ONE bundle and
 * routes it through whichever adapter the launcher picked. For that to be
 * safe, EVERY launchable adapter must expose the same surface with the
 * same signature:
 *
 *   - writeGrounding(markdown, { cwd })  → Promise<path>
 *   - removeGrounding({ cwd })           → Promise<void>
 *   - launchSpec()                       → { bin, args, heartbeatSource, label }
 *   - GROUNDING_BEGIN / GROUNDING_END    → distinct managed-block markers
 *
 * This is the gate that keeps claude-code + codex from drifting apart.
 * It also asserts the markers are mutually distinct across adapters, so a
 * tool-switched session never has two tools' blocks collide.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as claudeCode from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';

const LAUNCHABLE = [
  ['claude-code', claudeCode],
  ['codex', codex],
];

describe('adapter contract — grounding + launch surface', () => {
  for (const [id, mod] of LAUNCHABLE) {
    describe(id, () => {
      it('exposes writeGrounding / removeGrounding', () => {
        assert.equal(typeof mod.writeGrounding, 'function', 'writeGrounding');
        assert.equal(typeof mod.removeGrounding, 'function', 'removeGrounding');
        // writeGrounding takes (markdown, { cwd }); the second arg has a
        // default so .length is 1 — assert the markdown param exists.
        assert.ok(mod.writeGrounding.length >= 1,
          'writeGrounding must take a markdown arg');
      });

      it('exposes distinct GROUNDING_BEGIN / GROUNDING_END markers', () => {
        assert.equal(typeof mod.GROUNDING_BEGIN, 'string');
        assert.equal(typeof mod.GROUNDING_END, 'string');
        assert.notEqual(mod.GROUNDING_BEGIN, mod.GROUNDING_END);
      });

      it('exposes a launchSpec() with bin / args / heartbeatSource / label', () => {
        assert.equal(typeof mod.launchSpec, 'function');
        const spec = mod.launchSpec();
        assert.ok(spec && typeof spec === 'object');
        // bin may be null (binary not installed) but the KEY must exist.
        assert.ok('bin' in spec, 'spec.bin key present');
        assert.equal(typeof spec.args, 'function', 'spec.args maps argv');
        assert.equal(typeof spec.heartbeatSource, 'string');
        assert.equal(typeof spec.label, 'string');
      });

      it('writeGrounding returns the on-disk path and round-trips', async () => {
        const dir = mkdtempSync(join(tmpdir(), `mc-contract-${id}-`));
        try {
          const p = await mod.writeGrounding('# Session grounding\nx', { cwd: dir });
          assert.ok(typeof p === 'string' && p.length > 0);
          const body = readFileSync(p, 'utf8');
          assert.ok(body.includes(mod.GROUNDING_BEGIN));
          assert.ok(body.includes(mod.GROUNDING_END));
          await assert.doesNotReject(() => mod.removeGrounding({ cwd: dir }));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }

  it('grounding markers are mutually distinct across adapters', () => {
    const begins = new Set(LAUNCHABLE.map(([, m]) => m.GROUNDING_BEGIN));
    const ends = new Set(LAUNCHABLE.map(([, m]) => m.GROUNDING_END));
    assert.equal(begins.size, LAUNCHABLE.length, 'begin markers must be unique per adapter');
    assert.equal(ends.size, LAUNCHABLE.length, 'end markers must be unique per adapter');
  });

  it('heartbeat sources are distinct per adapter', () => {
    const sources = new Set(LAUNCHABLE.map(([, m]) => m.launchSpec().heartbeatSource));
    assert.equal(sources.size, LAUNCHABLE.length);
  });
});
