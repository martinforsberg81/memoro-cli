/**
 * Tests for the codex adapter's grounding materialisation
 * (Grounding Phase 3 — codex parity with claude-code).
 *
 * writeGrounding writes the SAME tool-agnostic bundle into the SESSION's
 * workspace AGENTS.md (codex's native instruction file) under a managed
 * block whose markers are DISTINCT from both the lens block AND the
 * claude-code grounding markers, so a session that switches tools never
 * has one tool's block collide with another's.
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

  it('writes the bundle into the cwd AGENTS.md (not CLAUDE.md, not global)', async () => {
    const target = await codex.writeGrounding('# Session grounding\nbody', { cwd: dir });
    assert.equal(target, join(dir, 'AGENTS.md'));
    assert.ok(existsSync(target));
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'must not touch CLAUDE.md');
    const body = readFileSync(target, 'utf8');
    assert.match(body, /memoro:managed:grounding:codex:begin/);
    assert.match(body, /memoro:managed:grounding:codex:end/);
    assert.match(body, /# Session grounding/);
  });

  it('replace is idempotent — only one grounding block remains', async () => {
    await codex.writeGrounding('first bundle', { cwd: dir });
    await codex.writeGrounding('second bundle', { cwd: dir });
    const body = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const begins = body.match(/memoro:managed:grounding:codex:begin/g) || [];
    assert.equal(begins.length, 1);
    assert.match(body, /second bundle/);
    assert.ok(!body.includes('first bundle'));
  });

  it('preserves hand-edited content outside the block', async () => {
    const handDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-hand-'));
    const p = join(handDir, 'AGENTS.md');
    writeFileSync(p, '# My agents rules\n- prefer ESM\n', 'utf8');
    await codex.writeGrounding('bundle body', { cwd: handDir });
    const body = readFileSync(p, 'utf8');
    assert.match(body, /# My agents rules/);
    assert.match(body, /prefer ESM/);
    assert.match(body, /bundle body/);
    rmSync(handDir, { recursive: true, force: true });
  });

  it('codex marker is distinct from claude-code grounding marker', () => {
    assert.notEqual(codex.GROUNDING_BEGIN, claudeCode.GROUNDING_BEGIN);
    assert.notEqual(codex.GROUNDING_END, claudeCode.GROUNDING_END);
  });

  it('coexists with a lens block (different marker) in the same AGENTS.md', async () => {
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
    assert.match(body, /grounding:codex:begin/);
    assert.match(body, /grounding body/);
    rmSync(coDir, { recursive: true, force: true });
  });

  it('removeGrounding strips only the codex grounding block', async () => {
    const rmDir = mkdtempSync(join(tmpdir(), 'mc-grounding-codex-rm-'));
    const p = join(rmDir, 'AGENTS.md');
    writeFileSync(
      p,
      '# hand\n<!-- memoro:managed:portrait-coding:begin -->\nlens\n<!-- memoro:managed:portrait-coding:end -->\n',
      'utf8',
    );
    await codex.writeGrounding('grounding body', { cwd: rmDir });
    await codex.removeGrounding({ cwd: rmDir });
    const body = readFileSync(p, 'utf8');
    assert.ok(!body.includes('grounding body'));
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
