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
    assert.match(out, /coordinator/i);
    assert.match(out, /altitude/i);
  });

  it('pins the three coordinator targets in the wake-up role', () => {
    const out = buildRole(dir, { exists: () => false });
    assert.match(out, /Roadmap and end-goal awareness/);
    assert.match(out, /Orchestrator-role discipline/);
    assert.match(out, /Cross-session work-project order/);
    assert.match(out, /plan, brief, delegate, and review/i);
    assert.match(out, /MEMORO\.md.*session state.*worktrees.*branches.*tool choice/s);
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

  it('an empty repo still gets the FULL role from package canon (Phase 5)', () => {
    // Phase 5: the canon ships in the package, so an empty repo is NO LONGER
    // terse — it gets the full framing, but does not get bogus repo-paths
    // to read. Terse fallback now means a broken install only.
    const empty = mkdtempSync(join(tmpdir(), 'mc-ground-role-empty-'));
    const out = buildRole(empty);
    assert.match(out, /orchestrator/i);
    assert.match(out, /Repo-local coordinator source files are not present/);
    assert.match(out, /mc adapter materialise/);
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

  it('supports adapters that deliver grounding as a startup message', async () => {
    const adapter = {
      async writeGrounding(markdown, { cwd }) {
        return { path: join(cwd, 'AGENTS.md'), delivery: 'startup-message', message: markdown };
      },
    };
    const res = await groundSession({
      cwd: dir,
      adapter,
      focus: 'startup delivery',
      deps: {
        readMapImpl: async () => '# MEMORO.md\nmap',
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => null,
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.delivery, 'startup-message');
    assert.match(res.path, /AGENTS\.md$/);
    assert.match(res.message, /# Session grounding/);
    assert.match(res.message, /startup delivery/);
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

  // ── Phase 2: MEMORO.md lifecycle folds into the bundle ──

  it('folds a SEED offer into the bundle when MEMORO.md is absent', async () => {
    const adapter = fakeAdapter();
    await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => null,      // no MEMORO.md
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => null,
        repoName: 'acme-cli',
      },
    });
    assert.match(adapter.written.markdown, /Keeping the map current/);
    assert.match(adapter.written.markdown, /seed|create/i);
    assert.match(adapter.written.markdown, /No separate\s+confirmation step is required/i);
    assert.match(adapter.written.markdown, /Inspect repo evidence/i);
    assert.match(adapter.written.markdown, /do not stop at an empty skeleton/i);
  });

  it('folds update guidance + in-flight nodes when MEMORO.md exists', async () => {
    const adapter = fakeAdapter();
    await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => '- **Live node** — `active · L · now`',
        buildRoleImpl: () => 'role',
        pullLensImpl: async () => null,
      },
    });
    assert.match(adapter.written.markdown, /Keeping the map current/);
    assert.match(adapter.written.markdown, /Live node/);
    assert.match(adapter.written.markdown, /living project state/i);
  });

  // ── Phase 4: language resolved from the lens response governs the bundle ──

  it('resolves language from the lens response and renders a directive', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => null,
        buildRoleImpl: () => 'role',
        // Phase 4: grounding pulls the WHOLE lens response, not just markdown.
        fetchLensDataImpl: async () => ({ ok: true, markdown: 'lens body', language: 'Swedish' }),
      },
    });
    assert.match(adapter.written.markdown, /## Who you are working with/);
    assert.match(adapter.written.markdown, /lens body/);
    assert.match(adapter.written.markdown, /Swedish/);
    assert.match(adapter.written.markdown, /respond/i);
    assert.equal(res.parts?.language, 'Swedish');
  });

  it('defaults to English (no directive) when the lens carries no language', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => null,
        buildRoleImpl: () => 'role',
        fetchLensDataImpl: async () => ({ ok: true, markdown: 'lens body' }),
      },
    });
    assert.ok(!/respond in/i.test(adapter.written.markdown), 'English default → no directive');
    assert.equal(res.parts.language, null);
  });

  it('soft-degrades to English + no lens when Memoro is unreachable', async () => {
    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: dir,
      adapter,
      deps: {
        readMapImpl: async () => 'map',
        buildRoleImpl: () => 'role',
        fetchLensDataImpl: async () => { throw new Error('unreachable'); },
      },
    });
    assert.equal(res.ok, true);
    assert.ok(!/## Who you are working with/.test(adapter.written.markdown));
    assert.ok(!/respond in/i.test(adapter.written.markdown));
    assert.equal(res.parts.language, null);
  });

  it('default grounding NEVER mutates MEMORO.md on disk (load-bearing)', async () => {
    // A real MEMORO.md on disk; ground through the real readMap path.
    const mapDir = mkdtempSync(join(tmpdir(), 'mc-ground-readonly-'));
    const p = join(mapDir, 'MEMORO.md');
    writeFileSync(p, '# MEMORO.md\n- **Node** — `active · L · now`\n', 'utf8');
    const before = readFileSync(p, 'utf8');

    const adapter = fakeAdapter();
    const res = await groundSession({
      cwd: mapDir,
      adapter,
      deps: { buildRoleImpl: () => 'role', pullLensImpl: async () => null },
    });
    assert.equal(res.ok, true);
    // The bundle read the map (it appears) but the file is byte-identical.
    assert.match(adapter.written.markdown, /## The map/);
    assert.equal(readFileSync(p, 'utf8'), before, 'grounding must not write MEMORO.md');
    rmSync(mapDir, { recursive: true, force: true });
  });
});
