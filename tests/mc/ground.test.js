/**
 * TDD spec for session grounding (Phase 1 — Grounding MVP).
 *
 * Two layers:
 *   1. `assembleBundle(parts)` — PURE. Renders { map + role + lens + focus }
 *      into one markdown body. Soft-degrade: missing parts are omitted.
 *   2. `groundSession({ cwd, adapter, ... })` — impure orchestration with
 *      injectable dep-portals. Never throws; soft-degrades every external
 *      dependency. Materialises via the adapter's writeGrounding.
 *
 * Also covers `readMap` (read-only MEMORO.md), `buildRole` (role framing
 * that references existing repo .claude sources), and `pullLensMarkdown`
 * (lens via injected fetch, null on any failure).
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assembleBundle,
  groundSession,
  readMap,
  buildRole,
  pullLensMarkdown,
} from '../../src/mc/ground.js';

// ─────────────────────────────────────────────────────────────
// assembleBundle — pure
// ─────────────────────────────────────────────────────────────

describe('assembleBundle (pure)', () => {
  it('renders all four parts as labelled sections', () => {
    const out = assembleBundle({
      map: '# MEMORO.md\nnorth star',
      role: 'You are the orchestrator.',
      lens: 'User prefers tabs.',
      focus: 'currently on the grounding MVP',
    });
    assert.match(out, /# Session grounding/);
    assert.match(out, /## Your role/);
    assert.match(out, /You are the orchestrator\./);
    assert.match(out, /## The map/);
    assert.match(out, /north star/);
    assert.match(out, /## Who you are working with/);
    assert.match(out, /User prefers tabs\./);
    assert.match(out, /## Current focus/);
    assert.match(out, /currently on the grounding MVP/);
  });

  it('omits a missing map entirely (no empty heading)', () => {
    const out = assembleBundle({ role: 'role text' });
    assert.ok(!/## The map/.test(out), 'map section should be absent');
    assert.match(out, /## Your role/);
  });

  it('omits empty / whitespace-only parts', () => {
    const out = assembleBundle({ map: '   \n  ', role: 'role', lens: '', focus: '\t' });
    assert.ok(!/## The map/.test(out));
    assert.ok(!/## Who you are working with/.test(out));
    assert.ok(!/## Current focus/.test(out));
    assert.match(out, /## Your role/);
  });

  it('empty bundle still produces a header + preamble (never blank)', () => {
    const out = assembleBundle({});
    assert.match(out, /# Session grounding/);
    // No part sections.
    assert.ok(!/## /.test(out));
  });

  it('is pure — same input yields identical output', () => {
    const parts = { map: 'm', role: 'r', lens: 'l', focus: 'f' };
    assert.equal(assembleBundle(parts), assembleBundle(parts));
  });

  it('collapses excessive blank lines and ends with a single newline', () => {
    const out = assembleBundle({ map: 'a\n\n\n\nb', role: 'r' });
    assert.ok(!/\n{3,}/.test(out), 'no runs of 3+ newlines');
    assert.ok(out.endsWith('\n'));
  });

  it('tolerates no argument', () => {
    assert.doesNotThrow(() => assembleBundle());
    assert.match(assembleBundle(), /# Session grounding/);
  });
});

// ─────────────────────────────────────────────────────────────
// readMap — read-only MEMORO.md
// ─────────────────────────────────────────────────────────────

describe('readMap (read-only MEMORO.md)', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-ground-map-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null when MEMORO.md is absent (soft-degrade)', async () => {
    const out = await readMap(dir);
    assert.equal(out, null);
  });

  it('reads MEMORO.md contents when present', async () => {
    writeFileSync(join(dir, 'MEMORO.md'), '# MEMORO.md\nintent', 'utf8');
    const out = await readMap(dir);
    assert.match(out, /intent/);
  });

  it('returns null (never throws) on read error', async () => {
    const out = await readMap(dir, {
      exists: () => true,
      readFileImpl: async () => { throw new Error('boom'); },
    });
    assert.equal(out, null);
  });

  it('does NOT write or mutate MEMORO.md', async () => {
    const p = join(dir, 'MEMORO.md');
    const before = readFileSync(p, 'utf8');
    await readMap(dir);
    assert.equal(readFileSync(p, 'utf8'), before);
  });
});

// ─────────────────────────────────────────────────────────────
// buildRole — references existing repo sources, soft-degrades
// ─────────────────────────────────────────────────────────────

describe('buildRole', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-ground-role-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('always includes orchestrator framing', () => {
    const out = buildRole(dir, { exists: () => false });
    assert.match(out, /orchestrator/i);
    assert.match(out, /altitude/i);
  });

  it('references repo .claude sources when present', () => {
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'agent-coordination.md'), 'x');
    writeFileSync(join(dir, 'docs', 'coding-agent-protocol.md'), 'x');
    const out = buildRole(dir);
    assert.match(out, /coding-agent-protocol\.md/);
    assert.match(out, /agent-coordination\.md/);
  });

  it('degrades to terse framing when no sources exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mc-ground-role-empty-'));
    const out = buildRole(empty);
    assert.match(out, /orchestrator/i);
    assert.ok(!/agent-coordination\.md/.test(out));
    rmSync(empty, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────
// pullLensMarkdown — injected fetch, null on failure
// ─────────────────────────────────────────────────────────────

describe('pullLensMarkdown', () => {
  it('returns the markdown from the injected fetch', async () => {
    const out = await pullLensMarkdown({ fetchLens: async () => 'lens body' });
    assert.equal(out, 'lens body');
  });

  it('returns null when fetch yields empty', async () => {
    assert.equal(await pullLensMarkdown({ fetchLens: async () => '' }), null);
    assert.equal(await pullLensMarkdown({ fetchLens: async () => null }), null);
  });

  it('returns null (never throws) when fetch rejects — no Memoro soft-degrade', async () => {
    const out = await pullLensMarkdown({ fetchLens: async () => { throw new Error('no token'); } });
    assert.equal(out, null);
  });
});

// ─────────────────────────────────────────────────────────────
// groundSession — orchestration + materialise
// ─────────────────────────────────────────────────────────────

describe('groundSession', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'mc-ground-session-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  function fakeAdapter() {
    return {
      written: null,
      async writeGrounding(markdown, { cwd }) {
        this.written = { markdown, cwd };
        return join(cwd, 'CLAUDE.md');
      },
    };
  }

  it('assembles all parts and materialises via the adapter', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      focus: 'on grounding',
      deps: {
        readMapImpl: async () => '# MEMORO.md\nmap',
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => 'lens',
      },
    });
    assert.equal(res.ok, true);
    assert.match(res.path, /CLAUDE\.md$/);
    assert.match(adapter.written.markdown, /## The map/);
    assert.match(adapter.written.markdown, /## Your role/);
    assert.match(adapter.written.markdown, /## Who you are working with/);
    assert.match(adapter.written.markdown, /on grounding/);
    assert.equal(adapter.written.cwd, dir);
  });

  it('soft-degrades when MEMORO.md missing — bundle without map', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => null,
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => 'lens',
      },
    });
    assert.equal(res.ok, true);
    assert.ok(!/## The map/.test(adapter.written.markdown));
    assert.match(adapter.written.markdown, /## Your role/);
  });

  it('soft-degrades when Memoro unavailable — bundle without lens', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => 'map',
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => null,
      },
    });
    assert.equal(res.ok, true);
    assert.ok(!/## Who you are working with/.test(adapter.written.markdown));
  });

  it('never throws when a dep-portal throws — returns parts anyway', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => { throw new Error('map boom'); },
        buildRoleImpl: () => { throw new Error('role boom'); },
        pullLensImpl: async () => { throw new Error('lens boom'); },
      },
    });
    // Materialise still succeeds with an empty-ish bundle.
    assert.equal(res.ok, true);
    assert.match(adapter.written.markdown, /# Session grounding/);
  });

  it('reports ok:false (does not throw) when the write fails', async () => {
    const adapter = {
      async writeGrounding() { throw new Error('disk full'); },
    };
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: { readMapImpl: async () => 'm', buildRoleImpl: () => 'r', pullLensImpl: async () => 'l' },
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /disk full/);
    assert.ok(res.parts, 'parts still returned for diagnostics');
  });

  it('rejects a missing adapter without throwing', async () => {
    const res = await groundSession({ cwd: dir });
    assert.equal(res.ok, false);
    assert.match(res.reason, /adapter/);
  });
});
