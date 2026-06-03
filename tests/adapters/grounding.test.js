/**
 * Tests for the claude-code adapter's grounding materialisation
 * (Phase 1 — Grounding MVP).
 *
 * writeGrounding writes the bundle into the SESSION's cwd CLAUDE.md
 * (not the global ~/.claude/CLAUDE.md) under a managed block whose
 * markers are DISTINCT from the lens block, so the two never collide.
 *
 * Covers: cwd targeting, managed-block round-trip (idempotent replace),
 * coexistence with a hand-edited file + a separate lens block, and
 * removeGrounding leaving everything else intact.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as claudeCode from '../../src/adapters/claude-code.js';

describe('claude-code adapter — writeGrounding / removeGrounding', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-grounding-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('writes the bundle into the cwd CLAUDE.md (not global)', async () => {
    const target = await claudeCode.writeGrounding('# Session grounding\nbody', { cwd: dir });
    assert.equal(target, join(dir, 'CLAUDE.md'));
    assert.ok(existsSync(target));
    const body = readFileSync(target, 'utf8');
    assert.match(body, /memoro:managed:grounding:begin/);
    assert.match(body, /memoro:managed:grounding:end/);
    assert.match(body, /# Session grounding/);
  });

  it('replace is idempotent — only one grounding block remains', async () => {
    await claudeCode.writeGrounding('first bundle', { cwd: dir });
    await claudeCode.writeGrounding('second bundle', { cwd: dir });
    const body = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const begins = body.match(/memoro:managed:grounding:begin/g) || [];
    assert.equal(begins.length, 1);
    assert.match(body, /second bundle/);
    assert.ok(!body.includes('first bundle'));
  });

  it('preserves hand-edited content outside the block', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'mc-grounding-hand-'));
    const p = join(handDir, 'CLAUDE.md');
    writeFileSync(p, '# My project rules\n- use tabs\n', 'utf8');
    await claudeCode.writeGrounding('bundle body', { cwd: handDir });
    const body = readFileSync(p, 'utf8');
    assert.match(body, /# My project rules/);
    assert.match(body, /use tabs/);
    assert.match(body, /bundle body/);
    rmSync(handDir, { recursive: true, force: true });
  });

  it('uses a marker distinct from the lens block (they coexist)', async () => {
    const coDir = mkdtempSync(join(tmpdir(), 'mc-grounding-coexist-'));
    const p = join(coDir, 'CLAUDE.md');
    // Simulate a pre-existing lens managed block (portrait-coding marker).
    writeFileSync(
      p,
      '<!-- memoro:managed:portrait-coding:begin -->\nlens body\n<!-- memoro:managed:portrait-coding:end -->\n',
      'utf8',
    );
    await claudeCode.writeGrounding('grounding body', { cwd: coDir });
    const body = readFileSync(p, 'utf8');
    // Both blocks present, untouched.
    assert.match(body, /portrait-coding:begin/);
    assert.match(body, /lens body/);
    assert.match(body, /grounding:begin/);
    assert.match(body, /grounding body/);
    rmSync(coDir, { recursive: true, force: true });
  });

  it('removeGrounding strips only the grounding block', async () => {
    const rmDir = mkdtempSync(join(tmpdir(), 'mc-grounding-rm-'));
    const p = join(rmDir, 'CLAUDE.md');
    writeFileSync(
      p,
      '# hand\n<!-- memoro:managed:portrait-coding:begin -->\nlens\n<!-- memoro:managed:portrait-coding:end -->\n',
      'utf8',
    );
    await claudeCode.writeGrounding('grounding body', { cwd: rmDir });
    await claudeCode.removeGrounding({ cwd: rmDir });
    const body = readFileSync(p, 'utf8');
    assert.ok(!body.includes('grounding body'));
    assert.ok(!body.includes('grounding:begin'));
    // Lens block + hand content survive.
    assert.match(body, /# hand/);
    assert.match(body, /lens/);
    assert.match(body, /portrait-coding:begin/);
    rmSync(rmDir, { recursive: true, force: true });
  });

  it('removeGrounding is a no-op when no CLAUDE.md exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mc-grounding-none-'));
    await assert.doesNotReject(() => claudeCode.removeGrounding({ cwd: emptyDir }));
    assert.ok(!existsSync(join(emptyDir, 'CLAUDE.md')));
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
