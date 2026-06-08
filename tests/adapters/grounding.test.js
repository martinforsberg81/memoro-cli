/**
 * Tests for the claude-code adapter's grounding materialisation
 * (Phase 1 — Grounding MVP).
 *
 * writeGrounding returns the bundle as launch-arg delivery. CLAUDE.md is
 * the static adapter-sync wrapper and must not be dirtied by per-session
 * runtime state. removeGrounding still strips legacy managed blocks left
 * by older releases.
 *
 * Covers: cwd targeting, no mutation of hand-edited/project files, and
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

  it('delivers the bundle as launch args without creating CLAUDE.md', async () => {
    const target = await claudeCode.writeGrounding('# Session grounding\nbody', { cwd: dir });
    assert.deepEqual(target, {
      path: join(dir, 'CLAUDE.md'),
      delivery: 'launch-args',
      message: '# Session grounding\nbody',
    });
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'must not dirty the workspace wrapper');
  });

  it('launch-arg delivery is idempotent', async () => {
    await claudeCode.writeGrounding('first bundle', { cwd: dir });
    const second = await claudeCode.writeGrounding('second bundle', { cwd: dir });
    assert.equal(second.message, 'second bundle');
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')));
  });

  it('preserves hand-edited content by not writing around it', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'mc-grounding-hand-'));
    const p = join(handDir, 'CLAUDE.md');
    writeFileSync(p, '# My project rules\n- use tabs\n', 'utf8');
    await claudeCode.writeGrounding('bundle body', { cwd: handDir });
    const body = readFileSync(p, 'utf8');
    assert.match(body, /# My project rules/);
    assert.match(body, /use tabs/);
    assert.ok(!body.includes('bundle body'));
    rmSync(handDir, { recursive: true, force: true });
  });

  it('does not disturb a lens block in the same CLAUDE.md', async () => {
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
    assert.match(body, /portrait-coding:begin/);
    assert.match(body, /lens body/);
    assert.ok(!body.includes('grounding:begin'));
    assert.ok(!body.includes('grounding body'));
    rmSync(coDir, { recursive: true, force: true });
  });

  it('removeGrounding strips only a legacy grounding block', async () => {
    const rmDir = mkdtempSync(join(tmpdir(), 'mc-grounding-rm-'));
    const p = join(rmDir, 'CLAUDE.md');
    writeFileSync(
      p,
      [
        '# hand',
        '<!-- memoro:managed:portrait-coding:begin -->',
        'lens',
        '<!-- memoro:managed:portrait-coding:end -->',
        claudeCode.GROUNDING_BEGIN,
        'legacy grounding body',
        claudeCode.GROUNDING_END,
        '',
      ].join('\n'),
      'utf8',
    );
    await claudeCode.removeGrounding({ cwd: rmDir });
    const body = readFileSync(p, 'utf8');
    assert.ok(!body.includes('legacy grounding body'));
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
