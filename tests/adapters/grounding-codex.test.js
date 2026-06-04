/**
 * Tests for the codex adapter's grounding materialisation
 * (Grounding Phase 3 — codex parity with claude-code).
 *
 * writeGrounding returns the SAME tool-agnostic bundle as a startup
 * message. AGENTS.md is the static adapter-sync wrapper and must not be
 * dirtied by per-session runtime state. removeGrounding still strips
 * legacy managed blocks left by older releases.
 *
 * Verified against the real on-disk layout (a tmpdir AGENTS.md), not a
 * fixture — Pattern 6. resolveWorkspaceRoot falls back to cwd when the dir
 * isn't a git repo, so a plain tmpdir is the workspace root here.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as codex from '../../src/adapters/codex.js';
import * as claudeCode from '../../src/adapters/claude-code.js';

describe('codex adapter — writeGrounding / removeGrounding', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('delivers the bundle as a startup message without creating AGENTS.md', async () => {
    const target = await codex.writeGrounding('# Session grounding\nbody', { cwd: dir });
    assert.deepEqual(target, {
      path: join(dir, 'AGENTS.md'),
      delivery: 'startup-message',
      message: '# Session grounding\nbody',
    });
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'must not dirty the workspace wrapper');
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'must not touch CLAUDE.md');
  });

  it('does not mutate an existing AGENTS.md wrapper', async () => {
    const existingDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-existing-'));
    const p = join(existingDir, 'AGENTS.md');
    writeFileSync(p, '# AGENTS.md\nstatic wrapper\n', 'utf8');
    await codex.writeGrounding('bundle body', { cwd: existingDir });
    assert.equal(readFileSync(p, 'utf8'), '# AGENTS.md\nstatic wrapper\n');
    rmSync(existingDir, { recursive: true, force: true });
  });

  it('startup-message delivery is idempotent', async () => {
    await codex.writeGrounding('first bundle', { cwd: dir });
    const second = await codex.writeGrounding('second bundle', { cwd: dir });
    assert.equal(second.message, 'second bundle');
    assert.ok(!existsSync(join(dir, 'AGENTS.md')));
  });

  it('preserves hand-edited content by not writing around it', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-hand-'));
    const p = join(handDir, 'AGENTS.md');
    writeFileSync(p, '# My agents rules\n- prefer ESM\n', 'utf8');
    await codex.writeGrounding('bundle body', { cwd: handDir });
    const body = readFileSync(p, 'utf8');
    assert.match(body, /# My agents rules/);
    assert.match(body, /prefer ESM/);
    assert.ok(!body.includes('bundle body'));
    rmSync(handDir, { recursive: true, force: true });
  });

  it('codex marker is distinct from claude-code grounding marker', () => {
    assert.notEqual(codex.GROUNDING_BEGIN, claudeCode.GROUNDING_BEGIN);
    assert.notEqual(codex.GROUNDING_END, claudeCode.GROUNDING_END);
  });

  it('does not disturb a lens block in the same AGENTS.md', async () => {
    const coDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-coexist-'));
    const p = join(coDir, 'AGENTS.md');
    writeFileSync(
      p,
      '<!-- memoro:managed:portrait-coding:begin -->\nlens body\n<!-- memoro:managed:portrait-coding:end -->\n',
      'utf8',
    );
    await codex.writeGrounding('grounding body', { cwd: coDir });
    const body = readFileSync(p, 'utf8');
    assert.match(body, /portrait-coding:begin/);
    assert.match(body, /lens body/);
    assert.ok(!body.includes('grounding:codex:begin'));
    assert.ok(!body.includes('grounding body'));
    rmSync(coDir, { recursive: true, force: true });
  });

  it('removeGrounding strips only a legacy codex grounding block', async () => {
    const rmDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-rm-'));
    const p = join(rmDir, 'AGENTS.md');
    writeFileSync(
      p,
      [
        '# hand',
        '<!-- memoro:managed:portrait-coding:begin -->',
        'lens',
        '<!-- memoro:managed:portrait-coding:end -->',
        codex.GROUNDING_BEGIN,
        'legacy grounding body',
        codex.GROUNDING_END,
        '',
      ].join('\n'),
      'utf8',
    );
    await codex.removeGrounding({ cwd: rmDir });
    const body = readFileSync(p, 'utf8');
    assert.ok(!body.includes('legacy grounding body'));
    assert.ok(!body.includes('grounding:codex:begin'));
    assert.match(body, /# hand/);
    assert.match(body, /lens/);
    assert.match(body, /portrait-coding:begin/);
    rmSync(rmDir, { recursive: true, force: true });
  });

  it('removeGrounding is a no-op when no AGENTS.md exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-none-'));
    await assert.doesNotReject(() => codex.removeGrounding({ cwd: emptyDir }));
    assert.ok(!existsSync(join(emptyDir, 'AGENTS.md')));
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
